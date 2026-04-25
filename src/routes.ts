import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";
import { z } from "zod";
import type { ProxyConfig, ResponsesRequest } from "./types.js";
import { ArkRequestAbortedError, ArkUpstreamFetchError, forwardResponsesRequest } from "./ark-client.js";
import { jsonError, makeRequestId, requireProxyAuth, resolveModel } from "./utils.js";

const responsesSchema = z.object({
  model: z.string().optional(),
  stream: z.boolean().optional(),
  input: z.unknown().optional(),
  tools: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  instructions: z.unknown().optional(),
  metadata: z.unknown().optional()
}).catchall(z.unknown());

function writeSse(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\n`);
  reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
}

type StreamingEventFrame = {
  event: string;
  data: Record<string, unknown>;
};

function chunkText(text: string, size = 16): string[] {
  if (!text) {
    return [];
  }

  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += size) {
    chunks.push(text.slice(index, index + size));
  }
  return chunks;
}

export function normalizeResponseForStreaming(payload: Record<string, unknown>, downstreamModel: string): Record<string, unknown> {
  const response = (payload.response && typeof payload.response === "object")
    ? payload.response as Record<string, unknown>
    : payload;

  return {
    ...response,
    model: response.model ?? downstreamModel,
    object: response.object ?? "response",
    status: response.status ?? "completed"
  };
}

export function pickAssistantMessage(response: Record<string, unknown>): Record<string, unknown> | null {
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (record.type === "message" && record.role === "assistant") {
      return record;
    }
  }
  return null;
}

export function extractOutputText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    if (record.type === "output_text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.join("");
}

export function buildStreamCompletionResponse(
  response: Record<string, unknown>,
  assistantMessage: Record<string, unknown> | null
): Record<string, unknown> {
  void assistantMessage;
  if (!Array.isArray(response.output)) {
    return response;
  }

  return {
    ...response,
    output: response.output
  };
}

function parseStreamingPayload(payloadText: string): Record<string, unknown> {
  const payload = JSON.parse(payloadText) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SyntaxError("Ark streaming payload must be a JSON object");
  }

  const record = payload as Record<string, unknown>;
  if (
    "response" in record &&
    (!record.response || typeof record.response !== "object" || Array.isArray(record.response))
  ) {
    throw new SyntaxError("Ark streaming response wrapper must contain a JSON object response");
  }

  return record;
}

function emitMessageItemEvents(params: {
  frames: StreamingEventFrame[];
  item: Record<string, unknown>;
  outputIndex: number;
  sequenceNumber: number;
}): number {
  const { frames, item, outputIndex } = params;
  let { sequenceNumber } = params;
  const itemId = typeof item.id === "string" ? item.id : `msg_${outputIndex}`;
  const content = Array.isArray(item.content) ? item.content : [];

  frames.push({
    event: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "message",
        role: item.role ?? "assistant",
        status: "in_progress",
        id: itemId,
        phase: item.phase,
        content: []
      },
      sequence_number: sequenceNumber++
    }
  });

  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const part = content[contentIndex];
    if (!part || typeof part !== "object") {
      continue;
    }
    const record = part as Record<string, unknown>;
    const partType = typeof record.type === "string" ? record.type : "output_text";
    const text = typeof record.text === "string"
      ? record.text
      : typeof record.refusal === "string"
        ? record.refusal
        : "";

    if (partType === "output_text" || partType === "refusal") {
      const deltaEvent = partType === "output_text" ? "response.output_text.delta" : "response.refusal.delta";
      const doneEvent = partType === "output_text" ? "response.output_text.done" : "response.refusal.done";

      for (const chunk of chunkText(text)) {
        frames.push({
          event: deltaEvent,
          data: {
            type: deltaEvent,
            content_index: contentIndex,
            delta: chunk,
            item_id: itemId,
            output_index: outputIndex,
            sequence_number: sequenceNumber++
          }
        });
      }

      frames.push({
        event: doneEvent,
        data: {
          type: doneEvent,
          content_index: contentIndex,
          ...(partType === "output_text" ? { text } : { refusal: text }),
          item_id: itemId,
          output_index: outputIndex,
          sequence_number: sequenceNumber++
        }
      });
    }
  }

  frames.push({
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        ...item,
        id: itemId,
        type: "message",
        role: item.role ?? "assistant",
        status: "completed",
        content
      },
      sequence_number: sequenceNumber++
    }
  });

  return sequenceNumber;
}

function reasoningSummaryText(item: Record<string, unknown>): string {
  const summary = Array.isArray(item.summary) ? item.summary : [];
  return summary
    .filter((part): part is Record<string, unknown> => Boolean(part) && typeof part === "object")
    .map((part) => typeof part.text === "string" ? part.text : "")
    .join("\n\n")
    .trim();
}

function emitReasoningItemEvents(params: {
  frames: StreamingEventFrame[];
  item: Record<string, unknown>;
  outputIndex: number;
  sequenceNumber: number;
}): number {
  const { frames, item, outputIndex } = params;
  let { sequenceNumber } = params;
  const itemId = typeof item.id === "string" ? item.id : `rs_${outputIndex}`;
  const text = reasoningSummaryText(item);

  frames.push({
    event: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        ...item,
        id: itemId,
        type: "reasoning",
        status: "in_progress",
        summary: []
      },
      sequence_number: sequenceNumber++
    }
  });

  if (text) {
    frames.push({
      event: "response.reasoning_summary_part.added",
      data: {
        type: "response.reasoning_summary_part.added",
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: {
          type: "summary_text",
          text: ""
        },
        sequence_number: sequenceNumber++
      }
    });

    for (const chunk of chunkText(text)) {
      frames.push({
        event: "response.reasoning_summary_text.delta",
        data: {
          type: "response.reasoning_summary_text.delta",
          item_id: itemId,
          output_index: outputIndex,
          summary_index: 0,
          delta: chunk,
          sequence_number: sequenceNumber++
        }
      });
    }

    frames.push({
      event: "response.reasoning_summary_text.done",
      data: {
        type: "response.reasoning_summary_text.done",
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        text,
        sequence_number: sequenceNumber++
      }
    });
  }

  frames.push({
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        ...item,
        id: itemId,
        type: "reasoning",
        status: "completed",
        summary: text ? [{ type: "summary_text", text }] : []
      },
      sequence_number: sequenceNumber++
    }
  });

  return sequenceNumber;
}

function emitFunctionCallItemEvents(params: {
  frames: StreamingEventFrame[];
  item: Record<string, unknown>;
  outputIndex: number;
  sequenceNumber: number;
}): number {
  const { frames, item, outputIndex } = params;
  let { sequenceNumber } = params;
  const itemId = typeof item.id === "string" ? item.id : `fc_${outputIndex}`;
  const callId = typeof item.call_id === "string" ? item.call_id : itemId;
  const name = typeof item.name === "string" ? item.name : "unknown_tool";
  const argumentsText = typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments ?? {});

  frames.push({
    event: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        ...item,
        id: itemId,
        type: "function_call",
        call_id: callId,
        name,
        arguments: "",
        status: "in_progress"
      },
      sequence_number: sequenceNumber++
    }
  });

  for (const chunk of chunkText(argumentsText)) {
    frames.push({
      event: "response.function_call_arguments.delta",
      data: {
        type: "response.function_call_arguments.delta",
        item_id: itemId,
        output_index: outputIndex,
        delta: chunk,
        sequence_number: sequenceNumber++
      }
    });
  }

  frames.push({
    event: "response.function_call_arguments.done",
    data: {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: outputIndex,
      arguments: argumentsText,
      sequence_number: sequenceNumber++
    }
  });

  frames.push({
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        ...item,
        id: itemId,
        type: "function_call",
        call_id: callId,
        name,
        arguments: argumentsText,
        status: item.status ?? "completed"
      },
      sequence_number: sequenceNumber++
    }
  });

  return sequenceNumber;
}

function emitGenericItemEvents(params: {
  frames: StreamingEventFrame[];
  item: Record<string, unknown>;
  outputIndex: number;
  sequenceNumber: number;
}): number {
  const { frames, item, outputIndex } = params;
  let { sequenceNumber } = params;

  frames.push({
    event: "response.output_item.added",
    data: {
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        ...item,
        status: "in_progress"
      },
      sequence_number: sequenceNumber++
    }
  });

  frames.push({
    event: "response.output_item.done",
    data: {
      type: "response.output_item.done",
      output_index: outputIndex,
      item: {
        ...item,
        status: item.status ?? "completed"
      },
      sequence_number: sequenceNumber++
    }
  });

  return sequenceNumber;
}

export function buildStreamingEvents(payloadText: string, downstreamModel: string): StreamingEventFrame[] {
  const payload = parseStreamingPayload(payloadText);
  const response = normalizeResponseForStreaming(payload, downstreamModel);
  const responseId = typeof response.id === "string" ? response.id : makeRequestId();
  const createdResponse = {
    ...response,
    id: responseId
  };
  const assistantMessage = pickAssistantMessage(createdResponse);
  const completedResponse = buildStreamCompletionResponse(createdResponse, assistantMessage);
  let sequenceNumber = 0;
  const frames: StreamingEventFrame[] = [];

  frames.push({
    event: "response.created",
    data: {
      type: "response.created",
      response: {
        ...createdResponse,
        output: []
      },
      sequence_number: sequenceNumber++
    }
  });
  frames.push({
    event: "response.in_progress",
    data: {
      type: "response.in_progress",
      response: {
        ...createdResponse,
        output: [],
        status: "in_progress"
      },
      sequence_number: sequenceNumber++
    }
  });

  const output = Array.isArray(completedResponse.output) ? completedResponse.output : [];
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const item = output[outputIndex];
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    if (record.type === "reasoning") {
      sequenceNumber = emitReasoningItemEvents({
        frames,
        item: record,
        outputIndex,
        sequenceNumber
      });
      continue;
    }

    if (record.type === "message") {
      sequenceNumber = emitMessageItemEvents({
        frames,
        item: record,
        outputIndex,
        sequenceNumber
      });
      continue;
    }

    if (record.type === "function_call") {
      sequenceNumber = emitFunctionCallItemEvents({
        frames,
        item: record,
        outputIndex,
        sequenceNumber
      });
      continue;
    }

    sequenceNumber = emitGenericItemEvents({
      frames,
      item: record,
      outputIndex,
      sequenceNumber
    });
  }

  frames.push({
    event: "response.completed",
    data: {
      type: "response.completed",
      response: completedResponse,
      sequence_number: sequenceNumber++
    }
  });

  return frames;
}

function streamNormalizedResponse(reply: FastifyReply, frames: StreamingEventFrame[], idleTimeoutMs: number): void {
  const resetIdleTimer = (() => {
    let timer: NodeJS.Timeout | undefined;
    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        reply.raw.destroy(new Error("SSE stream idle timeout"));
      }, idleTimeoutMs);
      return () => {
        if (timer) {
          clearTimeout(timer);
          timer = undefined;
        }
      };
    };
  })();
  const clearIdleTimer = resetIdleTimer();
  const headers: OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(reply.getHeaders())) {
    headers[key] = typeof value === "number" ? String(value) : value;
  }
  Object.assign(headers, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });
  reply.raw.writeHead(200, headers);
  try {
    for (const frame of frames) {
      resetIdleTimer();
      writeSse(reply, frame.event, frame.data);
    }
    resetIdleTimer();
    reply.raw.write("data: [DONE]\n\n");
    reply.raw.end();
  } finally {
    clearIdleTimer();
  }
}

async function handleResponses(request: FastifyRequest, reply: FastifyReply, config: ProxyConfig) {
  if (!requireProxyAuth(request, reply, config)) {
    return reply;
  }
  if (!config.arkApiKey) {
    return jsonError(reply, 503, "ARK_API_KEY is not configured", "configuration_error", "missing_ark_api_key");
  }

  let body: ResponsesRequest;
  try {
    body = responsesSchema.parse(request.body);
  } catch {
    return jsonError(reply, 400, "Invalid responses request body", "invalid_request_error", "invalid_body");
  }

  const requestId = makeRequestId();
  const { upstreamModel, downstreamModel } = resolveModel(body.model, config);
  const stream = body.stream === true;
  const clientAbortController = new AbortController();
  const abortOnClientDisconnect = () => clientAbortController.abort();
  const abortIfRequestWasAborted = () => {
    if (request.raw.aborted) {
      abortOnClientDisconnect();
    }
  };
  request.raw.on("aborted", abortOnClientDisconnect);
  request.raw.on("close", abortIfRequestWasAborted);
  reply.raw.socket?.on("close", abortOnClientDisconnect);
  reply.raw.on("close", abortOnClientDisconnect);

  request.log.info({
    requestId,
    upstreamModel,
    downstreamModel,
    stream,
    path: request.url,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    tools: body.tools,
    toolChoice: body.tool_choice
  }, "forwarding responses request");

  try {
    const upstreamResponse = await forwardResponsesRequest({
      body,
      context: {
        requestId,
        upstreamModel,
        downstreamModel,
        stream,
        signal: clientAbortController.signal
      },
      config
    });

    if (!upstreamResponse.ok) {
      request.log.error({
        requestId,
        status: upstreamResponse.status,
        body: upstreamResponse.text
      }, "ark request failed");
      reply.code(upstreamResponse.status);
      reply.header("content-type", upstreamResponse.contentType);
      return reply.send(upstreamResponse.text);
    }

    reply.header("x-codex-ark-proxy-request-id", requestId);
    reply.header("x-codex-ark-upstream-model", downstreamModel);

    reply.header("content-type", upstreamResponse.contentType);
    reply.code(upstreamResponse.status);

    if (!stream) {
      return reply.send(upstreamResponse.text);
    }

    const frames = buildStreamingEvents(upstreamResponse.text, downstreamModel);
    streamNormalizedResponse(reply, frames, config.streamIdleTimeoutMs);
    return reply;
  } catch (error) {
    if (error instanceof ArkRequestAbortedError) {
      if (error.reason === "client") {
        request.log.info({ requestId }, "client disconnected before ark response completed");
        return reply;
      }
      return jsonError(reply, 504, error.message, "timeout_error", "ark_request_timeout");
    }
    if (error instanceof ArkUpstreamFetchError) {
      request.log.error({ requestId, error }, "failed to reach ark upstream");
      return jsonError(reply, 502, error.message, "api_error", "ark_upstream_fetch_failed");
    }
    if (stream && error instanceof SyntaxError) {
      request.log.error({ requestId, error }, "ark returned invalid streaming payload");
      return jsonError(reply, 502, "Ark returned an invalid streaming payload", "api_error", "ark_invalid_streaming_payload");
    }
    throw error;
  } finally {
    request.raw.off("aborted", abortOnClientDisconnect);
    request.raw.off("close", abortIfRequestWasAborted);
    reply.raw.socket?.off("close", abortOnClientDisconnect);
    reply.raw.off("close", abortOnClientDisconnect);
  }
}

export async function registerRoutes(app: FastifyInstance, config: ProxyConfig): Promise<void> {
  app.addHook("onRequest", async (request) => {
    if (
      request.method === "POST" &&
      (request.url === "/responses" || request.url === "/v1/responses") &&
      !request.headers["content-type"]
    ) {
      request.headers["content-type"] = "application/json";
    }
  });

  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    try {
      const text = typeof body === "string" ? body : body.toString("utf8");
      done(null, text ? JSON.parse(text) : null);
    } catch (error) {
      done(error as Error);
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof SyntaxError) {
      return jsonError(reply, 400, "Invalid responses request body", "invalid_request_error", "invalid_body");
    }
    throw error;
  });

  app.get("/healthz", async () => ({
    ok: true,
    service: "codex-ark-proxy",
    arkBaseUrl: config.arkBaseUrl,
    defaultModel: config.arkModelDefault,
    exposeModels: config.exposeModels,
    authEnabled: Boolean(config.proxyAuthToken)
  }));

  app.get("/v1/models", async (_request, reply) => {
    return reply.send({
      object: "list",
      data: config.exposeModels.map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: "codex-ark-proxy"
      }))
    });
  });

  app.post("/v1/responses", async (request, reply) => handleResponses(request, reply, config));
  app.post("/responses", async (request, reply) => handleResponses(request, reply, config));
}
