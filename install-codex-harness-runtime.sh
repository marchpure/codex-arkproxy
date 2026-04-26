#!/usr/bin/env bash
set -euo pipefail

# Install and enable OpenClaw Codex harness runtime for the current user.
#
# Environment overrides:
#   OPENCLAW_CONFIG=/path/to/openclaw.json
#   OPENCLAW_CODEX_MODEL=codex-arkproxy-local/doubao-seed-2-0-pro-260215
#   OPENCLAW_CODEX_MODEL=codex/gpt-5.5
#   CODEX_PROVIDER_BASE_URL=http://127.0.0.1:8787/v1  # only used for codex-arkproxy-local
#   CODEX_PROVIDER_API_KEY=codex-arkproxy-local       # only used for codex-arkproxy-local
#   ARK_API_KEY=...
#   CODEX_BIN=/absolute/path/to/codex-arkproxy
#   CODEX_ARK_PROXY_BOOTSTRAP_URL=https://haoxingjun-test.tos-cn-beijing.volces.com/bootstrap-codex-ark.sh
#   INSTALL_CODEX_ARKPROXY=0
#   CODEX_ALIAS=0
#   DISABLE_AGENT_IDENTITY=0
#   RESTART_GATEWAY=0
#   RUN_AGENT_SMOKE=0
#   AGENT_SMOKE_SESSION_ID=agent:main:main
#   RESTORE_OPENCLAW_CONFIG=/path/to/known-good-openclaw.json

log() {
  printf '[codex-harness] %s\n' "$*"
}

fail() {
  printf '[codex-harness] ERROR: %s\n' "$*" >&2
  exit 1
}

wait_for_url() {
  local url="$1"
  local timeout="${2:-30}"
  local start
  start="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then
      return 1
    fi
    sleep 1
  done
}

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  if command -v nvm >/dev/null 2>&1; then
    nvm use 24 >/dev/null 2>&1 || nvm use 22 >/dev/null 2>&1 || nvm use default >/dev/null 2>&1 || true
  fi
fi

CONFIG_PATH="${OPENCLAW_CONFIG:-$HOME/.openclaw/openclaw.json}"
MODEL_ID="${OPENCLAW_CODEX_MODEL:-codex-arkproxy-local/doubao-seed-2-0-pro-260215}"
PUBLIC_BUCKET_BASE_URL="${PUBLIC_BUCKET_BASE_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com}"
CODEX_ARK_PROXY_BOOTSTRAP_URL="${CODEX_ARK_PROXY_BOOTSTRAP_URL:-$PUBLIC_BUCKET_BASE_URL/bootstrap-codex-ark.sh}"
INSTALL_CODEX_ARKPROXY="${INSTALL_CODEX_ARKPROXY:-1}"
CODEX_ALIAS="${CODEX_ALIAS:-1}"
DISABLE_AGENT_IDENTITY="${DISABLE_AGENT_IDENTITY:-1}"
RESTART_GATEWAY="${RESTART_GATEWAY:-1}"
RUN_AGENT_SMOKE="${RUN_AGENT_SMOKE:-1}"
AGENT_SMOKE_SESSION_ID="${AGENT_SMOKE_SESSION_ID:-agent:main:main}"
RESTORE_OPENCLAW_CONFIG="${RESTORE_OPENCLAW_CONFIG:-}"
CODEX_HOME_DIR="${CODEX_HOME_DIR:-$HOME/.codex-arkproxy}"

MODEL_PROVIDER_ID="${MODEL_ID%%/*}"
if [ "$MODEL_PROVIDER_ID" = "$MODEL_ID" ]; then
  MODEL_PROVIDER_ID="codex-arkproxy-local"
  MODEL_NAME="$MODEL_ID"
else
  MODEL_NAME="${MODEL_ID#*/}"
fi
USE_ARKPROXY=1
if [ "$MODEL_PROVIDER_ID" = "codex" ] && [[ "$MODEL_NAME" == gpt-* ]]; then
  USE_ARKPROXY=0
fi
CODEX_PROVIDER_BASE_URL="${CODEX_PROVIDER_BASE_URL:-http://127.0.0.1:8787/v1}"
CODEX_PROVIDER_API_KEY="${CODEX_PROVIDER_API_KEY:-codex-arkproxy-local}"

