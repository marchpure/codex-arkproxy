import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import Fastify from "fastify";
import { registerRoutes } from "../src/routes.ts";

const SCENARIO_COUNT = 1124;

type CapturedRequest = {
  path: string;
  body: Record<string, unknown>;
};

const captured: CapturedRequest[] = [];

const upstream = http.createServer((request, response) => {
  let rawBody = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => {
    rawBody += chunk;
  });
  request.on("end", () => {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    captured.push({ path: request.url ?? "", body });

    const messages = Array.isArray(body.messages) ? body.messages as Record<string, unknown>[] : [];
    const roles = messages.map((message) => message.role);
    const invalidRole = roles.find((role) => !["system", "assistant", "user", "tool"].includes(String(role)));
    const responseOnlyKeys = ["input", "instructions", "max_output_tokens", "previous_response_id"];

    if (request.url !== "/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "wrong path" } }));
      return;
    }
    if (invalidRole || roles.includes("developer")) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `invalid role: ${String(invalidRole ?? "developer")}` } }));
      return;
    }
    if (responseOnlyKeys.some((key) => key in body)) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "responses field leaked to chat completions" } }));
      return;
    }

    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: `chatcmpl_${captured.length}`,
      model: typeof body.model === "string" ? body.model : "coding-plan-model",
      choices: [
        {
          message: {
            role: "assistant",
            content: `coding-plan-ok-${captured.length}`
          }
        }
      ],
      usage: {
        total_tokens: 10 + captured.length
      }
    }));
  });
});

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

let app: Fastify.FastifyInstance;
let upstreamPort = 0;

test.before(async () => {
  upstreamPort = await listen(upstream);
  app = Fastify();
  await registerRoutes(app, {
    host: "127.0.0.1",
    port: 8787,
    logLevel: "error",
    arkBaseUrl: `http://127.0.0.1:${upstreamPort}`,
    arkApiMode: "chat_completions",
    arkApiKey: "ark-key",
    arkRegion: "",
    arkEndpoint: "",
    arkExtraHeaders: {},
    arkModelDefault: "doubao-seed-2-0-pro-260215",
    exposeModels: ["doubao-seed-2-0-pro-260215"],
    modelMap: {
      "gpt-5.4": "doubao-seed-2-0-pro-260215"
    },
    requestTimeoutMs: 1000,
    streamIdleTimeoutMs: 1000,
    proxyAuthToken: ""
  });
});

test.after(async () => {
  app.server.closeAllConnections();
  await app.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    upstream.close((error) => error ? reject(error) : resolve());
  });
});

function inputForScenario(index: number): unknown {
  const role = index % 7 === 0
    ? "developer"
    : index % 7 === 1
      ? "system"
      : index % 7 === 2
        ? "assistant"
        : "user";

  if (index % 5 === 0) {
    return `plain input ${index}`;
  }

  const input: unknown[] = [
    { type: "message", role, content: [{ type: "input_text", text: `message-${index}` }] }
  ];

  if (index % 4 === 0) {
    input.push({ type: "function_call_output", call_id: `call_${index}`, output: `tool-output-${index}` });
  }
  if (index % 6 === 0) {
    input.push({ type: "reasoning", summary: [{ type: "summary_text", text: "must be dropped for chat" }] });
  }
  if (index % 8 === 0) {
    input.push({ type: "function_call", call_id: `call_${index}`, name: "ignored_replay_call", arguments: "{}" });
  }

  return input;
}

function toolsForScenario(index: number): unknown[] | undefined {
  if (index % 3 !== 0) {
    return undefined;
  }
  return [
    {
      type: "function",
      name: `tool_${index}`,
      description: "strict coding plan function tool",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        external_web_access: true,
        verbosity: "low"
      }
    },
    {
      type: "web_search",
      name: "must_be_dropped",
      external_web_access: true
    }
  ];
}

function parseSseFrames(body: string): Array<{ event?: string; data?: unknown }> {
  return body.trim().split("\n\n").flatMap((frame) => {
    const event = frame.split("\n").find((line) => line.startsWith("event: "))?.slice("event: ".length);
    const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine || dataLine === "data: [DONE]") {
      return [];
    }
    return [{ event, data: JSON.parse(dataLine.slice("data: ".length)) as unknown }];
  });
}

function assertResponsesUsage(usage: unknown): void {
  assert.ok(usage && typeof usage === "object" && !Array.isArray(usage));
  const record = usage as Record<string, unknown>;
  assert.equal(typeof record.input_tokens, "number");
  assert.equal(typeof record.output_tokens, "number");
  assert.equal(typeof record.total_tokens, "number");
}

for (let index = 0; index < SCENARIO_COUNT; index += 1) {
  test(`coding plan strict matrix ${index}`, async () => {
    const stream = index % 2 === 0;
    const response = await app.inject({
      method: "POST",
      url: index % 2 === 0 ? "/responses" : "/v1/responses",
      payload: {
        model: index % 3 === 0 ? "gpt-5.4" : "doubao-seed-2-0-pro-260215",
        instructions: index % 4 === 0 ? `developer instruction ${index}` : undefined,
        input: inputForScenario(index),
        tools: toolsForScenario(index),
        tool_choice: index % 9 === 0 ? "auto" : undefined,
        parallel_tool_calls: index % 10 === 0,
        max_output_tokens: 128 + (index % 32),
        temperature: (index % 10) / 10,
        top_p: 0.9,
        stream
      }
    });

    assert.equal(response.statusCode, 200, response.body);

    const latest = captured.at(-1);
    assert.ok(latest);
    assert.equal(latest.path, "/chat/completions");
    assert.equal("input" in latest.body, false);
    assert.equal("instructions" in latest.body, false);
    assert.equal("max_output_tokens" in latest.body, false);
    assert.equal(latest.body.stream, false);
    assert.ok(Array.isArray(latest.body.messages));

    const roles = (latest.body.messages as Record<string, unknown>[]).map((message) => message.role);
    assert.equal(roles.includes("developer"), false);
    assert.equal(roles.every((role) => ["system", "assistant", "user", "tool"].includes(String(role))), true);
    if (index % 8 === 0 && index % 5 !== 0) {
      const replay = (latest.body.messages as Record<string, unknown>[]).find((message) => message.role === "assistant" && Array.isArray(message.tool_calls));
      assert.ok(replay);
      const toolCalls = replay.tool_calls as Record<string, unknown>[];
      assert.equal(toolCalls[0]?.id, `call_${index}`);
      assert.equal((toolCalls[0]?.function as Record<string, unknown> | undefined)?.name, "ignored_replay_call");
    }

    if (toolsForScenario(index)) {
      const tools = latest.body.tools as Record<string, unknown>[];
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.type, "function");
    }

    if (stream) {
      assert.match(response.body, /event: response\.created/);
      assert.match(response.body, /event: response\.completed/);
      assert.ok(response.body.includes("data: [DONE]"));
      const completed = parseSseFrames(response.body).find((frame) => frame.event === "response.completed");
      const completedData = completed?.data as Record<string, unknown>;
      const completedResponse = completedData.response as Record<string, unknown>;
      assertResponsesUsage(completedResponse.usage);
    } else {
      const payload = response.json();
      assert.equal(payload.object, "response");
      assert.equal(payload.status, "completed");
      assert.match(payload.output[0].content[0].text, /^coding-plan-ok-/);
      assertResponsesUsage(payload.usage);
    }
  });
}
