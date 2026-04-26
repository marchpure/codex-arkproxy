import test from "node:test";
import assert from "node:assert/strict";
import { buildDownstreamBody, deepStripExternalWebAccess, sanitizeTools } from "../src/ark-client.ts";
import { buildStreamingEvents } from "../src/routes.ts";
import { requireProxyAuth, resolveModel } from "../src/utils.ts";
import type { ProxyConfig } from "../src/types.ts";

const config: ProxyConfig = {
  host: "127.0.0.1",
  port: 8787,
  logLevel: "error",
  arkBaseUrl: "https://ark.example.com",
  arkApiKey: "ark-key",
  arkRegion: "",
  arkEndpoint: "",
  arkExtraHeaders: {},
  arkModelDefault: "default-model",
  exposeModels: ["gpt-5.4", "gpt-4.1", "default-model"],
  modelMap: {
    "gpt-5.4": "downstream-mini",
    "gpt-4.1": "downstream-pro",
    "trimmed-model": "trimmed-downstream"
  },
  requestTimeoutMs: 1000,
  streamIdleTimeoutMs: 1000,
  proxyAuthToken: ""
};

const context = {
  requestId: "req_mega",
  upstreamModel: "gpt-5.4",
  downstreamModel: "downstream-mini",
  stream: true
};

function replyStub() {
  return {
    codeCalledWith: 0,
    payload: undefined as unknown,
    code(status: number) {
      this.codeCalledWith = status;
      return this;
    },
    send(payload: unknown) {
      this.payload = payload;
      return this;
    }
  };
}

const stripStressCases = Array.from({ length: 96 }, (_, index) => ({
  index,
  input: {
    keep: `v-${index}`,
    external_web_access: index % 2 === 0,
    verbosity: index % 3 === 0 ? "high" : undefined,
    nested: {
      keepNested: index,
      external_web_access: true,
      child: {
        keepChild: `c-${index}`,
        verbosity: "low"
      }
    },
    list: [
      { keepList: index, external_web_access: true },
      { keepListChild: index + 1, verbosity: "medium" },
      null,
      `literal-${index}`
    ]
  }
}));

for (const testCase of stripStressCases) {
  test(`mega strip stress ${testCase.index}`, () => {
    const stripped = deepStripExternalWebAccess(testCase.input) as Record<string, unknown>;
    assert.equal("external_web_access" in stripped, false);
    assert.equal("verbosity" in stripped, false);
    assert.equal((stripped.nested as Record<string, unknown>).keepNested, testCase.index);
    assert.equal("external_web_access" in (stripped.nested as Record<string, unknown>), false);
    assert.equal("verbosity" in ((stripped.nested as Record<string, unknown>).child as Record<string, unknown>), false);
    assert.equal(Array.isArray(stripped.list), true);
    assert.equal("external_web_access" in (stripped.list as Record<string, unknown>[])[0], false);
    assert.equal("verbosity" in (stripped.list as Record<string, unknown>[])[1], false);
  });
}

const sanitizeToolCases = Array.from({ length: 96 }, (_, index) => ({
  index,
  tools: [
    { type: "function", name: `fn_${index}`, external_web_access: true },
    { type: "web_search", name: `web_${index}`, external_web_access: true },
    { type: index % 2 === 0 ? "custom" : "computer", name: "drop" },
    null,
    "bad",
    { nested: true }
  ]
}));

for (const testCase of sanitizeToolCases) {
  test(`mega sanitize tools ${testCase.index}`, () => {
    const tools = sanitizeTools(testCase.tools) as Record<string, unknown>[];
    assert.equal(tools.length, 2);
    assert.equal(tools[0].type, "function");
    assert.equal(tools[1].type, "web_search");
    assert.equal("external_web_access" in tools[0], false);
    assert.equal("external_web_access" in tools[1], false);
  });
}

const downstreamBodyCases = Array.from({ length: 120 }, (_, index) => ({
  index,
  model: index % 3 === 0 ? "gpt-5.4" : index % 3 === 1 ? "gpt-4.1" : undefined,
  input: [
    { type: "message", role: "user", content: `hello-${index}` },
    { type: "reasoning", summary: [{ type: "summary_text", text: `think-${index}` }] },
    { type: "function_call", call_id: `call_${index}`, name: "tool", arguments: "{}" },
    { type: "function_call_output", call_id: `call_${index}`, output: `out-${index}` },
    { type: "unknown", value: index }
  ],
  tools: [
    { type: "function", name: `tool_${index}`, parameters: { verbosity: "low", external_web_access: true, keep: true } },
    { type: "custom", name: "drop" }
  ],
  metadata: Object.fromEntries(Array.from({ length: (index % 6) + 1 }, (_, keyIndex) => [`k_${keyIndex}`, `v_${index}_${keyIndex}`]))
}));

