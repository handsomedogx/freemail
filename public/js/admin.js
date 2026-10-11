/**
 * 管理员页面
 * @module admin
 */

import {
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
} from './modules/admin/api.js';
import { formatTime, renderUserRow, renderUserList, generateSkeletonRows, renderPagination } from './modules/admin/user-list.js';
import { fillEditForm, collectEditFormData, validateEditForm, resetEditState } from './modules/admin/user-edit.js';
import { renderApiKeyList } from './modules/admin/api-keys.js';

// showToast 由 toast-utils.js 全局提供
const showToast = window.showToast || ((msg, type) => console.log(`[${type}] ${msg}`));

// 分页状态
let currentPage = 1, pageSize = 20, totalUsers = 0;
let currentViewingUser = null;
let mailboxPage = 1, mailboxPageSize = 20, totalMailboxes = 0;

// DOM 元素
const els = {
  back: document.getElementById('back'),
  logout: document.getElementById('logout'),
  demoBanner: document.getElementById('demo-banner'),
  usersTbody: document.getElementById('users-tbody'),
  usersRefresh: document.getElementById('users-refresh'),
  usersLoading: document.getElementById('users-loading'),
  usersCount: document.getElementById('users-count'),
  usersPagination: document.getElementById('users-pagination'),
  pageInfo: document.getElementById('page-info'),
  paginationText: document.getElementById('pagination-text'),
  prevPage: document.getElementById('prev-page'),
  nextPage: document.getElementById('next-page'),
  
  uOpen: document.getElementById('u-open'),
  uModal: document.getElementById('u-modal'),
  uClose: document.getElementById('u-close'),
  uCancel: document.getElementById('u-cancel'),
  uCreate: document.getElementById('u-create'),
  uName: document.getElementById('u-name'),
  uPass: document.getElementById('u-pass'),
  uRole: document.getElementById('u-role'),
  
  aOpen: document.getElementById('a-open'),
  aModal: document.getElementById('a-modal'),
  aClose: document.getElementById('a-close'),
  aCancel: document.getElementById('a-cancel'),
  aAssign: document.getElementById('a-assign'),
  aName: document.getElementById('a-name'),
  aMail: document.getElementById('a-mail'),
  
  // 取消分配模态框
  unassignOpen: document.getElementById('unassign-open'),
  unassignModal: document.getElementById('unassign-modal'),
  unassignClose: document.getElementById('unassign-close'),
  unassignCancel: document.getElementById('unassign-cancel'),
  unassignSubmit: document.getElementById('unassign-submit'),
  unassignName: document.getElementById('unassign-name'),
  unassignMail: document.getElementById('unassign-mail'),
  
  editModal: document.getElementById('edit-modal'),
  editClose: document.getElementById('edit-close'),
  editCancel: document.getElementById('edit-cancel'),
  editSave: document.getElementById('edit-save'),
  editName: document.getElementById('edit-name'),
  editUserDisplay: document.getElementById('edit-user-display'),
  editNewName: document.getElementById('edit-new-name'),
  editRoleCheck: document.getElementById('edit-role-check'),
  editLimit: document.getElementById('edit-limit'),
  editSendCheck: document.getElementById('edit-send-check'),
  editPass: document.getElementById('edit-pass'),
  editDelete: document.getElementById('edit-delete'),
  
  userMailboxes: document.getElementById('user-mailboxes'),
  userMailboxesLoading: document.getElementById('user-mailboxes-loading'),
  mailboxesCount: document.getElementById('mailboxes-count'),
  mailboxesPagination: document.getElementById('mailboxes-pagination'),
  mailboxesPageInfo: document.getElementById('mailboxes-page-info'),
  mailboxesPrevPage: document.getElementById('mailboxes-prev-page'),
  mailboxesNextPage: document.getElementById('mailboxes-next-page'),

  // API Key 管理
  apiKeysSection: document.getElementById('api-keys-section'),
  apiKeysTbody: document.getElementById('api-keys-tbody'),
  apiKeysCount: document.getElementById('api-keys-count'),
  apiKeysLoading: document.getElementById('api-keys-loading'),
  apiKeysRefresh: document.getElementById('api-keys-refresh'),
  apiKeysJump: document.getElementById('api-keys-jump'),
  apiKeyCreateOpen: document.getElementById('api-key-create-open'),
  apiKeyCreateModal: document.getElementById('api-key-create-modal'),
  apiKeyCreateClose: document.getElementById('api-key-create-close'),
  apiKeyCreateCancel: document.getElementById('api-key-create-cancel'),
  apiKeyCreateSubmit: document.getElementById('api-key-create-submit'),
  apiKeyName: document.getElementById('api-key-name'),
  apiKeyExpireDays: document.getElementById('api-key-expire-days'),
  apiKeyScopeMailboxesRead: document.getElementById('api-key-scope-mailboxes-read'),
  apiKeyScopeMailboxesWrite: document.getElementById('api-key-scope-mailboxes-write'),
  apiKeyScopeMessagesRead: document.getElementById('api-key-scope-messages-read'),
  apiKeySecretModal: document.getElementById('api-key-secret-modal'),
  apiKeySecretClose: document.getElementById('api-key-secret-close'),
  apiKeySecretDone: document.getElementById('api-key-secret-done'),
  apiKeySecretValue: document.getElementById('api-key-secret-value'),
  apiKeySecretCopy: document.getElementById('api-key-secret-copy'),
  
  // 确认模态框
  confirmModal: document.getElementById('admin-confirm-modal'),
  confirmMessage: document.getElementById('admin-confirm-message'),
  confirmClose: document.getElementById('admin-confirm-close'),
  confirmCancel: document.getElementById('admin-confirm-cancel'),
  confirmOk: document.getElementById('admin-confirm-ok')
};

