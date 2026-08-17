/**
 * Minimal structured logging for the Worker. Logs are emitted as single-line
 * JSON so they stay parseable in the Cloudflare dashboard and log pipelines.
 * Never log secrets here.
 */

export interface RequestLog {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function logRequest(entry: RequestLog): void {
  console.log(JSON.stringify({ level: "info", event: "request", ...entry }));
}

export function logError(message: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ level: "error", event: "error", message, ...fields }));
}
