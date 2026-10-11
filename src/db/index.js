/**
 * 数据库模块统一导出
 * @module db
 */

export { initDatabase, setupDatabase } from './init.js';
export { getDatabaseWithValidation, getInitializedDatabase } from './connection.js';
export {
  getOrCreateMailboxId,
  getMailboxIdByAddress,
  checkMailboxOwnership,
  toggleMailboxPin,
  getTotalMailboxCount,
  getForwardTarget
} from './mailboxes.js';
export {
  createUser,
  updateUser,
  deleteUser,
  listUsersWithCounts,
  getUserStats,
  assignMailboxToUser,
  getUserMailboxes,
  unassignMailboxFromUser
} from './users.js';
export {
  recordSentEmail,
  updateSentEmail
} from './sentEmails.js';
export {
  createApiKey,
  authenticateApiKey,
  listApiKeys,
  revokeApiKey,
  extractBearerToken,
  parseScopes,
  hasScope
} from './apiKeys.js';
export {
  createApiMailbox,
  getApiMailbox,
  listApiMailboxes,
  deleteApiMailbox,
  normalizeTtlSeconds,
  mailboxStatus
} from './apiMailboxes.js';
