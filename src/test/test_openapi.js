import { buildOpenApiSpec } from '../openapi/spec.js';
import { renderApiDocsHtml } from '../routes/docs.js';

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

await test('OpenAPI 文档覆盖 Mail API V1 核心路由', async () => {
  const spec = buildOpenApiSpec('https://email.tgcorexzone.com');
  assert(spec.openapi === '3.0.3', '应输出 OpenAPI 3.0.3');
  assert(spec.servers?.[0]?.url === 'https://email.tgcorexzone.com', 'production server URL 应正确');

  const expected = [
    '/api/v1/mailboxes',
    '/api/v1/mailboxes/{id}',
    '/api/v1/mailboxes/{id}/renew',
    '/api/v1/mailboxes/{id}/release',
    '/api/v1/mailboxes/{id}/messages',
    '/api/v1/mailboxes/{id}/wait',
    '/api/v1/messages/{id}',
    '/api/v1/admin/api-keys',
    '/api/v1/admin/api-keys/{id}',
    '/api/v1/admin/audit-logs'
  ];
  for (const path of expected) {
    assert(spec.paths[path], `缺少 OpenAPI path: ${path}`);
  }
});

await test('OpenAPI 明确 Bearer API Key 与幂等语义', async () => {
  const spec = buildOpenApiSpec();
  const bearer = spec.components?.securitySchemes?.ApiKeyBearer;
  assert(bearer?.type === 'http' && bearer?.scheme === 'bearer', '应定义 HTTP Bearer 安全方案');
  assert(bearer?.bearerFormat === 'fm_live_*', '应标明 fm_live_* API Key');

  const create = spec.paths['/api/v1/mailboxes'].post;
  const idempotency = create.parameters.find(item => item.name === 'Idempotency-Key');
  assert(idempotency?.in === 'header', '创建邮箱应文档化 Idempotency-Key header');
  assert(create.responses['200']?.headers?.['Idempotency-Replayed'], '应文档化幂等重放响应头');
  assert(create.responses['409'], '应文档化幂等冲突 409');
});

await test('wait 接口完整描述 mail/code/link 与 25 秒上限', async () => {
  const spec = buildOpenApiSpec();
  const wait = spec.paths['/api/v1/mailboxes/{id}/wait'].get;
  const type = wait.parameters.find(item => item.name === 'for');
  const timeout = wait.parameters.find(item => item.name === 'timeout');
  assert(JSON.stringify(type?.schema?.enum) === JSON.stringify(['mail', 'code', 'link']), 'wait for enum 应完整');
  assert(timeout?.schema?.maximum === 25, 'wait timeout 最大值应为 25');
  assert(String(wait.description).includes('for=code'), '应说明 code 模式只匹配验证码邮件');
});

await test('OpenAPI server 只使用当前请求 origin，忽略路径与恶意字符串', async () => {
  const local = buildOpenApiSpec('http://127.0.0.1:8788/docs');
  assert(local.servers[0].url === 'http://127.0.0.1:8788', '应只保留 URL origin');
  const fallback = buildOpenApiSpec('not a url');
  assert(fallback.servers[0].url === 'https://email.tgcorexzone.com', '无效 URL 应回退生产 origin');
});

await test('Swagger UI 页面公开 OpenAPI JSON 且不持久化敏感授权', async () => {
  const html = renderApiDocsHtml();
  assert(html.includes('SwaggerUIBundle'), '应加载 Swagger UI');
  assert(html.includes("url: '/openapi.json'"), 'Swagger UI 应读取 /openapi.json');
  assert(html.includes('persistAuthorization: false'), '公开文档不应跨刷新持久化 API Key');
  assert(html.includes('withCredentials: true'), '同源管理员调试应允许携带会话 Cookie');
  assert(html.includes('OpenAPI JSON'), '页面应提供规范原始 JSON 链接');
});

console.log(`\n总计: ${passed} 项通过`);
