#!/usr/bin/env bash

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/marchpure/codex-arkproxy.git}"
PUBLIC_BUCKET_BASE_URL="${PUBLIC_BUCKET_BASE_URL:-https://haoxingjun-test.tos-cn-beijing.volces.com}"
FALLBACK_ARCHIVE_URL="${FALLBACK_ARCHIVE_URL:-$PUBLIC_BUCKET_BASE_URL/codex-ark-proxy.tar.gz}"
GIT_CLONE_TIMEOUT_SEC="${GIT_CLONE_TIMEOUT_SEC:-20}"
INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.codex-arkproxy}"
PROJECT_DIR="${PROJECT_DIR:-$INSTALL_ROOT/codex-ark-proxy}"
CODEX_HOME_DIR="${CODEX_HOME_DIR:-$HOME/.codex-arkproxy}"
BIN_DIR="${BIN_DIR:-}"
LAUNCH_AGENT_LABEL="${LAUNCH_AGENT_LABEL:-com.marchpure.codex-arkproxy}"
LAUNCH_AGENT_DIR="${LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}"
LAUNCH_AGENT_PATH="${LAUNCH_AGENT_PATH:-$LAUNCH_AGENT_DIR/$LAUNCH_AGENT_LABEL.plist}"
SHELL_RC_FILE="${SHELL_RC_FILE:-}"
SERVICE_NAME="${SERVICE_NAME:-codex-arkproxy}"
SYSTEMD_USER_DIR="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
SYSTEMD_USER_PATH="${SYSTEMD_USER_PATH:-$SYSTEMD_USER_DIR/$SERVICE_NAME.service}"
SYSTEMD_SYSTEM_PATH="${SYSTEMD_SYSTEM_PATH:-/etc/systemd/system/$SERVICE_NAME.service}"
RUNNER_PATH="${RUNNER_PATH:-$INSTALL_ROOT/run-proxy.sh}"
PID_FILE="${PID_FILE:-$INSTALL_ROOT/$SERVICE_NAME.pid}"
LOG_DIR="${LOG_DIR:-$INSTALL_ROOT/logs}"
SERVICE_MANAGER="${SERVICE_MANAGER:-}"
INSTALL_CODEX_CLI="${INSTALL_CODEX_CLI:-true}"
CODEX_NPM_PACKAGE="${CODEX_NPM_PACKAGE:-@openai/codex}"
PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${PROXY_PORT:-8787}"
LOG_LEVEL="${LOG_LEVEL:-info}"
ARK_BASE_URL_WAS_SET="${ARK_BASE_URL+x}"
ARK_BASE_URL="${ARK_BASE_URL:-https://ark.cn-beijing.volces.com/api/v3}"
ARK_API_MODE="${ARK_API_MODE:-responses}"
ARK_MODEL_DEFAULT="${ARK_MODEL_DEFAULT:-doubao-seed-2-0-pro-260215}"
ARK_API_KEY="${ARK_API_KEY:-}"
ARK_REGION="${ARK_REGION:-}"
ARK_ENDPOINT="${ARK_ENDPOINT:-}"
ARK_EXTRA_HEADERS_JSON="${ARK_EXTRA_HEADERS_JSON:-{}}"
EXPOSE_MODELS="${EXPOSE_MODELS:-gpt-5.4,gpt-4.1,gpt-4.1-mini,doubao-seed-2-0-pro-260215,doubao-seed-2-0-mini-260215}"
CODING_PLAN="${CODING_PLAN:-false}"
OS_NAME="$(uname -s)"
CODEX_AVAILABLE=false

if [[ "$CODING_PLAN" == "true" ]]; then
  if [[ -z "$ARK_BASE_URL_WAS_SET" ]]; then
    ARK_BASE_URL="https://ark.cn-beijing.volces.com/api/coding/v3"
  fi
  ARK_API_MODE="${ARK_API_MODE:-chat_completions}"
  if [[ "$ARK_API_MODE" == "responses" ]]; then
    ARK_API_MODE="chat_completions"
  fi
