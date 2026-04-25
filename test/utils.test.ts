import test from "node:test";
import assert from "node:assert/strict";
import { jsonError, makeRequestId, requireProxyAuth, resolveModel } from "../src/utils.ts";

test("makeRequestId generates cap-prefixed ids", () => {
  assert.match(makeRequestId(), /^cap_[a-z0-9]+$/);
});

test("resolveModel maps configured upstream models and falls back to defaults", () => {
  const config = {
    host: "127.0.0.1",
    port: 8787,
    logLevel: "info" as const,
    arkBaseUrl: "https://ark.example.com",
    arkApiKey: "",
    arkModelDefault: "default-model",
    exposeModels: ["default-model"],
    modelMap: {
      "gpt-5.4": "doubao-seed-2-0-mini-260215"
    },
    requestTimeoutMs: 1,
    streamIdleTimeoutMs: 1,
    proxyAuthToken: ""
  };

  assert.deepEqual(resolveModel("gpt-5.4", config), {
    upstreamModel: "gpt-5.4",
    downstreamModel: "doubao-seed-2-0-mini-260215"
  });
  assert.deepEqual(resolveModel(undefined, config), {
    upstreamModel: "default-model",
    downstreamModel: "default-model"
  });
});

test("requireProxyAuth allows requests when auth is disabled", () => {
  const request = {
    headers: {}
  };
  const reply = {
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

  assert.equal(requireProxyAuth(request as never, reply as never, {
    host: "127.0.0.1",
    port: 8787,
    logLevel: "info",
    arkBaseUrl: "https://ark.example.com",
    arkApiKey: "",
    arkModelDefault: "default-model",
    exposeModels: [],
    modelMap: {},
    requestTimeoutMs: 1,
    streamIdleTimeoutMs: 1,
    proxyAuthToken: ""
  }), true);
  assert.equal(reply.codeCalledWith, 0);
});

test("requireProxyAuth rejects invalid bearer tokens", () => {
  const request = {
    headers: {
      authorization: "Bearer bad-token"
    }
  };
  const reply = {
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

  assert.equal(requireProxyAuth(request as never, reply as never, {
    host: "127.0.0.1",
    port: 8787,
    logLevel: "info",
    arkBaseUrl: "https://ark.example.com",
    arkApiKey: "",
    arkModelDefault: "default-model",
    exposeModels: [],
    modelMap: {},
    requestTimeoutMs: 1,
    streamIdleTimeoutMs: 1,
    proxyAuthToken: "good-token"
  }), false);
  assert.equal(reply.codeCalledWith, 401);
  assert.deepEqual(reply.payload, {
    error: {
      message: "Invalid proxy auth token",
      type: "authentication_error",
      code: "invalid_proxy_token"
    }
  });
});

test("jsonError formats standard error payloads", () => {
  const reply = {
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

  jsonError(reply as never, 400, "bad request", "invalid_request_error", "bad_request", "input");
  assert.equal(reply.codeCalledWith, 400);
  assert.deepEqual(reply.payload, {
    error: {
      message: "bad request",
      type: "invalid_request_error",
      param: "input",
      code: "bad_request"
    }
  });
});
