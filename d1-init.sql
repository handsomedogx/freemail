-- Cloudflare D1 数据库初始化脚本
-- 首次部署时执行：wrangler d1 execute maill_free_db --file=./d1-init.sql
-- 或修改 wrangler.toml 绑定后执行：wrangler d1 execute <database_name> --file=./d1-init.sql

-- 启用外键约束
PRAGMA foreign_keys = ON;

-- ────────────────────────────────────────
-- 邮箱地址表
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mailboxes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  address         TEXT    NOT NULL UNIQUE,
  local_part      TEXT    NOT NULL,
  domain          TEXT    NOT NULL,
  password_hash   TEXT,
  can_login       INTEGER DEFAULT 0,
  created_at      TEXT    DEFAULT CURRENT_TIMESTAMP,
  last_accessed_at TEXT,
  expires_at      TEXT,
  is_pinned       INTEGER DEFAULT 0,
  forward_to      TEXT    DEFAULT NULL,
  is_favorite     INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_mailboxes_address          ON mailboxes(address);
CREATE INDEX IF NOT EXISTS idx_mailboxes_is_pinned        ON mailboxes(is_pinned DESC);
CREATE INDEX IF NOT EXISTS idx_mailboxes_is_favorite      ON mailboxes(is_favorite DESC);
CREATE INDEX IF NOT EXISTS idx_mailboxes_address_created  ON mailboxes(address, created_at DESC);

-- ────────────────────────────────────────
-- 邮件消息表
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox_id        INTEGER NOT NULL,
  sender            TEXT    NOT NULL,
  to_addrs          TEXT    NOT NULL DEFAULT '',
  subject           TEXT    NOT NULL,
  verification_code TEXT,
  preview           TEXT,
  r2_bucket         TEXT    NOT NULL DEFAULT 'mail-eml',
  r2_object_key     TEXT    NOT NULL DEFAULT '',
  received_at       TEXT    DEFAULT CURRENT_TIMESTAMP,
  is_read           INTEGER DEFAULT 0,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_mailbox_received     ON messages(mailbox_id, received_at DESC);

-- ────────────────────────────────────────
-- 用户表
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT    NOT NULL UNIQUE,
  password_hash  TEXT,
  role           TEXT    NOT NULL DEFAULT 'user',
  can_send       INTEGER NOT NULL DEFAULT 0,
  mailbox_limit  INTEGER NOT NULL DEFAULT 10,
  created_at     TEXT    DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);

-- ────────────────────────────────────────
-- 用户-邮箱关联表
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_mailboxes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  mailbox_id  INTEGER NOT NULL,
  created_at  TEXT    DEFAULT CURRENT_TIMESTAMP,
  is_pinned   INTEGER NOT NULL DEFAULT 0,
  UNIQUE(user_id, mailbox_id),
  FOREIGN KEY(user_id)    REFERENCES users(id)     ON DELETE CASCADE,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_mailboxes_user       ON user_mailboxes(user_id);
CREATE INDEX IF NOT EXISTS idx_user_mailboxes_mailbox    ON user_mailboxes(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_user_mailboxes_user_pinned ON user_mailboxes(user_id, is_pinned DESC);
CREATE INDEX IF NOT EXISTS idx_user_mailboxes_composite  ON user_mailboxes(user_id, mailbox_id, is_pinned);

-- ────────────────────────────────────────
-- 发送邮件记录表
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sent_emails (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resend_id     TEXT,
  from_name     TEXT,
  from_addr     TEXT    NOT NULL,
  to_addrs      TEXT    NOT NULL,
  subject       TEXT    NOT NULL,
  html_content  TEXT,
  text_content  TEXT,
  status        TEXT    DEFAULT 'queued',
  scheduled_at  TEXT,
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  updated_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  provider      TEXT    NOT NULL DEFAULT 'resend'
);

CREATE INDEX IF NOT EXISTS idx_sent_emails_resend_id      ON sent_emails(resend_id);
CREATE INDEX IF NOT EXISTS idx_sent_emails_status_created ON sent_emails(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sent_emails_from_addr      ON sent_emails(from_addr);

-- ────────────────────────────────────────
-- API-first：API Key 与其创建的邮箱资源
-- 明文 API Key 不落库，只保存 SHA-256 哈希
-- ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  key_prefix    TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL UNIQUE,
  scopes        TEXT    NOT NULL DEFAULT 'mailboxes:read,mailboxes:write,messages:read',
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  last_used_at  TEXT,
  expires_at    TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS api_mailboxes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_id   TEXT    NOT NULL UNIQUE,
  api_key_id    INTEGER NOT NULL,
  mailbox_id    INTEGER NOT NULL UNIQUE,
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE,
  FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id    INTEGER NOT NULL,
  operation     TEXT    NOT NULL,
  key_hash      TEXT    NOT NULL,
  request_hash  TEXT    NOT NULL,
  resource_id   TEXT    NOT NULL,
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(api_key_id, operation, key_hash),
  FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS api_audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id    INTEGER,
  action        TEXT    NOT NULL,
  resource_type TEXT,
  resource_id   TEXT,
  status        TEXT    NOT NULL DEFAULT 'success',
  metadata_json TEXT,
  created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(api_key_id) REFERENCES api_keys(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash             ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_enabled          ON api_keys(enabled);
CREATE INDEX IF NOT EXISTS idx_api_mailboxes_key         ON api_mailboxes(api_key_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_api_mailboxes_mailbox     ON api_mailboxes(mailbox_id);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_lookup    ON api_idempotency_keys(api_key_id, operation, key_hash);
CREATE INDEX IF NOT EXISTS idx_api_idempotency_resource  ON api_idempotency_keys(api_key_id, resource_id);
CREATE INDEX IF NOT EXISTS idx_api_audit_key_created     ON api_audit_logs(api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_audit_action_created  ON api_audit_logs(action, created_at DESC);