[ -f "$CONFIG_PATH" ] || fail "OpenClaw config not found: $CONFIG_PATH"

if [ -n "$RESTORE_OPENCLAW_CONFIG" ]; then
  [ -f "$RESTORE_OPENCLAW_CONFIG" ] || fail "restore config not found: $RESTORE_OPENCLAW_CONFIG"
  RESTORE_BACKUP_PATH="${CONFIG_PATH}.before-restore-$(date +%Y%m%d-%H%M%S).bak"
  cp "$CONFIG_PATH" "$RESTORE_BACKUP_PATH"
  cp "$RESTORE_OPENCLAW_CONFIG" "$CONFIG_PATH"
  log "Restored config from $RESTORE_OPENCLAW_CONFIG"
  log "Previous config backed up to $RESTORE_BACKUP_PATH"
fi

read_existing_ark_api_key() {
  if [ -n "${ARK_API_KEY:-}" ]; then
    printf '%s\n' "$ARK_API_KEY"
    return
  fi

  local env_file="$HOME/.codex-arkproxy/codex-ark-proxy/.env"
  if [ -f "$env_file" ]; then
    awk -F= '/^ARK_API_KEY=/ && length($2) > 0 { print substr($0, index($0, "=") + 1); exit }' "$env_file"
    return
  fi

  CONFIG_PATH="$CONFIG_PATH" node <<'NODE'
const fs = require("node:fs");
const path = process.env.CONFIG_PATH;
try {
  const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
  const providers = cfg?.models?.providers;
  if (providers && typeof providers === "object") {
    for (const provider of Object.values(providers)) {
      const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
      const apiKey = typeof provider?.apiKey === "string" ? provider.apiKey : "";
      if (apiKey && /ark\.cn-beijing\.volces\.com/.test(baseUrl)) {
        process.stdout.write(apiKey);
        process.exit(0);
      }
    }
  }
} catch {}
NODE
}

fix_codex_arkproxy_codex_home() {
  local codex_home_dir="$CODEX_HOME_DIR"
  local codex_config="$codex_home_dir/config.toml"

  [ -f "$codex_config" ] || return 0

  if grep -Eq '^[[:space:]]*model_catalog_json[[:space:]]*=' "$codex_config"; then
    cp "$codex_config" "${codex_config}.pre-openclaw-fix-$(date +%Y%m%d-%H%M%S).bak"
    perl -0pi -e 's/^[ \t]*model_catalog_json[ \t]*=.*\n//m' "$codex_config"
    log "Removed unsupported model_catalog_json path from $codex_config"
  fi

  CODEX_CONFIG="$codex_config" node <<'NODE'
const fs = require("node:fs");
const path = process.env.CODEX_CONFIG;
let text = fs.readFileSync(path, "utf8");
if (!/^\[model_providers\.codex\]\s*$/m.test(text)) {
  process.exit(0);
}
const lines = text.split(/\n/);
let inCodex = false;
let hasApiKey = false;
let insertAt = -1;
for (let index = 0; index < lines.length; index += 1) {
  const line = lines[index];
  if (/^\[.+\]\s*$/.test(line)) {
    if (inCodex) {
      insertAt = index;
      break;
    }
    inCodex = line.trim() === "[model_providers.codex]";
    continue;
  }
  if (inCodex && /^\s*api_key\s*=/.test(line)) {
    hasApiKey = true;
  }
}
if (!inCodex && insertAt === -1) {
  process.exit(0);
}
if (insertAt === -1) {
  insertAt = lines.length;
}
if (!hasApiKey) {
  lines.splice(insertAt, 0, 'api_key = "codex-arkproxy-local"');
  fs.writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"));
}
NODE
}

