/**
 * API Key 数据访问层。
 * D1 只保存 SHA-256 哈希，明文 Key 仅在创建时返回一次。
 */

import { sha256Hex } from '../utils/common.js';

function randomBase64Url(byteLength = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function extractBearerToken(request) {
  const auth = request?.headers?.get('Authorization') || request?.headers?.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice(7).trim();
}

export function parseScopes(value) {
  return String(value || '')
    .split(/[\s,]+/)
    .map(v => v.trim())
    .filter(Boolean);
}

export function hasScope(apiKey, requiredScope) {
  if (!requiredScope) return true;
  const scopes = new Set(parseScopes(apiKey?.scopes));
  return scopes.has('*') || scopes.has(requiredScope);
}

export async function createApiKey(db, {
  name,
  scopes = 'mailboxes:read,mailboxes:write,messages:read',
  expiresAt = null
}) {
  const cleanName = String(name || '').trim();
  if (!cleanName) throw new Error('API Key 名称不能为空');

  const rawKey = `fm_live_${randomBase64Url(32)}`;
  const keyHash = await sha256Hex(rawKey);
  const keyPrefix = rawKey.slice(0, 18);
  const normalizedScopes = parseScopes(scopes).join(',') || 'mailboxes:read,mailboxes:write,messages:read';

  await db.prepare(`
    INSERT INTO api_keys (name, key_prefix, key_hash, scopes, expires_at, enabled)
    VALUES (?, ?, ?, ?, ?, 1)
  `).bind(cleanName, keyPrefix, keyHash, normalizedScopes, expiresAt || null).run();

  const row = await db.prepare(`
    SELECT id, name, key_prefix, scopes, created_at, expires_at, enabled
    FROM api_keys WHERE key_hash = ? LIMIT 1
  `).bind(keyHash).first();

  return { ...row, key: rawKey };
}

export async function authenticateApiKey(db, request) {
  const rawKey = extractBearerToken(request);
  if (!rawKey || !rawKey.startsWith('fm_live_')) return null;

  const keyHash = await sha256Hex(rawKey);
  const row = await db.prepare(`
    SELECT id, name, key_prefix, scopes, created_at, last_used_at, expires_at, enabled
    FROM api_keys
    WHERE key_hash = ? AND enabled = 1
    LIMIT 1
  `).bind(keyHash).first();

  if (!row) return null;
  if (row.expires_at) {
    const expiresAt = Date.parse(row.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) return null;
  }

  await db.prepare('UPDATE api_keys SET last_used_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(row.id).run();
  return row;
}

export async function listApiKeys(db) {
  const result = await db.prepare(`
    SELECT id, name, key_prefix, scopes, created_at, last_used_at, expires_at, enabled
    FROM api_keys
    ORDER BY id DESC
  `).all();
  return result?.results || [];
}

export async function revokeApiKey(db, id) {
  const keyId = Number(id || 0);
  if (!keyId) return false;
  const result = await db.prepare('UPDATE api_keys SET enabled = 0 WHERE id = ?').bind(keyId).run();
  return Number(result?.meta?.changes || 0) > 0;
}

