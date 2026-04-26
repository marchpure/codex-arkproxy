import type { ArkRequestContext, ProxyConfig, ResponsesRequest } from "./types.js";

export const TOP_LEVEL_ALLOWED_KEYS = new Set([
  "background",
  "conversation",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "parallel_tool_calls",
  "previous_response_id",
  "prompt",
  "prompt_cache_key",
  "prompt_cache_retention",
  "reasoning",
  "safety_identifier",
  "service_tier",
  "store",
  "stream",
  "temperature",
  "text",
  "tool_choice",
  "tools",
  "top_p",
  "truncation",
  "user"
]);

export function sanitizeTools(rawTools: unknown): unknown {
  if (!Array.isArray(rawTools)) {
    return rawTools;
  }

  return rawTools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") {
      return [];
    }

    const sanitized = deepStripExternalWebAccess(tool);
    if (!sanitized || typeof sanitized !== "object") {
      return [];
    }

    const record = sanitized as Record<string, unknown>;
    if (record.type !== "function" && record.type !== "web_search") {
      return [];
    }

    return [record];
  });
}

export function deepStripExternalWebAccess(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => deepStripExternalWebAccess(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(record)) {
    if (key === "external_web_access") {
      continue;
    }
    if (key === "verbosity") {
      continue;
    }
    output[key] = deepStripExternalWebAccess(nested);
  }
  return output;
}

function normalizeInputItemStatus(value: unknown): unknown {
  if (!Array.isArray(value)) {
    return value;
  }

  return value.map((item) => {
    if (!item || typeof item !== "object") {
      return item;
    }

    const record = item as Record<string, unknown>;
    if (typeof record.status === "string") {
      return record;
    }

    switch (record.type) {
      case "message":
      case "reasoning":
      case "function_call":
      case "function_call_output":
        return {
          ...record,
          status: "completed"
        };
      default:
        return record;
    }
  });
}

export function buildDownstreamBody(body: ResponsesRequest, context: ArkRequestContext): Record<string, unknown> {
  const downstreamBody: Record<string, unknown> = {
    model: context.downstreamModel
  };

  for (const [key, value] of Object.entries(body)) {
    if (key === "model") {
      continue;
    }
    if (!TOP_LEVEL_ALLOWED_KEYS.has(key)) {
      continue;
    }
    if (key === "tools") {
      downstreamBody.tools = sanitizeTools(value);
      continue;
    }
    if (key === "stream") {
      downstreamBody.stream = false;
      continue;
    }
    const sanitizedValue = deepStripExternalWebAccess(value);
    downstreamBody[key] = key === "input"
      ? normalizeInputItemStatus(sanitizedValue)
      : sanitizedValue;
  }

  return downstreamBody;
}

function textFromContentParts(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content.map((part) => {
    if (!part || typeof part !== "object") {
      return "";
    }
    const record = part as Record<string, unknown>;
    return typeof record.text === "string" ? record.text : "";
  }).join("");
}

function normalizeChatMessageRole(role: unknown): "system" | "assistant" | "user" | "tool" {
  switch (role) {
    case "system":
    case "assistant":
    case "user":
    case "tool":
      return role;
    case "developer":
      return "system";
    default:
      return "user";
  }
}

function responseInputToChatMessages(body: ResponsesRequest): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof body.instructions === "string" && body.instructions.trim()) {
    messages.push({ role: "system", content: body.instructions });
  }

  const input = body.input;
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) {
    return messages;
  }

  for (const item of input) {
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = deepStripExternalWebAccess(item) as Record<string, unknown>;
    if (record.type === "message") {
      messages.push({
        role: normalizeChatMessageRole(record.role),
        content: typeof record.content === "string" ? record.content : textFromContentParts(record.content)
      });
      continue;
    }
    if (record.type === "function_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: typeof record.call_id === "string" ? record.call_id : undefined,
        content: typeof record.output === "string" ? record.output : JSON.stringify(record.output ?? "")
      });
    }
  }

  return messages;
}