// 自定义确认对话框
let confirmResolver = null;
function showConfirm(message) {
  return new Promise(resolve => {
    confirmResolver = resolve;
    if (els.confirmMessage) els.confirmMessage.textContent = message;
    els.confirmModal?.classList.add('show');
  });
}

function initConfirmEvents() {
  if (els._confirmInitialized) return;
  els._confirmInitialized = true;
  
  const closeConfirm = (result) => {
    els.confirmModal?.classList.remove('show');
    if (confirmResolver) {
      confirmResolver(result);
      confirmResolver = null;
    }
  };
  
  els.confirmOk?.addEventListener('click', () => closeConfirm(true));
  els.confirmCancel?.addEventListener('click', () => closeConfirm(false));
  els.confirmClose?.addEventListener('click', () => closeConfirm(false));
  els.confirmModal?.addEventListener('click', (e) => {
    if (e.target === els.confirmModal) closeConfirm(false);
  });
}
initConfirmEvents();

let apiKeyManagerEnabled = false;

async function resolveAdminSession() {
  if (window.__ADMIN_SESSION__) return window.__ADMIN_SESSION__;
  try {
    const response = await fetch('/api/session', { headers: { 'Cache-Control': 'no-cache' } });
    if (!response.ok) return null;
    const session = await response.json();
    window.__ADMIN_SESSION__ = session;
    window.__STRICT_ADMIN__ = session?.strictAdmin === true;
    window.__GUEST_MODE__ = session?.role === 'guest';
    return session;
  } catch (_) {
    return null;
  }
}

function resetApiKeyCreateForm() {
  if (els.apiKeyName) els.apiKeyName.value = '';
  if (els.apiKeyExpireDays) els.apiKeyExpireDays.value = '';
  if (els.apiKeyScopeMailboxesRead) els.apiKeyScopeMailboxesRead.checked = true;
  if (els.apiKeyScopeMailboxesWrite) els.apiKeyScopeMailboxesWrite.checked = true;
  if (els.apiKeyScopeMessagesRead) els.apiKeyScopeMessagesRead.checked = true;
}

function getSelectedApiKeyScopes() {
  const scopes = [];
  if (els.apiKeyScopeMailboxesRead?.checked) scopes.push('mailboxes:read');
  if (els.apiKeyScopeMailboxesWrite?.checked) scopes.push('mailboxes:write');
  if (els.apiKeyScopeMessagesRead?.checked) scopes.push('messages:read');
  return scopes;
}

async function loadApiKeys() {
  if (!apiKeyManagerEnabled) return;
  if (els.apiKeysLoading) els.apiKeysLoading.style.display = 'flex';
  try {
    const result = await getApiKeys();
    const items = Array.isArray(result?.data) ? result.data : [];
    renderApiKeyList(items, els.apiKeysTbody);
    if (els.apiKeysCount) els.apiKeysCount.textContent = `${items.length} 个`;
    bindApiKeyRowEvents();
  } catch (error) {
    console.error('加载 API Keys 失败:', error);
    showToast(error?.message || '加载 API Keys 失败', 'error');
  } finally {
    if (els.apiKeysLoading) els.apiKeysLoading.style.display = 'none';
  }
}

