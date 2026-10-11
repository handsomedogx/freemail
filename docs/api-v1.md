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
    "scopes": "mailboxes:read,mailboxes:write,messages:read"
  }'
```

响应中的 `key` 只返回一次：

```json
{
  "id": 1,
  "name": "my-agent",
  "key_prefix": "fm_live_xxxxxxxx",
  "scopes": "mailboxes:read,mailboxes:write,messages:read",
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

## 5. 读取邮件

列出邮箱中的邮件：

```bash
curl "https://your-domain.example/api/v1/mailboxes/$MAILBOX_ID/messages?limit=20" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

读取单封邮件正文：

```bash
curl "https://your-domain.example/api/v1/messages/$MESSAGE_ID" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

邮件正文来自 R2 中保存的原始 EML。返回值会包含 `text`、`html`、`verification_code` 和仅提取、不自动访问的 `links`。所有外部邮件内容均标记：

```json
{ "content_trust": "untrusted_external" }
```

## 6. Agent 等待接口

等待任意一封邮件，最长单次等待 25 秒：

```bash
curl "https://your-domain.example/api/v1/mailboxes/$MAILBOX_ID/wait?for=mail&timeout=20" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

直接等待验证码：

```bash
curl "https://your-domain.example/api/v1/mailboxes/$MAILBOX_ID/wait?for=code&timeout=20&from_domain=example.com" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

直接等待邮件中的 HTTP/HTTPS 链接：

```bash
curl "https://your-domain.example/api/v1/mailboxes/$MAILBOX_ID/wait?for=link&timeout=20" \
  -H "Authorization: Bearer $MAIL_API_KEY"
```

支持的筛选参数：`from`、`from_domain`、`subject_contains`、`after_id`。若超时，会返回 JSON：

```json
{
  "matched": false,
  "timeout": true,
  "type": "code",
  "waited_ms": 20000
}
```

单次等待故意限制在 25 秒以内；未来 MCP 层可以自动重试或改用 Durable Objects / Queue，而不改变上层工具语义。

## 7. API Key 管理

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

当前版本已完成 API Key、邮箱资源隔离、真实 TTL、邮件读取、验证码/链接提取和短轮询等待接口。下一阶段会增加 Webhook/事件通知、租约/幂等性、审计日志以及 MCP 工具层。
