/**
 * API-first V1 路由。
 * 与原 Web 会话 API 解耦：Agent/外部程序使用独立 API Key。
 */

import { Hono } from 'hono';
import { getInitializedDatabase } from '../db/index.js';
import {
  createApiKey,
  authenticateApiKey,
  listApiKeys,
  revokeApiKey,
  hasScope,
  createApiMailbox,
  getApiMailbox,
  listApiMailboxes,
  renewApiMailbox,
  deleteApiMailbox,
  normalizeTtlSeconds,
  listApiMessages,
  getApiMessageDetail,
  waitForApiMessage,
  normalizeIdempotencyKey,
  fingerprintIdempotentRequest,
  getIdempotencyRecord,
  saveIdempotencyResult,
  deleteIdempotencyForResource,
  safeWriteApiAuditLog,
  listApiAuditLogs
} from '../db/index.js';
import { resolveAuthPayload } from '../middleware/auth.js';

const router = new Hono();

function error(c, status, code, message) {
  return c.json({ error: { code, message } }, status);
}

function configuredDomains(env) {
  return String(env.MAIL_DOMAIN || 'temp.example.com')
    .split(/[,\s]+/)
    .map(v => v.trim().toLowerCase())
    .filter(Boolean);
}

function randomLocalPart() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return Array.from(bytes, b => (b % 36).toString(36)).join('');
}

async function getDb(c) {
  try {
    return await getInitializedDatabase(c.env);
  } catch (e) {
    console.error('API V1 database error:', e);
    return null;
  }
}

async function requireStrictAdmin(c, db) {
  const secret = c.env.JWT_TOKEN || c.env.JWT_SECRET || '';
  const payload = await resolveAuthPayload(c.req.raw, secret);
  const adminName = String(c.env.ADMIN_NAME || 'admin').trim().toLowerCase();
  const allowed = payload?.role === 'admin' && (
    payload?.username === '__root__' ||
    String(payload?.username || '').trim().toLowerCase() === adminName
  );
  if (!allowed) return null;
  return { payload, db };
}

async function requireApiKey(c, db, scope) {
  const apiKey = await authenticateApiKey(db, c.req.raw);
  if (!apiKey) return { response: error(c, 401, 'invalid_api_key', 'API Key 无效、已撤销或已过期') };
  if (!hasScope(apiKey, scope)) {
    return { response: error(c, 403, 'insufficient_scope', `API Key 缺少权限：${scope}`) };
  }
  return { apiKey };
}

// 管理端：使用原 Freemail 严格管理员身份签发 API Key。
router.post('/api/v1/admin/api-keys', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  if (!await requireStrictAdmin(c, db)) return error(c, 403, 'forbidden', '需要严格管理员权限');

  let body = {};
  try { body = await c.req.json(); } catch (_) { return error(c, 400, 'invalid_json', '请求体必须是 JSON'); }

  const days = Number(body.expires_in_days || 0);
  const expiresAt = Number.isFinite(days) && days > 0
    ? new Date(Date.now() + Math.min(days, 3650) * 86400_000).toISOString()
    : null;

  try {
    const created = await createApiKey(db, {
      name: body.name,
      scopes: body.scopes || 'mailboxes:read,mailboxes:write,messages:read',
      expiresAt
    });
    return c.json(created, 201);
  } catch (e) {
    return error(c, 400, 'api_key_create_failed', String(e?.message || 'API Key 创建失败'));
  }
});

router.get('/api/v1/admin/api-keys', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  if (!await requireStrictAdmin(c, db)) return error(c, 403, 'forbidden', '需要严格管理员权限');
  return c.json({ data: await listApiKeys(db) });
});

router.delete('/api/v1/admin/api-keys/:id', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  if (!await requireStrictAdmin(c, db)) return error(c, 403, 'forbidden', '需要严格管理员权限');
  const ok = await revokeApiKey(db, c.req.param('id'));
  if (!ok) return error(c, 404, 'api_key_not_found', 'API Key 不存在');
  return c.json({ success: true });
});

router.get('/api/v1/admin/audit-logs', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  if (!await requireStrictAdmin(c, db)) return error(c, 403, 'forbidden', '需要严格管理员权限');
  const rows = await listApiAuditLogs(db, {
    limit: c.req.query('limit') || 100,
    apiKeyId: c.req.query('api_key_id') || null,
    action: c.req.query('action') || ''
  });
  return c.json({ data: rows });
});

