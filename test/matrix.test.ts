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
  arkModelDefault: "default-model",
  exposeModels: ["gpt-5.4", "gpt-4.1", "default-model"],
  modelMap: {
    "gpt-5.4": "downstream-mini",
    "gpt-4.1": "downstream-pro"
  },
  requestTimeoutMs: 1000,
  streamIdleTimeoutMs: 1000,
  proxyAuthToken: ""
};

type Handler = (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void | Promise<void>;

function payload(text = "ok", output: unknown[] = []) {
  return {
    id: "resp_matrix",
    output: output.length > 0 ? output : [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text }]
      }
    ]
  };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("server did not bind"));
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

async function withProxy(handler: Handler, run: (app: Fastify.FastifyInstance, bodies: string[]) => Promise<void>, config = {}) {
  const bodies: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    await new Promise<void>((resolve) => request.on("end", resolve));
    bodies.push(body);
    await handler(request, response, body);
  });
  const upstreamPort = await listen(upstream);
  const app = Fastify();
  try {
    await registerRoutes(app, {
      ...baseConfig,
      ...config,
      arkBaseUrl: `http://127.0.0.1:${upstreamPort}`
    });
    await run(app, bodies);
  } finally {
    app.server.closeAllConnections();
    await app.close();
    await close(upstream);
  }
}

function jsonOk(body: unknown): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
}

const methodCases = [
  ["GET", "/responses", 404],
  ["PUT", "/responses", 404],
  ["PATCH", "/responses", 404],
  ["DELETE", "/responses", 404],
  ["OPTIONS", "/responses", 404],
  ["GET", "/v1/responses", 404],
  ["PUT", "/v1/responses", 404],
  ["PATCH", "/v1/responses", 404],
  ["DELETE", "/v1/responses", 404],
  ["OPTIONS", "/v1/responses", 404],
  ["POST", "/v1/models", 404],
  ["POST", "/healthz", 404]
] as const;

for (const [method, url, expectedStatus] of methodCases) {
  test(`method matrix ${method} ${url}`, async () => {
    const app = Fastify();
    await registerRoutes(app, baseConfig);
    try {
      const response = await app.inject({ method, url });
      assert.equal(response.statusCode, expectedStatus);
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  });
}

const contentTypeCases = [
  {
    name: "application/json",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    expectedStatus: 200
  },
  {
    name: "application/json charset",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    expectedStatus: 200
  },
  {
    name: "missing content type object json",
    headers: {},
    body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    expectedStatus: 200
  },
  {
    name: "text plain rejected",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ model: "gpt-5.4", input: "hi" }),
    expectedStatus: 400
  },
  {
    name: "invalid json",
    headers: { "content-type": "application/json" },
    body: "{bad",
    expectedStatus: 400
  },
  {
    name: "empty json body",
    headers: { "content-type": "application/json" },
    body: "",
    expectedStatus: 400
  }
];

for (const testCase of contentTypeCases) {
  test(`content-type matrix ${testCase.name}`, async () => {
    await withProxy(jsonOk(payload()), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        headers: testCase.headers,
        payload: testCase.body
      });
      assert.equal(response.statusCode, testCase.expectedStatus);
    });
  });
}

const scalarJsonCases = [
  ["json string", "\"hello\""],
  ["json number", "123"],
  ["json true", "true"],
  ["json false", "false"],
  ["json array", "[]"],
  ["json null", "null"]
] as const;

for (const [name, body] of scalarJsonCases) {
  test(`scalar json body returns invalid_body for ${name}`, async () => {
    await withProxy(jsonOk(payload()), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        headers: { "content-type": "application/json" },
        payload: body
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().error.code, "invalid_body");
    });
  });
}

const inputShapeCases = [
  ["string input", "hello"],
  ["message object input", [{ type: "message", role: "user", content: "hello" }]],
  ["function output input", [{ type: "function_call_output", call_id: "call_1", output: "ok" }]],
  ["mixed replay input", [
    { type: "message", role: "assistant", content: "old" },
    { type: "reasoning", summary: [] },
    { type: "function_call", call_id: "call_1", name: "tool", arguments: "{}" }
  ]],
  ["null input", null],
  ["object input", { text: "hello" }]
] as const;

for (const [name, input] of inputShapeCases) {
  test(`input shape proxies ${name}`, async () => {
    await withProxy(jsonOk(payload()), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input }
      });
      assert.equal(response.statusCode, 200);
      const downstream = JSON.parse(bodies[0] ?? "{}");
      assert.equal(downstream.model, "downstream-mini");
      assert.equal("input" in downstream, true);
    });
  });
}

