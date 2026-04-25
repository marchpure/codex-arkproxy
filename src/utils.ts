import type { FastifyReply, FastifyRequest } from "fastify";
import type { ProxyConfig } from "./types.js";

export function makeRequestId(): string {
  return `cap_${Math.random().toString(36).slice(2, 12)}`;
}

export function resolveModel(requestedModel: string | undefined, config: ProxyConfig): {
  upstreamModel: string;
  downstreamModel: string;
} {
  const upstreamModel = requestedModel?.trim() || config.arkModelDefault;
  return {
    upstreamModel,
    downstreamModel: config.modelMap[upstreamModel] ?? upstreamModel ?? config.arkModelDefault
  };
}

export function requireProxyAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  config: ProxyConfig
): boolean {
  if (!config.proxyAuthToken) {
    return true;
  }

  const header = request.headers.authorization ?? request.headers["x-api-key"];
  const token = typeof request.headers.authorization === "string"
    ? request.headers.authorization.toLowerCase().startsWith("bearer ")
      ? request.headers.authorization.slice(7)
      : undefined
    : header;

  if (token !== config.proxyAuthToken) {
    void reply.code(401).send({
      error: {
        message: "Invalid proxy auth token",
        type: "authentication_error",
        code: "invalid_proxy_token"
      }
    });
    return false;
  }

  return true;
}

export function jsonError(
  reply: FastifyReply,
  statusCode: number,
  message: string,
  type: string,
  code: string,
  param?: string
): FastifyReply {
  return reply.code(statusCode).send({
    error: {
      message,
      type,
      ...(param ? { param } : {}),
      code
    }
  });
}