function bindApiKeyRowEvents() {
  els.apiKeysTbody?.querySelectorAll('.api-key-revoke:not(:disabled)').forEach(button => {
    button.onclick = async () => {
      const id = Number(button.dataset.apiKeyId || 0);
      if (!id) return;
      const confirmed = await showConfirm('确定撤销这个 API Key 吗？撤销后使用该 Key 的 Agent 会立即无法访问 API。');
      if (!confirmed) return;

      button.disabled = true;
      try {
        await revokeApiKey(id);
        showToast('API Key 已撤销', 'success');
        await loadApiKeys();
      } catch (error) {
        button.disabled = false;
        showToast(error?.message || '撤销失败', 'error');
      }
    };
  });
}

async function handleCreateApiKey() {
  const name = String(els.apiKeyName?.value || '').trim();
  if (!name) {
    showToast('请输入 API Key 名称', 'warning');
    els.apiKeyName?.focus();
    return;
  }

  const scopes = getSelectedApiKeyScopes();
  if (!scopes.length) {
    showToast('至少选择一个 Scope', 'warning');
    return;
  }

  const rawDays = String(els.apiKeyExpireDays?.value || '').trim();
  let expiresInDays;
  if (rawDays) {
    expiresInDays = Number(rawDays);
    if (!Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 3650) {
      showToast('过期天数必须是 1-3650 的整数', 'warning');
      return;
    }
  }

  if (els.apiKeyCreateSubmit) els.apiKeyCreateSubmit.disabled = true;
  try {
    const payload = {
      name,
      scopes: scopes.join(',')
    };
    if (expiresInDays) payload.expires_in_days = expiresInDays;
    const created = await createApiKey(payload);
    if (!created?.key) throw new Error('服务端未返回 API Key 明文');

    els.apiKeyCreateModal?.classList.remove('show');
    if (els.apiKeySecretValue) els.apiKeySecretValue.textContent = created.key;
    els.apiKeySecretModal?.classList.add('show');
    resetApiKeyCreateForm();
    await loadApiKeys();
  } catch (error) {
    showToast(error?.message || '创建 API Key 失败', 'error');
  } finally {
    if (els.apiKeyCreateSubmit) els.apiKeyCreateSubmit.disabled = false;
  }
}

function closeApiKeySecretModal() {
  els.apiKeySecretModal?.classList.remove('show');
  if (els.apiKeySecretValue) els.apiKeySecretValue.textContent = '';
}

async function copyApiKeySecret() {
  const value = String(els.apiKeySecretValue?.textContent || '').trim();
  if (!value) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    showToast('API Key 已复制', 'success');
  } catch (_) {
    showToast('复制失败，请手动选择 Key 复制', 'warning');
  }
}

async function initApiKeyManager() {
  const session = await resolveAdminSession();
  if (!session?.strictAdmin) return;
  apiKeyManagerEnabled = true;
  if (els.apiKeysSection) els.apiKeysSection.style.display = '';
  if (els.apiKeysJump) els.apiKeysJump.style.display = '';
  await loadApiKeys();
}

// 加载用户列表
async function loadUsers() {
  if (els.usersLoading) els.usersLoading.style.display = 'flex';
  if (els.usersTbody) els.usersTbody.innerHTML = generateSkeletonRows(5);

  try {
    const data = await getUsers({ page: currentPage, size: pageSize });
    const users = Array.isArray(data) ? data : (data.list || []);
    totalUsers = data.total || users.length;

    renderUserList(users, els.usersTbody);
    updatePagination();

    // 更新统计卡片（管理员数/可发件数均取后端全局聚合，而非当前页统计）
    updateStats({
      totalUsers,
      adminCount: data.admin_count || 0,
      totalMailboxes: data.total_mailboxes || 0,
      activeUsers: data.active_count || 0
    });

    if (els.usersCount) els.usersCount.textContent = `${totalUsers} 人`;

    bindUserEvents();
  } catch (e) {
    console.error('加载用户失败:', e);
    showToast('加载失败', 'error');
  } finally {
    if (els.usersLoading) els.usersLoading.style.display = 'none';
  }
}

// 更新统计卡片（全部使用后端返回的全局聚合值，避免与当前页口径混用）
function updateStats(stats) {
  const statTotal = document.getElementById('stat-total-users');
  const statAdmin = document.getElementById('stat-admin-count');
  const statMailbox = document.getElementById('stat-mailbox-count');
  const statActive = document.getElementById('stat-active-users');

  if (statTotal) statTotal.textContent = stats.totalUsers;
  if (statAdmin) statAdmin.textContent = stats.adminCount;
  if (statMailbox) statMailbox.textContent = stats.totalMailboxes;
  if (statActive) statActive.textContent = stats.activeUsers;
}