fi

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_file() {
  if [[ ! -f "$1" ]]; then
    echo "missing required file: $1" >&2
    exit 1
  fi
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

ensure_codex_cli() {
  if has_cmd codex; then
    CODEX_AVAILABLE=true
    return
  fi

  if [[ "$INSTALL_CODEX_CLI" != "true" ]]; then
    return
  fi

  print_step "installing codex CLI"
  npm install -g "$CODEX_NPM_PACKAGE"

  if has_cmd codex; then
    CODEX_AVAILABLE=true
  fi
}

download_and_extract_fallback_archive() {
  local archive_path
  archive_path="$(mktemp /tmp/codex-ark-proxy.XXXXXX.tar.gz)"

  curl -fsSL "$FALLBACK_ARCHIVE_URL" -o "$archive_path"
  rm -rf "$PROJECT_DIR"
  mkdir -p "$PROJECT_DIR"
  tar -xzf "$archive_path" -C "$PROJECT_DIR"
  rm -f "$archive_path"
}

ensure_repo() {
  mkdir -p "$INSTALL_ROOT"

  if [[ -d "$PROJECT_DIR/.git" ]]; then
    if git -C "$PROJECT_DIR" fetch --depth=1 origin main && git -C "$PROJECT_DIR" reset --hard origin/main; then
      return
    fi
    echo "git update failed, falling back to $FALLBACK_ARCHIVE_URL" >&2
    download_and_extract_fallback_archive
    return
  fi

  if [[ -f "$PROJECT_DIR/package.json" && -f "$PROJECT_DIR/src/server.ts" ]]; then
    rm -rf "$PROJECT_DIR"
  fi

  rm -rf "$PROJECT_DIR"
  if has_cmd timeout; then
    if timeout "$GIT_CLONE_TIMEOUT_SEC" git clone --depth=1 "$REPO_URL" "$PROJECT_DIR"; then
      return
    fi
  else
    if git clone --depth=1 "$REPO_URL" "$PROJECT_DIR"; then
      return
    fi
  fi

  echo "git clone failed or timed out, falling back to $FALLBACK_ARCHIVE_URL" >&2
  download_and_extract_fallback_archive
}

print_step() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$1"
}

ensure_env_file() {
  local env_file="$PROJECT_DIR/.env"

  if [[ ! -f "$env_file" ]]; then
    cat >"$env_file" <<EOF
PROXY_HOST=$PROXY_HOST
PROXY_PORT=$PROXY_PORT
LOG_LEVEL=$LOG_LEVEL

ARK_BASE_URL=$ARK_BASE_URL
ARK_API_MODE=$ARK_API_MODE
ARK_API_KEY=$ARK_API_KEY
ARK_REGION=$ARK_REGION
ARK_ENDPOINT=$ARK_ENDPOINT
ARK_EXTRA_HEADERS_JSON=$ARK_EXTRA_HEADERS_JSON
ARK_MODEL_DEFAULT=$ARK_MODEL_DEFAULT
EXPOSE_MODELS=$EXPOSE_MODELS
EOF
  fi

  upsert_env_var "$env_file" PROXY_HOST "$PROXY_HOST" always
  upsert_env_var "$env_file" PROXY_PORT "$PROXY_PORT" always
  upsert_env_var "$env_file" LOG_LEVEL "$LOG_LEVEL" always
  upsert_env_var "$env_file" ARK_BASE_URL "$ARK_BASE_URL" always
  upsert_env_var "$env_file" ARK_API_MODE "$ARK_API_MODE" always
  upsert_env_var "$env_file" ARK_API_KEY "$ARK_API_KEY" nonempty
  upsert_env_var "$env_file" ARK_REGION "$ARK_REGION" always
  upsert_env_var "$env_file" ARK_ENDPOINT "$ARK_ENDPOINT" always
  upsert_env_var "$env_file" ARK_EXTRA_HEADERS_JSON "$ARK_EXTRA_HEADERS_JSON" always
  upsert_env_var "$env_file" ARK_MODEL_DEFAULT "$ARK_MODEL_DEFAULT" always
  upsert_env_var "$env_file" EXPOSE_MODELS "$EXPOSE_MODELS" always

  local ark_api_key
  ark_api_key="$(grep '^ARK_API_KEY=' "$env_file" | tail -n 1 | cut -d= -f2-)"
  if [[ -z "$ark_api_key" ]]; then
    echo "please provide ARK_API_KEY, for example: ARK_API_KEY=xxx bash bootstrap-codex-ark.sh" >&2
    exit 1
  fi
}

