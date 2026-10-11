import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMailMcpHandler } from '../mcp/server.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

class FakeMcpDb {
  constructor() {
    this.mailboxes = [];
    this.apiMailboxes = [];
    this.idempotency = [];
    this.audit = [];
    this.messages = [];
  }

  prepare(sql) {
    const db = this;
    const text = String(sql).replace(/\s+/g, ' ').trim();
    return {
      bind(...args) {
        return {
          async run() {
            if (/INSERT INTO mailboxes /i.test(text)) {
              const [address, localPart, domain, expiresAt] = args;
              if (db.mailboxes.some(row => row.address === address)) {
                throw new Error('UNIQUE constraint failed: mailboxes.address');
              }
              db.mailboxes.push({
                id: db.mailboxes.length + 1,
                address,
                local_part: localPart,
                domain,
                created_at: '2026-10-11 12:00:00',
                expires_at: expiresAt
              });
              return { meta: { changes: 1 } };
            }

            if (/INSERT INTO api_mailboxes /i.test(text)) {
              const [resourceId, apiKeyId, mailboxId] = args;
              db.apiMailboxes.push({
                id: db.apiMailboxes.length + 1,
                resource_id: resourceId,
                api_key_id: Number(apiKeyId),
                mailbox_id: Number(mailboxId)
              });
              return { meta: { changes: 1 } };
            }

            if (/INSERT INTO api_idempotency_keys /i.test(text)) {
              const [apiKeyId, operation, keyHash, requestHash, resourceId] = args;
              const duplicate = db.idempotency.some(row =>
                row.api_key_id === Number(apiKeyId) &&
                row.operation === operation &&
                row.key_hash === keyHash
              );
              if (duplicate) throw new Error('UNIQUE constraint failed: api_idempotency_keys');
              db.idempotency.push({
                id: db.idempotency.length + 1,
                api_key_id: Number(apiKeyId),
                operation,
                key_hash: keyHash,
                request_hash: requestHash,
                resource_id: resourceId,
                created_at: '2026-10-11 12:00:00'
              });
              return { meta: { changes: 1 } };
            }

            if (/INSERT INTO api_audit_logs /i.test(text)) {
              const [apiKeyId, action, resourceType, resourceId, status, metadataJson] = args;
              db.audit.push({ apiKeyId, action, resourceType, resourceId, status, metadataJson });
              return { meta: { changes: 1 } };
            }

            if (/DELETE FROM api_idempotency_keys/i.test(text)) {
              const [apiKeyId, resourceId] = args;
              const before = db.idempotency.length;
              db.idempotency = db.idempotency.filter(row =>
                !(row.api_key_id === Number(apiKeyId) && row.resource_id === resourceId)
              );
              return { meta: { changes: before - db.idempotency.length } };
            }

            if (/DELETE FROM messages/i.test(text)) {
              const [mailboxId] = args;
              const before = db.messages.length;
              db.messages = db.messages.filter(row => row.mailbox_id !== Number(mailboxId));
              return { meta: { changes: before - db.messages.length } };
            }

            if (/DELETE FROM user_mailboxes/i.test(text)) {
              return { meta: { changes: 0 } };
            }

            if (/DELETE FROM api_mailboxes/i.test(text)) {
              const [mailboxId] = args;
              const before = db.apiMailboxes.length;
              db.apiMailboxes = db.apiMailboxes.filter(row => row.mailbox_id !== Number(mailboxId));
              return { meta: { changes: before - db.apiMailboxes.length } };
            }

            if (/DELETE FROM mailboxes/i.test(text)) {
              const [mailboxId] = args;
              const before = db.mailboxes.length;
              db.mailboxes = db.mailboxes.filter(row => row.id !== Number(mailboxId));
              return { meta: { changes: before - db.mailboxes.length } };
            }

            return { meta: { changes: 0 } };
          },

          async first() {
            if (/FROM mailboxes WHERE address = \?/i.test(text)) {
              const [address] = args;
              return db.mailboxes.find(row => row.address === address) || null;
            }

            if (/FROM api_mailboxes am JOIN mailboxes m/i.test(text)) {
              const [resourceId, apiKeyId] = args;
              const mapping = db.apiMailboxes.find(row =>
                row.resource_id === resourceId && row.api_key_id === Number(apiKeyId)
              );
              if (!mapping) return null;
              const mailbox = db.mailboxes.find(row => row.id === mapping.mailbox_id);
              if (!mailbox) return null;
              return {
                resource_id: mapping.resource_id,
                mailbox_id: mailbox.id,
                address: mailbox.address,
                created_at: mailbox.created_at,
                expires_at: mailbox.expires_at
              };
            }

            if (/FROM api_idempotency_keys/i.test(text)) {
              const [apiKeyId, operation, keyHash] = args;
              return db.idempotency.find(row =>
                row.api_key_id === Number(apiKeyId) &&
                row.operation === operation &&
                row.key_hash === keyHash
              ) || null;
            }

            if (/FROM messages msg JOIN api_mailboxes am/i.test(text)) {
              const [messageId, apiKeyId] = args;
              const message = db.messages.find(row => row.id === Number(messageId));
              if (!message) return null;
              const mapping = db.apiMailboxes.find(row =>
                row.mailbox_id === message.mailbox_id && row.api_key_id === Number(apiKeyId)
              );
              if (!mapping) return null;
              return { ...message, mailbox_resource_id: mapping.resource_id };
            }

            return null;
          },

          async all() {
            if (/SELECT r2_object_key FROM messages/i.test(text)) {
              const [mailboxId] = args;
              return {
                results: db.messages
                  .filter(row => row.mailbox_id === Number(mailboxId) && row.r2_object_key)
                  .map(row => ({ r2_object_key: row.r2_object_key }))
              };
            }

            if (/FROM api_mailboxes am JOIN messages msg/i.test(text)) {
              const [resourceId, apiKeyId, afterId, limit] = args;
              const mapping = db.apiMailboxes.find(row =>
                row.resource_id === resourceId && row.api_key_id === Number(apiKeyId)
              );
              if (!mapping) return { results: [] };
              const results = db.messages
                .filter(row => row.mailbox_id === mapping.mailbox_id && row.id > Number(afterId))
                .sort((a, b) => b.id - a.id)
                .slice(0, Number(limit))
                .map(row => ({
                  id: row.id,
                  sender: row.sender,
                  to_addrs: row.to_addrs,
                  subject: row.subject,
                  verification_code: row.verification_code,
                  preview: row.preview,
                  received_at: row.received_at,
                  is_read: row.is_read
                }));
              return { results };
            }
            return { results: [] };
          }
        };
      }
    };
  }
}

