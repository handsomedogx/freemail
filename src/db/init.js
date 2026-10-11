/**
 * 数据库初始化模块
 * @module db/init
 */

import { clearExpiredCache } from '../utils/cache.js';

// 初始化状态标志（全局共享，Worker 生命周期内有效）
let _isFirstInit = true;

/**
 * 轻量级数据库初始化（仅在首次启动时检查）
 * @param {object} db - 数据库连接对象
 * @returns {Promise<void>} 初始化完成后无返回值
 */
export async function initDatabase(db) {
  try {
    // 清理过期缓存
    clearExpiredCache();
    
    // 仅首次启动时执行完整初始化
    if (_isFirstInit) {
      await performFirstTimeSetup(db);
      _isFirstInit = false;
    }
    
    // 每次都确保外键约束开启
    await db.exec(`PRAGMA foreign_keys = ON;`);
  } catch (error) {
    console.error('数据库初始化失败', {
      stage: error?.dbStage || 'init_database',
      message: String(error?.message || error || 'unknown database initialization error'),
      cause: error?.cause ? String(error.cause?.message || error.cause) : undefined
    });
    throw error;
  }
}

function withDbStage(stage, error) {
  const wrapped = new Error(String(error?.message || error || stage));
  wrapped.dbStage = stage;
  wrapped.cause = error;
  return wrapped;
}

/**
 * 首次启动设置（仅执行一次）
 * @param {object} db - 数据库连接对象
 * @returns {Promise<void>}
 */
async function performFirstTimeSetup(db) {
  // 仅把“核心表检查失败”视为需要初始化，避免把 API 扩展表/索引异常误判为核心库损坏。
  let coreTablesReady = true;
  try {
    await db.prepare('SELECT 1 FROM mailboxes LIMIT 1').all();
    await db.prepare('SELECT 1 FROM messages LIMIT 1').all();
    await db.prepare('SELECT 1 FROM users LIMIT 1').all();
    await db.prepare('SELECT 1 FROM user_mailboxes LIMIT 1').all();
    await db.prepare('SELECT 1 FROM sent_emails LIMIT 1').all();
  } catch (_) {
    coreTablesReady = false;
  }

  if (coreTablesReady) {
    // 旧站核心表存在时，字段迁移继续保持非致命；API-first 扩展也不能拖垮旧 API。
    await migrateMailboxesFields(db);
    await migrateSentEmailsFields(db);
    await ensureOptionalApiSchema(db);
    return;
  }

  console.log('检测到数据库核心表不完整，开始初始化...');
  
  // 创建表结构（仅在表不存在时）- 包含新字段 forward_to 和 is_favorite
  await db.exec("CREATE TABLE IF NOT EXISTS mailboxes (id INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL UNIQUE, local_part TEXT NOT NULL, domain TEXT NOT NULL, password_hash TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, last_accessed_at TEXT, expires_at TEXT, is_pinned INTEGER DEFAULT 0, can_login INTEGER DEFAULT 0, forward_to TEXT DEFAULT NULL, is_favorite INTEGER DEFAULT 0);");
  await db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, mailbox_id INTEGER NOT NULL, sender TEXT NOT NULL, to_addrs TEXT NOT NULL DEFAULT '', subject TEXT NOT NULL, verification_code TEXT, preview TEXT, r2_bucket TEXT NOT NULL DEFAULT 'mail-eml', r2_object_key TEXT NOT NULL DEFAULT '', received_at TEXT DEFAULT CURRENT_TIMESTAMP, is_read INTEGER DEFAULT 0, FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id));");
  await db.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT, role TEXT NOT NULL DEFAULT 'user', can_send INTEGER NOT NULL DEFAULT 0, mailbox_limit INTEGER NOT NULL DEFAULT 10, created_at TEXT DEFAULT CURRENT_TIMESTAMP);");
  await db.exec("CREATE TABLE IF NOT EXISTS user_mailboxes (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, mailbox_id INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, is_pinned INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id, mailbox_id), FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE);");
  await db.exec("CREATE TABLE IF NOT EXISTS sent_emails (id INTEGER PRIMARY KEY AUTOINCREMENT, resend_id TEXT, from_name TEXT, from_addr TEXT NOT NULL, to_addrs TEXT NOT NULL, subject TEXT NOT NULL, html_content TEXT, text_content TEXT, status TEXT DEFAULT 'queued', scheduled_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP, provider TEXT NOT NULL DEFAULT 'resend');");
  await createCoreIndexes(db);
  await ensureOptionalApiSchema(db);
}