upsert_env_var() {
  local env_file="$1"
  local key="$2"
  local value="$3"
  local mode="${4:-always}"

  if [[ "$mode" == "nonempty" && -z "$value" && -n "$(grep "^$key=" "$env_file" 2>/dev/null | tail -n 1 | cut -d= -f2-)" ]]; then
    return
  fi

  if grep -q "^$key=" "$env_file"; then
    ENV_KEY="$key" ENV_VALUE="$value" perl -0pi -e 's/^\Q$ENV{ENV_KEY}\E=.*/$ENV{ENV_KEY}=$ENV{ENV_VALUE}/m' "$env_file"
  else
    printf '\n%s=%s\n' "$key" "$value" >>"$env_file"
  fi
}

setup_codex_home() {
  mkdir -p "$CODEX_HOME_DIR"

  if [[ -f "$HOME/.codex/auth.json" && ! -e "$CODEX_HOME_DIR/auth.json" ]]; then
    cp "$HOME/.codex/auth.json" "$CODEX_HOME_DIR/auth.json"
  fi

  local model_catalog_path
  model_catalog_path="$CODEX_HOME_DIR/model-catalogs/codex-arkproxy-current.json"
  mkdir -p "$(dirname "$model_catalog_path")"

  cat >"$CODEX_HOME_DIR/config.toml" <<EOF
model_provider = "codex"
model = "$ARK_MODEL_DEFAULT"
model_catalog_json = "$model_catalog_path"
model_reasoning_effort = "medium"
model_reasoning_summary = "auto"
approval_policy = "never"
sandbox_mode = "danger-full-access"
disable_response_storage = true

[model_providers.codex]
name = "codex"
base_url = "http://$PROXY_HOST:$PROXY_PORT"
wire_api = "responses"
EOF

  node - "$model_catalog_path" "$EXPOSE_MODELS" "$ARK_MODEL_DEFAULT" <<'NODE'
const fs = require("node:fs");
const [catalogPath, exposeModels, defaultModel] = process.argv.slice(2);
const modelIds = exposeModels.split(",").map((item) => item.trim()).filter(Boolean);
if (!modelIds.includes(defaultModel)) {
  modelIds.unshift(defaultModel);
}
const models = [...new Set(modelIds)].map((id, index) => ({
  slug: id,
  display_name: id,
  description: `${id} via codex-ark-proxy.`,
  default_reasoning_level: "medium",
  supported_reasoning_levels: [
    { effort: "low", description: "Fast responses with lighter reasoning." },
    { effort: "medium", description: "Balanced speed and reasoning depth." },
    { effort: "high", description: "Greater reasoning depth for complex tasks." },
    { effort: "xhigh", description: "Extra high reasoning depth for complex tasks." }
  ],
  supports_reasoning_summaries: true,
  default_reasoning_summary: "auto",
  support_verbosity: true,
  default_verbosity: "low",
  shell_type: "shell_command",
  visibility: "list",
  supported_in_api: true,
  priority: id === defaultModel ? 100 : 50 + index,
  additional_speed_tiers: [],
  availability_nux: null,
  upgrade: null,
  model_messages: [],
  apply_patch_tool_type: "freeform",
  web_search_tool_type: "text_and_image",
  truncation_policy: { mode: "tokens", limit: 10000 },
  supports_parallel_tool_calls: true,
  supports_image_detail_original: true,
  experimental_supported_tools: [],
  input_modalities: ["text", "image"],
  supports_search_tool: true,
  context_window: 131072,
  effective_context_window_percent: 95,
  base_instructions: "You are a coding agent running in Codex CLI via codex-ark-proxy."
}));
fs.writeFileSync(catalogPath, `${JSON.stringify({ models }, null, 2)}\n`, "utf8");
NODE
}

