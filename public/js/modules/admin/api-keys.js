/**
 * API Key 管理界面渲染辅助。
 * @module modules/admin/api-keys
 */

import { escapeHtml, escapeAttr } from '../app/ui-helpers.js';

export function formatApiKeyTime(value) {
  if (!value) return '—';
  try {
    let raw = String(value).trim();
    if (!/[zZ]$|[+-]\d\d:\d\d$/.test(raw)) {
      raw = raw.includes('T') ? `${raw}Z` : `${raw.replace(' ', 'T')}Z`;
    }
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) return String(value);
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch (_) {
    return String(value);
  }
}

function renderScopes(scopes) {
  const items = String(scopes || '')
    .split(/[\s,]+/)
    .map(v => v.trim())
    .filter(Boolean);
  if (!items.length) return '<span class="api-key-muted">—</span>';
  return `<div class="api-key-scopes">${items.map(scope => `<span class="api-key-scope">${escapeHtml(scope)}</span>`).join('')}</div>`;
}

export function renderApiKeyRow(item) {
  const enabled = Number(item.enabled) === 1;
  const expired = item.expires_at && Date.parse(item.expires_at) <= Date.now();
  const status = !enabled ? '已撤销' : (expired ? '已过期' : '有效');
  const statusClass = !enabled ? 'is-revoked' : (expired ? 'is-expired' : 'is-active');
  const id = Number(item.id || 0);

  return `
    <tr>
      <td class="api-key-name-cell">${escapeHtml(item.name || '')}</td>
      <td><code class="api-key-prefix">${escapeHtml(item.key_prefix || '')}</code></td>
      <td>${renderScopes(item.scopes)}</td>
      <td class="api-key-time">${escapeHtml(formatApiKeyTime(item.created_at))}</td>
      <td class="api-key-time">${escapeHtml(formatApiKeyTime(item.last_used_at))}</td>
      <td class="api-key-time">${escapeHtml(formatApiKeyTime(item.expires_at))}</td>
      <td><span class="api-key-status ${statusClass}">${status}</span></td>
      <td>
        <button class="btn btn-sm btn-danger-outline api-key-revoke" data-api-key-id="${escapeAttr(String(id))}" ${enabled ? '' : 'disabled'}>
          撤销
        </button>
      </td>
    </tr>
  `;
}

export function renderApiKeyList(items, tbody) {
  if (!tbody) return;
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state api-key-empty">还没有 API Key，点击右上角创建一个。</td></tr>';
    return;
  }
  tbody.innerHTML = list.map(renderApiKeyRow).join('');
}

export default {
  formatApiKeyTime,
  renderApiKeyRow,
  renderApiKeyList
};
