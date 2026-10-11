/**
 * RFC 2047 邮件主题解码测试
 *
 * 验证收件解析层返回的是可直接写入 D1 / 展示给用户的主题，
 * 而不是原始的 encoded-word Header。
 */

import { parseEmailBody } from '../email/parser.js';

const TESTS = [
  {
    label: 'UTF-8 Base64 中文主题',
    raw: [
      'From: sender@example.com',
      'To: receiver@example.com',
      'Subject: =?utf-8?B?5L2g5aW9?=',
      'Content-Type: text/plain; charset=utf-8',
      '',
      '你好',
    ].join('\r\n'),
    expectedSubject: '你好',
    expectedText: '你好',
  },
  {
    label: 'UTF-8 Q 编码中文主题',
    raw: [
      'From: sender@example.com',
      'To: receiver@example.com',
      'Subject: =?UTF-8?Q?=E6=B5=8B=E8=AF=95?=',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'body',
    ].join('\r\n'),
    expectedSubject: '测试',
    expectedText: 'body',
  },
];

let failed = 0;

for (const test of TESTS) {
  const parsed = await parseEmailBody(test.raw);
  const ok = parsed.subject === test.expectedSubject && parsed.text?.trim() === test.expectedText;

  if (ok) {
    console.log(`✓ PASS  ${test.label}: ${parsed.subject}`);
  } else {
    failed++;
    console.error(`✗ FAIL  ${test.label}`);
    console.error(`  subject: expected=${JSON.stringify(test.expectedSubject)} actual=${JSON.stringify(parsed.subject)}`);
    console.error(`  text:    expected=${JSON.stringify(test.expectedText)} actual=${JSON.stringify(parsed.text?.trim())}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
