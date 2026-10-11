/**
 * API V1 邮件读取与 Agent 友好提取能力。
 */

import { parseEmailBody } from '../email/parser.js';

function clampLimit(value, fallback = 20, max = 100) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

export async function listApiMessages(db, {
  apiKeyId,
  resourceId,
  limit = 20,
  afterId = 0
}) {
  const safeLimit = clampLimit(limit, 20, 100);
  const safeAfterId = Math.max(0, Math.floor(Number(afterId) || 0));
  const result = await db.prepare(`
    SELECT msg.id, msg.sender, msg.to_addrs, msg.subject, msg.verification_code,
           msg.preview, msg.received_at, msg.is_read
    FROM api_mailboxes am
    JOIN messages msg ON msg.mailbox_id = am.mailbox_id
    WHERE am.resource_id = ? AND am.api_key_id = ? AND msg.id > ?
    ORDER BY msg.id DESC
    LIMIT ?
  `).bind(String(resourceId || ''), Number(apiKeyId), safeAfterId, safeLimit).all();

  return (result?.results || []).map(row => ({
    ...row,
    content_trust: 'untrusted_external'
  }));
}

export async function getApiMessageMetadata(db, { apiKeyId, messageId }) {
  const id = Number(messageId || 0);
  if (!Number.isInteger(id) || id <= 0) return null;

  const row = await db.prepare(`
    SELECT msg.id, msg.sender, msg.to_addrs, msg.subject, msg.verification_code,
           msg.preview, msg.r2_object_key, msg.received_at, msg.is_read,
           am.resource_id AS mailbox_resource_id
    FROM messages msg
    JOIN api_mailboxes am ON am.mailbox_id = msg.mailbox_id
    WHERE msg.id = ? AND am.api_key_id = ?
    LIMIT 1
  `).bind(id, Number(apiKeyId)).first();

  return row || null;
}

async function readRawMessage(r2, objectKey) {
  if (!r2 || !objectKey) return '';
  const obj = await r2.get(objectKey);
  if (!obj) return '';
  if (typeof obj.text === 'function') return await obj.text();
  if (typeof obj.arrayBuffer === 'function') {
    return new TextDecoder().decode(await obj.arrayBuffer());
  }
  return await new Response(obj.body).text();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

export function extractLinks({ text = '', html = '' } = {}) {
  const urls = new Set();
  const add = (candidate) => {
    const cleaned = decodeHtmlEntities(candidate).trim().replace(/[),.;!?]+$/g, '');
    if (!/^https?:\/\//i.test(cleaned)) return;
    try {
      const url = new URL(cleaned);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.add(url.toString());
    } catch (_) { }
  };

  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  for (const match of String(html || '').matchAll(hrefRe)) add(match[1]);

  const urlRe = /https?:\/\/[^\s<>"']+/gi;
  for (const match of String(text || '').matchAll(urlRe)) add(match[0]);
  for (const match of String(html || '').matchAll(urlRe)) add(match[0]);

  return Array.from(urls);
}

export async function getApiMessageDetail(db, r2, { apiKeyId, messageId }) {
  const row = await getApiMessageMetadata(db, { apiKeyId, messageId });
  if (!row) return null;

  let text = '';
  let html = '';
  if (row.r2_object_key) {
    try {
      const raw = await readRawMessage(r2, row.r2_object_key);
      if (raw) {
        const parsed = await parseEmailBody(raw);
        text = parsed.text || '';
        html = parsed.html || '';
      }
    } catch (_) { }
  }

  return {
    id: row.id,
    mailbox_id: row.mailbox_resource_id,
    sender: row.sender,
    to_addrs: row.to_addrs,
    subject: row.subject,
    verification_code: row.verification_code || null,
    preview: row.preview || '',
    received_at: row.received_at,
    is_read: row.is_read,
    text,
    html,
    links: extractLinks({ text, html }),
    content_trust: 'untrusted_external'
  };
}

export function matchesMessageFilter(message, {
  from = '',
  fromDomain = '',
  subjectContains = ''
} = {}) {
  const sender = String(message?.sender || '').toLowerCase();
  const subject = String(message?.subject || '').toLowerCase();
  const wantedFrom = String(from || '').trim().toLowerCase();
  const wantedDomain = String(fromDomain || '').trim().toLowerCase().replace(/^@/, '');
  const wantedSubject = String(subjectContains || '').trim().toLowerCase();

  if (wantedFrom && !sender.includes(wantedFrom)) return false;
  if (wantedDomain) {
    const domain = sender.includes('@') ? sender.split('@').pop() : sender;
    if (domain !== wantedDomain && !domain.endsWith(`.${wantedDomain}`)) return false;
  }
  if (wantedSubject && !subject.includes(wantedSubject)) return false;
  return true;
}

export function normalizeWaitOptions({ type, timeoutSeconds, intervalMs } = {}) {
  const allowed = new Set(['mail', 'code', 'link']);
  const normalizedType = allowed.has(String(type || '').toLowerCase())
    ? String(type).toLowerCase()
    : 'mail';
  const timeout = Number(timeoutSeconds);
  const interval = Number(intervalMs);
  return {
    type: normalizedType,
    timeoutSeconds: Number.isFinite(timeout) ? Math.max(0, Math.min(25, timeout)) : 20,
    intervalMs: Number.isFinite(interval) ? Math.max(250, Math.min(5000, Math.floor(interval))) : 1000
  };
}

async function defaultSleep(ms) {
  if (globalThis.scheduler && typeof globalThis.scheduler.wait === 'function') {
    await globalThis.scheduler.wait(ms);
    return;
  }
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForApiMessage({
  listMessages,
  loadDetail,
  type = 'mail',
  timeoutSeconds = 20,
  intervalMs = 1000,
  filters = {},
  sleep = defaultSleep,
  now = () => Date.now()
}) {
  const opts = normalizeWaitOptions({ type, timeoutSeconds, intervalMs });
  const startedAt = now();
  const deadline = startedAt + opts.timeoutSeconds * 1000;
  const inspectedForLinks = new Set();

  while (true) {
    const messages = await listMessages();
    for (const message of messages || []) {
      if (!matchesMessageFilter(message, filters)) continue;

      if (opts.type === 'mail') {
        return {
          matched: true,
          type: 'mail',
          waited_ms: Math.max(0, now() - startedAt),
          message
        };
      }

      if (opts.type === 'code' && message.verification_code) {
        return {
          matched: true,
          type: 'code',
          waited_ms: Math.max(0, now() - startedAt),
          code: String(message.verification_code),
          message
        };
      }

      if (opts.type === 'link' && !inspectedForLinks.has(message.id)) {
        inspectedForLinks.add(message.id);
        const detail = await loadDetail(message.id);
        const links = detail?.links || [];
        if (links.length) {
          return {
            matched: true,
            type: 'link',
            waited_ms: Math.max(0, now() - startedAt),
            link: links[0],
            links,
            message: detail
          };
        }
      }
    }

    const current = now();
    if (current >= deadline) {
      return {
        matched: false,
        timeout: true,
        type: opts.type,
        waited_ms: Math.max(0, current - startedAt)
      };
    }

    await sleep(Math.min(opts.intervalMs, Math.max(0, deadline - current)));
  }
}