const allowedKeyCases = [
  ["max_output_tokens", 100],
  ["max_tool_calls", 3],
  ["parallel_tool_calls", true],
  ["previous_response_id", "resp_prev"],
  ["prompt_cache_key", "cache-key"],
  ["prompt_cache_retention", "24h"],
  ["reasoning", { effort: "medium" }],
  ["safety_identifier", "safe"],
  ["service_tier", "auto"],
  ["store", false],
  ["temperature", 0.2],
  ["tool_choice", "auto"],
  ["top_p", 0.9],
  ["truncation", "auto"],
  ["user", "user-1"],
  ["metadata", { k: "v" }],
  ["instructions", "answer briefly"],
  ["include", ["reasoning.encrypted_content"]],
  ["conversation", "conv_1"],
  ["background", false]
] as const;

for (const [key, value] of allowedKeyCases) {
  test(`allowed downstream key preserves ${key}`, async () => {
    await withProxy(jsonOk(payload()), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: "hi", [key]: value }
      });
      assert.equal(response.statusCode, 200);
      const downstream = JSON.parse(bodies[0] ?? "{}");
      assert.deepEqual(downstream[key], value);
    });
  });
}

const forbiddenKeyCases = [
  "client_secret",
  "api_key",
  "response_format",
  "stream_options",
  "logprobs",
  "top_logprobs",
  "n",
  "best_of",
  "suffix",
  "unknown_nested"
];

for (const key of forbiddenKeyCases) {
  test(`forbidden downstream key drops ${key}`, async () => {
    await withProxy(jsonOk(payload()), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: "hi", [key]: "drop" }
      });
      assert.equal(response.statusCode, 200);
      const downstream = JSON.parse(bodies[0] ?? "{}");
      assert.equal(key in downstream, false);
    });
  });
}

const toolCases = [
  {
    name: "function with parameters",
    tools: [{ type: "function", name: "tool", parameters: { type: "object" } }],
    expectedLength: 1
  },
  {
    name: "web search",
    tools: [{ type: "web_search", external_web_access: true }],
    expectedLength: 1
  },
  {
    name: "mixed invalid entries",
    tools: [null, "bad", { type: "custom" }, { type: "function", name: "ok" }],
    expectedLength: 1
  },
  {
    name: "non-array tools passthrough",
    tools: { type: "function", name: "object-tool" },
    expectedLength: undefined
  },
  {
    name: "empty tools",
    tools: [],
    expectedLength: 0
  },
  {
    name: "nested stripped fields",
    tools: [{ type: "function", name: "ok", nested: { verbosity: "high", external_web_access: true, keep: true } }],
    expectedLength: 1
  }
];

for (const testCase of toolCases) {
  test(`tool sanitation ${testCase.name}`, async () => {
    await withProxy(jsonOk(payload()), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: "hi", tools: testCase.tools }
      });
      assert.equal(response.statusCode, 200);
      const downstream = JSON.parse(bodies[0] ?? "{}");
      if (typeof testCase.expectedLength === "number") {
        assert.equal(downstream.tools.length, testCase.expectedLength);
      } else {
        assert.deepEqual(downstream.tools, testCase.tools);
      }
      assert.equal(JSON.stringify(downstream.tools).includes("external_web_access"), false);
      assert.equal(JSON.stringify(downstream.tools).includes("verbosity"), false);
    });
  });
}

const outputMatrix = [
  ["empty output", []],
  ["single message", [{ type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }]],
  ["two messages", [
    { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "one" }] },
    { type: "message", id: "m2", role: "assistant", content: [{ type: "output_text", text: "two" }] }
  ]],
  ["reasoning then message", [
    { type: "reasoning", id: "r1", summary: [{ type: "summary_text", text: "think" }] },
    { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }
  ]],
  ["function then message", [
    { type: "function_call", id: "f1", call_id: "c1", name: "tool", arguments: "{\"a\":1}" },
    { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }
  ]],
  ["unknown then message", [
    { type: "custom_item", id: "x1" },
    { type: "message", id: "m1", role: "assistant", content: [{ type: "output_text", text: "ok" }] }
  ]]
] as const;

