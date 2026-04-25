#!/usr/bin/env bash

set -euo pipefail

INSTALL_ROOT="${INSTALL_ROOT:-$HOME/.codex-arkproxy}"
PROJECT_DIR="${PROJECT_DIR:-$INSTALL_ROOT/codex-ark-proxy}"
CODEX_HOME_DIR="${CODEX_HOME_DIR:-$HOME/.codex-arkproxy}"
BIN_DIR="${BIN_DIR:-}"
LAUNCH_AGENT_LABEL="${LAUNCH_AGENT_LABEL:-com.marchpure.codex-arkproxy}"
LAUNCH_AGENT_DIR="${LAUNCH_AGENT_DIR:-$HOME/Library/LaunchAgents}"
LAUNCH_AGENT_PATH="${LAUNCH_AGENT_PATH:-$LAUNCH_AGENT_DIR/$LAUNCH_AGENT_LABEL.plist}"
SERVICE_NAME="${SERVICE_NAME:-codex-arkproxy}"
SYSTEMD_USER_DIR="${SYSTEMD_USER_DIR:-$HOME/.config/systemd/user}"
SYSTEMD_USER_PATH="${SYSTEMD_USER_PATH:-$SYSTEMD_USER_DIR/$SERVICE_NAME.service}"
SYSTEMD_SYSTEM_PATH="${SYSTEMD_SYSTEM_PATH:-/etc/systemd/system/$SERVICE_NAME.service}"
RUNNER_PATH="${RUNNER_PATH:-$INSTALL_ROOT/run-proxy.sh}"
PID_FILE="${PID_FILE:-$INSTALL_ROOT/$SERVICE_NAME.pid}"
LOG_DIR="${LOG_DIR:-$INSTALL_ROOT/logs}"
REMOVE_CODEX_CLI="${REMOVE_CODEX_CLI:-false}"
CODEX_NPM_PACKAGE="${CODEX_NPM_PACKAGE:-@openai/codex}"
OS_NAME="$(uname -s)"

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

print_step() {
  printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$1"
}

choose_bin_dir() {
  local candidate

  if [[ -n "$BIN_DIR" ]]; then
    printf '%s\n' "$BIN_DIR"
    return
  fi

  for candidate in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin"; do
    if [[ -e "$candidate/codex-arkproxy" || -w "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  printf '%s\n' "$HOME/.local/bin"
}

stop_launchd() {
  launchctl bootout "gui/$(id -u)/$LAUNCH_AGENT_LABEL" >/dev/null 2>&1 || true
  rm -f "$LAUNCH_AGENT_PATH"
}

stop_systemd_user() {
  if has_cmd systemctl; then
    systemctl --user disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl --user daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_USER_PATH"
}

stop_systemd_system() {
  if has_cmd systemctl; then
    systemctl disable --now "$SERVICE_NAME" >/dev/null 2>&1 || true
    systemctl daemon-reload >/dev/null 2>&1 || true
  fi
  rm -f "$SYSTEMD_SYSTEM_PATH"
}

stop_nohup() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
      sleep 1
    fi
    rm -f "$PID_FILE"
  fi
}

remove_launcher() {
  local resolved_bin
  resolved_bin="$(choose_bin_dir)"
  rm -f "$resolved_bin/codex-arkproxy"
}

remove_installation_files() {
  rm -f "$RUNNER_PATH"
  rm -rf "$PROJECT_DIR"
  rm -rf "$LOG_DIR"
}

remove_codex_home_if_empty() {
  if [[ -d "$CODEX_HOME_DIR" ]]; then
    find "$CODEX_HOME_DIR" -mindepth 1 -maxdepth 1 | grep -q . || rmdir "$CODEX_HOME_DIR" || true
  fi
}

remove_codex_cli_if_requested() {
  if [[ "$REMOVE_CODEX_CLI" != "true" ]]; then
    return
  fi

  if has_cmd npm; then
    npm uninstall -g "$CODEX_NPM_PACKAGE" >/dev/null 2>&1 || true
  fi
}

main() {
  print_step "stopping background service"

  if [[ "$OS_NAME" == "Darwin" ]]; then
    stop_launchd
  else
    stop_systemd_user
    if [[ "$(id -u)" -eq 0 ]]; then
      stop_systemd_system
    fi
  fi
  stop_nohup

  print_step "removing launcher"
  remove_launcher

  print_step "removing installation files"
  remove_installation_files
  remove_codex_home_if_empty

  if [[ "$REMOVE_CODEX_CLI" == "true" ]]; then
    print_step "removing codex CLI"
    remove_codex_cli_if_requested
  fi

  cat <<EOF

codex-ark-proxy has been removed.

install root:
  $INSTALL_ROOT

codex home:
  $CODEX_HOME_DIR
EOF
}

main "$@"
