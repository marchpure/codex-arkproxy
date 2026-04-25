import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify from "fastify";
import { registerRoutes } from "../src/routes.ts";

const baseConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "error" as const,
  arkBaseUrl: "https://ark.example.com",
  arkApiKey: "ark-key",
  arkModelDefault: "doubao-seed-2-0-pro-260215",
  exposeModels: ["gpt-5.4", "gpt-4.1", "doubao-seed-2-0-pro-260215"],
  modelMap: {
    "gpt-5.4": "doubao-seed-2-0-mini-260215",
    "gpt-4.1": "doubao-seed-2-0-pro-260215"
  },
  requestTimeoutMs: 1000,
  streamIdleTimeoutMs: 1000,
  proxyAuthToken: ""
};

type UpstreamHandler = (request: http.IncomingMessage, response: http.ServerResponse) => void | Promise<void>;

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

async function withProxy(handler: UpstreamHandler, run: (app: Fastify.FastifyInstance, seenBodies: string[]) => Promise<void>, config = {}) {
  const seenBodies: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    await new Promise<void>((resolve) => request.on("end", resolve));
    seenBodies.push(body);
    await handler(request, response);
  });
  const upstreamPort = await listen(upstream);
  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      ...config,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`
    });
    await run(app, seenBodies);
  } finally {
    app.server.closeAllConnections();
    await app.close();
    await close(upstream);
  }
}

function responsePayload(text = "ok", extraOutput: unknown[] = []) {
  return {
    id: "resp_test",
    output: [
      ...extraOutput,
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text }]
      }
    ]
  };
}

function okJson(payload: unknown): UpstreamHandler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
}

const authCases = [
  {
    name: "accepts bearer auth token",
    headers: { authorization: "Bearer secret" },
    expectedStatus: 200
  },
  {
    name: "accepts x-api-key auth token",
    headers: { "x-api-key": "secret" },
    expectedStatus: 200
  },
  {
    name: "rejects malformed bearer token",
    headers: { authorization: "Bearer wrong" },
    expectedStatus: 401
  },
  {
    name: "rejects missing auth token",
    headers: {},
    expectedStatus: 401
  },
  {
    name: "rejects lowercase bearer with bad token",
    headers: { authorization: "bearer bad" },
    expectedStatus: 401
  },
  {
    name: "rejects basic auth",
    headers: { authorization: "Basic secret" },
    expectedStatus: 401
  }
];

for (const testCase of authCases) {
  test(`auth ${testCase.name}`, async () => {
    await withProxy(okJson(responsePayload()), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        headers: testCase.headers,
        payload: {
          model: "gpt-5.4",
          input: "hi"
        }
      });
      assert.equal(response.statusCode, testCase.expectedStatus);
    }, { proxyAuthToken: "secret" });
  });
}

const modelCases = [
  {
    name: "maps gpt-5.4 to mini",
    requestedModel: "gpt-5.4",
    expectedModel: "doubao-seed-2-0-mini-260215"
  },
  {
    name: "maps gpt-4.1 to pro",
    requestedModel: "gpt-4.1",
    expectedModel: "doubao-seed-2-0-pro-260215"
  },
  {
    name: "passes through native doubao model",
    requestedModel: "doubao-seed-2-0-pro-260215",
    expectedModel: "doubao-seed-2-0-pro-260215"
  },
  {
    name: "uses default model when omitted",
    requestedModel: undefined,
    expectedModel: "doubao-seed-2-0-pro-260215"
  },
  {
    name: "trims requested model",
    requestedModel: " gpt-5.4 ",
    expectedModel: "doubao-seed-2-0-mini-260215"
  },
  {
    name: "passes through unknown model",
    requestedModel: "custom-model",
    expectedModel: "custom-model"
  }
];

for (const testCase of modelCases) {
  test(`model routing ${testCase.name}`, async () => {
    await withProxy(okJson(responsePayload()), async (app, seenBodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          ...(testCase.requestedModel ? { model: testCase.requestedModel } : {}),
          input: "hi"
        }
      });
      assert.equal(response.statusCode, 200);
      const downstream = JSON.parse(seenBodies[0] ?? "{}");
      assert.equal(downstream.model, testCase.expectedModel);
    });
  });
}

const bodySanitizationCases = [
  {
    name: "drops unsupported top-level fields",
    payload: {
      model: "gpt-5.4",
      input: "hi",
      unsupported: "drop-me"
    },
    assertBody: (body: Record<string, unknown>) => {
      assert.equal("unsupported" in body, false);
    }
  },
  {
    name: "forces downstream stream false",
    payload: {
      model: "gpt-5.4",
      stream: true,
      input: "hi"
    },
    assertBody: (body: Record<string, unknown>) => {
      assert.equal(body.stream, false);
    }
  },
  {
    name: "strips external web access from tools",
    payload: {
      model: "gpt-5.4",
      input: "hi",
      tools: [{ type: "web_search", external_web_access: true }]
    },
    assertBody: (body: Record<string, unknown>) => {
      assert.deepEqual(body.tools, [{ type: "web_search" }]);
    }
  },
  {
    name: "adds missing completed status for replayed items",
    payload: {
      model: "gpt-5.4",
      input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }]
    },
    assertBody: (body: Record<string, unknown>) => {
      assert.deepEqual(body.input, [{ type: "function_call_output", call_id: "call_1", output: "ok", status: "completed" }]);
    }
  },
  {
    name: "preserves allowed metadata",
    payload: {
      model: "gpt-5.4",
      input: "hi",
      metadata: { trace_id: "abc" }
    },
    assertBody: (body: Record<string, unknown>) => {
      assert.deepEqual(body.metadata, { trace_id: "abc" });
    }
  },
  {
    name: "drops unsupported custom tool",
    payload: {
      model: "gpt-5.4",
      input: "hi",
      tools: [{ type: "custom", name: "bad" }, { type: "function", name: "ok" }]
    },
    assertBody: (body: Record<string, unknown>) => {
      assert.deepEqual(body.tools, [{ type: "function", name: "ok" }]);
    }
  },
  {
    name: "strips nested verbosity",
    payload: {
      model: "gpt-5.4",
      input: "hi",
      text: { verbosity: "low", format: { type: "text" } }
    },
    assertBody: (body: Record<string, unknown>) => {
      assert.deepEqual(body.text, { format: { type: "text" } });
    }
  }
];

for (const testCase of bodySanitizationCases) {
  test(`downstream body ${testCase.name}`, async () => {
    await withProxy(okJson(responsePayload()), async (app, seenBodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: testCase.payload
      });
      assert.equal(response.statusCode, 200);
      testCase.assertBody(JSON.parse(seenBodies[0] ?? "{}"));
    });
  });
}

const streamOutputCases = [
  {
    name: "message text",
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "hello" }]
      }
    ],
    expectedEvent: "response.output_text.delta"
  },
  {
    name: "reasoning summary",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "thinking" }]
      }
    ],
    expectedEvent: "response.reasoning_summary_text.delta"
  },
  {
    name: "function call",
    output: [
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "tool",
        arguments: "{\"x\":1}"
      }
    ],
    expectedEvent: "response.function_call_arguments.delta"
  },
  {
    name: "generic item",
    output: [
      {
        type: "unknown_item",
        id: "item_1"
      }
    ],
    expectedEvent: "response.output_item.done"
  },
  {
    name: "refusal message",
    output: [
      {
        type: "message",
        id: "msg_refusal",
        role: "assistant",
        content: [{ type: "refusal", refusal: "cannot comply" }]
      }
    ],
    expectedEvent: "response.refusal.delta"
  },
  {
    name: "multi-part message",
    output: [
      {
        type: "message",
        id: "msg_multi",
        role: "assistant",
        content: [
          { type: "output_text", text: "hello" },
          { type: "output_text", text: "world" }
        ]
      }
    ],
    expectedEvent: "response.output_text.done"
  }
];

for (const testCase of streamOutputCases) {
  test(`streaming emits native-like events for ${testCase.name}`, async () => {
    await withProxy(okJson({ id: "resp_stream", output: testCase.output }), async (app) => {
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
      assert.match(response.body, new RegExp(`event: ${testCase.expectedEvent.replaceAll(".", "\\.")}`));
      assert.match(response.body, /event: response\.completed/);
      assert.match(response.body, /data: \[DONE\]/);
    });
  });
}

const longTaskCases = [
  {
    name: "large non-stream answer",
    stream: false,
    textSize: 32_000
  },
  {
    name: "large stream answer",
    stream: true,
    textSize: 32_000
  },
  {
    name: "large tool arguments stream",
    stream: true,
    toolArgsSize: 24_000
  },
  {
    name: "long reasoning stream",
    stream: true,
    reasoningSize: 24_000
  },
  {
    name: "very large non-stream answer",
    stream: false,
    textSize: 96_000
  },
  {
    name: "very large stream answer",
    stream: true,
    textSize: 96_000
  }
];

for (const testCase of longTaskCases) {
  test(`long task handles ${testCase.name}`, async () => {
    const output: unknown[] = [];
    if (testCase.reasoningSize) {
      output.push({
        type: "reasoning",
        id: "rs_long",
        summary: [{ type: "summary_text", text: "r".repeat(testCase.reasoningSize) }]
      });
    }
    if (testCase.toolArgsSize) {
      output.push({
        type: "function_call",
        id: "fc_long",
        call_id: "call_long",
        name: "tool",
        arguments: JSON.stringify({ payload: "a".repeat(testCase.toolArgsSize) })
      });
    }
    output.push({
      type: "message",
      id: "msg_long",
      role: "assistant",
      content: [{ type: "output_text", text: "x".repeat(testCase.textSize ?? 1024) }]
    });

    await withProxy(okJson({ id: "resp_long", output }), async (app) => {
      const startedAt = performance.now();
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          model: "gpt-5.4",
          stream: testCase.stream,
          input: "long task"
        }
      });
      const elapsedMs = performance.now() - startedAt;
      assert.equal(response.statusCode, 200);
      assert.ok(response.body.length > 20_000);
      assert.ok(elapsedMs < 2000, `long task ${testCase.name} took ${elapsedMs}ms`);
    });
  });
}

const upstreamErrorCases = [
  {
    name: "text/plain 429",
    status: 429,
    contentType: "text/plain",
    body: "rate limited"
  },
  {
    name: "json 500",
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: "server error" } })
  },
  {
    name: "empty 503",
    status: 503,
    contentType: "text/plain",
    body: ""
  },
  {
    name: "html 504",
    status: 504,
    contentType: "text/html",
    body: "<h1>timeout</h1>"
  },
  {
    name: "json 401",
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: "bad key" } })
  },
  {
    name: "text 418",
    status: 418,
    contentType: "text/plain",
    body: "teapot"
  }
];

for (const testCase of upstreamErrorCases) {
  test(`upstream error passthrough ${testCase.name}`, async () => {
    await withProxy((_request, response) => {
      response.writeHead(testCase.status, { "content-type": testCase.contentType });
      response.end(testCase.body);
    }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          model: "gpt-5.4",
          input: "hi"
        }
      });
      assert.equal(response.statusCode, testCase.status);
      assert.equal(response.body, testCase.body);
      assert.match(String(response.headers["content-type"]), new RegExp(testCase.contentType.replace("/", "\\/")));
    });
  });
}

const invalidRequestCases = [
  {
    name: "null body",
    payload: null
  },
  {
    name: "string body",
    payload: "not object"
  },
  {
    name: "number body",
    payload: 42
  },
  {
    name: "array body",
    payload: []
  },
  {
    name: "boolean body",
    payload: true
  },
  {
    name: "empty string json body",
    payload: ""
  }
];

for (const testCase of invalidRequestCases) {
  test(`invalid request rejects ${testCase.name}`, async () => {
    const app = Fastify();
    await registerRoutes(app, baseConfig);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: testCase.payload
      });
      assert.equal(response.statusCode, 400);
      assert.deepEqual(response.json(), {
        error: {
          message: "Invalid responses request body",
          type: "invalid_request_error",
          code: "invalid_body"
        }
      });
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });
}

const concurrencyCases = [
  {
    name: "short 50 non-stream",
    count: 50,
    streamEvery: 0
  },
  {
    name: "short 50 stream",
    count: 50,
    streamEvery: 1
  },
  {
    name: "mixed 150",
    count: 150,
    streamEvery: 3
  },
  {
    name: "mixed 250",
    count: 250,
    streamEvery: 2
  },
  {
    name: "large-ish 300 mixed",
    count: 300,
    streamEvery: 4
  }
];

for (const testCase of concurrencyCases) {
  test(`performance concurrent ${testCase.name}`, async () => {
    let activeRequests = 0;
    let completedRequests = 0;
    await withProxy(async (_request, response) => {
      activeRequests += 1;
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeRequests -= 1;
      completedRequests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responsePayload("ok")));
    }, async (app) => {
      const startedAt = performance.now();
      const responses = await Promise.all(Array.from({ length: testCase.count }, (_, index) => app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          model: "gpt-5.4",
          stream: testCase.streamEvery > 0 && index % testCase.streamEvery === 0,
          input: `task ${index}`
        }
      })));
      const elapsedMs = performance.now() - startedAt;
      assert.equal(responses.every((response) => response.statusCode === 200), true);
      assert.equal(completedRequests, testCase.count);
      assert.equal(activeRequests, 0);
      assert.ok(elapsedMs < 5000, `${testCase.name} took ${elapsedMs}ms`);
    });
  });
}

const endpointCases = [
  {
    name: "health reports auth disabled",
    url: "/healthz",
    assertResponse: (response: { statusCode: number; json(): unknown }) => {
      assert.equal(response.statusCode, 200);
      assert.equal((response.json() as { authEnabled: boolean }).authEnabled, false);
    }
  },
  {
    name: "models expose configured ids",
    url: "/v1/models",
    assertResponse: (response: { statusCode: number; json(): unknown }) => {
      assert.equal(response.statusCode, 200);
      assert.deepEqual((response.json() as { data: Array<{ id: string }> }).data.map((model) => model.id), baseConfig.exposeModels);
    }
  },
  {
    name: "unknown route returns 404",
    url: "/unknown",
    assertResponse: (response: { statusCode: number; json(): unknown }) => {
      assert.equal(response.statusCode, 404);
    }
  }
];

for (const testCase of endpointCases) {
  test(`metadata endpoint ${testCase.name}`, async () => {
    const app = Fastify();
    await registerRoutes(app, baseConfig);
    try {
      const response = await app.inject({
        method: "GET",
        url: testCase.url
      });
      testCase.assertResponse(response);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });
}

test("metadata endpoint health reports auth enabled", async () => {
  const app = Fastify();
  await registerRoutes(app, {
    ...baseConfig,
    proxyAuthToken: "secret"
  });
  try {
    const response = await app.inject({
      method: "GET",
      url: "/healthz"
    });
    assert.equal(response.statusCode, 200);
    assert.equal((response.json() as { authEnabled: boolean }).authEnabled, true);
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});

const responsePathCases = [
  {
    name: "root responses path",
    url: "/responses"
  },
  {
    name: "v1 responses path",
    url: "/v1/responses"
  }
];

for (const testCase of responsePathCases) {
  test(`response path supports ${testCase.name}`, async () => {
    await withProxy(okJson(responsePayload("path ok")), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: testCase.url,
        payload: {
          model: "gpt-5.4",
          input: "hi"
        }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().id, "resp_test");
    });
  });
}

test("auth prefers authorization bearer over mismatched x-api-key", async () => {
  await withProxy(okJson(responsePayload()), async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/responses",
      headers: {
        authorization: "Bearer secret",
        "x-api-key": "wrong"
      },
      payload: {
        model: "gpt-5.4",
        input: "hi"
      }
    });
    assert.equal(response.statusCode, 200);
  }, { proxyAuthToken: "secret" });
});

test("long task preserves unicode content", async () => {
  const text = "你好 Привет مرحبا 🚀 ".repeat(2000);
  await withProxy(okJson(responsePayload(text)), async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        input: "unicode"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().output[0].content[0].text, text);
  });
});

test("long stream preserves unicode content in SSE", async () => {
  const text = "你好 🚀 ".repeat(1000);
  await withProxy(okJson(responsePayload(text)), async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        stream: true,
        input: "unicode"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.body, /你好/);
    assert.match(response.body, /data: \[DONE\]/);
  });
});

test("non-stream request with stream false remains non-stream", async () => {
  await withProxy(okJson(responsePayload("non-stream")), async (app) => {
    const response = await app.inject({
      method: "POST",
      url: "/responses",
      payload: {
        model: "gpt-5.4",
        stream: false,
        input: "hi"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /^application\/json/);
    assert.equal(response.json().id, "resp_test");
  });
});

const timeoutCases = [
  {
    name: "slow headers",
    delayBeforeHeadersMs: 120,
    partialBody: false
  },
  {
    name: "slow body",
    delayBeforeHeadersMs: 0,
    partialBody: true
  }
];

for (const testCase of timeoutCases) {
  test(`timeout handles ${testCase.name}`, async () => {
    let closed = false;
    await withProxy(async (_request, response) => {
      response.on("close", () => {
        closed = true;
      });
      if (testCase.delayBeforeHeadersMs) {
        await new Promise((resolve) => setTimeout(resolve, testCase.delayBeforeHeadersMs));
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (testCase.partialBody) {
        response.write("{");
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
      if (!response.destroyed) {
        response.end(JSON.stringify(responsePayload()));
      }
    }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          model: "gpt-5.4",
          input: "slow task"
        }
      });
      assert.equal(response.statusCode, 504);
      assert.equal(response.json().error.code, "ark_request_timeout");
    }, { requestTimeoutMs: 50 });
    for (let attempt = 0; attempt < 50 && !closed; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(closed, true);
  });
}

const cancellationCases = [
  {
    name: "non-stream client cancel",
    stream: false
  },
  {
    name: "stream client cancel",
    stream: true
  }
];

for (const testCase of cancellationCases) {
  test(`cancellation closes upstream for ${testCase.name}`, async () => {
    let upstreamClosed = false;
    let upstreamStarted = false;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = http.createServer(async (request, response) => {
      upstreamStarted = true;
      request.resume();
      response.on("close", () => {
        upstreamClosed = true;
        release?.();
      });
      await released;
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responsePayload()));
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
      const request = fetch(`http://127.0.0.1:${address.port}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", stream: testCase.stream, input: "cancel" }),
        signal: controller.signal
      }).catch((error: unknown) => error);
      for (let attempt = 0; attempt < 50 && !upstreamStarted; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(upstreamStarted, true);
      controller.abort();
      await request;
      for (let attempt = 0; attempt < 50 && !upstreamClosed; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(upstreamClosed, true);
    } finally {
      release?.();
      app.server.closeAllConnections();
      await app.close();
      await close(upstream);
    }
  });
}