ensure_codex_arkproxy_model_provider() {
  local codex_config="$CODEX_HOME_DIR/config.toml"
  [ -f "$codex_config" ] || return 0

  local provider_id model_name
  provider_id="$MODEL_PROVIDER_ID"
  model_name="$MODEL_NAME"

  CODEX_CONFIG="$codex_config" PROVIDER_ID="$provider_id" MODEL_NAME="$model_name" \
    CODEX_PROVIDER_BASE_URL="${CODEX_PROVIDER_BASE_URL%/v1}" \
    CODEX_PROVIDER_API_KEY="$CODEX_PROVIDER_API_KEY" node <<'NODE'
const fs = require("node:fs");
const path = process.env.CODEX_CONFIG;
const providerId = process.env.PROVIDER_ID || "codex-arkproxy-local";
const modelName = process.env.MODEL_NAME || "doubao-seed-2-0-pro-260215";
const baseUrl = process.env.CODEX_PROVIDER_BASE_URL || "http://127.0.0.1:8787";
const apiKey = process.env.CODEX_PROVIDER_API_KEY || "codex-arkproxy-local";
let text = fs.readFileSync(path, "utf8");
text = text.replace(/^model_provider\s*=.*$/m, `model_provider = "${providerId}"`);
text = text.replace(/^model\s*=.*$/m, `model = "${modelName}"`);
const escaped = providerId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sectionRe = new RegExp(`^\\[model_providers\\.${escaped}\\]\\s*$`, "m");
if (!sectionRe.test(text)) {
  text = text.replace(/\n*$/, "\n") + `
[model_providers.${providerId}]
name = "${providerId}"
base_url = "${baseUrl}"
wire_api = "responses"
api_key = "${apiKey}"
`;
}
fs.writeFileSync(path, text.replace(/\n*$/, "\n"));
NODE
}

find_real_codex_bin() {
  if [ -n "${REAL_CODEX_BIN:-}" ]; then
    [ -x "$REAL_CODEX_BIN" ] && printf '%s\n' "$REAL_CODEX_BIN" && return 0
  fi

  local candidate
  for candidate in \
    "$HOME/.nvm/versions/node/v24.8.0/bin/codex" \
    "$HOME/.nvm/versions/node/v24.9.0/bin/codex" \
    "$HOME/.nvm/versions/node/v24/bin/codex" \
    "$HOME/.nvm/versions/node/v22/bin/codex" \
    "/opt/homebrew/bin/codex" \
    "/usr/local/bin/codex"; do
    if [ -x "$candidate" ] && [ "$candidate" != "$(command -v codex-arkproxy 2>/dev/null || true)" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  candidate="$(command -v codex 2>/dev/null || true)"
  if [ -n "$candidate" ] && [ -x "$candidate" ] && [ "$candidate" != "$(command -v codex-arkproxy 2>/dev/null || true)" ]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  return 1
}

detect_openclaw_cmd() {
  local plist="$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
  if [ -f "$plist" ]; then
    local node_bin cli_js
    node_bin="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$plist" 2>/dev/null || true)"
    cli_js="$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:1' "$plist" 2>/dev/null || true)"
    if [ -n "$node_bin" ] && [ -n "$cli_js" ] && [ -x "$node_bin" ] && [ -f "$cli_js" ]; then
      printf '%q %q\n' "$node_bin" "$cli_js"
      return 0
    fi
  fi

  if [ -x "./openclaw.mjs" ]; then
    printf './openclaw.mjs\n'
    return 0
  fi

  command -v openclaw 2>/dev/null || true
}

pin_openclaw_session_harness() {
  local sessions_path="$HOME/.openclaw/agents/main/sessions/sessions.json"
  [ -f "$sessions_path" ] || return 0

  SESSIONS_PATH="$sessions_path" MODEL_ID="$MODEL_ID" node <<'NODE'
const fs = require("node:fs");
const path = process.env.SESSIONS_PATH;
const modelId = process.env.MODEL_ID || "codex-arkproxy-local/doubao-seed-2-0-pro-260215";
const [providerId, modelName] = modelId.includes("/")
  ? modelId.split("/", 2)
  : ["codex-arkproxy-local", modelId];
const data = JSON.parse(fs.readFileSync(path, "utf8"));
let changed = false;
for (const [key, value] of Object.entries(data)) {
  if (!value || typeof value !== "object") {
    continue;
  }
  if (
    key === "agent:main:main" ||
    key === "agent:main:explicit:agent:main:main" ||
    value.sessionKey === "agent:main:main"
  ) {
    if (value.agentHarnessId !== "codex") {
      value.agentHarnessId = "codex";
      changed = true;
    }
    if (value.modelProvider !== providerId) {
      value.modelProvider = providerId;
      changed = true;
    }
    if (value.model !== modelName) {
      value.model = modelName;
      changed = true;
    }
  }
}
if (changed) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  fs.copyFileSync(path, `${path}.pre-codex-harness-pin-${stamp}.bak`);
  fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}
