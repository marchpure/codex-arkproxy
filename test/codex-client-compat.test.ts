import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { buildStreamingEvents, normalizeUpstreamPayload } from "../src/routes.ts";

const responseUsageSchema = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  total_tokens: z.number()
}).passthrough();

const responseSchema = z.object({
  id: z.string(),
  object: z.literal("response"),
  status: z.string(),
  model: z.string(),
  output: z.array(z.unknown()),
  usage: responseUsageSchema.optional()
}).passthrough();

const completedEventSchema = z.object({
  type: z.literal("response.completed"),
  response: responseSchema.extend({
    usage: responseUsageSchema
  }),
  sequence_number: z.number()
}).passthrough();

const createdEventSchema = z.object({
  type: z.literal("response.created"),
  response: responseSchema,
  sequence_number: z.number()
}).passthrough();

const inProgressEventSchema = z.object({
  type: z.literal("response.in_progress"),
  response: responseSchema.extend({
    status: z.literal("in_progress")
  }),
  sequence_number: z.number()
}).passthrough();

const knownEventSchemas: Record<string, z.ZodType<unknown>> = {
  "response.created": createdEventSchema,
  "response.in_progress": inProgressEventSchema,
  "response.completed": completedEventSchema
};

function encodeFrames(frames: Array<{ event: string; data: Record<string, unknown> }>): string {
  return `${frames.map((frame) => `event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n`).join("\n")}data: [DONE]\n\n`;
}

function parseSseFrames(body: string): Array<{ event: string; data: unknown }> {
  return body.trim().split("\n\n").flatMap((rawFrame) => {
    const lines = rawFrame.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice("event: ".length);
    const data = lines.find((line) => line.startsWith("data: "))?.slice("data: ".length);
    if (!event || !data || data === "[DONE]") {
      return [];
    }
    return [{ event, data: JSON.parse(data) as unknown }];
  });
}

function assertCodexClientCanParseSse(body: string): void {
  const frames = parseSseFrames(body);
  assert.ok(frames.length > 0);
  assert.equal(frames.at(-1)?.event, "response.completed");

  const seenSequenceNumbers = new Set<number>();
  for (const frame of frames) {
    const schema = knownEventSchemas[frame.event];
    if (!schema) {
      const generic = z.object({
        type: z.literal(frame.event),
        sequence_number: z.number()
      }).passthrough().parse(frame.data) as { sequence_number: number };
      assert.equal(seenSequenceNumbers.has(generic.sequence_number), false);
      seenSequenceNumbers.add(generic.sequence_number);
      continue;
    }

    const parsed = schema.parse(frame.data) as { sequence_number: number };
    assert.equal(seenSequenceNumbers.has(parsed.sequence_number), false);
    seenSequenceNumbers.add(parsed.sequence_number);
  }
}

test("codex client compat parses Coding Plan stream response.completed usage", () => {
  const normalized = normalizeUpstreamPayload(JSON.stringify({
    id: "chatcmpl_coding_plan",
    created: 123,
    model: "doubao-coding-plan",
    choices: [
      {
        message: {
          role: "assistant",
          content: "coding plan answer"
        }
      }
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18
    }
  }), "doubao-coding-plan", "chat_completions");

  const frames = buildStreamingEvents(JSON.stringify(normalized), "doubao-coding-plan");
  assertCodexClientCanParseSse(encodeFrames(frames));
});

test("codex client compat rejects completed event without input_tokens", () => {
  assert.throws(() => {
    assertCodexClientCanParseSse(encodeFrames([
      {
        event: "response.completed",
        data: {
          type: "response.completed",
          sequence_number: 0,
          response: {
            id: "resp_bad_usage",
            object: "response",
            status: "completed",
            model: "doubao-coding-plan",
            output: [],
            usage: {
              total_tokens: 18
            }
          }
        }
      }
    ]));
  }, /input_tokens/);
});

