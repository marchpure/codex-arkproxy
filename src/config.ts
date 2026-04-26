import dotenv from "dotenv";
import { z } from "zod";
import type { ProxyConfig } from "./types.js";

dotenv.config();

const envSchema = z.object({
  PROXY_HOST: z.string().default("127.0.0.1"),
  PROXY_PORT: z.coerce.number().int().positive().default(8787),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  ARK_BASE_URL: z.string().url(),
  ARK_API_KEY: z.string().default(""),
  ARK_REGION: z.string().default(""),
  ARK_ENDPOINT: z.string().default(""),
  ARK_EXTRA_HEADERS_JSON: z.string().default("{}"),
  ARK_MODEL_DEFAULT: z.string().min(1),
  EXPOSE_MODELS: z.string().default("gpt-5.4,gpt-4.1,gpt-4.1-mini,doubao-seed-2-0-pro-260215,doubao-seed-2-0-mini-260215"),
  MODEL_MAP_JSON: z.string().default("{\"gpt-5.4\":\"doubao-seed-2-0-mini-260215\",\"gpt-4.1\":\"doubao-seed-2-0-pro-260215\",\"gpt-4.1-mini\":\"doubao-seed-2-0-mini-260215\",\"doubao-seed-2-0-pro-260215\":\"doubao-seed-2-0-pro-260215\",\"doubao-seed-2-0-mini-260215\":\"doubao-seed-2-0-mini-260215\"}"),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300000),
  STREAM_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  PROXY_AUTH_TOKEN: z.string().default("")
});

export function loadConfig(): ProxyConfig {
  const env = envSchema.parse(process.env);
  const parsedMap = z.record(z.string(), z.string()).parse(JSON.parse(env.MODEL_MAP_JSON));
  const extraHeaders = z.record(z.string(), z.string()).parse(JSON.parse(env.ARK_EXTRA_HEADERS_JSON));

  return {
    host: env.PROXY_HOST,
    port: env.PROXY_PORT,
    logLevel: env.LOG_LEVEL,
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
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
