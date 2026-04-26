import dotenv from "dotenv";
import { z } from "zod";
import type { ProxyConfig } from "./types.js";

dotenv.config();

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function isLocalProxyUrl(baseUrl: string, host: string, port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const normalizedHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const configuredHosts = new Set([normalizedHost, "127.0.0.1", "localhost"]);
  const parsedPort = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));

  return parsedPort === port && localHosts.has(parsed.hostname) && configuredHosts.has(normalizedHost);
}

const envSchema = z.object({
  PROXY_HOST: z.string().default("127.0.0.1"),
  PROXY_PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ARK_BASE_URL: z.string().url(),
  ARK_API_MODE: z.literal("responses").default("responses"),
  ARK_API_KEY: z.string().default(""),
  ARK_REGION: z.string().default(""),
  ARK_ENDPOINT: z.string().default(""),
  ARK_EXTRA_HEADERS_JSON: z.string().default("{}"),
  ARK_MODEL_DEFAULT: z.string().min(1),
  EXPOSE_MODELS: z.string().default("doubao-seed-2-0-pro-260215,doubao-seed-2-0-mini-260215"),
  MODEL_MAP_JSON: z.string().default("{\"doubao-seed-2-0-pro-260215\":\"doubao-seed-2-0-pro-260215\",\"doubao-seed-2-0-mini-260215\":\"doubao-seed-2-0-mini-260215\"}"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  PROXY_AUTH_TOKEN: z.string().default("")
});

export function loadConfig(): ProxyConfig {
  const env = envSchema.parse(process.env);
  const parsedMap = z.record(z.string(), z.string()).parse(JSON.parse(env.MODEL_MAP_JSON));
  const extraHeaders = z.record(z.string(), z.string()).parse(JSON.parse(env.ARK_EXTRA_HEADERS_JSON));
  const arkBaseUrl = normalizeBaseUrl(env.ARK_BASE_URL);

  if (isLocalProxyUrl(arkBaseUrl, env.PROXY_HOST, env.PROXY_PORT)) {
    throw new Error(
      `ARK_BASE_URL points to the local proxy (${arkBaseUrl}). ` +
      "Set ARK_BASE_URL to the real Ark Responses API endpoint, for example https://ark.cn-beijing.volces.com/api/v3."
    );
  }

  return {
    host: env.PROXY_HOST,
    port: env.PROXY_PORT,
    logLevel: env.LOG_LEVEL,
    arkBaseUrl,
    arkApiMode: env.ARK_API_MODE,
    arkApiKey: env.ARK_API_KEY,
    arkRegion: env.ARK_REGION,
    arkEndpoint: env.ARK_ENDPOINT,
    arkExtraHeaders: extraHeaders,
    arkModelDefault: env.ARK_MODEL_DEFAULT,
    exposeModels: env.EXPOSE_MODELS.split(",").map((item) => item.trim()).filter(Boolean),
    modelMap: parsedMap,
    requestTimeoutMs: env.REQUEST_TIMEOUT_MS,
    streamIdleTimeoutMs: env.STREAM_IDLE_TIMEOUT_MS,
    proxyAuthToken: env.PROXY_AUTH_TOKEN
  };
}
