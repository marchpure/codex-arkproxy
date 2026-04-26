import test from "node:test";
import assert from "node:assert/strict";
import {
  buildStreamingEvents,
  buildStreamCompletionResponse,
  extractOutputText,
  normalizeUpstreamPayload,
  normalizeResponseForStreaming,
  normalizeResponsesUsage,
  pickAssistantMessage
} from "../src/routes.ts";

test("normalizeResponseForStreaming fills response defaults", () => {
  assert.deepEqual(
    normalizeResponseForStreaming(
      {
        id: "resp_1"
      },
      "doubao-seed-2-0-pro-260215"
    ),
    {
      id: "resp_1",
      model: "doubao-seed-2-0-pro-260215",
      object: "response",
      status: "completed"
    }
  );
});

test("normalizeResponsesUsage converts chat completions usage into responses usage", () => {
  assert.deepEqual(
    normalizeResponsesUsage({
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10
    }),
    {
      prompt_tokens: 7,
      completion_tokens: 3,
      total_tokens: 10,
      input_tokens: 7,
      output_tokens: 3
    }
  );
});

test("normalizeResponseForStreaming fills response usage token fields", () => {
  const normalized = normalizeResponseForStreaming(
    {
      id: "resp_1",
      usage: {
        total_tokens: 12
      }
    },
    "doubao-seed-2-0-pro-260215"
  );

  assert.deepEqual(normalized.usage, {
    total_tokens: 12,
    input_tokens: 0,
    output_tokens: 0
  });
});

test("pickAssistantMessage returns the assistant message item only", () => {
  const response = {
    output: [
      { type: "reasoning", id: "rs_1" },
      {
        type: "message",
        role: "assistant",
        id: "msg_1",
        content: [{ type: "output_text", text: "hello" }]
      }
    ]
  };

  assert.deepEqual(pickAssistantMessage(response), {
    type: "message",
    role: "assistant",
    id: "msg_1",
    content: [{ type: "output_text", text: "hello" }]
  });
});

test("extractOutputText concatenates assistant text parts", () => {
  const message = {
    content: [
      { type: "output_text", text: "hello" },
      { type: "output_text", text: " world" },
      { type: "other", text: "ignored" }
    ]
  };

  assert.equal(extractOutputText(message), "hello world");
});

test("buildStreamCompletionResponse preserves full output payload", () => {
  const assistantMessage = {
    type: "message",
    role: "assistant",
    id: "msg_1",
    content: [{ type: "output_text", text: "done" }]
  };
  const response = {
    id: "resp_1",
    output: [
      { type: "reasoning", id: "rs_1" },
      assistantMessage
    ]
  };

  assert.deepEqual(buildStreamCompletionResponse(response, assistantMessage), {
    id: "resp_1",
    output: [
      { type: "reasoning", id: "rs_1" },
      assistantMessage
    ]
  });
});

test("buildStreamingEvents emits native-like reasoning, tool call, and message sequences", () => {
  const payload = JSON.stringify({
    id: "resp_reasoning_1",
    output: [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [{ type: "summary_text", text: "searching first\n\nthen answering" }]
      },
      {
        type: "function_call",
        id: "fc_1",
        call_id: "call_1",
        name: "web_search",
        arguments: "{\"query\":\"github trending\"}"
      },
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "final answer" }]
      }
    ]
  });

  const frames = buildStreamingEvents(payload, "doubao-seed-2-0-pro-260215");
  const eventTypes = frames.map((frame) => frame.event);

  assert.deepEqual(eventTypes.slice(0, 2), ["response.created", "response.in_progress"]);
  assert.ok(eventTypes.includes("response.reasoning_summary_part.added"));
  assert.ok(eventTypes.includes("response.reasoning_summary_text.delta"));
  assert.ok(eventTypes.includes("response.reasoning_summary_text.done"));
  assert.ok(eventTypes.includes("response.function_call_arguments.delta"));
  assert.ok(eventTypes.includes("response.function_call_arguments.done"));
  assert.ok(eventTypes.includes("response.output_text.delta"));
  assert.ok(eventTypes.includes("response.output_text.done"));
  assert.equal(eventTypes.at(-1), "response.completed");

  const reasoningAddedIndex = eventTypes.indexOf("response.output_item.added");
  const reasoningDeltaIndex = eventTypes.indexOf("response.reasoning_summary_text.delta");
  const reasoningDoneIndex = eventTypes.indexOf("response.output_item.done");
  assert.ok(reasoningAddedIndex >= 0);
  assert.ok(reasoningDeltaIndex > reasoningAddedIndex);
  assert.ok(reasoningDoneIndex > reasoningDeltaIndex);

  const functionCallAddedIndex = eventTypes.indexOf("response.output_item.added", reasoningDoneIndex + 1);
  const functionCallDeltaIndex = eventTypes.indexOf("response.function_call_arguments.delta");
  const functionCallDoneIndex = eventTypes.indexOf("response.function_call_arguments.done");
  const functionCallItemDoneIndex = eventTypes.indexOf("response.output_item.done", functionCallDoneIndex + 1);
  assert.ok(functionCallAddedIndex >= 0);
  assert.ok(functionCallDeltaIndex > functionCallAddedIndex);
  assert.ok(functionCallDoneIndex > functionCallDeltaIndex);
  assert.ok(functionCallItemDoneIndex > functionCallDoneIndex);

  const messageAddedIndex = eventTypes.indexOf("response.output_item.added", functionCallItemDoneIndex + 1);
  const messageDeltaIndex = eventTypes.indexOf("response.output_text.delta");
  const messageDoneIndex = eventTypes.indexOf("response.output_text.done");
  const messageItemDoneIndex = eventTypes.indexOf("response.output_item.done", messageDoneIndex + 1);
  assert.ok(messageAddedIndex >= 0);
  assert.ok(messageDeltaIndex > messageAddedIndex);
  assert.ok(messageDoneIndex > messageDeltaIndex);
  assert.ok(messageItemDoneIndex > messageDoneIndex);

  const reasoningAdded = frames[reasoningAddedIndex]?.data.item as Record<string, unknown>;
  assert.equal(reasoningAdded.type, "reasoning");
  assert.equal(reasoningAdded.status, "in_progress");

  const functionCallAdded = frames[functionCallAddedIndex]?.data.item as Record<string, unknown>;
  assert.equal(functionCallAdded.type, "function_call");
  assert.equal(functionCallAdded.arguments, "");

  const functionCallDone = frames[functionCallDoneIndex]?.data as Record<string, unknown>;
  assert.equal(functionCallDone.arguments, "{\"query\":\"github trending\"}");

  const messageAdded = frames[messageAddedIndex]?.data.item as Record<string, unknown>;
  assert.equal(messageAdded.type, "message");
  assert.equal(messageAdded.phase, "final_answer");
});

test("buildStreamingEvents includes completed usage required by Codex parser", () => {
  const frames = buildStreamingEvents(JSON.stringify({
    id: "resp_usage_1",
    usage: { total_tokens: 10 },
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }]
      }
    ]
  }), "doubao-seed-2-0-pro-260215");

  const completed = frames.find((frame) => frame.event === "response.completed");
  const response = completed?.data.response as Record<string, unknown>;
  assert.deepEqual(response.usage, {
    total_tokens: 10,
    input_tokens: 0,
    output_tokens: 0
  });
});
