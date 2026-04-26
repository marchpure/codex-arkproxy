import test from "node:test";
import assert from "node:assert/strict";
import { buildArkHeaders, buildChatCompletionsBody, buildDownstreamBody, deepStripExternalWebAccess, sanitizeTools } from "../src/ark-client.ts";

const context = {
  requestId: "req_test",
  upstreamModel: "doubao-seed-2-0-pro-260215",
  downstreamModel: "doubao-seed-2-0-pro-260215",
  stream: true
};

test("deepStripExternalWebAccess removes Ark-incompatible nested fields", () => {
  const input = {
    text: {
      verbosity: "low"
    },
    tools: [
      {
        type: "web_search",
        external_web_access: true
      }
    ],
    nested: {
      external_web_access: true,
      child: {
        verbosity: "low",
        keep: "ok"
      }
    }
  };

  assert.deepEqual(deepStripExternalWebAccess(input), {
    text: {},
    tools: [
      {
        type: "web_search"
      }
    ],
    nested: {
      child: {
        keep: "ok"
      }
    }
  });
});

test("sanitizeTools keeps only function tools", () => {
  const input = [
    { type: "function", name: "exec_command" },
    { type: "custom", name: "apply_patch" },
    { type: "web_search", external_web_access: true },
    "bad-shape"
  ];

  assert.deepEqual(sanitizeTools(input), [
    { type: "function", name: "exec_command" },
    { type: "web_search" }
  ]);
});

test("buildDownstreamBody rewrites stream mode and strips unsupported fields", () => {
  const input = {
    model: "doubao-seed-2-0-pro-260215",
    stream: true,
    input: [{ type: "message", role: "user", content: "hi" }],
    text: { verbosity: "low" },
    tools: [
      { type: "function", name: "exec_command" },
      { type: "custom", name: "apply_patch" },
      { type: "web_search", external_web_access: true }
    ],
    client_metadata: { dropped: true },
    prompt_cache_key: "abc"
  };

  assert.deepEqual(buildDownstreamBody(input, context), {
    model: "doubao-seed-2-0-pro-260215",
    stream: false,
    input: [{ type: "message", role: "user", content: "hi", status: "completed" }],
    text: {},
    tools: [
      { type: "function", name: "exec_command" },
      { type: "web_search" }
    ],
    prompt_cache_key: "abc"
  });
});

test("buildDownstreamBody preserves nested input status for future compatibility", () => {
  const input = {
    input: [
      {
        type: "function_call_output",
        call_id: "call_1",
        status: "completed",
        output: "ok"
      }
    ]
  };

  assert.deepEqual(buildDownstreamBody(input, context), {
    model: "doubao-seed-2-0-pro-260215",
    input: [
      {
        type: "function_call_output",
        call_id: "call_1",
        status: "completed",
        output: "ok"
      }
    ]
  });
});

test("buildDownstreamBody backfills missing input status for replayed output items", () => {
  const input = {
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "thinking" }]
      },
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "hello" }]
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "web_search",
        arguments: "{}"
      }
    ]
  };

  assert.deepEqual(buildDownstreamBody(input, context), {
    model: "doubao-seed-2-0-pro-260215",
    input: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "thinking" }],
        status: "completed"
      },
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "hello" }],
        status: "completed"
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "web_search",
        arguments: "{}",
        status: "completed"
      }
    ]
  });
});

test("buildArkHeaders forwards region endpoint and safe extra headers", () => {
  const headers = buildArkHeaders({
    host: "127.0.0.1",
    port: 8787,
    logLevel: "info",
    arkBaseUrl: "https://ark.example.com",
    arkApiMode: "responses",
    arkApiKey: "ark-key",
    arkRegion: "sg",
    arkEndpoint: "ep-123",
    arkExtraHeaders: {
      "x-extra": "extra",
      authorization: "Bearer ignored",
      "content-type": "text/plain"
    },
    arkModelDefault: "default-model",
    exposeModels: [],
    modelMap: {},
    requestTimeoutMs: 1,
    streamIdleTimeoutMs: 1,
    proxyAuthToken: ""
  });

  assert.equal(headers.get("authorization"), "Bearer ark-key");
  assert.equal(headers.get("content-type"), "application/json");
  assert.equal(headers.get("x-user-region"), "sg");
  assert.equal(headers.get("x-user-model"), "ep-123");
  assert.equal(headers.get("x-extra"), "extra");
});

test("buildChatCompletionsBody converts responses input and tools for Coding Plan", () => {
  const body = buildChatCompletionsBody({
    model: "gpt-5.4",
    instructions: "Be concise.",
    input: [
      { type: "message", role: "developer", content: "developer guidance" },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "exec_command", arguments: "{\"cmd\":\"pwd\"}" },
      { type: "function_call_output", call_id: "call_1", output: "ok" }
    ],
    tools: [
      { type: "function", name: "exec_command", description: "run", parameters: { type: "object" } },
      { type: "web_search", name: "drop" }
    ],
    max_output_tokens: 123,
    temperature: 0.2
  }, {
    ...context,
    downstreamModel: "doubao-coding-plan"
  });

  assert.deepEqual(body, {
    model: "doubao-coding-plan",
    stream: false,
    messages: [
      { role: "system", content: "Be concise." },
      { role: "system", content: "developer guidance" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "exec_command",
              arguments: "{\"cmd\":\"pwd\"}"
            }
          }
        ]
      },
      { role: "tool", tool_call_id: "call_1", content: "ok" }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "exec_command",
          description: "run",
          parameters: { type: "object" }
        }
      }
    ],
    temperature: 0.2,
    max_tokens: 123
  });
});
