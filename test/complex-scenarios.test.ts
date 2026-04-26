import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify from "fastify";
import { buildStreamingEvents, registerRoutes } from "../src/routes.ts";

const baseConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "error" as const,
  arkBaseUrl: "https://ark.example.com",
  arkApiMode: "responses",
  arkApiKey: "ark-key",
  arkRegion: "",
  arkEndpoint: "",
  arkExtraHeaders: {},
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

function complexOutput(index: number, textSize = 2048) {
  return [
    {
      type: "reasoning",
      id: `rs_${index}`,
      summary: [
        { type: "summary_text", text: `reasoning-${index}-a`.repeat(16) },
        { type: "summary_text", text: `reasoning-${index}-b`.repeat(16) }
      ]
    },
    {
      type: "function_call",
      id: `fc_${index}`,
      call_id: `call_${index}`,
      name: "tool",
      arguments: JSON.stringify({
        index,
        payload: "a".repeat(Math.min(textSize, 8192))
      })
    },
    {
      type: "custom_item",
      id: `custom_${index}`,
      status: "completed"
    },
    {
      type: "message",
      id: `msg_${index}`,
      role: "assistant",
      phase: "final_answer",
      content: [
        { type: "output_text", text: `answer-${index}:` + "x".repeat(textSize) },
        { type: "output_text", text: `tail-${index}` }
      ]
    }
  ];
}

function responsePayload(index = 1, textSize = 2048) {
  return {
    id: `resp_${index}`,
    output: complexOutput(index, textSize)
  };
}

function jsonOk(payload: unknown): Handler {
  return (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
}

const complexOutputCases = [
  ["reasoning-tool-custom-message small", 512],
  ["reasoning-tool-custom-message medium", 8192],
  ["reasoning-tool-custom-message large", 65536],
  ["unicode mixed large", 32768],
  ["many output items", 4096],
  ["empty content item mixed", 1024],
  ["missing ids fallback", 2048],
  ["refusal plus final", 2048],
  ["deep argument json", 4096],
  ["large summary and answer", 49152]
] as const;

for (const [name, size] of complexOutputCases) {
  for (const stream of [false, true]) {
    test(`complex output ${name} stream=${stream}`, async () => {
      const output = name === "many output items"
        ? Array.from({ length: 20 }, (_, index) => ({
          type: "message",
          id: `msg_${index}`,
          role: "assistant",
          content: [{ type: "output_text", text: `item-${index}-` + "x".repeat(size) }]
        }))
        : name === "empty content item mixed"
          ? [
            { type: "reasoning", id: "rs_empty", summary: [] },
            { type: "message", id: "msg_empty", role: "assistant", content: [] },
            ...complexOutput(1, size)
          ]
          : name === "missing ids fallback"
            ? [
              { type: "reasoning", summary: [{ type: "summary_text", text: "fallback" }] },
              { type: "function_call", name: "tool", arguments: "{}" },
              { type: "message", role: "assistant", content: [{ type: "output_text", text: "fallback" }] }
            ]
            : name === "refusal plus final"
              ? [
                { type: "message", id: "refusal", role: "assistant", content: [{ type: "refusal", refusal: "no" }] },
                ...complexOutput(1, size)
              ]
              : name === "deep argument json"
                ? [
                  {
                    type: "function_call",
                    id: "fc_deep",
                    call_id: "call_deep",
                    name: "tool",
                    arguments: JSON.stringify({ a: { b: { c: { d: "x".repeat(size) } } } })
                  },
                  ...complexOutput(1, size)
                ]
                : complexOutput(1, name === "unicode mixed large" ? 1024 : size);

      await withProxy(jsonOk({ id: "resp_complex", output }), async (app) => {
        const response = await app.inject({
          method: "POST",
          url: "/responses",
          payload: {
            model: "gpt-5.4",
            stream,
            input: "complex"
          }
        });
        assert.equal(response.statusCode, 200);
        if (stream) {
          assert.match(response.body, /event: response\.created/);
          assert.match(response.body, /event: response\.completed/);
          assert.match(response.body, /data: \[DONE\]/);
        } else {
          assert.equal(response.json().id, "resp_complex");
        }
      });
    });
  }
}

const requestReplayCases = Array.from({ length: 30 }, (_, index) => ({
  name: `replay chain ${index}`,
  previousResponseId: `resp_prev_${index}`,
  functionOutputs: Array.from({ length: (index % 5) + 1 }, (__, outputIndex) => ({
    type: "function_call_output",
    call_id: `call_${index}_${outputIndex}`,
    output: `tool-output-${outputIndex}`
  })),
  stream: index % 2 === 0
}));

for (const testCase of requestReplayCases) {
  test(`complex replay ${testCase.name}`, async () => {
    await withProxy(jsonOk(responsePayload(1, 1024)), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: testCase.stream ? "/v1/responses" : "/responses",
        payload: {
          model: indexModel(testCase.previousResponseId),
          stream: testCase.stream,
          previous_response_id: testCase.previousResponseId,
          input: [
            { type: "message", role: "user", content: "continue" },
            ...testCase.functionOutputs
          ]
        }
      });
      assert.equal(response.statusCode, 200);
      const downstream = JSON.parse(bodies[0] ?? "{}");
      assert.equal(downstream.previous_response_id, testCase.previousResponseId);
      assert.equal(downstream.input.every((item: { status?: string }) => item.status === "completed" || !("status" in item)), true);
    });
  });
}