/**
 * API-first 扩展表。与原用户/邮箱体系解耦，便于 Agent/API Key 独立授权。
 */
export async function ensureApiTables(db) {
  let existing;
  try {
    existing = await db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN (
        'api_keys', 'api_mailboxes', 'api_idempotency_keys', 'api_audit_logs'
      )
    `).all();
  } catch (error) {
    throw withDbStage('check_api_tables', error);
  }

  const names = new Set((existing?.results || []).map(row => String(row.name || '')));
  let created = false;

  if (!names.has('api_keys')) {
    try {
      await db.exec(`CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL DEFAULT 'mailboxes:read,mailboxes:write,messages:read',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_used_at TEXT,
      expires_at TEXT,
      enabled INTEGER NOT NULL DEFAULT 1
      );`);
      created = true;
    } catch (error) {
      throw withDbStage('create_api_keys', error);
    }
  }

  if (!names.has('api_mailboxes')) {
    try {
      await db.exec(`CREATE TABLE api_mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id TEXT NOT NULL UNIQUE,
      api_key_id INTEGER NOT NULL,
      mailbox_id INTEGER NOT NULL UNIQUE,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
      FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
      );`);
      created = true;
    } catch (error) {
      throw withDbStage('create_api_mailboxes', error);
    }
  }

  if (!names.has('api_idempotency_keys')) {
    try {
      await db.exec(`CREATE TABLE api_idempotency_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      operation TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(api_key_id, operation, key_hash),
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
      );`);
      created = true;
    } catch (error) {
      throw withDbStage('create_api_idempotency_keys', error);
    }
  }

  if (!names.has('api_audit_logs')) {
    try {
      await db.exec(`CREATE TABLE api_audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      action TEXT NOT NULL,
      resource_type TEXT,
      resource_id TEXT,
      status TEXT NOT NULL DEFAULT 'success',
      metadata_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
      );`);
      created = true;
    } catch (error) {
      throw withDbStage('create_api_audit_logs', error);
    }
  }

  return { created };
}

/**
 * API-first 扩展属于可选能力：初始化失败时记录诊断信息，但不能让旧 Web/API 整站 500。
 */
export async function ensureOptionalApiSchema(db) {
  try {
    const result = await ensureApiTables(db);
    // 正常部署由 d1-init.sql 创建表和索引；只有运行时实际补建了表时才补索引。
    if (result?.created) await createApiIndexes(db);
    return true;
  } catch (error) {
    console.error('API 扩展数据库初始化失败', {
      stage: error?.dbStage || 'ensure_api_schema',
      message: String(error?.message || error || 'unknown API schema error'),
      cause: error?.cause ? String(error.cause?.message || error.cause) : undefined
    });
    return false;
  }
}

/**
 * 创建数据库索引
 * @param {object} db - 数据库连接对象
 */
async function createCoreIndexes(db) {
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_mailboxes_address ON mailboxes(address);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_mailboxes_is_pinned ON mailboxes(is_pinned DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_mailboxes_address_created ON mailboxes(address, created_at DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_mailboxes_is_favorite ON mailboxes(is_favorite DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_mailbox_received ON messages(mailbox_id, received_at DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_user_mailboxes_user ON user_mailboxes(user_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_user_mailboxes_mailbox ON user_mailboxes(mailbox_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_user_mailboxes_user_pinned ON user_mailboxes(user_id, is_pinned DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_user_mailboxes_composite ON user_mailboxes(user_id, mailbox_id, is_pinned);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_emails_resend_id ON sent_emails(resend_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_emails_status_created ON sent_emails(status, created_at DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_sent_emails_from_addr ON sent_emails(from_addr);`);
}