ensure_shell_rc() {
  if [[ -n "$SHELL_RC_FILE" ]]; then
    printf '%s\n' "$SHELL_RC_FILE"
    return
  fi

  if [[ -n "${ZSH_VERSION:-}" || "${SHELL:-}" == */zsh ]]; then
    printf '%s\n' "$HOME/.zshrc"
    return
  fi

  if [[ -n "${BASH_VERSION:-}" || "${SHELL:-}" == */bash ]]; then
    printf '%s\n' "$HOME/.bashrc"
    return
  fi

  printf '%s\n' "$HOME/.profile"
}

choose_bin_dir() {
  local candidate

  if [[ -n "$BIN_DIR" ]]; then
    printf '%s\n' "$BIN_DIR"
    return
  fi

  for candidate in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin"; do
    if [[ -d "$candidate" && -w "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
    if [[ ! -e "$candidate" && -w "$(dirname "$candidate")" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  printf '%s\n' "$HOME/.local/bin"
}

install_launcher() {
  local launcher_path
  local shell_rc

  BIN_DIR="$(choose_bin_dir)"
  launcher_path="$BIN_DIR/codex-arkproxy"
  mkdir -p "$BIN_DIR"
  shell_rc="$(ensure_shell_rc)"
  touch "$shell_rc"

  cat >"$launcher_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
if ! command -v codex >/dev/null 2>&1; then
  echo "codex CLI is not installed. Install codex first, then rerun: codex-arkproxy --model $ARK_MODEL_DEFAULT" >&2
  exit 1
fi
export CODEX_HOME="$CODEX_HOME_DIR"
exec codex "\$@"
EOF
  chmod +x "$launcher_path"

  if [[ "$BIN_DIR" == "$HOME/.local/bin" ]]; then
    if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$shell_rc"; then
      printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$shell_rc"
    fi
  fi
}

install_runner() {
  mkdir -p "$LOG_DIR"

  cat >"$RUNNER_PATH" <<EOF
#!/usr/bin/env bash
set -euo pipefail
cd "$PROJECT_DIR"
exec "$(command -v node)" "$PROJECT_DIR/dist/server.js"
EOF
  chmod +x "$RUNNER_PATH"
}

install_launch_agent() {
  local node_path
  node_path="$(command -v node)"

  mkdir -p "$LAUNCH_AGENT_DIR" "$LOG_DIR"

  cat >"$LAUNCH_AGENT_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LAUNCH_AGENT_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_path</string>
    <string>$PROJECT_DIR/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$PROJECT_DIR</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$INSTALL_ROOT/logs/proxy.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$INSTALL_ROOT/logs/proxy.stderr.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
  </dict>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$LAUNCH_AGENT_PATH"
  launchctl kickstart -k "gui/$(id -u)/$LAUNCH_AGENT_LABEL"
}

install_systemd_user_service() {
  mkdir -p "$SYSTEMD_USER_DIR" "$LOG_DIR"

  cat >"$SYSTEMD_USER_PATH" <<EOF
[Unit]
Description=codex-ark-proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$RUNNER_PATH
Restart=always
RestartSec=2
StandardOutput=append:$LOG_DIR/proxy.stdout.log
StandardError=append:$LOG_DIR/proxy.stderr.log

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "$SERVICE_NAME"
}

install_systemd_system_service() {
  mkdir -p "$LOG_DIR"

  cat >"$SYSTEMD_SYSTEM_PATH" <<EOF
[Unit]
Description=codex-ark-proxy
After=network.target

[Service]
Type=simple
WorkingDirectory=$PROJECT_DIR
ExecStart=$RUNNER_PATH
Restart=always
RestartSec=2
StandardOutput=append:$LOG_DIR/proxy.stdout.log
StandardError=append:$LOG_DIR/proxy.stderr.log
User=$(id -un)
Environment=HOME=$HOME

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable --now "$SERVICE_NAME"
}

install_nohup_service() {
  mkdir -p "$LOG_DIR"

  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" >/dev/null 2>&1; then
      kill "$old_pid" >/dev/null 2>&1 || true
      sleep 1
    fi
  fi

  nohup "$RUNNER_PATH" >>"$LOG_DIR/proxy.stdout.log" 2>>"$LOG_DIR/proxy.stderr.log" </dev/null &
  echo "$!" >"$PID_FILE"
}

select_service_manager() {
  if [[ -n "$SERVICE_MANAGER" ]]; then
    printf '%s\n' "$SERVICE_MANAGER"
    return
  fi

  if [[ "$OS_NAME" == "Darwin" ]]; then
    printf '%s\n' launchd
    return
  fi

  if has_cmd systemctl && systemctl --user show-environment >/dev/null 2>&1; then
    printf '%s\n' systemd-user
    return
  fi

  if has_cmd systemctl && [[ "$(id -u)" -eq 0 ]]; then
    printf '%s\n' systemd-system
    return
  fi

  printf '%s\n' nohup
}

install_service() {
  local manager
  manager="$(select_service_manager)"
  SERVICE_MANAGER="$manager"

  case "$manager" in
    launchd)
      install_launch_agent
      ;;
    systemd-user)
      install_systemd_user_service
      ;;
    systemd-system)
      install_systemd_system_service
      ;;
    nohup)
      install_nohup_service
      ;;
    *)
      echo "unsupported service manager: $manager" >&2
      exit 1
      ;;
  esac
}