NODE
}

if [ "$USE_ARKPROXY" = "1" ] && [ "$INSTALL_CODEX_ARKPROXY" != "0" ]; then
  command -v curl >/dev/null 2>&1 || fail "curl not found"
  command -v node >/dev/null 2>&1 || fail "node not found"
  command -v npm >/dev/null 2>&1 || fail "npm not found"
  command -v git >/dev/null 2>&1 || fail "git not found"

  ARK_API_KEY="$(read_existing_ark_api_key || true)"
  [ -n "$ARK_API_KEY" ] || fail "ARK_API_KEY not found. Set ARK_API_KEY=... and rerun."

  log "Installing/updating codex-arkproxy from $CODEX_ARK_PROXY_BOOTSTRAP_URL"
  curl -fsSL "$CODEX_ARK_PROXY_BOOTSTRAP_URL" | \
    ARK_API_KEY="$ARK_API_KEY" \
    PUBLIC_BUCKET_BASE_URL="$PUBLIC_BUCKET_BASE_URL" \
    ARK_MODEL_DEFAULT="${ARK_MODEL_DEFAULT:-$MODEL_NAME}" \
    bash

  ARKPROXY_PROJECT_DIR="${CODEX_ARKPROXY_PROJECT_DIR:-$HOME/.codex-arkproxy/codex-ark-proxy}"
  if [ -f "$ARKPROXY_PROJECT_DIR/src/ark-client.ts" ]; then
    log "Patching codex-arkproxy Ark Responses compatibility"
    ARKPROXY_PROJECT_DIR="$ARKPROXY_PROJECT_DIR" node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const projectDir = process.env.ARKPROXY_PROJECT_DIR;
const sourcePath = path.join(projectDir, "src", "ark-client.ts");
let source = fs.readFileSync(sourcePath, "utf8");

if (!source.includes("const ARK_INCOMPATIBLE_KEYS = new Set(")) {
  source = source.replace(
    `export function deepStripExternalWebAccess(value: unknown): unknown {\n`,
    `const ARK_INCOMPATIBLE_KEYS = new Set([\n  "external_web_access",\n  "search_content_types",\n  "summary",\n  "verbosity"\n]);\n\nexport function deepStripExternalWebAccess(value: unknown): unknown {\n`,
  );
  source = source.replace(
    /    if \(key === "external_web_access"\) \{\n      continue;\n    \n?    \}\n    if \(key === "verbosity"\) \{\n      continue;\n    \n?    \}/,
    `    if (ARK_INCOMPATIBLE_KEYS.has(key)) {\n      continue;\n    }`,
  );
} else {
  for (const key of ["search_content_types", "summary"]) {
    if (!source.includes(`"${key}"`)) {
      source = source.replace(
        `const ARK_INCOMPATIBLE_KEYS = new Set([\n`,
        `const ARK_INCOMPATIBLE_KEYS = new Set([\n  "${key}",\n`,
      );
    }
  }
}

fs.writeFileSync(sourcePath, source);
NODE
    ROUTES_PATH="$ARKPROXY_PROJECT_DIR/src/routes.ts" node <<'NODE'
const fs = require("node:fs");
const path = process.env.ROUTES_PATH;
let source = fs.readFileSync(path, "utf8");
if (!source.includes("const rawUsage = record.usage && typeof record.usage === \"object\"")) {
  source = source.replace(
    `  const output: Record<string, unknown>[] = [];\n  const content = typeof assistant.content === "string" ? assistant.content : "";\n`,
    `  const output: Record<string, unknown>[] = [];\n  const content = typeof assistant.content === "string" ? assistant.content : "";\n  const rawUsage = record.usage && typeof record.usage === "object"\n    ? record.usage as Record<string, unknown>\n    : {};\n  const inputTokens = typeof rawUsage.input_tokens === "number"\n    ? rawUsage.input_tokens\n    : typeof rawUsage.prompt_tokens === "number"\n      ? rawUsage.prompt_tokens\n      : 0;\n  const outputTokens = typeof rawUsage.output_tokens === "number"\n    ? rawUsage.output_tokens\n    : typeof rawUsage.completion_tokens === "number"\n      ? rawUsage.completion_tokens\n      : 0;\n  const totalTokens = typeof rawUsage.total_tokens === "number"\n    ? rawUsage.total_tokens\n    : inputTokens + outputTokens;\n`,
  );
  source = source.replace(
    `    output,\n    usage: record.usage\n`,
    `    output,\n    usage: {\n      ...rawUsage,\n      input_tokens: inputTokens,\n      output_tokens: outputTokens,\n      total_tokens: totalTokens\n    }\n`,
  );
  fs.writeFileSync(path, source);
}
NODE
    npm --prefix "$ARKPROXY_PROJECT_DIR" run build
    case "$(uname -s)" in
      Darwin)
        launchctl kickstart -k "gui/$(id -u)/com.marchpure.codex-arkproxy" >/dev/null 2>&1 || true
        ;;
    esac
  fi
