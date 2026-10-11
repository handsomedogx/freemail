/**
 * Mail API V1 第三阶段：幂等、Lease 与审计辅助测试。
 */

import {
  normalizeIdempotencyKey,
  fingerprintIdempotentRequest,
  getIdempotencyRecord,
  saveIdempotencyResult,
  deleteIdempotencyForResource,
  writeApiAuditLog,
  listApiAuditLogs
} from '../db/apiOperations.js';
import { renewApiMailbox } from '../db/apiMailboxes.js';
import { sha256Hex } from '../utils/common.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`✓ PASS  ${name}`);
    passed++;
  } catch (error) {
    console.error(`✗ FAIL  ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

class FakeOperationsDb {
  constructor() {
    this.idempotency = [];
    this.audit = [];
  }

  prepare(sql) {
    const db = this;
    const text = String(sql);
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO api_idempotency_keys/i.test(text)) {
              const [apiKeyId, operation, keyHash, requestHash, resourceId] = args;
              const duplicate = db.idempotency.some(row =>
                row.api_key_id === apiKeyId && row.operation === operation && row.key_hash === keyHash
              );
              if (duplicate) throw new Error('UNIQUE constraint failed: api_idempotency_keys');
              db.idempotency.push({
                id: db.idempotency.length + 1,
                api_key_id: apiKeyId,
                operation,
                key_hash: keyHash,
                request_hash: requestHash,
                resource_id: resourceId,
                created_at: '2026-10-11 12:00:00'
              });
              return { meta: { changes: 1 } };
            }
            if (/DELETE FROM api_idempotency_keys/i.test(text)) {
              const [apiKeyId, resourceId] = args;
              const before = db.idempotency.length;
              db.idempotency = db.idempotency.filter(row =>
                !(row.api_key_id === apiKeyId && row.resource_id === resourceId)
              );
              return { meta: { changes: before - db.idempotency.length } };
            }
            if (/INSERT INTO api_audit_logs/i.test(text)) {
              const [apiKeyId, action, resourceType, resourceId, status, metadataJson] = args;
              db.audit.push({
                id: db.audit.length + 1,
                api_key_id: apiKeyId,
                api_key_name: 'agent-test',
                action,
                resource_type: resourceType,
                resource_id: resourceId,
                status,
                metadata_json: metadataJson,
                created_at: '2026-10-11 12:00:01'
              });
              return { meta: { changes: 1 } };
            }
            return { meta: { changes: 0 } };
          },
          async first() {
            if (/FROM api_idempotency_keys/i.test(text)) {
              const [apiKeyId, operation, keyHash] = args;
              return db.idempotency.find(row =>
                row.api_key_id === apiKeyId && row.operation === operation && row.key_hash === keyHash
              ) || null;
            }
            return null;
          },
          async all() {
            if (/FROM api_audit_logs/i.test(text)) {
              const limit = Number(args[args.length - 1]);
              let rows = [...db.audit].reverse();
              if (/l\.api_key_id = \?/i.test(text)) {
                const apiKeyId = Number(args[0]);
                rows = rows.filter(row => row.api_key_id === apiKeyId);
              }
              if (/l\.action = \?/i.test(text)) {
                const actionArg = /l\.api_key_id = \?/i.test(text) ? args[1] : args[0];
                rows = rows.filter(row => row.action === actionArg);
              }
              return { results: rows.slice(0, limit) };
            }
            return { results: [] };
          }
        };
      }
    };
  }
}

class FakeMailboxDb {
  constructor(expiresAt) {
    this.row = {
      resource_id: 'mb_test',
      mailbox_id: 7,
      address: 'agent@example.com',
      created_at: '2026-10-11 12:00:00',
      expires_at: expiresAt
    };
  }

  prepare(sql) {
    const db = this;
    const text = String(sql);
    return {
      bind(...args) {
        return {
          async first() {
            if (/FROM api_mailboxes am/i.test(text)) {
              const [resourceId, apiKeyId] = args;
              if (resourceId === db.row.resource_id && Number(apiKeyId) === 1) return { ...db.row };
            }
            return null;
          },
          async run() {
            if (/UPDATE mailboxes/i.test(text)) {
              const [expiresAt, resourceId, apiKeyId] = args;
              if (resourceId === db.row.resource_id && Number(apiKeyId) === 1) {
                db.row.expires_at = expiresAt;
                return { meta: { changes: 1 } };
              }
            }
            return { meta: { changes: 0 } };
          }
        };
      }
    };
  }
}

await test('Idempotency-Key 规范化、长度与请求指纹正确', async () => {
  assert(normalizeIdempotencyKey(' task-123 ') === 'task-123', '应去掉首尾空格');
  let tooLongRejected = false;
  try { normalizeIdempotencyKey('x'.repeat(201)); } catch (_) { tooLongRejected = true; }
  assert(tooLongRejected, '超长 Idempotency-Key 应拒绝');
  const a = await fingerprintIdempotentRequest({ ttl: 600, local: '' });
  const b = await fingerprintIdempotentRequest({ ttl: 600, local: '' });
  const c = await fingerprintIdempotentRequest({ ttl: 1200, local: '' });
  assert(a === b, '相同参数应生成相同请求指纹');
  assert(a !== c, '不同参数应生成不同请求指纹');
});

await test('幂等记录只保存 key 哈希并可按资源清理', async () => {
  const db = new FakeOperationsDb();
  const rawKey = 'signup-task-001';
  const requestHash = await fingerprintIdempotentRequest({ ttl: 600 });
  await saveIdempotencyResult(db, {
    apiKeyId: 1,
    operation: 'mailbox.create',
    key: rawKey,
    requestHash,
    resourceId: 'mb_test'
  });
  assert(db.idempotency.length === 1, '应写入一条幂等记录');
  assert(db.idempotency[0].key_hash === await sha256Hex(rawKey), '应保存 Idempotency-Key SHA-256');
  assert(db.idempotency[0].key_hash !== rawKey, '不应保存 Idempotency-Key 明文');

  const found = await getIdempotencyRecord(db, {
    apiKeyId: 1,
    operation: 'mailbox.create',
    key: rawKey
  });
  assert(found?.resource_id === 'mb_test', '应命中原资源');
  assert(found?.request_hash === requestHash, '应保留请求指纹用于冲突检测');

  const deleted = await deleteIdempotencyForResource(db, { apiKeyId: 1, resourceId: 'mb_test' });
  assert(deleted === 1 && db.idempotency.length === 0, 'release 时应可清理幂等记录');
});

await test('审计日志结构化写入并解析 metadata', async () => {
  const db = new FakeOperationsDb();
  await writeApiAuditLog(db, {
    apiKeyId: 1,
    action: 'messages.wait',
    resourceType: 'mailbox',
    resourceId: 'mb_test',
    status: 'matched',
    metadata: { type: 'code', waited_ms: 5404 }
  });
  const rows = await listApiAuditLogs(db, { apiKeyId: 1, action: 'messages.wait' });
  assert(rows.length === 1, '应返回审计记录');
  assert(rows[0].metadata?.type === 'code', 'metadata 应解析为对象');
  assert(rows[0].metadata?.waited_ms === 5404, 'metadata 内容应完整');
});

await test('超长审计 metadata 截断后仍保持合法 JSON', async () => {
  const db = new FakeOperationsDb();
  await writeApiAuditLog(db, {
    apiKeyId: 1,
    action: 'mailbox.create',
    resourceType: 'mailbox',
    resourceId: 'mb_test',
    metadata: { payload: 'x'.repeat(5000) }
  });
  const rows = await listApiAuditLogs(db, { action: 'mailbox.create' });
  assert(rows[0].metadata?.truncated === true, '超长 metadata 应标记 truncated');
  assert(typeof rows[0].metadata?.preview === 'string', '截断 metadata 应保留可读 preview');
});

await test('Lease renew 从当前时间重新计算过期时间，过期邮箱不可复活', async () => {
  const activeDb = new FakeMailboxDb(new Date(Date.now() + 30_000).toISOString());
  const before = Date.now();
  const renewed = await renewApiMailbox(activeDb, {
    apiKeyId: 1,
    resourceId: 'mb_test',
    ttlSeconds: 600
  });
  const renewedTs = Date.parse(renewed.expires_at);
  assert(renewed?.renewed === true, '有效邮箱应续期成功');
  assert(renewedTs >= before + 590_000, '续期时间应约为当前时间 + TTL');

  const expiredDb = new FakeMailboxDb(new Date(Date.now() - 30_000).toISOString());
  const expired = await renewApiMailbox(expiredDb, {
    apiKeyId: 1,
    resourceId: 'mb_test',
    ttlSeconds: 600
  });
  assert(expired?.renewed === false, '已过期邮箱不应被续期复活');
});

console.log(`\n总计: ${passed} 项通过`);
