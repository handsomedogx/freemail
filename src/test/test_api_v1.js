/**
 * Mail API V1 基础能力测试。
 * 不连接 Cloudflare，使用轻量 Fake D1 验证 API Key 明文不落库、鉴权与 TTL 辅助逻辑。
 */

import {
  createApiKey,
  authenticateApiKey,
  extractBearerToken,
  hasScope
} from '../db/apiKeys.js';
import { normalizeTtlSeconds, mailboxStatus } from '../db/apiMailboxes.js';
import { sha256Hex } from '../utils/common.js';

class FakeApiKeyDb {
  constructor() {
    this.row = null;
  }

  prepare(sql) {
    const db = this;
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO api_keys/i.test(sql)) {
              db.row = {
                id: 1,
                name: args[0],
                key_prefix: args[1],
                key_hash: args[2],
                scopes: args[3],
                created_at: new Date().toISOString(),
                last_used_at: null,
                expires_at: args[4],
                enabled: 1
              };
              return { meta: { changes: 1 } };
            }
            if (/UPDATE api_keys SET last_used_at/i.test(sql)) {
              if (db.row && Number(args[0]) === db.row.id) db.row.last_used_at = new Date().toISOString();
              return { meta: { changes: db.row ? 1 : 0 } };
            }
            return { meta: { changes: 0 } };
          },
          async first() {
            if (/FROM api_keys/i.test(sql) && db.row && args[0] === db.row.key_hash && db.row.enabled) {
              return { ...db.row };
            }
            return null;
          }
        };
      }
    };
  }
}

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

await test('API Key 只将 SHA-256 哈希写入数据库', async () => {
  const db = new FakeApiKeyDb();
  const created = await createApiKey(db, { name: 'agent-test' });
  assert(created.key.startsWith('fm_live_'), '缺少 fm_live_ 前缀');
  assert(db.row.key_hash !== created.key, '数据库不应保存明文 key');
  assert(db.row.key_hash === await sha256Hex(created.key), '数据库应保存 key 的 SHA-256');
  assert(!Object.prototype.hasOwnProperty.call(db.row, 'key'), '数据库行不应包含明文 key 字段');
});

await test('Bearer API Key 可鉴权，错误 Key 被拒绝', async () => {
  const db = new FakeApiKeyDb();
  const created = await createApiKey(db, { name: 'agent-test' });
  const good = new Request('https://example.test/api/v1/mailboxes', {
    headers: { Authorization: `Bearer ${created.key}` }
  });
  const bad = new Request('https://example.test/api/v1/mailboxes', {
    headers: { Authorization: 'Bearer fm_live_wrong' }
  });
  assert((await authenticateApiKey(db, good))?.id === 1, '正确 API Key 鉴权失败');
  assert(await authenticateApiKey(db, bad) === null, '错误 API Key 不应通过');
});

await test('Scope 与 Bearer 解析正确', async () => {
  const req = new Request('https://example.test', { headers: { Authorization: 'Bearer fm_live_abc' } });
  assert(extractBearerToken(req) === 'fm_live_abc', 'Bearer 解析错误');
  assert(hasScope({ scopes: 'mailboxes:read,mailboxes:write' }, 'mailboxes:read'), 'read scope 应存在');
  assert(!hasScope({ scopes: 'mailboxes:read' }, 'mailboxes:write'), 'write scope 不应存在');
  assert(hasScope({ scopes: '*' }, 'mailboxes:write'), '* scope 应放行');
});

await test('TTL 默认值、上下限与过期状态正确', async () => {
  assert(normalizeTtlSeconds(undefined) === 600, '默认 TTL 应为 600 秒');
  assert(normalizeTtlSeconds(1) === 60, 'TTL 最短应为 60 秒');
  assert(normalizeTtlSeconds(999999) === 86400, 'TTL 默认最长应为 86400 秒');
  assert(normalizeTtlSeconds(undefined, { defaultTtl: NaN, maxTtl: NaN }) === 600, '非法环境配置应回退默认 TTL');
  assert(mailboxStatus({ expires_at: new Date(Date.now() - 1000).toISOString() }) === 'expired', '过去时间应已过期');
  assert(mailboxStatus({ expires_at: new Date(Date.now() + 1000).toISOString() }) === 'active', '未来时间应有效');
  assert(mailboxStatus({ expires_at: null }) === 'active', '无 TTL 的旧邮箱应保持有效');
});

console.log(`\n总计: ${passed} 项通过`);