fi

if [ "$USE_ARKPROXY" = "1" ]; then
  fix_codex_arkproxy_codex_home
  ensure_codex_arkproxy_model_provider
fi

REAL_CODEX_BIN="$(find_real_codex_bin || true)"
[ -n "$REAL_CODEX_BIN" ] || fail "real codex binary not found; install @openai/codex or set REAL_CODEX_BIN=/path/to/codex"

if [ -z "${CODEX_BIN:-}" ]; then
  if [ "$USE_ARKPROXY" = "1" ]; then
    CODEX_BIN="$(command -v codex-arkproxy || true)"
  else
    CODEX_BIN="$REAL_CODEX_BIN"
  fi
fi

if [ -z "$CODEX_BIN" ] && [ "$USE_ARKPROXY" = "1" ]; then
  CODEX_BIN="$HOME/.local/bin/codex-arkproxy"
fi

[ -n "$CODEX_BIN" ] || fail "codex-arkproxy binary not found; install it or set CODEX_BIN=/path/to/codex-arkproxy"
[ -x "$CODEX_BIN" ] || fail "codex-arkproxy binary is not executable: $CODEX_BIN"
if [ "$USE_ARKPROXY" = "1" ]; then
  if ! grep -Fq 'requested_model' "$CODEX_BIN" || ! grep -Fq 'requested_model" == gpt-*' "$CODEX_BIN"; then
    log "WARNING: $CODEX_BIN does not contain the native GPT bypass launcher. Re-run the latest bootstrap-codex-ark.sh if gpt-* should bypass proxy."
  fi
fi
pin_openclaw_session_harness

if [ "$CODEX_ALIAS" != "0" ]; then
  SHELL_RC="${SHELL_RC_FILE:-}"
  if [ -z "$SHELL_RC" ]; then
    case "${SHELL:-}" in
      */bash) SHELL_RC="$HOME/.bashrc" ;;
      *) SHELL_RC="$HOME/.zshrc" ;;
    esac
  fi
  touch "$SHELL_RC"
  if ! grep -Fq '# openclaw codex-arkproxy alias' "$SHELL_RC"; then
    {
      printf '\n# openclaw codex-arkproxy alias\n'
      printf "alias codex=%q\n" "$CODEX_BIN"
    } >>"$SHELL_RC"
    log "Added shell alias to $SHELL_RC: codex -> $CODEX_BIN"
  fi
fi

OPENCLAW_CMD="$(detect_openclaw_cmd)"

if [ -n "$OPENCLAW_CMD" ] && [ "$RESTART_GATEWAY" != "0" ]; then
  log "Stopping OpenClaw gateway before writing config"
  eval "$OPENCLAW_CMD gateway stop" || true
fi

BACKUP_PATH="${CONFIG_PATH}.pre-codex-harness-$(date +%Y%m%d-%H%M%S).bak"
cp "$CONFIG_PATH" "$BACKUP_PATH"
log "Backed up config to $BACKUP_PATH"

CONFIG_PATH="$CONFIG_PATH" \
MODEL_ID="$MODEL_ID" \
CODEX_PROVIDER_BASE_URL="$CODEX_PROVIDER_BASE_URL" \
CODEX_PROVIDER_API_KEY="$CODEX_PROVIDER_API_KEY" \
CODEX_BIN="$CODEX_BIN" \
DISABLE_AGENT_IDENTITY="$DISABLE_AGENT_IDENTITY" \
USE_ARKPROXY="$USE_ARKPROXY" \
node <<'NODE'
const fs = require("node:fs");

