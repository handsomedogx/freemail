/**
 * API V1 邮箱资源数据访问层。
 */

import { invalidateMailboxCache, invalidateSystemStatCache } from '../utils/cache.js';

function randomResourceId() {
  const uuid = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now()}${Math.random().toString(36).slice(2)}`;
  return `mb_${uuid.slice(0, 20)}`;
}

export function normalizeTtlSeconds(value, { defaultTtl = 600, maxTtl = 86400 } = {}) {
  const defaultValue = Number(defaultTtl);
  const maxValue = Number(maxTtl);
  const safeDefault = Number.isFinite(defaultValue) && defaultValue > 0 ? Math.floor(defaultValue) : 600;
  const safeMax = Number.isFinite(maxValue) && maxValue >= 60 ? Math.floor(maxValue) : 86400;
  const parsed = Number(value);
  const ttl = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : safeDefault;
  return Math.max(60, Math.min(safeMax, ttl));
}

export function mailboxStatus(row, now = Date.now()) {
  if (!row?.expires_at) return 'active';
  const expiresAt = Date.parse(row.expires_at);
  return Number.isFinite(expiresAt) && expiresAt <= now ? 'expired' : 'active';
}

export async function createApiMailbox(db, {
  apiKeyId,
  address,
  ttlSeconds
}) {
  const normalized = String(address || '').trim().toLowerCase();
  const [localPart, domain] = normalized.split('@');
  if (!localPart || !domain) throw new Error('无效的邮箱地址');

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const resourceId = randomResourceId();

  await db.prepare(`
    INSERT INTO mailboxes (address, local_part, domain, password_hash, last_accessed_at, expires_at)
    VALUES (?, ?, ?, NULL, CURRENT_TIMESTAMP, ?)
  `).bind(normalized, localPart, domain, expiresAt).run();

  const mailbox = await db.prepare(`
    SELECT id, address, local_part, domain, created_at, expires_at
    FROM mailboxes WHERE address = ? LIMIT 1
  `).bind(normalized).first();
  if (!mailbox) throw new Error('邮箱创建失败');

  try {
    await db.prepare(`
      INSERT INTO api_mailboxes (resource_id, api_key_id, mailbox_id)
      VALUES (?, ?, ?)
    `).bind(resourceId, Number(apiKeyId), Number(mailbox.id)).run();
  } catch (error) {
    await db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(mailbox.id).run().catch(() => {});
    throw error;
  }

  invalidateSystemStatCache('total_mailboxes');
  return {
    id: resourceId,
    address: mailbox.address,
    created_at: mailbox.created_at,
    expires_at: mailbox.expires_at,
    status: 'active'
  };
}

export async function getApiMailbox(db, { apiKeyId, resourceId }) {
  const row = await db.prepare(`
    SELECT am.resource_id, m.id AS mailbox_id, m.address, m.created_at, m.expires_at
    FROM api_mailboxes am
    JOIN mailboxes m ON m.id = am.mailbox_id
    WHERE am.resource_id = ? AND am.api_key_id = ?
    LIMIT 1
  `).bind(String(resourceId || ''), Number(apiKeyId)).first();

  if (!row) return null;
  return {
    id: row.resource_id,
    address: row.address,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status: mailboxStatus(row)
  };
}

export async function listApiMailboxes(db, { apiKeyId, limit = 100 }) {
  const parsedLimit = Number(limit);
  const safeLimit = Number.isFinite(parsedLimit)
    ? Math.max(1, Math.min(500, Math.floor(parsedLimit)))
    : 100;
  const result = await db.prepare(`
    SELECT am.resource_id, m.address, m.created_at, m.expires_at
    FROM api_mailboxes am
    JOIN mailboxes m ON m.id = am.mailbox_id
    WHERE am.api_key_id = ?
    ORDER BY am.id DESC
    LIMIT ?
  `).bind(Number(apiKeyId), safeLimit).all();

  return (result?.results || []).map(row => ({
    id: row.resource_id,
    address: row.address,
    created_at: row.created_at,
    expires_at: row.expires_at,
    status: mailboxStatus(row)
  }));
}

export async function renewApiMailbox(db, {
  apiKeyId,
  resourceId,
  ttlSeconds
}) {
  const current = await getApiMailbox(db, { apiKeyId, resourceId });
  if (!current) return null;
  if (current.status === 'expired') return { ...current, renewed: false };

  const expiresAt = new Date(Date.now() + Number(ttlSeconds) * 1000).toISOString();
  const result = await db.prepare(`
    UPDATE mailboxes
    SET expires_at = ?, last_accessed_at = CURRENT_TIMESTAMP
    WHERE id = (
      SELECT mailbox_id FROM api_mailboxes
      WHERE resource_id = ? AND api_key_id = ?
      LIMIT 1
    )
  `).bind(expiresAt, String(resourceId || ''), Number(apiKeyId)).run();

  if (Number(result?.meta?.changes || 0) <= 0) return null;
  const updated = await getApiMailbox(db, { apiKeyId, resourceId });
  return updated ? { ...updated, renewed: true } : null;
}

export async function deleteApiMailbox(db, r2, { apiKeyId, resourceId }) {
  const row = await db.prepare(`
    SELECT am.resource_id, m.id AS mailbox_id, m.address
    FROM api_mailboxes am
    JOIN mailboxes m ON m.id = am.mailbox_id
    WHERE am.resource_id = ? AND am.api_key_id = ?
    LIMIT 1
  `).bind(String(resourceId || ''), Number(apiKeyId)).first();
  if (!row) return false;

  const messageRows = await db.prepare(
    'SELECT r2_object_key FROM messages WHERE mailbox_id = ? AND r2_object_key <> \'\''
  ).bind(row.mailbox_id).all();

  await db.prepare('DELETE FROM messages WHERE mailbox_id = ?').bind(row.mailbox_id).run();
  await db.prepare('DELETE FROM user_mailboxes WHERE mailbox_id = ?').bind(row.mailbox_id).run();
  await db.prepare('DELETE FROM api_mailboxes WHERE mailbox_id = ?').bind(row.mailbox_id).run();
  await db.prepare('DELETE FROM mailboxes WHERE id = ?').bind(row.mailbox_id).run();

  invalidateMailboxCache(row.address);
  invalidateSystemStatCache('total_mailboxes');

  if (r2) {
    const keys = (messageRows?.results || []).map(v => v.r2_object_key).filter(Boolean);
    if (keys.length) {
      await Promise.allSettled(keys.map(key => r2.delete(key)));
    }
  }

  return true;
}