async function main() {
  const db = new FakeMcpDb();
  const rawEml = 'From: sender@example.com\r\nTo: agent@tgcorexzone.com\r\nSubject: Example\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello https://example.com/verify\r\n';
  const handler = createMailMcpHandler({
    db,
    r2: {
      async get(key) {
        if (key !== 'test/message.eml') return null;
        return { async text() { return rawEml; } };
      },
      async delete() {}
    },
    env: { MAIL_DOMAIN: 'tgcorexzone.com' },
    apiKey: {
      id: 1,
      name: 'mcp-test',
      scopes: 'mailboxes:read,mailboxes:write,messages:read',
      enabled: 1
    }
  });

  const client = new Client(
    { name: 'freemail-test-client', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } }
  );
  const transport = new StreamableHTTPClientTransport(new URL('https://mcp.test/mcp'), {
    fetch: (input, init) => handler.fetch(new Request(input, init))
  });

  await client.connect(transport);
  assert(client.getProtocolEra() === 'modern', '应通过 server/discover 协商到 2026 modern era');
  assert(client.getServerVersion()?.name === 'freemail', 'MCP serverInfo 应为 freemail');

  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  const expected = [
    'mail_create_inbox',
    'mail_get_message',
    'mail_release_inbox',
    'mail_wait_for_code',
    'mail_wait_for_link',
    'mail_wait_for_message'
  ].sort();
  assert(JSON.stringify(names) === JSON.stringify(expected), 'tools/list 应精确返回 6 个邮件工具');

  const first = await client.callTool({
    name: 'mail_create_inbox',
    arguments: { ttl: 600, idempotency_key: 'mcp-protocol-test-001' }
  });
  assert(first.isError !== true, '首次创建不应失败');
  const mailboxId = first.structuredContent?.id;
  assert(typeof mailboxId === 'string' && mailboxId.startsWith('mb_'), '应返回 mb_ 邮箱资源 ID');
  assert(first.structuredContent?.replayed === false, '首次创建 replayed 应为 false');

  const replay = await client.callTool({
    name: 'mail_create_inbox',
    arguments: { ttl: 600, idempotency_key: 'mcp-protocol-test-001' }
  });
  assert(replay.structuredContent?.id === mailboxId, '相同幂等键应返回同一邮箱');
  assert(replay.structuredContent?.replayed === true, '第二次创建应标记 replayed');
  assert(db.mailboxes.length === 1, '幂等重试不能重复创建 mailboxes 行');

  const mailboxRow = db.mailboxes[0];
  db.messages.push({
    id: 1,
    mailbox_id: mailboxRow.id,
    sender: 'sender@example.com',
    to_addrs: mailboxRow.address,
    subject: 'Example message',
    verification_code: '654321',
    preview: 'Example message 654321',
    r2_object_key: 'test/message.eml',
    received_at: '2026-10-11 12:00:05',
    is_read: 0
  });

  const waitedMail = await client.callTool({
    name: 'mail_wait_for_message',
    arguments: { mailbox_id: mailboxId, timeout: 0 }
  });
  assert(waitedMail.structuredContent?.matched === true, 'mail_wait_for_message 应命中邮件');
  assert(waitedMail.structuredContent?.content_trust === 'untrusted_external', '邮件结果必须标记 untrusted_external');

  const waitedCode = await client.callTool({
    name: 'mail_wait_for_code',
    arguments: { mailbox_id: mailboxId, timeout: 0 }
  });
  assert(waitedCode.structuredContent?.code === '654321', 'mail_wait_for_code 应直接返回结构化数字码');

  const waitedLink = await client.callTool({
    name: 'mail_wait_for_link',
    arguments: { mailbox_id: mailboxId, timeout: 0 }
  });
  assert(waitedLink.structuredContent?.link === 'https://example.com/verify', 'mail_wait_for_link 应提取链接');

  const message = await client.callTool({
    name: 'mail_get_message',
    arguments: { message_id: 1 }
  });
  assert(message.structuredContent?.verification_code === '654321', 'mail_get_message 应返回数字码元数据');
  assert(String(message.structuredContent?.text || '').includes('https://example.com/verify'), 'mail_get_message 应解析 R2 EML 正文');
  assert(message.structuredContent?.content_trust === 'untrusted_external', '完整邮件也必须标记 untrusted_external');

  const released = await client.callTool({
    name: 'mail_release_inbox',
    arguments: { mailbox_id: mailboxId }
  });
  assert(released.structuredContent?.released === true, 'release 应成功');
  assert(db.mailboxes.length === 0, 'release 应删除 mailbox');
  assert(db.apiMailboxes.length === 0, 'release 应删除 api_mailboxes 映射');
  assert(db.idempotency.length === 0, 'release 应清理幂等记录');
  assert(db.messages.length === 0, 'release 应删除邮件元数据');
  assert(db.audit.some(row => row.action === 'mailbox.create'), '应记录 mailbox.create 审计');
  assert(db.audit.some(row => row.action === 'messages.wait'), '应记录 messages.wait 审计');
  assert(db.audit.some(row => row.action === 'message.get'), '应记录 message.get 审计');
  assert(db.audit.some(row => row.action === 'mailbox.release'), '应记录 mailbox.release 审计');

  await transport.close();
  console.log('✓ PASS  MCP 2026 modern 协商、tools/list 与 6 个邮件工具全链路');
}

await main();
