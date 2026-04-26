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
  arkApiMode: "responses",
  arkApiKey: "ark-key",
  arkRegion: "",
  arkEndpoint: "",
  arkExtraHeaders: {},
  arkModelDefault: "doubao-seed-2-0-pro-260215",
  exposeModels: ["doubao-seed-2-0-pro-260215", "doubao-seed-2-0-mini-260215"],
  modelMap: {
    "doubao-seed-2-0-pro-260215": "doubao-seed-2-0-pro-260215",
    "doubao-seed-2-0-mini-260215": "doubao-seed-2-0-mini-260215"
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
    exposeModels: ["doubao-seed-2-0-pro-260215", "doubao-seed-2-0-mini-260215"],
    authEnabled: false,
    region: null,
    endpoint: null
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
        id: "doubao-seed-2-0-pro-260215",
        object: "model",
        created: 0,
        owned_by: "codex-ark-proxy"
      },
      {
        id: "doubao-seed-2-0-mini-260215",
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

test("responses route preserves upstream error status and body", async () => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(502, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "upstream unavailable" } }));
  });
  const upstreamPort = await listen(upstream);

  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`
    });

    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        input: "hi"
      }
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      error: {
        message: "upstream unavailable"
      }
    });
    assert.match(String(response.headers["content-type"]), /^application\/json/);
  } finally {
    await closeApp(app);
    await close(upstream);
  }
});

test("responses route returns 502 when upstream connection fails", async () => {
  const closedServer = http.createServer();
  const upstreamPort = await listen(closedServer);
  await close(closedServer);

  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`
    });

    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        input: "hi"
      }
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      error: {
        message: "Failed to connect to Ark upstream",
        type: "api_error",
        code: "ark_upstream_fetch_failed"
      }
    });
  } finally {
    await closeApp(app);
  }
});

test("streaming responses return 502 before SSE headers when upstream payload is invalid", async () => {
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end("not-json");
  });
  const upstreamPort = await listen(upstream);

  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`
    });

    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        stream: true,
        input: "hi"
      }
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      error: {
        message: "Ark returned an invalid streaming payload",
        type: "api_error",
        code: "ark_invalid_streaming_payload"
      }
    });
    assert.match(String(response.headers["content-type"]), /^application\/json/);
  } finally {
    await closeApp(app);
    await close(upstream);
  }
});

test("streaming responses emit SSE frames and done sentinel", async () => {
  const upstreamPayload = {
    id: "resp_stream_1",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "hello from stream" }]
      }
    ]
  };
  const upstream = http.createServer((request, response) => {
    request.resume();
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(upstreamPayload));
  });
  const upstreamPort = await listen(upstream);

  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`
    });

    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        stream: true,
        input: "hi"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /^text\/event-stream/);
    assert.match(response.body, /event: response\.created/);
    assert.match(response.body, /event: response\.output_text\.delta/);
    assert.match(response.body, /data: \[DONE\]/);
  } finally {
    await closeApp(app);
    await close(upstream);
  }
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
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function closeApp(app: Fastify.FastifyInstance): Promise<void> {
  app.server.closeAllConnections();
  await app.close();
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
    await closeApp(app);
    await close(upstream);
  }
});

test("responses route times out stalled upstream response bodies", async () => {
  let upstreamClosed = false;
  let finishUpstream: (() => void) | undefined;
  const upstreamReleased = new Promise<void>((resolve) => {
    finishUpstream = resolve;
  });

  const upstream = http.createServer(async (request, response) => {
    request.resume();
    response.on("close", () => {
      upstreamClosed = true;
      finishUpstream?.();
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    await upstreamReleased;
    if (!response.destroyed) {
      response.end("\"id\":\"resp_1\",\"output\":[]}");
    }
  });
  upstream.keepAliveTimeout = 1;
  const upstreamPort = await listen(upstream);

  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`,
      requestTimeoutMs: 100
    });

    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        input: "hi"
      }
    });

    assert.equal(response.statusCode, 504);
    assert.deepEqual(response.json(), {
      error: {
        message: "Ark request timed out",
        type: "timeout_error",
        code: "ark_request_timeout"
      }
    });
    for (let attempt = 0; attempt < 50 && !upstreamClosed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(upstreamClosed, true);
  } finally {
    finishUpstream?.();
    await closeApp(app);
    await close(upstream);
  }
});

test("responses route handles concurrent requests without leaving active upstream work", async () => {
  let activeRequests = 0;
  let maxActiveRequests = 0;
  let completedRequests = 0;
  const upstream = http.createServer(async (request, response) => {
    request.resume();
    activeRequests += 1;
    maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
    await new Promise((resolve) => setTimeout(resolve, 5));
    activeRequests -= 1;
    completedRequests += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `resp_${completedRequests}`,
      output: [
        {
          type: "message",
          id: "msg_1",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }]
        }
      ]
    }));
  });
  const upstreamPort = await listen(upstream);

  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`
    });

    const startedAt = performance.now();
    const responses = await Promise.all(Array.from({ length: 100 }, (_, index) => app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        stream: index % 2 === 0,
        input: `task ${index}`
      }
    })));
    const elapsedMs = performance.now() - startedAt;

    assert.equal(responses.every((response) => response.statusCode === 200), true);
    assert.equal(completedRequests, 100);
    assert.equal(activeRequests, 0);
    assert.ok(maxActiveRequests > 1);
    assert.ok(elapsedMs < 5000, `concurrent smoke took ${elapsedMs}ms`);
  } finally {
    await closeApp(app);
    await close(upstream);
  }
});
