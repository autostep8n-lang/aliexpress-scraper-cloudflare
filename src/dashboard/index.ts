/**
 * Minimal browser-facing landing page. Serves as the seed for the
 * Cloudflare Dashboard UI (routed worker frontend, static assets, etc.).
 */
export function handleDashboard(url: URL): Response {
  const baseUrl = `${url.protocol}//${url.host}`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Product Intelligence Platform</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; background: #0b1220; color: #e6edf3; }
      main { max-width: 42rem; margin: 0 auto; }
      h1 { font-size: 1.5rem; }
      code { background: #1c2333; padding: 0.15rem 0.4rem; border-radius: 4px; }
      a { color: #58a6ff; }
      ul { line-height: 1.8; }
    </style>
  </head>
  <body>
    <main>
      <h1>Product Intelligence Platform</h1>
      <p>Cloudflare Worker foundation is running.</p>
      <ul>
        <li>Health check: <a href="${baseUrl}/health">/health</a></li>
        <li>Supabase connection: <a href="${baseUrl}/health/supabase">/health/supabase</a></li>
        <li>Scraping API: <code>GET /api/scrape?url=&lt;product-url&gt;</code> (not implemented yet)</li>
      </ul>
    </main>
  </body>
</html>`;

  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