for (const [name, output] of outputMatrix) {
  for (const stream of [false, true]) {
    test(`output matrix ${name} stream=${stream}`, async () => {
      await withProxy(jsonOk({ id: "resp_output", output }), async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/responses",
          payload: { model: "gpt-5.4", stream, input: "hi" }
        });
        assert.equal(response.statusCode, 200);
        if (stream) {
          assert.match(response.body, /event: response\.completed/);
          assert.match(response.body, /data: \[DONE\]/);
        } else {
          assert.equal(response.json().id, "resp_output");
        }
      });
    });
  }
}

const malformedUpstreamCases = [
  ["stream invalid json", true, "not-json", 502, "ark_invalid_streaming_payload"],
  ["stream empty body", true, "", 502, "ark_invalid_streaming_payload"],
  ["stream null json", true, "null", 502, "ark_invalid_streaming_payload"],
  ["stream array json", true, "[]", 502, "ark_invalid_streaming_payload"],
  ["stream wrapped null response", true, "{\"response\":null}", 502, "ark_invalid_streaming_payload"],
  ["non-stream invalid json passes through", false, "not-json", 200, undefined],
  ["non-stream empty body passes through", false, "", 200, undefined]
] as const;

for (const [name, stream, body, expectedStatus, expectedCode] of malformedUpstreamCases) {
  test(`malformed upstream ${name}`, async () => {
    await withProxy((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", stream, input: "hi" }
      });
      assert.equal(response.statusCode, expectedStatus);
      if (expectedCode) {
        assert.equal(response.json().error.code, expectedCode);
      } else {
        assert.equal(response.body, body);
      }
    });
  });
}

const headerCases = [
  ["request id header non-stream", false],
  ["request id header stream", true],
  ["upstream model header non-stream", false],
  ["upstream model header stream", true]
] as const;

for (const [name, stream] of headerCases) {
  test(`response headers ${name}`, async () => {
    await withProxy(jsonOk(payload()), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", stream, input: "hi" }
      });
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers["x-codex-ark-proxy-request-id"]), /^cap_/);
      assert.equal(response.headers["x-codex-ark-upstream-model"], "downstream-mini");
    });
  });
}

const longSizeCases = [1, 16, 255, 1024, 8192, 65536, 131072, 262144] as const;

for (const size of longSizeCases) {
  test(`long output size ${size} non-stream`, async () => {
    const text = "x".repeat(size);
    await withProxy(jsonOk(payload(text)), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: "hi" }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().output[0].content[0].text.length, size);
    });
  });

  test(`long output size ${size} stream`, async () => {
    const text = "x".repeat(size);
    await withProxy(jsonOk(payload(text)), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", stream: true, input: "hi" }
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /data: \[DONE\]/);
      assert.ok(response.body.length > size);
    });
  });
}

const concurrentMatrix = [
  [10, false],
  [10, true],
  [25, false],
  [25, true],
  [75, false],
  [75, true],
  [125, false],
  [125, true],
  [200, false],
  [200, true]
] as const;

for (const [count, stream] of concurrentMatrix) {
  test(`concurrency matrix count=${count} stream=${stream}`, async () => {
    let active = 0;
    let completed = 0;
    await withProxy(async (_request, response) => {
      active += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      completed += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload("ok")));
    }, async (app) => {
      const startedAt = performance.now();
      const responses = await Promise.all(Array.from({ length: count }, (_, index) => app.inject({
        method: "POST",
        url: index % 2 === 0 ? "/responses" : "/v1/responses",
        payload: { model: "gpt-5.4", stream, input: `task ${index}` }
      })));
      const elapsedMs = performance.now() - startedAt;
      assert.equal(responses.every((response) => response.statusCode === 200), true);
      assert.equal(completed, count);
      assert.equal(active, 0);
      assert.ok(elapsedMs < 5000, `concurrency matrix took ${elapsedMs}ms`);
    });
  });
}

const statusMatrix = [400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504] as const;

for (const status of statusMatrix) {
  test(`status passthrough ${status}`, async () => {
    await withProxy((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: status } }));
    }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: "hi" }
      });
      assert.equal(response.statusCode, status);
      assert.equal(response.json().error.code, status);
    });
  });
}

const extraStatusMatrix = [200, 201, 202, 204, 301, 302, 307, 308, 418, 451, 499, 520] as const;

for (const status of extraStatusMatrix) {
  test(`extra status behavior ${status}`, async () => {
    await withProxy((_request, response) => {
      response.writeHead(status, { "content-type": "text/plain" });
      response.end(status === 204 ? "" : `status-${status}`);
    }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: "hi" }
      });
      assert.equal(response.statusCode, status);
      if (status !== 204 && response.body) {
        assert.equal(response.body, `status-${status}`);
      }
    });
  });
}

