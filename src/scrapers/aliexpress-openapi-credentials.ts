import type { Env } from "../env";

export interface OpenApiCredentials {
  appKey: string;
  appSecret: string;
}

export function openApiCredentials(env: Env): OpenApiCredentials | undefined {
  const appKey = env.ALIEXPRESS_OPENAPI_KEY?.trim();
  const appSecret = env.ALIEXPRESS_OPENAPI_SECRET?.trim();
  if (!appKey || !appSecret) return undefined;
  return { appKey, appSecret };
}

export function hasOpenApiCredentials(env: Env): boolean {
  return openApiCredentials(env) !== undefined;
}
