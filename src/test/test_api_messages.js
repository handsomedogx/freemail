/**
 * Mail API V1 第二阶段：邮件读取辅助、链接提取与等待语义测试。
 */

import {
  extractLinks,
  matchesMessageFilter,
  normalizeWaitOptions,
  waitForApiMessage
} from '../db/apiMessages.js';

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

await test('链接提取仅返回 HTTP/HTTPS 并去重', async () => {
  const links = extractLinks({
    text: 'Open https://example.com/verify?id=1 and https://example.com/verify?id=1.',
    html: '<a href="https://example.org/a?x=1&amp;y=2">ok</a><a href="javascript:alert(1)">bad</a>'
  });
  assert(links.includes('https://example.com/verify?id=1'), '缺少文本链接');
  assert(links.includes('https://example.org/a?x=1&y=2'), '缺少 HTML href 链接');
  assert(links.filter(v => v === 'https://example.com/verify?id=1').length === 1, '链接未去重');
  assert(!links.some(v => v.startsWith('javascript:')), '不应返回 javascript 链接');
});

await test('邮件筛选支持发件人、域名和主题', async () => {
  const message = { sender: 'noreply@mail.accounts.example.com', subject: 'Your Login Code' };
  assert(matchesMessageFilter(message, { from: 'noreply' }), 'from 筛选失败');
  assert(matchesMessageFilter(message, { fromDomain: 'example.com' }), '父域筛选失败');
  assert(matchesMessageFilter(message, { subjectContains: 'login' }), '主题筛选失败');
  assert(!matchesMessageFilter(message, { fromDomain: 'evil.test' }), '错误域名不应匹配');
});

await test('等待参数有明确上限', async () => {
  const opts = normalizeWaitOptions({ type: 'code', timeoutSeconds: 999, intervalMs: 5 });
  assert(opts.type === 'code', '等待类型错误');
  assert(opts.timeoutSeconds === 25, '单次等待必须限制为 25 秒');
  assert(opts.intervalMs === 250, '轮询间隔必须限制最小值');
});

await test('wait_for_code 直接返回结构化验证码而不需要正文', async () => {
  const result = await waitForApiMessage({
    type: 'code',
    timeoutSeconds: 0,
    listMessages: async () => [{
      id: 7,
      sender: 'noreply@example.com',
      subject: 'Verification code',
      verification_code: '123456',
      content_trust: 'untrusted_external'
    }],
    loadDetail: async () => null
  });
  assert(result.matched === true, '应该匹配验证码');
  assert(result.code === '123456', '验证码错误');
  assert(result.message.id === 7, '邮件 ID 错误');
});

await test('wait_for_link 返回提取后的链接', async () => {
  const result = await waitForApiMessage({
    type: 'link',
    timeoutSeconds: 0,
    listMessages: async () => [{ id: 8, sender: 'noreply@example.com', subject: 'Verify' }],
    loadDetail: async () => ({
      id: 8,
      links: ['https://example.com/verify/abc'],
      content_trust: 'untrusted_external'
    })
  });
  assert(result.matched === true, '应该匹配链接');
  assert(result.link === 'https://example.com/verify/abc', '链接错误');
});

await test('等待会轮询后命中，并在超时时返回结构化结果', async () => {
  let fakeNow = 0;
  let calls = 0;
  const hit = await waitForApiMessage({
    type: 'mail',
    timeoutSeconds: 2,
    intervalMs: 500,
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    listMessages: async () => {
      calls++;
      return calls >= 3 ? [{ id: 9, sender: 'a@example.com', subject: 'Hello' }] : [];
    },
    loadDetail: async () => null
  });
  assert(hit.matched === true && hit.message.id === 9, '轮询后应命中邮件');
  assert(calls === 3, '轮询次数不符合预期');

  fakeNow = 0;
  const timeout = await waitForApiMessage({
    type: 'mail',
    timeoutSeconds: 1,
    intervalMs: 500,
    now: () => fakeNow,
    sleep: async (ms) => { fakeNow += ms; },
    listMessages: async () => [],
    loadDetail: async () => null
  });
  assert(timeout.matched === false && timeout.timeout === true, '超时结果错误');
  assert(timeout.waited_ms === 1000, '超时时间错误');
});

console.log(`\n总计: ${passed} 项通过`);

