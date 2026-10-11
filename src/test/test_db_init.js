/**
 * D1 初始化回归测试：已有核心库不能被可选 API 扩展初始化拖垮。
 */

import { ensureApiTables, ensureOptionalApiSchema, initDatabase } from '../db/init.js';

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

await test('API 扩展表已存在时不重复执行运行时 DDL', async () => {
  const execSql = [];
  const db = {
    prepare(sql) {
      return {
        async all() {
          assert(String(sql).includes('sqlite_master'), '应通过 sqlite_master 检查表是否存在');
          return { results: [{ name: 'api_keys' }, { name: 'api_mailboxes' }] };
        }
      };
    },
    async exec(sql) {
      execSql.push(String(sql));
    }
  };

  const result = await ensureApiTables(db);
  assert(result?.created === false, '已有表不应标记为新建');
  assert(execSql.length === 0, '已有 API 表时不应执行 CREATE TABLE');
});

await test('可选 API schema 检查失败不会抛错拖垮旧 API', async () => {
  const db = {
    prepare() {
      return {
        async all() {
          throw new Error('simulated D1 metadata failure');
        }
      };
    },
    async exec() {
      throw new Error('不应执行到这里');
    }
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    const ok = await ensureOptionalApiSchema(db);
    assert(ok === false, '可选 schema 失败应返回 false');
  } finally {
    console.error = originalError;
  }
});

await test('已有核心表时 API schema 异常不会让 initDatabase 失败', async () => {
  const execSql = [];
  const db = {
    prepare(sql) {
      const text = String(sql);
      return {
        async all() {
          if (text.includes('SELECT 1 FROM ')) return { results: [{ ok: 1 }] };
          if (text.includes('PRAGMA table_info(mailboxes)')) {
            return { results: [{ name: 'forward_to' }, { name: 'is_favorite' }] };
          }
          if (text.includes('PRAGMA table_info(sent_emails)')) {
            return { results: [{ name: 'provider' }] };
          }
          if (text.includes('sqlite_master')) {
            throw new Error('simulated API schema check failure');
          }
          return { results: [] };
        }
      };
    },
    async exec(sql) {
      execSql.push(String(sql));
    }
  };

  const originalError = console.error;
  console.error = () => {};
  try {
    await initDatabase(db);
  } finally {
    console.error = originalError;
  }

  assert(execSql.some(sql => sql.includes('PRAGMA foreign_keys = ON')), '核心初始化应继续完成');
  assert(!execSql.some(sql => /CREATE TABLE api_/i.test(sql)), 'API schema 检查失败后不应继续运行时建表');
});

console.log(`\n总计: ${passed} 项通过`);