// Agent/API：创建临时邮箱。ttl 单位为秒，默认 10 分钟，最短 60 秒，默认最长 24 小时。
router.post('/api/v1/mailboxes', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'mailboxes:write');
  if (auth.response) return auth.response;

  let body = {};
  try { body = await c.req.json(); } catch (_) { body = {}; }

  const domains = configuredDomains(c.env);
  const requestedDomain = String(body.domain || domains[0] || '').trim().toLowerCase();
  if (!domains.includes(requestedDomain)) {
    return error(c, 400, 'invalid_domain', '请求的邮箱域名不在允许列表中');
  }

  const requestedLocal = String(body.local || '').trim().toLowerCase();
  if (requestedLocal && !/^[a-z0-9_]{1,64}$/.test(requestedLocal)) {
    return error(c, 400, 'invalid_local_part', '邮箱前缀仅允许字母、数字和下划线');
  }

  const defaultTtl = Number(c.env.MAIL_API_DEFAULT_TTL_SECONDS || 600);
  const maxTtl = Number(c.env.MAIL_API_MAX_TTL_SECONDS || 86400);
  const ttlSeconds = normalizeTtlSeconds(body.ttl, { defaultTtl, maxTtl });

  let idempotencyKey = '';
  try {
    idempotencyKey = normalizeIdempotencyKey(c.req.header('Idempotency-Key') || '');
  } catch (e) {
    return error(c, 400, 'invalid_idempotency_key', String(e?.message || 'Idempotency-Key 无效'));
  }

  const operation = 'mailbox.create';
  const requestHash = idempotencyKey
    ? await fingerprintIdempotentRequest({ domain: requestedDomain, local: requestedLocal, ttl: ttlSeconds })
    : '';

  if (idempotencyKey) {
    const existing = await getIdempotencyRecord(db, {
      apiKeyId: auth.apiKey.id,
      operation,
      key: idempotencyKey
    });
    if (existing) {
      if (existing.request_hash !== requestHash) {
        await safeWriteApiAuditLog(db, {
          apiKeyId: auth.apiKey.id,
          action: operation,
          resourceType: 'mailbox',
          resourceId: existing.resource_id,
          status: 'conflict',
          metadata: { reason: 'idempotency_request_mismatch' }
        });
        return error(c, 409, 'idempotency_conflict', '同一个 Idempotency-Key 不能用于不同的创建参数');
      }
      const mailbox = await getApiMailbox(db, {
        apiKeyId: auth.apiKey.id,
        resourceId: existing.resource_id
      });
      if (mailbox) {
        c.header('Idempotency-Replayed', 'true');
        await safeWriteApiAuditLog(db, {
          apiKeyId: auth.apiKey.id,
          action: operation,
          resourceType: 'mailbox',
          resourceId: mailbox.id,
          status: 'replay',
          metadata: { ttl: ttlSeconds }
        });
        return c.json({ ...mailbox, ttl: ttlSeconds }, 200);
      }
      try {
        await deleteIdempotencyForResource(db, {
          apiKeyId: auth.apiKey.id,
          resourceId: existing.resource_id
        });
      } catch (_) { }
    }
  }

  for (let attempt = 0; attempt < (requestedLocal ? 1 : 5); attempt++) {
    const local = requestedLocal || randomLocalPart();
    const address = `${local}@${requestedDomain}`;
    try {
      const mailbox = await createApiMailbox(db, {
        apiKeyId: auth.apiKey.id,
        address,
        ttlSeconds
      });

      if (idempotencyKey) {
        try {
          await saveIdempotencyResult(db, {
            apiKeyId: auth.apiKey.id,
            operation,
            key: idempotencyKey,
            requestHash,
            resourceId: mailbox.id
          });
        } catch (idemError) {
          await deleteApiMailbox(db, c.env.MAIL_EML, {
            apiKeyId: auth.apiKey.id,
            resourceId: mailbox.id
          }).catch(() => {});

          const winner = await getIdempotencyRecord(db, {
            apiKeyId: auth.apiKey.id,
            operation,
            key: idempotencyKey
          }).catch(() => null);
          if (winner && winner.request_hash === requestHash) {
            const winnerMailbox = await getApiMailbox(db, {
              apiKeyId: auth.apiKey.id,
              resourceId: winner.resource_id
            });
            if (winnerMailbox) {
              c.header('Idempotency-Replayed', 'true');
              await safeWriteApiAuditLog(db, {
                apiKeyId: auth.apiKey.id,
                action: operation,
                resourceType: 'mailbox',
                resourceId: winnerMailbox.id,
                status: 'replay',
                metadata: { ttl: ttlSeconds, concurrent: true }
              });
              return c.json({ ...winnerMailbox, ttl: ttlSeconds }, 200);
            }
          }

          console.error('API V1 idempotency save failed:', idemError);
          return error(c, 500, 'idempotency_store_failed', '幂等状态保存失败，未保留本次创建的邮箱');
        }
      }

      await safeWriteApiAuditLog(db, {
        apiKeyId: auth.apiKey.id,
        action: operation,
        resourceType: 'mailbox',
        resourceId: mailbox.id,
        status: 'success',
        metadata: { ttl: ttlSeconds, idempotent: Boolean(idempotencyKey) }
      });
      return c.json({ ...mailbox, ttl: ttlSeconds }, 201);
    } catch (e) {
      const message = String(e?.message || '');
      const duplicate = /UNIQUE|constraint/i.test(message);
      if (!requestedLocal && duplicate && attempt < 4) continue;
      if (duplicate && idempotencyKey) {
        const existing = await getIdempotencyRecord(db, {
          apiKeyId: auth.apiKey.id,
          operation,
          key: idempotencyKey
        }).catch(() => null);
        if (existing && existing.request_hash === requestHash) {
          const mailbox = await getApiMailbox(db, {
            apiKeyId: auth.apiKey.id,
            resourceId: existing.resource_id
          });
          if (mailbox) {
            c.header('Idempotency-Replayed', 'true');
            return c.json({ ...mailbox, ttl: ttlSeconds }, 200);
          }
        }
      }
      if (duplicate) return error(c, 409, 'mailbox_exists', '邮箱地址已存在');
      console.error('API V1 mailbox create failed:', e);
      await safeWriteApiAuditLog(db, {
        apiKeyId: auth.apiKey.id,
        action: operation,
        resourceType: 'mailbox',
        status: 'failed',
        metadata: { reason: 'mailbox_create_failed' }
      });
      return error(c, 500, 'mailbox_create_failed', '邮箱创建失败');
    }
  }

  return error(c, 500, 'mailbox_create_failed', '无法生成唯一邮箱地址');
});