stop_existing_proxy_processes() {
  local pids

  pids="$(lsof -tiTCP:"$PROXY_PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -z "$pids" ]]; then
    return
  fi

  while IFS= read -r pid; do
    [[ -z "$pid" ]] && continue
    if [[ "$pid" == "$$" ]]; then
      continue
    fi
    kill "$pid" >/dev/null 2>&1 || true
  done <<<"$pids"

  sleep 1
}

print_usage_summary() {
  local next_step="codex-arkproxy --model $ARK_MODEL_DEFAULT"

  cat <<EOF

codex-ark-proxy is ready.

install root:
  $INSTALL_ROOT

project dir:
  $PROJECT_DIR

proxy env file:
  $PROJECT_DIR/.env

codex home:
  $CODEX_HOME_DIR

launcher:
  $BIN_DIR/codex-arkproxy

service manager:
  $SERVICE_MANAGER

next steps:
  $next_step

proxy checks:
  curl http://$PROXY_HOST:$PROXY_PORT/healthz
  curl http://$PROXY_HOST:$PROXY_PORT/v1/models
EOF

  if [[ "$CODEX_AVAILABLE" != "true" ]]; then
    cat <<EOF

codex CLI was not found during install.
install codex first, then run:
  codex-arkproxy --model $ARK_MODEL_DEFAULT
EOF
  fi

  case "$SERVICE_MANAGER" in
    launchd)
      printf 'launch agent:\n  %s\n' "$LAUNCH_AGENT_PATH"
      ;;
    systemd-user)
      printf 'systemd user service:\n  %s\n' "$SYSTEMD_USER_PATH"
      ;;
    systemd-system)
      printf 'systemd system service:\n  %s\n' "$SYSTEMD_SYSTEM_PATH"
      ;;
    nohup)
      printf 'pid file:\n  %s\n' "$PID_FILE"
      ;;
  esac
}

main() {
  require_cmd node
  require_cmd npm
  require_cmd git
  ensure_codex_cli

  print_step "preparing project files"
  ensure_repo

  require_file "$PROJECT_DIR/package.json"
  require_file "$PROJECT_DIR/scripts/repair-model-cache.mjs"

  print_step "checking .env"
  ensure_env_file

  print_step "installing dependencies"
  npm --prefix "$PROJECT_DIR" install

  print_step "building proxy"
  npm --prefix "$PROJECT_DIR" run build

  print_step "preparing CODEX_HOME at $CODEX_HOME_DIR"
  setup_codex_home

  print_step "repairing Codex model cache"
  npm --prefix "$PROJECT_DIR" run repair-model-cache

  print_step "installing codex launcher"
  install_launcher

  print_step "installing proxy runner"
  install_runner

  print_step "stopping old proxy instances on :$PROXY_PORT"
  stop_existing_proxy_processes

  print_step "registering background service"
  install_service

  print_step "done"
  print_usage_summary
}

main "$@"