async function createApiIndexes(db) {
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_keys_enabled ON api_keys(enabled);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_mailboxes_key ON api_mailboxes(api_key_id, resource_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_mailboxes_mailbox ON api_mailboxes(mailbox_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_idempotency_lookup ON api_idempotency_keys(api_key_id, operation, key_hash);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_idempotency_resource ON api_idempotency_keys(api_key_id, resource_id);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_audit_key_created ON api_audit_logs(api_key_id, created_at DESC);`);
  await db.exec(`CREATE INDEX IF NOT EXISTS idx_api_audit_action_created ON api_audit_logs(action, created_at DESC);`);
}

async function createIndexes(db) {
  await createCoreIndexes(db);
  await createApiIndexes(db);
}

/**
 * 迁移 mailboxes 表字段（向后兼容）
 * 检查并添加缺失的字段：forward_to, is_favorite
 * @param {object} db - 数据库连接对象
 * @returns {Promise<void>}
 */
async function migrateMailboxesFields(db) {
  try {
    const columns = await db.prepare("PRAGMA table_info(mailboxes)").all();
    const columnNames = (columns.results || []).map(c => c.name);

    // 添加 forward_to 字段（转发目标）
    if (!columnNames.includes('forward_to')) {
      await db.exec("ALTER TABLE mailboxes ADD COLUMN forward_to TEXT DEFAULT NULL;");
      console.log('已添加 mailboxes.forward_to 字段');
    }

    // 添加 is_favorite 字段（收藏状态）
    if (!columnNames.includes('is_favorite')) {
      await db.exec("ALTER TABLE mailboxes ADD COLUMN is_favorite INTEGER DEFAULT 0;");
      await db.exec("CREATE INDEX IF NOT EXISTS idx_mailboxes_is_favorite ON mailboxes(is_favorite DESC);");
      console.log('已添加 mailboxes.is_favorite 字段');
    }
  } catch (error) {
    console.error('mailboxes 字段迁移失败:', error);
    // 不抛出异常，允许继续运行
  }
}

/**
 * 迁移 sent_emails 表字段（向后兼容）
 * 检查并添加缺失的字段：provider（区分发件渠道：resend / sendflare）
 * @param {object} db - 数据库连接对象
 * @returns {Promise<void>}
 */
async function migrateSentEmailsFields(db) {
  try {
    const columns = await db.prepare("PRAGMA table_info(sent_emails)").all();
    const columnNames = (columns.results || []).map(c => c.name);

    if (!columnNames.includes('provider')) {
      await db.exec("ALTER TABLE sent_emails ADD COLUMN provider TEXT NOT NULL DEFAULT 'resend';");
      console.log('已添加 sent_emails.provider 字段');
    }
  } catch (error) {
    console.error('sent_emails 字段迁移失败:', error);
    // 不抛出异常，允许继续运行
  }
}

/**
 * 完整的数据库设置脚本（用于首次部署）
 * 可通过 wrangler d1 execute 或管理面板执行
 * @param {object} db - 数据库连接对象
 * @returns {Promise<void>}
 */
export async function setupDatabase(db) {
  await db.exec(`PRAGMA foreign_keys = ON;`);
  
  // 创建所有表
  await db.exec(`
    CREATE TABLE IF NOT EXISTS mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      address TEXT NOT NULL UNIQUE,
      local_part TEXT NOT NULL,
      domain TEXT NOT NULL,
      password_hash TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_accessed_at TEXT,
      expires_at TEXT,
      is_pinned INTEGER DEFAULT 0,
      can_login INTEGER DEFAULT 0,
      forward_to TEXT DEFAULT NULL,
      is_favorite INTEGER DEFAULT 0
    );
  `);
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mailbox_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      to_addrs TEXT NOT NULL DEFAULT '',
      subject TEXT NOT NULL,
      verification_code TEXT,
      preview TEXT,
      r2_bucket TEXT NOT NULL DEFAULT 'mail-eml',
      r2_object_key TEXT NOT NULL DEFAULT '',
      received_at TEXT DEFAULT CURRENT_TIMESTAMP,
      is_read INTEGER DEFAULT 0,
      FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id)
    );
  `);
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      can_send INTEGER NOT NULL DEFAULT 0,
      mailbox_limit INTEGER NOT NULL DEFAULT 10,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      mailbox_id INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      UNIQUE(user_id, mailbox_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
    );
  `);
  
  await db.exec(`
    CREATE TABLE IF NOT EXISTS sent_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resend_id TEXT,
      from_name TEXT,
      from_addr TEXT NOT NULL,
      to_addrs TEXT NOT NULL,
      subject TEXT NOT NULL,
      html_content TEXT,
      text_content TEXT,
      status TEXT DEFAULT 'queued',
      scheduled_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      provider TEXT NOT NULL DEFAULT 'resend'
    );
  `);
  await ensureApiTables(db);
  
  // 创建所有索引
  await createIndexes(db);
}