// 更新分页
function updatePagination() {
  const totalPages = Math.max(1, Math.ceil(totalUsers / pageSize));
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalUsers);

  if (els.pageInfo) els.pageInfo.textContent = `${currentPage} / ${totalPages}`;
  if (els.paginationText) els.paginationText.textContent = `显示 ${start}-${end} 条，共 ${totalUsers} 条`;
  if (els.prevPage) els.prevPage.disabled = currentPage <= 1;
  if (els.nextPage) els.nextPage.disabled = currentPage >= totalPages;
}

// 绑定用户操作事件
function bindUserEvents() {
  // 点击整行加载邮箱列表
  els.usersTbody?.querySelectorAll('.user-row.clickable').forEach(row => {
    row.onclick = async (e) => {
      // 如果点击的是按钮，不触发行点击
      if (e.target.closest('[data-action]')) return;
      
      const userId = row.dataset.userId;
      if (userId) {
        // 移除其他行的选中状态
        els.usersTbody.querySelectorAll('.user-row').forEach(r => r.classList.remove('active'));
        row.classList.add('active');
        await openMailboxesPanel(userId);
      }
    };
  });
  
  // 编辑按钮事件
  els.usersTbody?.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const userId = btn.dataset.userId;
      await openEditModal(userId);
    };
  });
}

// 打开编辑模态框
async function openEditModal(userId) {
  try {
    const data = await getUsers({ page: 1, size: 100 });
    const users = Array.isArray(data) ? data : (data.list || []);
    const user = users.find(u => u.id == userId);
    if (!user) { showToast('用户不存在', 'error'); return; }
    
    currentViewingUser = user;
    fillEditForm(els, user);
    els.editModal?.classList.add('show');
  } catch(e) {
    showToast('加载用户信息失败', 'error');
  }
}

// 保存用户编辑
async function saveEdit() {
  if (!currentViewingUser) return;
  
  const formData = collectEditFormData(els);
  const validation = validateEditForm(formData, false);
  if (!validation.valid) {
    showToast(validation.error, 'error');
    return;
  }
  
  try {
    await updateUser(currentViewingUser.id, formData);
    showToast('保存成功', 'success');
    els.editModal?.classList.remove('show');
    loadUsers();
  } catch(e) {
    showToast('保存失败', 'error');
  }
}

// 打开邮箱面板
async function openMailboxesPanel(userId) {
  try {
    const data = await getUsers({ page: 1, size: 100 });
    const users = Array.isArray(data) ? data : (data.list || []);
    const user = users.find(u => u.id == userId);
    if (!user) { showToast('用户不存在', 'error'); return; }
    
    currentViewingUser = user;
    mailboxPage = 1;
    await loadUserMailboxes();
    
    // 显示邮箱面板
    if (els.userMailboxes) els.userMailboxes.style.display = 'block';
    if (els.aName) els.aName.value = user.username;
  } catch(e) {
    showToast('加载失败', 'error');
  }
}

// 加载用户邮箱
async function loadUserMailboxes() {
  if (!currentViewingUser) return;
  if (els.userMailboxesLoading) els.userMailboxesLoading.style.display = 'flex';

  try {
    const data = await getUserMailboxes(currentViewingUser.id, { page: mailboxPage, size: mailboxPageSize });
    const list = Array.isArray(data) ? data : (data.list || []);
    totalMailboxes = data.total || list.length;

    if (els.mailboxesCount) els.mailboxesCount.textContent = `${totalMailboxes} 个`;

    // 渲染邮箱列表
    const container = document.getElementById('mailbox-list');
    const emptyState = document.getElementById('empty-mailbox-list');

    if (container) {
      if (list.length > 0) {
        container.innerHTML = list.map(m => `
          <div class="mailbox-item" data-address="${m.address}" data-href="/?mailbox=${encodeURIComponent(m.address)}">
            <span class="address">${m.address}</span>
            <button class="btn danger" data-action="unassign">取消分配</button>
          </div>
        `).join('');
        if (emptyState) emptyState.classList.add('hidden');

        // 绑定取消分配事件
        container.querySelectorAll('[data-action="unassign"]').forEach(btn => {
          btn.onclick = async (e) => {
            e.stopPropagation();
            const address = btn.closest('[data-address]')?.dataset.address;
            if (!address) return;

            const confirmed = await showConfirm(`确定取消分配邮箱 ${address}？`);
            if (!confirmed) return;

            try {
              await unassignMailbox(currentViewingUser.username, address);
              showToast('已取消分配', 'success');
              loadUserMailboxes();
            } catch(e) { showToast('取消分配失败', 'error'); }
          };
        });
      } else {
        container.innerHTML = '';
        if (emptyState) emptyState.classList.remove('hidden');
      }
    }

    // 更新分页
    const totalPages = Math.max(1, Math.ceil(totalMailboxes / mailboxPageSize));
    if (els.mailboxesPageInfo) els.mailboxesPageInfo.textContent = `${mailboxPage} / ${totalPages}`;
    if (els.mailboxesPrevPage) els.mailboxesPrevPage.disabled = mailboxPage <= 1;
    if (els.mailboxesNextPage) els.mailboxesNextPage.disabled = mailboxPage >= totalPages;

    // 更新选中用户显示
    const selectedUserInfo = document.getElementById('selected-user-info');
    if (selectedUserInfo) {
      selectedUserInfo.innerHTML = `<span class="selected-user-name">${currentViewingUser.username}</span>`;
    }
  } catch(e) {
    showToast('加载邮箱失败', 'error');
  } finally {
    if (els.userMailboxesLoading) els.userMailboxesLoading.style.display = 'none';
  }
}