for (const testCase of downstreamBodyCases) {
  test(`mega downstream body ${testCase.index}`, () => {
    const body = buildDownstreamBody({
      model: testCase.model,
      stream: testCase.index % 2 === 0,
      input: testCase.input,
      tools: testCase.tools,
      metadata: testCase.metadata,
      unsupported: "drop",
      text: { verbosity: "medium", format: { type: "text" } }
    }, {
      ...context,
      downstreamModel: testCase.model === "gpt-4.1" ? "downstream-pro" : "downstream-mini"
    });

    assert.equal(body.stream, false);
    assert.equal("unsupported" in body, false);
    assert.deepEqual(body.metadata, testCase.metadata);
    assert.equal((body.input as Record<string, unknown>[])[0].status, "completed");
    assert.equal((body.input as Record<string, unknown>[])[1].status, "completed");
    assert.equal((body.input as Record<string, unknown>[])[2].status, "completed");
    assert.equal((body.input as Record<string, unknown>[])[3].status, "completed");
    assert.equal("status" in (body.input as Record<string, unknown>[])[4], false);
    assert.equal((body.tools as unknown[]).length, 1);
    assert.equal("verbosity" in ((body.text as Record<string, unknown>)), false);
    assert.equal("external_web_access" in (((body.tools as Record<string, unknown>[])[0].parameters) as Record<string, unknown>), false);
  });
}

const streamingPayloadRejectCases = [
  "",
  "null",
  "[]",
  "123",
  "\"string\"",
  "true",
  "false",
  "{\"response\":null}",
  "{\"response\":[]}",
  "{\"response\":123}",
  "{\"response\":\"bad\"}",
  "{\"response\":true}"
] as const;

for (let index = 0; index < 72; index += 1) {
  const payloadText = streamingPayloadRejectCases[index % streamingPayloadRejectCases.length];
  test(`mega streaming payload rejects ${index}`, () => {
    assert.throws(() => buildStreamingEvents(payloadText, "downstream-model"), SyntaxError);
  });
}

const streamingEventCases = Array.from({ length: 96 }, (_, index) => {
  const output = Array.from({ length: (index % 5) + 1 }, (_, itemIndex) => {
    const kind = (index + itemIndex) % 4;
    if (kind === 0) {
      return { type: "message", id: `msg_${index}_${itemIndex}`, role: "assistant", content: [{ type: "output_text", text: `text-${index}-${itemIndex}` }] };
    }
    if (kind === 1) {
      return { type: "reasoning", id: `rs_${index}_${itemIndex}`, summary: [{ type: "summary_text", text: `summary-${index}-${itemIndex}` }] };
    }
    if (kind === 2) {
      return { type: "function_call", id: `fc_${index}_${itemIndex}`, call_id: `call_${index}_${itemIndex}`, name: "tool", arguments: JSON.stringify({ index, itemIndex }) };
    }
    return { type: "custom_item", id: `custom_${index}_${itemIndex}`, status: "completed" };
  });
  return {
    index,
    payloadText: JSON.stringify(index % 2 === 0 ? { response: { id: `resp_${index}`, output } } : { id: `resp_${index}`, output })
  };
});

for (const testCase of streamingEventCases) {
  test(`mega streaming events ${testCase.index}`, () => {
    const frames = buildStreamingEvents(testCase.payloadText, "downstream-model");
    const events = frames.map((frame) => frame.event);

    assert.equal(events[0], "response.created");
    assert.equal(events[1], "response.in_progress");
    assert.equal(events.at(-1), "response.completed");
    assert.equal(frames.every((frame, index) => frame.data.sequence_number === index), true);
    assert.ok(events.includes("response.output_item.added"));
    assert.ok(events.includes("response.output_item.done"));
  });
}

const modelResolutionCases = Array.from({ length: 48 }, (_, index) => ({
  index,
  requestedModel: index % 6 === 0
    ? "gpt-5.4"
    : index % 6 === 1
      ? "gpt-4.1"
      : index % 6 === 2
        ? " trimmed-model "
        : index % 6 === 3
          ? ""
          : index % 6 === 4
            ? undefined
            : `custom-${index}`,
  expectedDownstream: index % 6 === 0
    ? "downstream-mini"
    : index % 6 === 1
      ? "downstream-pro"
      : index % 6 === 2
        ? "trimmed-downstream"
        : index % 6 === 3 || index % 6 === 4
          ? "default-model"
          : `custom-${index}`
}));

for (const testCase of modelResolutionCases) {
  test(`mega model resolution ${testCase.index}`, () => {
    const resolved = resolveModel(testCase.requestedModel, config);
    assert.equal(resolved.downstreamModel, testCase.expectedDownstream);
    assert.equal(resolved.upstreamModel, testCase.requestedModel?.trim() || "default-model");
  });
}

const authHeaderCases = Array.from({ length: 48 }, (_, index) => ({
  index,
  headers: index % 6 === 0
    ? { authorization: "Bearer secret" }
    : index % 6 === 1
      ? { authorization: "bearer secret" }
      : index % 6 === 2
        ? { authorization: "Bearer wrong", "x-api-key": "secret" }
        : index % 6 === 3
          ? { "x-api-key": "secret" }
          : index % 6 === 4
            ? { authorization: "secret" }
            : {},
  expected: index % 6 === 0 || index % 6 === 1 || index % 6 === 3
}));

for (const testCase of authHeaderCases) {
  test(`mega auth headers ${testCase.index}`, () => {
    const reply = replyStub();
    const ok = requireProxyAuth({ headers: testCase.headers } as never, reply as never, {
      ...config,
      proxyAuthToken: "secret"
    });

    assert.equal(ok, testCase.expected);
    assert.equal(reply.codeCalledWith, testCase.expected ? 0 : 401);
  });
}
