/**
 * 管理员 API 模块
 * @module modules/admin/api
 */

import { mockApi } from '../app/mock-api.js';

/**
 * API 请求封装
 * @param {string} path - API 路径
 * @param {object} options - fetch 选项
 * @returns {Promise<Response>}
 */
export async function api(path, options = {}) {
  // Guest 模式使用 mock API
  if (window.__GUEST_MODE__) {
    return mockApi(path, options);
  }
  
  const r = await fetch(path, {
    ...options,
    headers: { 'Cache-Control': 'no-cache', ...options.headers }
  });
  if (r.status === 401) {
    location.replace('/html/login.html');
    throw new Error('unauthorized');
  }
  return r;
}

/**
 * 获取用户列表
 * @param {object} params - 查询参数
 * @returns {Promise<object>}
 */
export async function getUsers(params = {}) {
  const query = new URLSearchParams();
  if (params.page) query.set('page', params.page);
  if (params.size) query.set('size', params.size);
  const r = await api(`/api/users?${query.toString()}`);
  return r.json();
}

/**
 * 创建用户
 * @param {object} data - 用户数据
 * @returns {Promise<Response>}
 */
export async function createUser(data) {
  return api('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

/**
 * 更新用户
 * @param {number} id - 用户 ID
 * @param {object} data - 更新数据
 * @returns {Promise<Response>}
 */
export async function updateUser(id, data) {
  return api(`/api/users/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

/**
 * 删除用户
 * @param {number} id - 用户 ID
 * @returns {Promise<Response>}
 */
export async function deleteUser(id) {
  return api(`/api/users/${id}`, { method: 'DELETE' });
}

/**
 * 获取用户邮箱列表
 * @param {number} userId - 用户 ID
 * @param {object} params - 查询参数
 * @returns {Promise<object>}
 */
export async function getUserMailboxes(userId, params = {}) {
  const query = new URLSearchParams();
  if (params.page) query.set('page', params.page);
  if (params.size) query.set('size', params.size);
  const r = await api(`/api/users/${userId}/mailboxes?${query.toString()}`);
  return r.json();
}

/**
 * 分配邮箱给用户
 * @param {string} username - 用户名
 * @param {string} address - 邮箱地址
 * @returns {Promise<Response>}
 */
export async function assignMailbox(username, address) {
  return api('/api/users/assign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, address })
  });
}

/**
 * 取消分配邮箱
 * @param {string} username - 用户名
 * @param {string} address - 邮箱地址
 * @returns {Promise<Response>}
 */
export async function unassignMailbox(username, address) {
  return api('/api/users/unassign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, address })
  });
}

async function readJsonOrThrow(response) {
  let data = null;
  try { data = await response.json(); } catch (_) { }
  if (!response.ok) {
    const message = data?.error?.message || data?.error || `请求失败 (${response.status})`;
    throw new Error(message);
  }
  return data;
}

export async function getApiKeys() {
  const response = await api('/api/v1/admin/api-keys');
  return readJsonOrThrow(response);
}

export async function createApiKey(data) {
  const response = await api('/api/v1/admin/api-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  return readJsonOrThrow(response);
}

export async function revokeApiKey(id) {
  const response = await api(`/api/v1/admin/api-keys/${id}`, { method: 'DELETE' });
  return readJsonOrThrow(response);
}

export default {
  api,
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  getUserMailboxes,
  assignMailbox,
  unassignMailbox,
  getApiKeys,
  createApiKey,
  revokeApiKey
};