// 创建用户
async function handleCreateUser() {
  const username = els.uName?.value.trim();
  const password = els.uPass?.value.trim();
  const role = els.uRole?.value || 'user';
  
  if (!username || !password) {
    showToast('用户名和密码不能为空', 'error');
    return;
  }
  
  try {
    await createUser({ username, password, role });
    showToast('用户创建成功', 'success');
    els.uModal?.classList.remove('show');
    els.uName.value = '';
    els.uPass.value = '';
    loadUsers();
  } catch(e) {
    showToast('创建失败', 'error');
  }
}

// 分配邮箱
async function handleAssignMailbox() {
  const username = els.aName?.value.trim();
  const addressText = els.aMail?.value.trim();
  
  if (!username) {
    showToast('请输入用户名', 'error');
    return;
  }
  
  if (!addressText) {
    showToast('请输入邮箱地址', 'error');
    return;
  }
  
  // 支持批量分配（每行一个地址）
  const addresses = addressText.split('\n').map(a => a.trim()).filter(a => a);
  if (addresses.length === 0) {
    showToast('请输入有效的邮箱地址', 'error');
    return;
  }
  
  try {
    let successCount = 0;
    let failCount = 0;
    for (const address of addresses) {
      try {
        await assignMailbox(username, address);
        successCount++;
      } catch(e) {
        failCount++;
      }
    }
    
    if (successCount > 0 && failCount === 0) {
      showToast(`成功分配 ${successCount} 个邮箱`, 'success');
    } else if (successCount > 0 && failCount > 0) {
      showToast(`成功 ${successCount} 个，失败 ${failCount} 个`, 'warning');
    } else {
      showToast('分配失败', 'error');
    }
    
    els.aModal?.classList.remove('show');
    els.aMail.value = '';
    els.aName.value = '';
    
    // 如果当前有查看的用户且用户名匹配，刷新邮箱列表
    if (currentViewingUser && currentViewingUser.username === username) {
      loadUserMailboxes();
    }
  } catch(e) {
    showToast('分配失败', 'error');
  }
}

// 取消分配邮箱
async function handleUnassignMailbox() {
  const username = els.unassignName?.value.trim();
  const addressText = els.unassignMail?.value.trim();
  
  if (!username) {
    showToast('请输入用户名', 'error');
    return;
  }
  
  if (!addressText) {
    showToast('请输入邮箱地址', 'error');
    return;
  }
  
  // 支持批量取消分配（每行一个地址）
  const addresses = addressText.split('\n').map(a => a.trim()).filter(a => a);
  if (addresses.length === 0) {
    showToast('请输入有效的邮箱地址', 'error');
    return;
  }
  
  try {
    let successCount = 0;
    let failCount = 0;
    for (const address of addresses) {
      try {
        await unassignMailbox(username, address);
        successCount++;
      } catch(e) {
        failCount++;
      }
    }
    
    if (successCount > 0 && failCount === 0) {
      showToast(`成功取消分配 ${successCount} 个邮箱`, 'success');
    } else if (successCount > 0 && failCount > 0) {
      showToast(`成功 ${successCount} 个，失败 ${failCount} 个`, 'warning');
    } else {
      showToast('取消分配失败', 'error');
    }
    
    els.unassignModal?.classList.remove('show');
    els.unassignMail.value = '';
    els.unassignName.value = '';
    
    // 如果当前有查看的用户且用户名匹配，刷新邮箱列表
    if (currentViewingUser && currentViewingUser.username === username) {
      loadUserMailboxes();
    }
  } catch(e) {
    showToast('取消分配失败', 'error');
  }
}

