/**
 * API V1 运行辅助：幂等键与审计日志。
 * 明文 Idempotency-Key 不落库，仅保存 SHA-256。
 */

import { sha256Hex } from '../utils/common.js';

export function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (!key) return '';
  if (key.length > 200) throw new Error('Idempotency-Key 最长 200 个字符');
  if (/[\u0000-\u001f\u007f]/.test(key)) throw new Error('Idempotency-Key 包含非法控制字符');
  return key;
}

export async function fingerprintIdempotentRequest(value) {
  return sha256Hex(JSON.stringify(value ?? null));
}

async function idempotencyKeyHash(key) {
  return sha256Hex(normalizeIdempotencyKey(key));
}

export async function getIdempotencyRecord(db, {
  apiKeyId,
  operation,
  key
}) {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return null;
  const keyHash = await idempotencyKeyHash(normalized);
  return await db.prepare(`
    SELECT id, api_key_id, operation, key_hash, request_hash, resource_id, created_at
    FROM api_idempotency_keys
    WHERE api_key_id = ? AND operation = ? AND key_hash = ?
    LIMIT 1
  `).bind(Number(apiKeyId), String(operation || ''), keyHash).first();
}

export async function saveIdempotencyResult(db, {
  apiKeyId,
  operation,
  key,
  requestHash,
  resourceId
}) {
  const normalized = normalizeIdempotencyKey(key);
  if (!normalized) return null;
  const keyHash = await idempotencyKeyHash(normalized);
  await db.prepare(`
    INSERT INTO api_idempotency_keys (
      api_key_id, operation, key_hash, request_hash, resource_id
    ) VALUES (?, ?, ?, ?, ?)
  `).bind(
    Number(apiKeyId),
    String(operation || ''),
    keyHash,
    String(requestHash || ''),
    String(resourceId || '')
  ).run();
  return { key_hash: keyHash, request_hash: requestHash, resource_id: resourceId };
}

export async function deleteIdempotencyForResource(db, { apiKeyId, resourceId }) {
  const result = await db.prepare(`
    DELETE FROM api_idempotency_keys
    WHERE api_key_id = ? AND resource_id = ?
  `).bind(Number(apiKeyId), String(resourceId || '')).run();
  return Number(result?.meta?.changes || 0);
}

function safeMetadata(metadata) {
  if (metadata == null) return null;
  let text;
  try {
    text = JSON.stringify(metadata);
  } catch (_) {
    text = JSON.stringify({ note: 'metadata_not_serializable' });
  }
  if (text.length <= 4096) return text;
  return JSON.stringify({ truncated: true, preview: text.slice(0, 3000) });
}

export async function writeApiAuditLog(db, {
  apiKeyId,
  action,
  resourceType = null,
  resourceId = null,
  status = 'success',
  metadata = null
}) {
  await db.prepare(`
    INSERT INTO api_audit_logs (
      api_key_id, action, resource_type, resource_id, status, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).bind(
    apiKeyId == null ? null : Number(apiKeyId),
    String(action || ''),
    resourceType == null ? null : String(resourceType),
    resourceId == null ? null : String(resourceId),
    String(status || 'success'),
    safeMetadata(metadata)
  ).run();
}

export async function safeWriteApiAuditLog(db, entry) {
  try {
    await writeApiAuditLog(db, entry);
    return true;
  } catch (error) {
    console.error('API audit log write failed:', {
      action: entry?.action,
      message: String(error?.message || error || 'unknown audit error')
    });
    return false;
  }
}

export async function listApiAuditLogs(db, {
  limit = 100,
  apiKeyId = null,
  action = ''
} = {}) {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const filters = [];
  const args = [];
  if (apiKeyId != null && Number(apiKeyId) > 0) {
    filters.push('l.api_key_id = ?');
    args.push(Number(apiKeyId));
  }
  if (String(action || '').trim()) {
    filters.push('l.action = ?');
    args.push(String(action).trim());
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const result = await db.prepare(`
    SELECT l.id, l.api_key_id, k.name AS api_key_name, l.action,
           l.resource_type, l.resource_id, l.status, l.metadata_json, l.created_at
    FROM api_audit_logs l
    LEFT JOIN api_keys k ON k.id = l.api_key_id
    ${where}
    ORDER BY l.id DESC
    LIMIT ?
  `).bind(...args, safeLimit).all();

  return (result?.results || []).map(row => {
    let metadata = null;
    try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch (_) { }
    const { metadata_json, ...rest } = row;
    return { ...rest, metadata };
  });
}