function sanitizeChatTools(rawTools: unknown): unknown {
  if (!Array.isArray(rawTools)) {
    return rawTools;
  }

  return rawTools.flatMap((tool) => {
    if (!tool || typeof tool !== "object") {
      return [];
    }
    const record = deepStripExternalWebAccess(tool) as Record<string, unknown>;
    if (record.type !== "function") {
      return [];
    }
    if (record.function && typeof record.function === "object") {
      return [{ type: "function", function: record.function }];
    }
    if (typeof record.name !== "string") {
      return [];
    }
    return [{
      type: "function",
      function: {
        name: record.name,
        ...(typeof record.description === "string" ? { description: record.description } : {}),
        ...(record.parameters && typeof record.parameters === "object" ? { parameters: record.parameters } : {})
      }
    }];
  });
}

export function buildChatCompletionsBody(body: ResponsesRequest, context: ArkRequestContext): Record<string, unknown> {
  const downstreamBody: Record<string, unknown> = {
    model: context.downstreamModel,
    stream: false,
    messages: responseInputToChatMessages(body)
  };

  if (body.tools !== undefined) {
    downstreamBody.tools = sanitizeChatTools(body.tools);
  }
  if (body.tool_choice !== undefined) {
    downstreamBody.tool_choice = body.tool_choice;
  }
  if (body.temperature !== undefined) {
    downstreamBody.temperature = body.temperature;
  }
  if (body.top_p !== undefined) {
    downstreamBody.top_p = body.top_p;
  }
  if (body.parallel_tool_calls !== undefined) {
    downstreamBody.parallel_tool_calls = body.parallel_tool_calls;
  }
  if (body.max_output_tokens !== undefined) {
    downstreamBody.max_tokens = body.max_output_tokens;
  }

  return downstreamBody;
}

export function buildArkHeaders(config: ProxyConfig): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${config.arkApiKey}`);
  if (config.arkRegion) {
    headers.set("x-user-region", config.arkRegion);
  }
  if (config.arkEndpoint) {
    headers.set("x-user-model", config.arkEndpoint);
  }
  for (const [key, value] of Object.entries(config.arkExtraHeaders ?? {})) {
    if (key.toLowerCase() === "authorization" || key.toLowerCase() === "content-type") {
      continue;
    }
    headers.set(key, value);
  }
  return headers;
}

export type ArkAbortReason = "client" | "timeout";

export class ArkRequestAbortedError extends Error {
  constructor(public readonly reason: ArkAbortReason) {
    super(reason === "timeout" ? "Ark request timed out" : "Ark request was cancelled by the client");
    this.name = "ArkRequestAbortedError";
  }
}

export class ArkUpstreamFetchError extends Error {
  constructor(cause: unknown) {
    super("Failed to connect to Ark upstream", { cause });
    this.name = "ArkUpstreamFetchError";
  }
}

export type ForwardResponsesResult = {
  ok: boolean;
  status: number;
  contentType: string;
  text: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export async function forwardResponsesRequest(params: {
  body: ResponsesRequest;
  context: ArkRequestContext;
  config: ProxyConfig;
}): Promise<ForwardResponsesResult> {
  const { body, context, config } = params;
  const controller = new AbortController();
  let abortReason: ArkAbortReason | undefined;
  const abortForClient = () => {
    abortReason = "client";
    controller.abort();
  };
  const abortForTimeout = () => {
    abortReason = "timeout";
    controller.abort();
  };
  const timeout = setTimeout(abortForTimeout, config.requestTimeoutMs);
  if (context.signal?.aborted) {
    abortForClient();
  } else {
    context.signal?.addEventListener("abort", abortForClient, { once: true });
  }

  try {
    const downstreamBody = config.arkApiMode === "chat_completions"
      ? buildChatCompletionsBody(body, context)
      : buildDownstreamBody(body, context);

    if (process.env.LOG_LEVEL === "debug") {
      console.error("[codex-ark-proxy] downstream body", JSON.stringify(downstreamBody));
    }

    const path = config.arkApiMode === "chat_completions" ? "/chat/completions" : "/responses";
    const response = await fetch(`${config.arkBaseUrl}${path}`, {
      method: "POST",
      headers: buildArkHeaders(config),
      body: JSON.stringify(downstreamBody),
      signal: controller.signal
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType: response.headers.get("content-type") ?? "application/json",
      text
    };
  } catch (error) {
    if (isAbortError(error)) {
      throw new ArkRequestAbortedError(abortReason ?? (context.signal?.aborted ? "client" : "timeout"));
    }
    throw new ArkUpstreamFetchError(error);
  } finally {
    clearTimeout(timeout);
    context.signal?.removeEventListener("abort", abortForClient);
  }
}
