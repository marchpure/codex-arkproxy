import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { registerRoutes } from "../src/routes.ts";

const baseConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "info" as const,
  arkBaseUrl: "https://ark.example.com",
  arkApiKey: "ark-key",
  arkModelDefault: "doubao-seed-2-0-pro-260215",
  exposeModels: ["gpt-5.4", "doubao-seed-2-0-pro-260215"],
  modelMap: {
    "gpt-5.4": "doubao-seed-2-0-mini-260215"
  },
  requestTimeoutMs: 1000,
  streamIdleTimeoutMs: 1000,
  proxyAuthToken: ""
};

test("health and models routes expose proxy metadata", async () => {
  const app = Fastify();
  await registerRoutes(app, baseConfig);

  const health = await app.inject({
    method: "GET",
    url: "/healthz"
  });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(health.json(), {
    ok: true,
    service: "codex-ark-proxy",
    arkBaseUrl: "https://ark.example.com",
    defaultModel: "doubao-seed-2-0-pro-260215",
    exposeModels: ["gpt-5.4", "doubao-seed-2-0-pro-260215"],
    authEnabled: false
  });

  const models = await app.inject({
    method: "GET",
    url: "/v1/models"
  });
  assert.equal(models.statusCode, 200);
  assert.deepEqual(models.json(), {
    object: "list",
    data: [
      {
        id: "gpt-5.4",
        object: "model",
        created: 0,
        owned_by: "codex-ark-proxy"
      },
      {
        id: "doubao-seed-2-0-pro-260215",
        object: "model",
        created: 0,
        owned_by: "codex-ark-proxy"
      }
    ]
  });

  await app.close();
});

test("responses route returns configuration error when ARK key is missing", async () => {
  const app = Fastify();
  await registerRoutes(app, {
    ...baseConfig,
    arkApiKey: ""
  });

  const response = await app.inject({
    method: "POST",
    url: "/responses",
    payload: {
      model: "gpt-5.4",
      input: "hi"
    }
  });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    error: {
      message: "ARK_API_KEY is not configured",
      type: "configuration_error",
      code: "missing_ark_api_key"
    }
  });

  await app.close();
});

test("responses route enforces proxy auth when configured", async () => {
  const app = Fastify();
  await registerRoutes(app, {
    ...baseConfig,
    proxyAuthToken: "secret"
  });

  const response = await app.inject({
    method: "POST",
    url: "/responses",
    payload: {
      input: "hi"
    }
  });

  assert.equal(response.statusCode, 401);
  assert.deepEqual(response.json(), {
    error: {
      message: "Invalid proxy auth token",
      type: "authentication_error",
      code: "invalid_proxy_token"
    }
  });

  await app.close();
});