router.get('/api/v1/mailboxes', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'mailboxes:read');
  if (auth.response) return auth.response;
  const limit = Number(c.req.query('limit') || 100);
  return c.json({ data: await listApiMailboxes(db, { apiKeyId: auth.apiKey.id, limit }) });
});

router.get('/api/v1/mailboxes/:id', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'mailboxes:read');
  if (auth.response) return auth.response;
  const mailbox = await getApiMailbox(db, { apiKeyId: auth.apiKey.id, resourceId: c.req.param('id') });
  if (!mailbox) return error(c, 404, 'mailbox_not_found', '邮箱不存在');
  return c.json(mailbox);
});

router.post('/api/v1/mailboxes/:id/renew', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'mailboxes:write');
  if (auth.response) return auth.response;

  const resourceId = c.req.param('id');
  const current = await getApiMailbox(db, { apiKeyId: auth.apiKey.id, resourceId });
  if (!current) return error(c, 404, 'mailbox_not_found', '邮箱不存在');
  if (current.status === 'expired') return error(c, 410, 'mailbox_expired', '邮箱已过期，不能续期');

  let body = {};
  try { body = await c.req.json(); } catch (_) { body = {}; }
  const defaultTtl = Number(c.env.MAIL_API_DEFAULT_TTL_SECONDS || 600);
  const maxTtl = Number(c.env.MAIL_API_MAX_TTL_SECONDS || 86400);
  const ttlSeconds = normalizeTtlSeconds(body.ttl, { defaultTtl, maxTtl });
  const renewed = await renewApiMailbox(db, {
    apiKeyId: auth.apiKey.id,
    resourceId,
    ttlSeconds
  });
  if (!renewed) return error(c, 404, 'mailbox_not_found', '邮箱不存在');
  if (renewed.status === 'expired' || renewed.renewed === false) {
    return error(c, 410, 'mailbox_expired', '邮箱已过期，不能续期');
  }

  await safeWriteApiAuditLog(db, {
    apiKeyId: auth.apiKey.id,
    action: 'mailbox.renew',
    resourceType: 'mailbox',
    resourceId,
    status: 'success',
    metadata: { ttl: ttlSeconds, expires_at: renewed.expires_at }
  });
  return c.json({ ...renewed, ttl: ttlSeconds });
});

router.get('/api/v1/mailboxes/:id/messages', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'messages:read');
  if (auth.response) return auth.response;

  const mailbox = await getApiMailbox(db, {
    apiKeyId: auth.apiKey.id,
    resourceId: c.req.param('id')
  });
  if (!mailbox) return error(c, 404, 'mailbox_not_found', '邮箱不存在');

  const resourceId = c.req.param('id');
  const messages = await listApiMessages(db, {
    apiKeyId: auth.apiKey.id,
    resourceId,
    limit: c.req.query('limit') || 20,
    afterId: c.req.query('after_id') || 0
  });
  await safeWriteApiAuditLog(db, {
    apiKeyId: auth.apiKey.id,
    action: 'messages.list',
    resourceType: 'mailbox',
    resourceId,
    status: 'success',
    metadata: { count: messages.length }
  });
  return c.json({ data: messages });
});

