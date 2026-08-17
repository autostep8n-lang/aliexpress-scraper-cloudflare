import { handleDashboard } from "./dashboard";
import { handleHealth, handleSupabaseHealth } from "./health";
import { findScraper } from "./scrapers/registry";
import type { Env } from "./env";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  switch (url.pathname) {
    case "/":
      return handleDashboard(url);

    case "/health":
      return handleHealth(env);

    case "/health/supabase":
      return handleSupabaseHealth(env);

    case "/api/scrape": {
      const target = url.searchParams.get("url");
      if (!target) {
        return json({ error: "Missing required 'url' query parameter" }, 400);
      }

      let parsed: URL;
      try {
        parsed = new URL(target);
      } catch {
        return json({ error: "Invalid 'url' query parameter" }, 400);
      }

      const scraper = findScraper(parsed);
      if (!scraper) {
        return json({ error: `No scraper registered for ${parsed.hostname} yet` }, 501);
      }

      const result = await scraper.scrape(parsed, env, ctx);
      return json(result);
    }

    default:
      if (url.pathname.startsWith("/api/")) {
        return json({ error: `Not implemented: ${url.pathname}` }, 501);
      }
      return json({ error: "Not Found" }, 404);
  }
}
