import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
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

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not bind to a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("responses route aborts upstream request when client disconnects", async () => {
  let upstreamClosed = false;
  let upstreamStarted = false;
  let finishUpstream: (() => void) | undefined;
  const upstreamReleased = new Promise<void>((resolve) => {
    finishUpstream = resolve;
  });

  const upstream = http.createServer(async (request, response) => {
    upstreamStarted = true;
    request.on("aborted", () => {
      upstreamClosed = true;
      finishUpstream?.();
    });
    response.on("close", () => {
      upstreamClosed = true;
      finishUpstream?.();
    });
    request.resume();
    await upstreamReleased;
    if (!response.destroyed) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "resp_1", output: [] }));
    }
  });
  const upstreamPort = await listen(upstream);

  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      requestTimeoutMs: 5000
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address !== "string");

    const controller = new AbortController();
    const clientRequest = fetch(`http://127.0.0.1:${address.port}/responses`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ model: "gpt-5.4", input: "long task" }),
      signal: controller.signal
    }).catch((error: unknown) => error);

    for (let attempt = 0; attempt < 50 && !upstreamStarted; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamStarted, true);

    controller.abort();
    await clientRequest;

    for (let attempt = 0; attempt < 50 && !upstreamClosed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamClosed, true);
  } finally {
    finishUpstream?.();
    await app.close();
    await close(upstream);
  }
});
