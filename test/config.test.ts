import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("loadConfig normalizes base URL and parses exposed models and model map", () => {
  const originalEnv = {
    ...process.env
  };

  process.env.PROXY_HOST = "0.0.0.0";
  process.env.PROXY_PORT = "9999";
  process.env.LOG_LEVEL = "debug";
  process.env.ARK_BASE_URL = "https://ark.example.com///";
  process.env.ARK_API_MODE = "chat_completions";
  process.env.ARK_API_KEY = "test-key";
  process.env.ARK_REGION = "sg";
  process.env.ARK_ENDPOINT = "ep-123";
  process.env.ARK_EXTRA_HEADERS_JSON = "{\"x-custom\":\"custom-value\"}";
  process.env.ARK_MODEL_DEFAULT = "doubao-default";
  process.env.EXPOSE_MODELS = "a, b , ,c";
  process.env.MODEL_MAP_JSON = "{\"a\":\"aa\",\"b\":\"bb\"}";
  process.env.REQUEST_TIMEOUT_MS = "1234";
  process.env.STREAM_IDLE_TIMEOUT_MS = "4321";
  process.env.PROXY_AUTH_TOKEN = "token";

  try {
    assert.deepEqual(loadConfig(), {
      host: "0.0.0.0",
      port: 9999,
      logLevel: "debug",
      arkBaseUrl: "https://ark.example.com",
      arkApiMode: "chat_completions",
      arkApiKey: "test-key",
      arkRegion: "sg",
      arkEndpoint: "ep-123",
      arkExtraHeaders: {
        "x-custom": "custom-value"
      },
      arkModelDefault: "doubao-default",
      exposeModels: ["a", "b", "c"],
      modelMap: {
        a: "aa",
        b: "bb"
      },
      requestTimeoutMs: 1234,
      streamIdleTimeoutMs: 4321,
      proxyAuthToken: "token"
    });
  } finally {
    process.env = originalEnv;
  }
});
