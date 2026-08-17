/**
 * Shared JSON response helpers. Every API response should be JSON and carry a
 * stable error `code` that clients can rely on.
 */

export function jsonOk(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

export function jsonError(status: number, message: string, code?: string, requestId?: string): Response {
  const body: { error: string; code?: string; requestId?: string } = { error: message };
  if (code) body.code = code;
  if (requestId) body.requestId = requestId;
  return Response.json(body, { status });
}

export function methodNotAllowed(allowed: string[], requestId?: string): Response {
  const body: { error: string; code: string; requestId?: string } = {
    error: "Method not allowed",
    code: "METHOD_NOT_ALLOWED",
  };
  if (requestId) body.requestId = requestId;
  return Response.json(body, { status: 405, headers: { Allow: allowed.join(", ") } });
}

export function notFound(message: string, requestId?: string): Response {
  return jsonError(404, message, "NOT_FOUND", requestId);
}

export function notImplemented(message: string, requestId?: string): Response {
  return jsonError(501, message, "NOT_IMPLEMENTED", requestId);
}