router.get('/api/v1/messages/:id', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'messages:read');
  if (auth.response) return auth.response;

  const messageId = c.req.param('id');
  const message = await getApiMessageDetail(db, c.env.MAIL_EML, {
    apiKeyId: auth.apiKey.id,
    messageId
  });
  if (!message) return error(c, 404, 'message_not_found', '邮件不存在');
  await safeWriteApiAuditLog(db, {
    apiKeyId: auth.apiKey.id,
    action: 'message.get',
    resourceType: 'message',
    resourceId: messageId,
    status: 'success',
    metadata: { mailbox_id: message.mailbox_id }
  });
  return c.json(message);
});

router.get('/api/v1/mailboxes/:id/wait', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'messages:read');
  if (auth.response) return auth.response;

  const resourceId = c.req.param('id');
  const mailbox = await getApiMailbox(db, {
    apiKeyId: auth.apiKey.id,
    resourceId
  });
  if (!mailbox) return error(c, 404, 'mailbox_not_found', '邮箱不存在');
  if (mailbox.status === 'expired') return error(c, 410, 'mailbox_expired', '邮箱已过期');

  const type = String(c.req.query('for') || 'mail').toLowerCase();
  if (!['mail', 'code', 'link'].includes(type)) {
    return error(c, 400, 'invalid_wait_type', 'for 仅支持 mail、code、link');
  }

  const afterId = c.req.query('after_id') || 0;
  const result = await waitForApiMessage({
    type,
    timeoutSeconds: c.req.query('timeout') ?? 20,
    intervalMs: c.req.query('interval_ms') ?? 1000,
    filters: {
      from: c.req.query('from') || '',
      fromDomain: c.req.query('from_domain') || '',
      subjectContains: c.req.query('subject_contains') || ''
    },
    listMessages: () => listApiMessages(db, {
      apiKeyId: auth.apiKey.id,
      resourceId,
      limit: 20,
      afterId
    }),
    loadDetail: (messageId) => getApiMessageDetail(db, c.env.MAIL_EML, {
      apiKeyId: auth.apiKey.id,
      messageId
    })
  });

  await safeWriteApiAuditLog(db, {
    apiKeyId: auth.apiKey.id,
    action: 'messages.wait',
    resourceType: 'mailbox',
    resourceId,
    status: result.matched ? 'matched' : 'timeout',
    metadata: {
      type,
      waited_ms: result.waited_ms,
      message_id: result?.message?.id || null
    }
  });
  return c.json(result);
});

router.post('/api/v1/mailboxes/:id/release', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'mailboxes:write');
  if (auth.response) return auth.response;

  const resourceId = c.req.param('id');
  const deleted = await deleteApiMailbox(db, c.env.MAIL_EML, {
    apiKeyId: auth.apiKey.id,
    resourceId
  });
  if (!deleted) return error(c, 404, 'mailbox_not_found', '邮箱不存在');
  try {
    await deleteIdempotencyForResource(db, { apiKeyId: auth.apiKey.id, resourceId });
  } catch (e) {
    console.error('API V1 release idempotency cleanup failed:', e);
  }
  await safeWriteApiAuditLog(db, {
    apiKeyId: auth.apiKey.id,
    action: 'mailbox.release',
    resourceType: 'mailbox',
    resourceId,
    status: 'success'
  });
  return c.json({ success: true, released: true });
});

router.delete('/api/v1/mailboxes/:id', async (c) => {
  const db = await getDb(c);
  if (!db) return error(c, 500, 'database_unavailable', '数据库连接失败');
  const auth = await requireApiKey(c, db, 'mailboxes:write');
  if (auth.response) return auth.response;
  const resourceId = c.req.param('id');
  const deleted = await deleteApiMailbox(db, c.env.MAIL_EML, {
    apiKeyId: auth.apiKey.id,
    resourceId
  });
  if (!deleted) return error(c, 404, 'mailbox_not_found', '邮箱不存在');
  try {
    await deleteIdempotencyForResource(db, { apiKeyId: auth.apiKey.id, resourceId });
  } catch (e) {
    console.error('API V1 delete idempotency cleanup failed:', e);
  }
  await safeWriteApiAuditLog(db, {
    apiKeyId: auth.apiKey.id,
    action: 'mailbox.delete',
    resourceType: 'mailbox',
    resourceId,
    status: 'success'
  });
  return c.json({ success: true });
});

// 必须吞掉所有未知 V1 路径，避免落入旧 /api/* 处理器。
router.all('/api/v1/*', (c) => error(c, 404, 'not_found', '未找到 API V1 路径'));

export default router;

