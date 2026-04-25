export type CodexModelMetadata = {
  slug: string;
  display_name: string;
  description: string;
  default_reasoning_level: string;
  supported_reasoning_levels: Array<{
    effort: string;
    description: string;
  }>;
  shell_type: string;
  visibility: string;
  supported_in_api: boolean;
  priority: number;
  additional_speed_tiers: string[];
  availability_nux: unknown;
  upgrade: unknown;
  base_instructions: string;
  model_messages: unknown[];
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: string;
  support_verbosity: boolean;
  default_verbosity: string;
  apply_patch_tool_type: string;
  web_search_tool_type: string;
  truncation_policy: {
    mode: string;
    limit: number;
  };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: boolean;
  experimental_supported_tools: unknown[];
  input_modalities: string[];
  supports_search_tool: boolean;
  context_window: number;
  effective_context_window_percent: number;
};

export const REQUIRED_MODEL_METADATA_KEYS = [
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
] as const;

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildDerivedModelMetadata(params: {
  slug: string;
  displayName?: string;
  description?: string;
  priority?: number;
  template: CodexModelMetadata;
}): CodexModelMetadata {
  const { slug, displayName, description, priority, template } = params;
  const metadata = cloneJson(template);

  metadata.slug = slug;
  metadata.display_name = displayName ?? slug;
  metadata.description = description ?? template.description;
  metadata.priority = priority ?? template.priority;
  metadata.default_reasoning_summary = "auto";

  return metadata;
}

export function findMissingMetadataKeys(model: Record<string, unknown>): string[] {
  return REQUIRED_MODEL_METADATA_KEYS.filter((key) => !(key in model));
}