const path = process.env.CONFIG_PATH;
const modelId = process.env.MODEL_ID || "codex-arkproxy-local/doubao-seed-2-0-pro-260215";
const codexProviderBaseUrl = process.env.CODEX_PROVIDER_BASE_URL || "http://127.0.0.1:8787/v1";
const codexProviderApiKey = process.env.CODEX_PROVIDER_API_KEY || "codex-arkproxy-local";
const codexBin = process.env.CODEX_BIN;
const disableAgentIdentity = process.env.DISABLE_AGENT_IDENTITY !== "0";
const useArkproxy = process.env.USE_ARKPROXY === "1";
const [providerId, modelName] = modelId.includes("/")
  ? modelId.split("/", 2)
  : ["codex", modelId];

const cfg = JSON.parse(fs.readFileSync(path, "utf8"));

cfg.plugins ??= {};
cfg.plugins.entries ??= {};
cfg.plugins.entries.codex ??= {};
cfg.plugins.entries.codex.enabled = true;
cfg.plugins.entries.codex.config ??= {};
delete cfg.plugins.entries.codex.config.model;
cfg.plugins.entries.codex.config.discovery ??= {};
cfg.plugins.entries.codex.config.discovery.enabled = false;
cfg.plugins.entries.codex.config.discovery.timeoutMs ??= 10000;
cfg.plugins.entries.codex.config.appServer ??= {};
cfg.plugins.entries.codex.config.appServer.command = codexBin;
cfg.plugins.entries.codex.config.appServer.transport = "stdio";
cfg.plugins.entries.codex.config.appServer.args = ["app-server", "--listen", "stdio://"];
cfg.plugins.entries.codex.config.appServer.approvalPolicy ??= "never";
cfg.plugins.entries.codex.config.appServer.sandbox ??= "danger-full-access";
cfg.plugins.entries.codex.config.appServer.requestTimeoutMs ??= 300000;
if (Array.isArray(cfg.plugins.allow)) {
  const allow = cfg.plugins.allow.filter((id) => id !== "codex");
  allow.unshift("codex");
  cfg.plugins.allow = disableAgentIdentity ? allow.filter((id) => id !== "agent-identity") : allow;
}

if (disableAgentIdentity) {
  delete cfg.plugins.entries["agent-identity"];
}

cfg.agents ??= {};
cfg.agents.defaults ??= {};
cfg.agents.defaults.model ??= {};
cfg.agents.defaults.model.primary = modelId;
cfg.agents.defaults.embeddedHarness ??= {};
cfg.agents.defaults.embeddedHarness.runtime = "codex";
cfg.agents.defaults.embeddedHarness.fallback = "none";

cfg.models ??= {};
cfg.models.mode ??= "merge";
cfg.models.providers ??= {};
if (useArkproxy) {
  delete cfg.models.providers.codex;
}
const existingProvider = cfg.models.providers[providerId] ?? {};
const providerConfig = {
  api: "openai-responses",
  request: {
    ...(existingProvider.request ?? {})
  },
  models: [
    {
      id: modelName,
      name: modelName,
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 32000,
      compat: {
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
        supportsStore: false
      }
    }
  ]
};
if (useArkproxy) {
  providerConfig.baseUrl = codexProviderBaseUrl;
  providerConfig.apiKey = codexProviderApiKey;
  providerConfig.auth = "api-key";
  providerConfig.request.allowPrivateNetwork = true;
} else {
  delete providerConfig.request.allowPrivateNetwork;
}
cfg.models.providers[providerId] = {
  ...existingProvider,
  ...providerConfig
};

fs.writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
NODE

log "Updated config: $CONFIG_PATH"
log "Codex app-server command: $CODEX_BIN"
if [ "$USE_ARKPROXY" = "1" ]; then
  log "Model: $MODEL_ID via $CODEX_PROVIDER_BASE_URL"
else
  log "Model: $MODEL_ID via native Codex provider"
fi

if [ "$USE_ARKPROXY" = "1" ] && command -v curl >/dev/null 2>&1; then
  log "Waiting for codex-arkproxy on 127.0.0.1:8787"
  wait_for_url http://127.0.0.1:8787/healthz 30 || log "codex-arkproxy health check did not become ready within 30s"
  log "codex-arkproxy health:"
  curl -fsS http://127.0.0.1:8787/healthz || true
  printf '\n'
  log "codex-arkproxy models:"
  curl -fsS http://127.0.0.1:8787/v1/models || true
  printf '\n'