// 事件绑定
els.back?.addEventListener('click', () => history.back());
els.logout?.addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST' }); } catch(_) {} location.replace('/html/login.html'); });
els.usersRefresh?.addEventListener('click', loadUsers);
els.prevPage?.addEventListener('click', () => { if (currentPage > 1) { currentPage--; loadUsers(); }});
els.nextPage?.addEventListener('click', () => { const totalPages = Math.ceil(totalUsers / pageSize); if (currentPage < totalPages) { currentPage++; loadUsers(); }});

// 创建用户模态框
els.uOpen?.addEventListener('click', () => els.uModal?.classList.add('show'));
els.uClose?.addEventListener('click', () => els.uModal?.classList.remove('show'));
els.uCancel?.addEventListener('click', () => els.uModal?.classList.remove('show'));
els.uCreate?.addEventListener('click', handleCreateUser);

// 分配邮箱模态框
els.aOpen?.addEventListener('click', () => els.aModal?.classList.add('show'));
els.aClose?.addEventListener('click', () => els.aModal?.classList.remove('show'));
els.aCancel?.addEventListener('click', () => els.aModal?.classList.remove('show'));
els.aAssign?.addEventListener('click', handleAssignMailbox);

// 取消分配模态框
els.unassignOpen?.addEventListener('click', () => els.unassignModal?.classList.add('show'));
els.unassignClose?.addEventListener('click', () => els.unassignModal?.classList.remove('show'));
els.unassignCancel?.addEventListener('click', () => els.unassignModal?.classList.remove('show'));
els.unassignSubmit?.addEventListener('click', handleUnassignMailbox);

// 编辑模态框
els.editClose?.addEventListener('click', () => els.editModal?.classList.remove('show'));
els.editCancel?.addEventListener('click', () => els.editModal?.classList.remove('show'));
els.editSave?.addEventListener('click', saveEdit);
els.editDelete?.addEventListener('click', async () => {
  if (!currentViewingUser) return;
  
  const confirmed = await showConfirm(`确定删除用户 "${currentViewingUser.username}" 吗？此操作不可恢复。`);
  if (!confirmed) return;
  
  try {
    await deleteUser(currentViewingUser.id);
    showToast('用户已删除', 'success');
    els.editModal?.classList.remove('show');
    loadUsers();
  } catch(e) { showToast('删除失败', 'error'); }
});

// 邮箱分页
els.mailboxesPrevPage?.addEventListener('click', () => { if (mailboxPage > 1) { mailboxPage--; loadUserMailboxes(); }});
els.mailboxesNextPage?.addEventListener('click', () => { const totalPages = Math.ceil(totalMailboxes / mailboxPageSize); if (mailboxPage < totalPages) { mailboxPage++; loadUserMailboxes(); }});

// API Key 管理
els.apiKeysRefresh?.addEventListener('click', loadApiKeys);
els.apiKeysJump?.addEventListener('click', () => {
  els.apiKeysSection?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
els.apiKeyCreateOpen?.addEventListener('click', () => {
  resetApiKeyCreateForm();
  els.apiKeyCreateModal?.classList.add('show');
  setTimeout(() => els.apiKeyName?.focus(), 0);
});
els.apiKeyCreateClose?.addEventListener('click', () => els.apiKeyCreateModal?.classList.remove('show'));
els.apiKeyCreateCancel?.addEventListener('click', () => els.apiKeyCreateModal?.classList.remove('show'));
els.apiKeyCreateSubmit?.addEventListener('click', handleCreateApiKey);
els.apiKeyCreateModal?.addEventListener('click', (event) => {
  if (event.target === els.apiKeyCreateModal) els.apiKeyCreateModal.classList.remove('show');
});
els.apiKeyName?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') handleCreateApiKey();
});

els.apiKeySecretCopy?.addEventListener('click', copyApiKeySecret);
els.apiKeySecretClose?.addEventListener('click', closeApiKeySecretModal);
els.apiKeySecretDone?.addEventListener('click', closeApiKeySecretModal);

// 初始化
loadUsers();
initApiKeyManager();
