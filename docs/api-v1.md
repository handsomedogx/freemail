# Mail API V1

Freemail 的 API-first 接口，面向自动化程序、Agent 与未来 MCP 使用。

## 1. 创建 API Key

API Key 只能由 Freemail 严格管理员创建。首次创建时可以使用现有 `JWT_TOKEN`：

```bash
curl -X POST "https://your-domain.example/api/v1/admin/api-keys" \
  -H "Authorization: Bearer $JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "my-agent",
    "scopes": "mailboxes:read,mailboxes:write"
  }'
```

响应中的 `key` 只返回一次：

```json
{
  "id": 1,
  "name": "my-agent",
  "key_prefix": "fm_live_xxxxxxxx",
  "scopes": "mailboxes:read,mailboxes:write",
  "created_at": "2026-10-11 10:00:00",
  "expires_at": null,
  "enabled": 1,
  "key": "fm_live_xxxxxxxxxxxxxxxxxxxxxxxxx"
}
```

D1 只保存 API Key 的 SHA-256 哈希，不保存明文。

## 2. 创建临时邮箱

`ttl` 单位为秒，默认 600 秒；默认最短 60 秒、最长 86400 秒。

```bash
curl -X POST "https://your-domain.example/api/v1/mailboxes" \
  -H "Authorization: Bearer $MAIL_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"ttl": 600}'
```

响应：

```json
{
  "id": "mb_0123456789abcdef",
  "address": "a1b2c3d4e5@example.com",
  "created_at": "2026-10-11 10:00:00",
  "expires_at": "2026-10-11T10:10:00.000Z",
  "status": "active",
  "ttl": 600
}
```

可选指定 `domain` 和 `local`。`domain` 必须属于 `MAIL_DOMAIN` 配置；`local` 仅允许字母、数字和下划线。

## 3. 查询邮箱

```bash
curl "https://your-domain.example/api/v1/mailboxes/$MAILBOX_ID" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

列出当前 API Key 创建的邮箱：

```bash
curl "https://your-domain.example/api/v1/mailboxes?limit=100" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

不同 API Key 之间不能查询或删除彼此创建的邮箱。

## 4. 删除邮箱

```bash
curl -X DELETE "https://your-domain.example/api/v1/mailboxes/$MAILBOX_ID" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

删除时会同时清理该邮箱的邮件记录以及已记录的 R2 EML 对象。

## 5. API Key 管理

列出 API Key（不会返回明文 Key 或哈希）：

```bash
curl "https://your-domain.example/api/v1/admin/api-keys" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

撤销 API Key：

```bash
curl -X DELETE "https://your-domain.example/api/v1/admin/api-keys/1" \
  -H "Authorization: Bearer $JWT_TOKEN"
```

## 当前 V1 范围

当前版本先完成 API Key、邮箱资源隔离和真实 TTL。下一阶段会增加邮件读取、`wait_for_mail` / `wait_for_code`、链接提取、Webhook/事件通知以及 MCP 工具层。
