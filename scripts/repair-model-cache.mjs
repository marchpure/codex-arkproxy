#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const home = process.env.HOME;
if (!home) {
  throw new Error("HOME is not set");
}

const cachePath = path.join(home, ".codex-arkproxy", "models_cache.json");
const backupPath = `${cachePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const fallbackTemplate = {
  slug: "gpt-5.4",
  display_name: "gpt-5.4",
  description: "Template model metadata for Ark provider models via codex-ark-proxy.",
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning." },
    { effort: "medium", description: "Balanced speed and reasoning depth." },
    { effort: "high", description: "Greater reasoning depth for complex tasks." },
    { effort: "xhigh", description: "Extra high reasoning depth for complex tasks." }
  ],
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: 2,
  additional_speed_tiers: ["fast"],
  availability_nux: null,
  upgrade: null,
  base_instructions: "",
  model_messages: [],
  supports_reasoning_summaries: true,
  default_reasoning_summary: "auto",
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

fs.mkdirSync(path.dirname(cachePath), { recursive: true });

const cacheExisted = fs.existsSync(cachePath);
const parsed = cacheExisted
  ? JSON.parse(fs.readFileSync(cachePath, "utf8"))
  : { models: [fallbackTemplate] };

if (!Array.isArray(parsed.models)) {
  throw new Error("models_cache.json is missing models array");
}

const template = parsed.models.find((model) => model?.slug === "gpt-5.4") ?? fallbackTemplate;
if (!template) {
  throw new Error("gpt-5.4 template model not found in models_cache.json");
}

const requiredKeys = [
  "slug",
  "display_name",
  "description",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "shell_type",
  "visibility",
  "supported_in_api",
  "priority",
  "additional_speed_tiers",
  "availability_nux",
  "upgrade",
  "base_instructions",
  "model_messages",
  "supports_reasoning_summaries",
  "default_reasoning_summary",
  "support_verbosity",
  "default_verbosity",
  "apply_patch_tool_type",
  "web_search_tool_type",
  "truncation_policy",
  "supports_parallel_tool_calls",
  "supports_image_detail_original",
  "experimental_supported_tools",
  "input_modalities",
  "supports_search_tool",
  "context_window",
  "effective_context_window_percent"
];

const doubaoSpecs = [
  {
    slug: "doubao-seed-2-0-pro-260215",
    description: "Ark provider model via codex-ark-proxy.",
    priority: 50
  },
  {
    slug: "doubao-seed-2-0-mini-260215",
    description: "Ark provider model via codex-ark-proxy.",
    priority: 51
  }
];

const configuredModels = [
  process.env.ARK_MODEL_DEFAULT,
  ...(process.env.EXPOSE_MODELS ?? "").split(",")
].map((slug) => slug?.trim()).filter(Boolean);

for (const slug of configuredModels) {
  if (!doubaoSpecs.some((spec) => spec.slug === slug)) {
    doubaoSpecs.push({
      slug,
      description: "Ark provider model via codex-ark-proxy.",
      priority: 60 + doubaoSpecs.length
    });
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function buildDerivedModel(spec) {
  const model = clone(template);
  model.slug = spec.slug;
  model.display_name = spec.slug;
  model.description = spec.description;
  model.priority = spec.priority;
  model.default_reasoning_summary = "auto";
  return model;
}

function missingKeys(model) {
  return requiredKeys.filter((key) => !(key in model));
}

const repairedModels = parsed.models.filter((model) => !doubaoSpecs.some((spec) => spec.slug === model?.slug));
for (const spec of doubaoSpecs) {
  const derived = buildDerivedModel(spec);
  const missing = missingKeys(derived);
  if (missing.length > 0) {
    throw new Error(`derived model ${spec.slug} is missing keys: ${missing.join(", ")}`);
  }
  repairedModels.push(derived);
}

if (cacheExisted) {
  fs.copyFileSync(cachePath, backupPath);
}
fs.writeFileSync(
  cachePath,
  `${JSON.stringify({ ...parsed, models: repairedModels }, null, 2)}\n`,
  "utf8"
);

console.log(JSON.stringify({
  cachePath,
  backupPath: cacheExisted ? backupPath : null,
  cacheCreated: !cacheExisted,
  repairedSlugs: doubaoSpecs.map((spec) => spec.slug)
}, null, 2));