fi

if [ -n "$OPENCLAW_CMD" ]; then
  log "OpenClaw version:"
  eval "$OPENCLAW_CMD --version" || true
  GATEWAY_PAIRING_REQUIRED=0

  if [ "$RESTART_GATEWAY" != "0" ]; then
    log "Restarting OpenClaw gateway"
    eval "$OPENCLAW_CMD gateway restart" || true
    log "Gateway status:"
    STATUS_OUTPUT="$(eval "$OPENCLAW_CMD gateway status" 2>&1 || true)"
    printf '%s\n' "$STATUS_OUTPUT"
    if printf '%s\n' "$STATUS_OUTPUT" | grep -Fqi 'pairing required'; then
      GATEWAY_PAIRING_REQUIRED=1
    fi
    log "Gateway health:"
    HEALTH_OUTPUT="$(eval "$OPENCLAW_CMD gateway health" 2>&1 || true)"
    printf '%s\n' "$HEALTH_OUTPUT"
    if printf '%s\n' "$HEALTH_OUTPUT" | grep -Fqi 'pairing required'; then
      GATEWAY_PAIRING_REQUIRED=1
    fi
  fi

  if [ "$RUN_AGENT_SMOKE" != "0" ]; then
    if [ "${GATEWAY_PAIRING_REQUIRED:-0}" = "1" ]; then
      log "Skipping Gateway agent validation because this Gateway requires pairing."
      log "After pairing this client, run: openclaw agent --session-id $AGENT_SMOKE_SESSION_ID --message '你是否能正常工作，只回复OK' --timeout 120 --json"
    else
      log "Validating Gateway agent path with session $AGENT_SMOKE_SESSION_ID"
      set +e
      SMOKE_JSON="$(eval "$OPENCLAW_CMD agent --session-id \"\$AGENT_SMOKE_SESSION_ID\" --message '你是否能正常工作，只回复OK' --timeout 120 --json" 2>&1)"
      SMOKE_STATUS=$?
      set -e
      if printf '%s\n' "$SMOKE_JSON" | grep -Fqi 'pairing required'; then
        printf '%s\n' "$SMOKE_JSON"
        log "Skipping Gateway agent validation because this Gateway requires pairing."
        log "After pairing this client, run: openclaw agent --session-id $AGENT_SMOKE_SESSION_ID --message '你是否能正常工作，只回复OK' --timeout 120 --json"
      elif [ "$SMOKE_STATUS" -ne 0 ]; then
        printf '%s\n' "$SMOKE_JSON"
        fail "Gateway agent validation failed"
      else
    printf '%s\n' "$SMOKE_JSON"
    SMOKE_JSON="$SMOKE_JSON" EXPECTED_PROVIDER="$MODEL_PROVIDER_ID" node <<'NODE'
const text = process.env.SMOKE_JSON || "";
const start = text.indexOf("{");
if (start < 0) {
  throw new Error("agent smoke output did not contain JSON");
}
const payload = JSON.parse(text.slice(start));
const result = payload.result && typeof payload.result === "object" ? payload.result : payload;
const meta = result.meta?.agentMeta || result.meta || {};
const expectedProvider = process.env.EXPECTED_PROVIDER || "codex-arkproxy-local";
const payloads = result.payloads || payload.payloads || [];
const reply = payloads.map((item) => item?.text ?? "").join("").trim();
if (payload.status !== "ok" || reply !== "OK") {
  throw new Error(`agent smoke failed: status=${payload.status} reply=${JSON.stringify(reply)}`);
}
if (meta.agentHarnessId && meta.agentHarnessId !== "codex") {
  throw new Error(`agent smoke did not use codex harness: ${meta.agentHarnessId}`);
}
if (meta.provider && meta.provider !== expectedProvider) {
  throw new Error(`agent smoke did not use ${expectedProvider} provider: ${meta.provider}`);
}
NODE
    log "Agent smoke validation passed"
      fi
    fi
  fi
else
  log "OpenClaw CLI not found; restart gateway manually after this script."
fi

log "Done. Test with: openclaw agent --session-id $AGENT_SMOKE_SESSION_ID --message '只回复 OK' --timeout 120 --json"