function indexModel(value: string): string {
  return Number(value.split("_").at(-1)) % 2 === 0 ? "gpt-5.4" : "gpt-4.1";
}

const cancellationBatchCases = [
  [10, false],
  [10, true],
  [25, false],
  [25, true],
  [50, false],
  [50, true],
  [75, false],
  [75, true]
] as const;

for (const [count, stream] of cancellationBatchCases) {
  test(`batch cancellation count=${count} stream=${stream}`, async () => {
    let started = 0;
    let closed = 0;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = http.createServer(async (request, response) => {
      started += 1;
      request.resume();
      response.on("close", () => {
        closed += 1;
      });
      await released;
      if (!response.destroyed) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(responsePayload(1, 256)));
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
      const controllers = Array.from({ length: count }, () => new AbortController());
      const requests = controllers.map((controller, index) => fetch(`http://127.0.0.1:${address.port}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.4", stream, input: `cancel ${index}` }),
        signal: controller.signal
      }).catch((error: unknown) => error));
      for (let attempt = 0; attempt < 100 && started < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(started, count);
      controllers.forEach((controller) => controller.abort());
      await Promise.all(requests);
      for (let attempt = 0; attempt < 100 && closed < count; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(closed, count);
    } finally {
      release?.();
      app.server.closeAllConnections();
      await app.close();
      await close(upstream);
    }
  });
}

const mixedOutcomeCases = [
  [20, 0],
  [20, 1],
  [40, 2],
  [40, 3],
  [60, 4],
  [60, 5],
  [80, 6],
  [80, 7],
  [100, 8],
  [100, 9]
] as const;

for (const [count, variant] of mixedOutcomeCases) {
  test(`mixed outcome batch count=${count} variant=${variant}`, async () => {
    let active = 0;
    let completed = 0;
    await withProxy(async (_request, response, body) => {
      active += 1;
      const request = JSON.parse(body || "{}");
      await new Promise((resolve) => setTimeout(resolve, variant % 3));
      active -= 1;
      completed += 1;
      if (String(request.input).includes("error")) {
        response.writeHead(429, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "rate limit" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responsePayload(completed, 512)));
    }, async (app) => {
      const responses = await Promise.all(Array.from({ length: count }, (_, index) => app.inject({
        method: "POST",
        url: index % 2 === 0 ? "/responses" : "/v1/responses",
        payload: {
          model: index % 3 === 0 ? "gpt-5.4" : "gpt-4.1",
          stream: index % 4 === 0,
          input: index % 5 === 0 ? `error ${index}` : `ok ${index}`
        }
      })));
      assert.equal(responses.filter((response) => response.statusCode === 429).length, Math.ceil(count / 5));
      assert.equal(responses.filter((response) => response.statusCode === 200).length, count - Math.ceil(count / 5));
      assert.equal(active, 0);
      assert.equal(completed, count);
    });
  });
}

const timeoutStormCases = [
  [10, "headers"],
  [10, "body"],
  [25, "headers"],
  [25, "body"],
  [40, "headers"],
  [40, "body"]
] as const;

for (const [count, mode] of timeoutStormCases) {
  test(`timeout storm count=${count} mode=${mode}`, async () => {
    let started = 0;
    await withProxy(async (_request, response) => {
      started += 1;
      if (mode === "headers") {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.write("{");
      if (mode === "body") {
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      if (!response.destroyed) {
        response.end(JSON.stringify(responsePayload()));
      }
    }, async (app) => {
      const responses = await Promise.all(Array.from({ length: count }, (_, index) => app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", input: `timeout ${index}` }
      })));
      assert.equal(responses.every((response) => response.statusCode === 504), true);
    }, { requestTimeoutMs: 30 });
    assert.ok(started > 0);
    assert.ok(started <= count);
  });
}

const performanceComplexCases = [
  [100, 1024, false],
  [100, 1024, true],
  [150, 4096, false],
  [150, 4096, true],
  [200, 2048, false],
  [200, 2048, true],
  [250, 512, false],
  [250, 512, true]
] as const;

for (const [count, size, stream] of performanceComplexCases) {
  test(`complex performance count=${count} size=${size} stream=${stream}`, async () => {
    let active = 0;
    let completed = 0;
    await withProxy(async (_request, response) => {
      active += 1;
      active -= 1;
      completed += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(responsePayload(completed, size)));
    }, async (app) => {
      const startedAt = performance.now();
      const responses = await Promise.all(Array.from({ length: count }, (_, index) => app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", stream, input: `perf ${index}` }
      })));
      const elapsedMs = performance.now() - startedAt;
      assert.equal(responses.every((response) => response.statusCode === 200), true);
      assert.equal(active, 0);
      assert.equal(completed, count);
      assert.ok(elapsedMs < 8000, `complex performance took ${elapsedMs}ms`);
    });
  });
}

const upstreamMalformedComplexCases = [
  ["truncated json stream", true, "{\"id\":\"resp\"", 502],
  ["array json stream", true, "[]", 502],
  ["number json stream", true, "123", 502],
  ["string json stream", true, "\"hello\"", 502],
  ["null json stream", true, "null", 502],
  ["wrapped null response stream", true, "{\"response\":null}", 502],
  ["wrapped array response stream", true, "{\"response\":[]}", 502],
  ["object no output stream", true, "{\"id\":\"resp\"}", 200],
  ["object output non-array stream", true, "{\"id\":\"resp\",\"output\":{}}", 200],
  ["object null output stream", true, "{\"id\":\"resp\",\"output\":null}", 200]
] as const;

for (const [name, stream, body, expectedStatus] of upstreamMalformedComplexCases) {
  test(`upstream malformed complex ${name}`, async () => {
    await withProxy((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    }, async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: { model: "gpt-5.4", stream, input: "malformed" }
      });
      assert.equal(response.statusCode, expectedStatus);
      if (expectedStatus === 502) {
        assert.equal(response.json().error.code, "ark_invalid_streaming_payload");
      }
    });
  });
}

const metadataStressCases = Array.from({ length: 24 }, (_, index) => ({
  index,
  metadata: Object.fromEntries(Array.from({ length: (index % 8) + 1 }, (__, keyIndex) => [`k${keyIndex}`, `v${index}-${keyIndex}`]))
}));

for (const testCase of metadataStressCases) {
  test(`metadata stress ${testCase.index}`, async () => {
    await withProxy(jsonOk(responsePayload()), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          model: "gpt-5.4",
          input: "metadata",
          metadata: testCase.metadata
        }
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(JSON.parse(bodies[0] ?? "{}").metadata, testCase.metadata);
    });
  });
}

const streamingIntegrityCases = Array.from({ length: 72 }, (_, index) => {
  const itemKind = index % 6;
  const contentSize = 1 + (index % 12) * 17;
  const output = itemKind === 0
    ? [{ type: "message", id: `msg_${index}`, role: "assistant", content: [{ type: "output_text", text: "x".repeat(contentSize) }] }]
    : itemKind === 1
      ? [{ type: "message", id: `ref_${index}`, role: "assistant", content: [{ type: "refusal", refusal: "r".repeat(contentSize) }] }]
      : itemKind === 2
        ? [{ type: "reasoning", id: `rs_${index}`, summary: [{ type: "summary_text", text: "s".repeat(contentSize) }] }]
        : itemKind === 3
          ? [{ type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "tool", arguments: JSON.stringify({ value: "a".repeat(contentSize) }) }]
          : itemKind === 4
            ? [{ type: "custom_item", id: `custom_${index}`, status: index % 2 === 0 ? "completed" : undefined }]
            : [
              { type: "reasoning", id: `rs_${index}`, summary: [{ type: "summary_text", text: `plan-${index}` }] },
              { type: "function_call", id: `fc_${index}`, call_id: `call_${index}`, name: "tool", arguments: "{}" },
              { type: "message", id: `msg_${index}`, role: "assistant", content: [{ type: "output_text", text: `answer-${index}` }] }
            ];
  return {
    index,
    wrapped: index % 2 === 0,
    output
  };
});

for (const testCase of streamingIntegrityCases) {
  test(`streaming integrity sequence ${testCase.index}`, () => {
    const response = {
      id: `resp_integrity_${testCase.index}`,
      output: testCase.output
    };
    const payloadText = JSON.stringify(testCase.wrapped ? { response } : response);
    const frames = buildStreamingEvents(payloadText, "downstream-model");

    assert.equal(frames.at(0)?.event, "response.created");
    assert.equal(frames.at(1)?.event, "response.in_progress");
    assert.equal(frames.at(-1)?.event, "response.completed");
    assert.equal(frames.every((frame, index) => frame.data.sequence_number === index), true);
    assert.equal(frames.filter((frame) => frame.event === "response.completed").length, 1);
    assert.equal((frames.at(-1)?.data.response as { id?: string }).id, response.id);
  });
}

const downstreamCombinationCases = Array.from({ length: 48 }, (_, index) => ({
  index,
  route: index % 2 === 0 ? "/responses" : "/v1/responses",
  stream: index % 3 === 0,
  model: index % 4 === 0 ? "gpt-5.4" : index % 4 === 1 ? "gpt-4.1" : index % 4 === 2 ? " default-model " : `custom-${index}`,
  input: [
    { type: "message", role: index % 2 === 0 ? "user" : "assistant", content: `msg-${index}` },
    { type: "function_call_output", call_id: `call_${index}`, output: `out-${index}` },
    { type: "unknown", value: index }
  ],
  tools: [
    {
      type: "function",
      name: `tool_${index}`,
      external_web_access: true,
      parameters: {
        type: "object",
        verbosity: "high",
        properties: {
          q: {
            type: "string",
            external_web_access: true
          }
        }
      }
    },
    { type: "custom", name: "drop" },
    null
  ],
  metadata: {
    index,
    shard: index % 7,
    value: "m".repeat((index % 5) + 1)
  }
}));

for (const testCase of downstreamCombinationCases) {
  test(`downstream combination ${testCase.index}`, async () => {
    await withProxy(jsonOk(responsePayload(testCase.index, 128)), async (app, bodies) => {
      const response = await app.inject({
        method: "POST",
        url: testCase.route,
        payload: {
          model: testCase.model,
          stream: testCase.stream,
          input: testCase.input,
          tools: testCase.tools,
          metadata: testCase.metadata,
          previous_response_id: `resp_prev_${testCase.index}`,
          unsupported_field: "drop-me"
        }
      });
      assert.equal(response.statusCode, 200);

      const downstream = JSON.parse(bodies[0] ?? "{}");
      assert.equal(downstream.stream, false);
      assert.equal("unsupported_field" in downstream, false);
      assert.deepEqual(downstream.metadata, testCase.metadata);
      assert.equal(downstream.previous_response_id, `resp_prev_${testCase.index}`);
      assert.equal(downstream.input[0].status, "completed");
      assert.equal(downstream.input[1].status, "completed");
      assert.equal("status" in downstream.input[2], false);
      assert.equal(downstream.tools.length, 1);
      assert.equal(downstream.tools[0].type, "function");
      assert.equal("external_web_access" in downstream.tools[0], false);
      assert.equal("verbosity" in downstream.tools[0].parameters, false);
    });
  });
}

const responseWrapperCases = Array.from({ length: 36 }, (_, index) => ({
  index,
  response: {
    id: `resp_wrapped_${index}`,
    status: index % 2 === 0 ? "completed" : undefined,
    model: index % 3 === 0 ? `upstream-model-${index}` : undefined,
    output: index % 4 === 0
      ? []
      : [
        {
          type: "message",
          id: `msg_wrap_${index}`,
          role: "assistant",
          content: [{ type: "output_text", text: `wrapped-${index}` }]
        }
      ]
  }
}));

for (const testCase of responseWrapperCases) {
  test(`streaming wrapper normalization ${testCase.index}`, async () => {
    await withProxy(jsonOk({ response: testCase.response }), async (app) => {
      const response = await app.inject({
        method: "POST",
        url: "/responses",
        payload: {
          model: "gpt-5.4",
          stream: true,
          input: `wrapper ${testCase.index}`
        }
      });

      assert.equal(response.statusCode, 200);
      assert.match(response.body, /event: response\.created/);
      assert.match(response.body, /event: response\.completed/);
      assert.match(response.body, new RegExp(`resp_wrapped_${testCase.index}`));
      assert.match(response.body, /data: \[DONE\]/);
    });
  });
}
