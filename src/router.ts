import { handleDashboard, handleOpportunitiesDashboard, handleProductDetailDashboard } from "./dashboard";
import { handleAlertList } from "./api/alerts";
import { handleDiscover } from "./api/discover";
import { handleGoogleTrends } from "./api/google-trends";
import { handleInstagram, handleInstagramOAuthCallback, handleInstagramOAuthStart } from "./api/instagram";
import { handleInstagramMeSmoke } from "./api/instagram-me";
import { handleOpportunityList } from "./api/opportunities";
import { handleReddit } from "./api/reddit";
import { handleYouTube } from "./api/youtube";
import { handleHealth, handleSupabaseHealth } from "./health";
import { handleProductDetail, handleProductIngest, handleProductList } from "./api/products";
import { handleScrape } from "./api/scrape";
import { jsonError, methodNotAllowed, notFound, notImplemented } from "./utils/http";
import { createRequestId, logError, logRequest } from "./logging";
import { parseProductId } from "./dashboard/assemble";
import type { Env } from "./env";

/** Returns a 405 response when the request is not a GET/HEAD, else null. */
function guardGet(request: Request, requestId: string): Response | null {
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }
  return methodNotAllowed(["GET", "HEAD"], requestId);
}

function withRequestId(response: Response, requestId: string): Response {
  response.headers.set("x-request-id", requestId);
  return response;
}

export async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const requestId = createRequestId();
  const startedAt = Date.now();
  const pathname = new URL(request.url).pathname;

  try {
    const response = await dispatch(request, env, ctx, requestId);
    logRequest({
      requestId,
      method: request.method,
      path: pathname,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return withRequestId(response, requestId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError("unhandled request error", { requestId, method: request.method, path: pathname, message });
    return withRequestId(jsonError(500, "Internal Server Error", "INTERNAL_ERROR", requestId), requestId);
  }
}

async function dispatch(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const url = new URL(request.url);

  switch (url.pathname) {
    case "/": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleDashboard(url, env);
    }

    case "/health": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleHealth(env);
    }

    case "/health/supabase": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleSupabaseHealth(env);
    }

    case "/api/scrape": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleScrape(request, env, ctx, requestId);
    }

    case "/api/discover": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleDiscover(request, env, ctx, requestId);
    }

    case "/api/market/google-trends": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleGoogleTrends(request, env, ctx, requestId);
    }

    case "/api/market/reddit": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleReddit(request, env, ctx, requestId);
    }

    case "/api/market/youtube": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleYouTube(request, env, ctx, requestId);
    }

    case "/api/market/instagram": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleInstagram(request, env, ctx, requestId);
    }

    case "/api/market/instagram/oauth": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleInstagramOAuthStart(request, env, requestId);
    }

    case "/api/market/instagram/oauth/callback": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleInstagramOAuthCallback(request, env, requestId);
    }

    case "/api/tmp/instagram-me": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleInstagramMeSmoke(env, requestId);
    }

    case "/api/products": {
      if (request.method === "GET" || request.method === "HEAD") {
        return handleProductList(request, env, requestId);
      }
      if (request.method !== "POST") {
        return methodNotAllowed(["GET", "HEAD", "POST"], requestId);
      }
      return handleProductIngest(request, env, ctx, requestId);
    }

    case "/api/opportunities": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleOpportunityList(request, env, requestId);
    }

    case "/api/alerts": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleAlertList(request, env, requestId);
    }

    case "/opportunities": {
      const denied = guardGet(request, requestId);
      if (denied) return denied;
      return handleOpportunitiesDashboard(url, env);
    }

    default: {
      const productApiId = matchSingleSegment(url.pathname, "/api/products/");
      if (productApiId !== null) {
        const denied = guardGet(request, requestId);
        if (denied) return denied;
        return handleProductDetail(env, requestId, productApiId);
      }
      const productPageId = matchSingleSegment(url.pathname, "/products/");
      if (productPageId !== null) {
        const denied = guardGet(request, requestId);
        if (denied) return denied;
        return handleProductDetailDashboard(url, env, productPageId);
      }
      if (url.pathname.startsWith("/api/")) {
        return notImplemented(`Not implemented: ${url.pathname}`, requestId);
      }
      return notFound("Not Found", requestId);
    }
  }
}

function matchSingleSegment(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  return parseProductId(rest);
}
