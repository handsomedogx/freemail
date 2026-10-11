import { Hono } from 'hono';
import { buildOpenApiSpec } from '../openapi/spec.js';

const router = new Hono();
const SWAGGER_UI_VERSION = '5.17.14';

export function renderApiDocsHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Freemail Mail API interactive OpenAPI documentation">
  <title>Freemail Mail API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css">
  <style>
    html { box-sizing: border-box; overflow-y: scroll; }
    *, *::before, *::after { box-sizing: inherit; }
    body { margin: 0; background: #f6f8fb; }
    .api-docs-banner {
      background: #111827;
      color: #f9fafb;
      padding: 14px 24px;
      font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      display: flex;
      gap: 20px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }
    .api-docs-banner strong { font-size: 15px; }
    .api-docs-banner span { color: #cbd5e1; }
    .api-docs-banner a { color: #93c5fd; text-decoration: none; }
    .api-docs-banner a:hover { text-decoration: underline; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info { margin: 34px 0 24px; }
    .swagger-ui .scheme-container { box-shadow: none; border: 1px solid #e5e7eb; }
  </style>
</head>
<body>
  <div class="api-docs-banner">
    <div><strong>Freemail Mail API</strong> <span>REST API / OpenAPI 3.0</span></div>
    <div>
      <a href="/openapi.json" target="_blank" rel="noopener">OpenAPI JSON</a>
      &nbsp;·&nbsp;
      <a href="/" target="_blank" rel="noopener">Freemail</a>
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin="anonymous"></script>
  <script>
    window.addEventListener('load', function () {
      SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        filter: true,
        displayRequestDuration: true,
        persistAuthorization: false,
        withCredentials: true,
        docExpansion: 'list',
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 2,
        validatorUrl: null,
        presets: [
          SwaggerUIBundle.presets.apis
        ],
        layout: 'BaseLayout'
      });
    });
  </script>
</body>
</html>`;
}

function docsSecurityHeaders(c) {
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://unpkg.com; style-src 'self' 'unsafe-inline' https://unpkg.com; img-src 'self' data: https:; font-src 'self' data: https://unpkg.com; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
  c.header('Cache-Control', 'public, max-age=300');
}

router.get('/openapi.json', c => {
  const origin = new URL(c.req.url).origin;
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Cache-Control', 'public, max-age=300');
  return c.json(buildOpenApiSpec(origin));
});

router.options('/openapi.json', c => {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    }
  });
});

router.get('/docs', c => {
  docsSecurityHeaders(c);
  return c.html(renderApiDocsHtml());
});

router.get('/docs/', c => {
  docsSecurityHeaders(c);
  return c.html(renderApiDocsHtml());
});

export default router;
