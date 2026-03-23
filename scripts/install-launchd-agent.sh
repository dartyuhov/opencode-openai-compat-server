#!/bin/sh

set -eu

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
DEFAULT_REPO_DIR="$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)"

OPENCODE_BIN="${OPENCODE_BIN:-$(command -v opencode 2>/dev/null || true)}"
if [ -z "${OPENCODE_BIN}" ]; then
  echo "Could not find 'opencode' on PATH." >&2
  exit 1
fi

BUN_BIN="${BUN_BIN:-$(command -v bun 2>/dev/null || true)}"
if [ -z "${BUN_BIN}" ]; then
  echo "Could not find 'bun' on PATH." >&2
  exit 1
fi

LABEL="${LAUNCHD_LABEL:-com.user.opencode-serve-openai-compat}"
SERVER_PORT="${OPENCODE_SERVER_PORT:-4096}"
SERVER_HOSTNAME="${OPENCODE_SERVER_HOSTNAME:-127.0.0.1}"
SIDECAR_PORT="${OPENCODE_OPENAI_COMPAT_PORT:-4097}"
API_KEY="${OPENCODE_OPENAI_COMPAT_API_KEY:-}"
LOG_DIR="${HOME}/Library/Logs/opencode-openai-compat"
PLIST_PATH="${HOME}/Library/LaunchAgents/${LABEL}.plist"
REPO_DIR="${REPO_DIR:-${DEFAULT_REPO_DIR}}"

mkdir -p "${HOME}/Library/LaunchAgents" "${LOG_DIR}"

cat > "${PLIST_PATH}" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${BUN_BIN}</string>
    <string>run</string>
    <string>scripts/serve-with-sidecar.ts</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>OPENCODE_BIN</key>
    <string>${OPENCODE_BIN}</string>
    <key>OPENCODE_SERVER_HOSTNAME</key>
    <string>${SERVER_HOSTNAME}</string>
    <key>OPENCODE_SERVER_PORT</key>
    <string>${SERVER_PORT}</string>
    <key>OPENCODE_OPENAI_COMPAT_PORT</key>
    <string>${SIDECAR_PORT}</string>
    <key>OPENCODE_OPENAI_COMPAT_API_KEY</key>
    <string>${API_KEY}</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${LOG_DIR}/stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/stderr.log</string>
</dict>
</plist>
EOF

launchctl unload "${PLIST_PATH}" >/dev/null 2>&1 || true
launchctl load "${PLIST_PATH}"

echo "Installed launchd agent: ${PLIST_PATH}"
echo "OpenCode server: http://${SERVER_HOSTNAME}:${SERVER_PORT}"
echo "Compat sidecar: http://127.0.0.1:${SIDECAR_PORT}/v1"
if [ -n "${API_KEY}" ]; then
  echo "Compat API key: ${API_KEY}"
else
  echo "Compat API key: disabled"
fi
