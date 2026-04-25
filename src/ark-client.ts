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

function buildArkHeaders(config: ProxyConfig): Headers {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  headers.set("authorization", `Bearer ${config.arkApiKey}`);
  return headers;
}

export async function forwardResponsesRequest(params: {
  body: ResponsesRequest;
  context: ArkRequestContext;
  config: ProxyConfig;
}): Promise<Response> {
  const { body, context, config } = params;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  try {
    const downstreamBody = buildDownstreamBody(body, context);

    if (process.env.LOG_LEVEL === "debug") {
      console.error("[codex-ark-proxy] downstream body", JSON.stringify(downstreamBody));
    }

    return await fetch(`${config.arkBaseUrl}/responses`, {
      method: "POST",
      headers: buildArkHeaders(config),
      body: JSON.stringify(downstreamBody),
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}