const contentTypePassthroughCases = [
  "application/json",
  "application/problem+json",
  "text/plain",
  "text/html",
  "application/octet-stream",
  "application/x-ndjson",
  "text/event-stream",
  "application/vnd.api+json"
];

for (const contentType of contentTypePassthroughCases) {
  test(`content-type passthrough ${contentType}`, async () => {
    await withProxy((_request, response) => {
      response.writeHead(200, { "content-type": contentType });
      response.end("plain-body");
    }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: "hi" }
      });
      assert.equal(response.statusCode, 200);
      assert.match(String(response.headers["content-type"]), new RegExp(contentType.replace(/[.+/]/g, "\\$&")));
      assert.equal(response.body, "plain-body");
    });
  });
}

const modelMapExtraCases = [
  ["empty string model uses default", "", "default-model"],
  ["spaces model uses default", "   ", "default-model"],
  ["case-sensitive unknown model", "GPT-5.4", "GPT-5.4"],
  ["model with slash", "vendor/model", "vendor/model"],
  ["model with colon", "vendor:model", "vendor:model"],
  ["model with date suffix", "model-2026-04-25", "model-2026-04-25"],
  ["default model explicitly", "default-model", "default-model"],
  ["mapped model with tabs", "\tgpt-4.1\t", "downstream-pro"]
] as const;

for (const [name, requestedModel, expectedModel] of modelMapExtraCases) {
  test(`model map extra ${name}`, async () => {
    await withProxy(jsonOk(payload()), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: requestedModel, input: "hi" }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(bodies[0] ?? "{}").model, expectedModel);
    });
  });
}

const longInputSizes = [0, 1, 1024, 8192, 32768, 131072] as const;

for (const size of longInputSizes) {
  test(`long input size ${size}`, async () => {
    await withProxy(jsonOk(payload()), async (app, bodies) => {
      const input = "u".repeat(size);
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(JSON.parse(bodies[0] ?? "{}").input.length, size);
    });
  });
}

const streamTokenCases = [
  ["newline text", "line1\nline2"],
  ["quote text", "\"quoted\""],
  ["backslash text", "path\\to\\file"],
  ["emoji text", "🚀".repeat(128)],
  ["cjk text", "你好世界".repeat(128)],
  ["mixed whitespace", " \n\t ".repeat(128)]
] as const;

for (const [name, text] of streamTokenCases) {
  test(`stream token escaping ${name}`, async () => {
    await withProxy(jsonOk(payload(text)), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", stream: true, input: "hi" }
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.body, /event: response\.output_text\.done/);
      assert.match(response.body, /data: \[DONE\]/);
    });
  });
}

const authExtraCases = [
  ["bearer with trailing space rejected", "Bearer secret ", 401],
  ["bearer with leading space rejected", " Bearer secret", 401],
  ["lowercase bearer valid", "bearer secret", 200],
  ["uppercase bearer valid", "BEARER secret", 200],
  ["token without scheme rejected", "secret", 401],
  ["empty bearer rejected", "Bearer ", 401]
] as const;

for (const [name, authorization, expectedStatus] of authExtraCases) {
  test(`auth extra ${name}`, async () => {
    await withProxy(jsonOk(payload()), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        headers: { authorization },
        payload: { model: "gpt-5.4", input: "hi" }
      });
      assert.equal(response.statusCode, expectedStatus);
    }, { proxyAuthToken: "secret" });
  });
}

const routeConcurrencyCases = [
  ["/responses", 25, false],
  ["/responses", 25, true],
  ["/v1/responses", 25, false],
  ["/v1/responses", 25, true],
  ["/responses", 100, false],
  ["/v1/responses", 100, true]
] as const;

for (const [url, count, stream] of routeConcurrencyCases) {
  test(`route concurrency ${url} count=${count} stream=${stream}`, async () => {
    let completed = 0;
    await withProxy(async (_request, response) => {
      completed += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload("ok")));
    }, async (app) => {
      const responses = await Promise.all(Array.from({ length: count }, (_, index) => app.inject({
        method: "POST",
        url,
        payload: { model: "gpt-5.4", stream, input: `task ${index}` }
      })));
      assert.equal(responses.every((response) => response.statusCode === 200), true);
      assert.equal(completed, count);
    });
  });
}
