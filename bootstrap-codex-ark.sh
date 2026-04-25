#!/usr/bin/env bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODEX_HOME_DIR="${CODEX_HOME_DIR:-$HOME/.codex-arkproxy}"
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

install_alias_hint() {
  cat <<EOF

alias codex-arkproxy='CODEX_HOME=$CODEX_HOME_DIR codex'

startup commands:
  cd $PROJECT_DIR
  npm start

  CODEX_HOME=$CODEX_HOME_DIR codex --model $ARK_MODEL_DEFAULT
EOF
}

main() {
  require_cmd node
  require_cmd npm
  require_cmd codex

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

  print_step "done"
  cat <<EOF
codex-ark-proxy is ready.

proxy env file:
  $PROJECT_DIR/.env

codex home:
  $CODEX_HOME_DIR
EOF
  install_alias_hint
}

main "$@"
