#!/usr/bin/env bash

set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/marchpure/codex-arkproxy.git}"
INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.codex-arkproxy}"
PROJECT_DIR="${PROJECT_DIR:-$INSTALL_ROOT/codex-ark-proxy}"
CODEX_HOME_DIR="${CODEX_HOME_DIR:-$HOME/.codex-arkproxy}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"
LAUNCH_AGENT_LABEL="${LAUNCH_AGENT_LABEL:-com.marchpure.codex-arkproxy}"
LAUNCH_AGENT_DIR="${LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}"
LAUNCH_AGENT_PATH="${LAUNCH_AGENT_PATH:-$LAUNCH_AGENT_DIR/$LAUNCH_AGENT_LABEL.plist}"
SHELL_RC_FILE="${SHELL_RC_FILE:-}"
PROXY_HOST="${PROXY_HOST:-127.0.0.1}"
PROXY_PORT="${PROXY_PORT:-8787}"
LOG_LEVEL="${LOG_LEVEL:-info}"
ARK_BASE_URL="${ARK_BASE_URL:-https://ark.cn-beijing.volces.com/api/v3}"
ARK_MODEL_DEFAULT="${ARK_MODEL_DEFAULT:-doubao-seed-2-0-pro-260215}"
ARK_API_KEY="${ARK_API_KEY:-}"

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

ensure_repo() {
  if [[ -f "$PROJECT_DIR/package.json" && -f "$PROJECT_DIR/src/server.ts" ]]; then
    return
  fi

  mkdir -p "$INSTALL_ROOT"

  if [[ -d "$PROJECT_DIR/.git" ]]; then
    git -C "$PROJECT_DIR" fetch --depth=1 origin main
    git -C "$PROJECT_DIR" reset --hard origin/main
    return
  fi

  rm -rf "$PROJECT_DIR"
  git clone --depth=1 "$REPO_URL" "$PROJECT_DIR"
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
ARK_API_KEY=$ARK_API_KEY
ARK_MODEL_DEFAULT=$ARK_MODEL_DEFAULT
EOF
  fi

  if ! grep -q '^ARK_API_KEY=' "$env_file"; then
    printf '\nARK_API_KEY=%s\n' "$ARK_API_KEY" >>"$env_file"
  elif [[ -n "$ARK_API_KEY" ]]; then
    perl -0pi -e 's/^ARK_API_KEY=.*/ARK_API_KEY='"$ARK_API_KEY"'/m' "$env_file"
  fi

  local ark_api_key
  ark_api_key="$(grep '^ARK_API_KEY=' "$env_file" | tail -n 1 | cut -d= -f2-)"
  if [[ -z "$ark_api_key" ]]; then
    echo "please provide ARK_API_KEY, for example: ARK_API_KEY=xxx bash bootstrap-codex-ark.sh" >&2
    exit 1
  fi
}

setup_codex_home() {
  mkdir -p "$CODEX_HOME_DIR"

  if [[ -f "$HOME/.codex/auth.json" && ! -e "$CODEX_HOME_DIR/auth.json" ]]; then
    cp "$HOME/.codex/auth.json" "$CODEX_HOME_DIR/auth.json"
  fi

  cat >"$CODEX_HOME_DIR/config.toml" <<EOF
model_provider = "codex"
model = "$ARK_MODEL_DEFAULT"
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

install_launcher() {
  local launcher_path="$BIN_DIR/codex-arkproxy"
  local shell_rc

  mkdir -p "$BIN_DIR"
  shell_rc="$(ensure_shell_rc)"
  touch "$shell_rc"

  cat >"$launcher_path" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export CODEX_HOME="$CODEX_HOME_DIR"
exec codex "\$@"
EOF
  chmod +x "$launcher_path"

  if ! grep -Fq 'export PATH="$HOME/.local/bin:$PATH"' "$shell_rc"; then
    printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >>"$shell_rc"
  fi
}

install_launch_agent() {
  local node_path
  node_path="$(command -v node)"

  mkdir -p "$LAUNCH_AGENT_DIR" "$INSTALL_ROOT/logs"

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

launch agent:
  $LAUNCH_AGENT_PATH

next steps:
  source "$(ensure_shell_rc)"
  codex-arkproxy --model $ARK_MODEL_DEFAULT

proxy checks:
  curl http://$PROXY_HOST:$PROXY_PORT/healthz
  curl http://$PROXY_HOST:$PROXY_PORT/v1/models
EOF
}

main() {
  require_cmd node
  require_cmd npm
  require_cmd codex
  require_cmd git
  require_cmd launchctl

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

  print_step "stopping old proxy instances on :$PROXY_PORT"
  stop_existing_proxy_processes

  print_step "registering launch agent"
  install_launch_agent

  print_step "done"
  print_usage_summary
}

main "$@"
