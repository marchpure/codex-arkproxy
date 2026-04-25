export type ModelMap = Record<string, string>;

export type ProxyConfig = {
  host: string;
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  arkBaseUrl: string;
  arkApiKey: string;
  arkModelDefault: string;
  exposeModels: string[];
  modelMap: ModelMap;
  requestTimeoutMs: number;
  streamIdleTimeoutMs: number;
  proxyAuthToken: string;
};

export type HealthResponse = {
  ok: true;
  service: "codex-ark-proxy";
  arkBaseUrl: string;
  defaultModel: string;
  exposeModels: string[];
  authEnabled: boolean;
};

export type ResponsesRequest = {
  model?: string;
  stream?: boolean;
  input?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  instructions?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
};

export type ArkRequestContext = {
  upstreamModel: string;
  downstreamModel: string;
  requestId: string;
  stream: boolean;
  signal?: AbortSignal;
};
