import { Hono } from 'hono';

import { authenticateApiKey, getInitializedDatabase } from '../db/index.js';
import { createMailMcpHandler } from '../mcp/server.js';

const router = new Hono();

function unauthorized(message = 'API Key 无效、已撤销或已过期') {
  return Response.json(
    { error: 'invalid_token', error_description: message },
    {
      status: 401,
      headers: {
        'WWW-Authenticate': 'Bearer realm="Freemail MCP", error="invalid_token"'
      }
    }
  );
}

function databaseUnavailable() {
  return Response.json(
    { error: 'server_error', error_description: '数据库连接失败' },
    { status: 500 }
  );
}

router.options('/mcp', c => {
  const requestedHeaders = c.req.header('Access-Control-Request-Headers');
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
  if (requestedHeaders) {
    headers['Access-Control-Allow-Headers'] = requestedHeaders;
    headers.Vary = 'Access-Control-Request-Headers';
  } else {
    headers['Access-Control-Allow-Headers'] =
      'Authorization, Content-Type, Accept, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id';
  }
  return new Response(null, { status: 204, headers });
});

router.all('/mcp', async c => {
  let db;
  try {
    db = await getInitializedDatabase(c.env);
  } catch (error) {
    console.error('MCP database initialization failed:', {
      stage: error?.dbStage || 'get_initialized_database',
      message: String(error?.message || error || 'unknown database error')
    });
    return databaseUnavailable();
  }

  let apiKey;
  try {
    apiKey = await authenticateApiKey(db, c.req.raw);
  } catch (error) {
    console.error('MCP API Key authentication failed:', error);
    return unauthorized();
  }
  if (!apiKey) return unauthorized();

  const handler = createMailMcpHandler({
    db,
    r2: c.env.MAIL_EML,
    env: c.env,
    apiKey
  });

  try {
    const response = await handler.fetch(c.req.raw);
    const headers = new Headers(response.headers);
    headers.set('Access-Control-Allow-Origin', '*');
    headers.append('Vary', 'Origin');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  } catch (error) {
    console.error('MCP handler failed:', error);
    return Response.json(
      { error: 'server_error', error_description: 'MCP 请求处理失败' },
      { status: 500 }
    );
  }
});

export default router;
