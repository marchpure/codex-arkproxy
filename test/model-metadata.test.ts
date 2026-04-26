import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  buildDerivedModelMetadata,
  findMissingMetadataKeys,
  REQUIRED_MODEL_METADATA_KEYS,
  type CodexModelMetadata
} from "../src/model-metadata.ts";

const template: CodexModelMetadata = {
  slug: "gpt-5.4",
  display_name: "gpt-5.4",
  description: "Latest frontier agentic coding model.",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning" },
    { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
    { effort: "high", description: "Greater reasoning depth for complex problems" },
    { effort: "xhigh", description: "Extra high reasoning depth for complex problems" }
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 2,
  additional_speed_tiers: ["fast"],
  availability_nux: null,
  upgrade: null,
  base_instructions: "base instructions",
  model_messages: {
    instructions_template: "base instructions\n\n{{ personality }}",
    instructions_variables: {
      personality_default: "",
      personality_friendly: "",
      personality_pragmatic: ""
    }
  },
  supports_reasoning_summaries: true,
  default_reasoning_summary: "none",
  support_verbosity: true,
  default_verbosity: "low",
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: {
    mode: "tokens",
    limit: 10000
  },
  supports_parallel_tool_calls: true,
  supports_image_detail_original: true,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: true,
  context_window: 272000,
  effective_context_window_percent: 95
};

test("buildDerivedModelMetadata clones a complete template for doubao models", () => {
  const derived = buildDerivedModelMetadata({
    slug: "doubao-seed-2-0-pro-260215",
    description: "Ark provider model via codex-ark-proxy.",
    priority: 50,
    template
  });

  assert.equal(derived.slug, "doubao-seed-2-0-pro-260215");
  assert.equal(derived.display_name, "doubao-seed-2-0-pro-260215");
  assert.equal(derived.description, "Ark provider model via codex-ark-proxy.");
  assert.equal(derived.priority, 50);
  assert.equal(derived.default_reasoning_summary, "auto");
  assert.deepEqual(findMissingMetadataKeys(derived), []);
});

test("findMissingMetadataKeys catches incomplete metadata entries", () => {
  const incomplete = {
    slug: "doubao-seed-2-0-pro-260215",
    display_name: "doubao-seed-2-0-pro-260215"
  };

  const missing = findMissingMetadataKeys(incomplete);
  assert.ok(missing.includes("base_instructions"));
  assert.ok(missing.includes("model_messages"));
  assert.ok(missing.includes("apply_patch_tool_type"));
  assert.ok(missing.includes("web_search_tool_type"));
  assert.ok(missing.length < REQUIRED_MODEL_METADATA_KEYS.length);
});

test("repair-model-cache initializes models_cache.json when missing", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-arkproxy-home-"));

  execFileSync("node", ["scripts/repair-model-cache.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempHome
    }
  });

  const cachePath = path.join(tempHome, ".codex-arkproxy", "models_cache.json");
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const slugs = parsed.models.map((model: { slug: string }) => model.slug);

  assert.equal(slugs.includes("gpt-5.4"), false);
  assert.ok(slugs.includes("doubao-seed-2-0-pro-260215"));
  assert.ok(slugs.includes("doubao-seed-2-0-mini-260215"));
  const derived = parsed.models.find((model: { slug: string }) => model.slug === "doubao-seed-2-0-pro-260215");
  assert.equal(typeof derived.model_messages.instructions_template, "string");
  assert.equal(typeof derived.model_messages.instructions_variables, "object");
});

test("repair-model-cache includes configured exposed models", () => {
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "codex-arkproxy-home-"));

  execFileSync("node", ["scripts/repair-model-cache.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: tempHome,
      ARK_MODEL_DEFAULT: "custom-default",
      EXPOSE_MODELS: "custom-default, custom-extra, gpt-5.5"
    }
  });

  const cachePath = path.join(tempHome, ".codex-arkproxy", "models_cache.json");
  const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
  const slugs = parsed.models.map((model: { slug: string }) => model.slug);

  assert.ok(slugs.includes("custom-default"));
  assert.ok(slugs.includes("custom-extra"));
  assert.equal(slugs.includes("gpt-5.5"), false);
});

test("bootstrap catalog generator emits Codex-compatible model_messages", () => {
  const script = fs.readFileSync("bootstrap-codex-ark.sh", "utf8");
  assert.match(script, /model_messages: \{/);
  assert.match(script, /instructions_template:/);
  assert.match(script, /instructions_variables:/);
  assert.doesNotMatch(script, /model_messages: \[\]/);
});

test("bootstrap launcher pins Codex to arkproxy provider and model", () => {
  const script = fs.readFileSync("bootstrap-codex-ark.sh", "utf8");
  assert.match(script, /-c 'model_provider="codex-arkproxy-local"'/);
  assert.match(script, /-c 'model="\$ARK_MODEL_DEFAULT"'/);
  assert.match(script, /-c 'model_catalog_json="\$CODEX_HOME_DIR\/model-catalogs\/codex-arkproxy-current\.json"'/);
  assert.match(script, /model_providers\.codex-arkproxy-local\.base_url="http:\/\/\$PROXY_HOST:\$PROXY_PORT"/);
});

test("bootstrap launcher routes gpt models to native Codex instead of arkproxy", () => {
  const script = fs.readFileSync("bootstrap-codex-ark.sh", "utf8");
  assert.match(script, /requested_model/);
  assert.match(script, /\[\[ "\\\$requested_model" == gpt-\* \]\]/);
  assert.match(script, /unset CODEX_HOME/);
  assert.match(script, /exec "\\\$codex_bin" "\\\$@"/);
});
