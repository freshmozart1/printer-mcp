#!/usr/bin/env bash
# Install (or remove) the printer-mcp LaunchAgent so the server starts at login
# and restarts if it crashes.
#
#   ./scripts/install-agent.sh            install and start
#   ./scripts/install-agent.sh --uninstall  stop and remove
set -euo pipefail

LABEL="com.ole.printer-mcp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$HOME/Library/Logs"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL."
  exit 0
fi

# launchd runs with a minimal PATH, so node must be referenced absolutely. nvm-managed
# installs move when Node is upgraded — re-run this script after upgrading Node.
# Pick a node new enough to run TypeScript directly. `command -v node` is not
# sufficient: with nvm installed the shell default may be an older version that
# cannot strip types, and the agent would fail at launch with an opaque ESM error.
find_node() {
  local candidate
  for candidate in "$(command -v node || true)" "$HOME"/.nvm/versions/node/*/bin/node; do
    [[ -x "$candidate" ]] || continue
    local major
    major="$("$candidate" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if (( major >= 24 )); then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "No Node 24+ found. This server runs TypeScript directly and needs Node 24 or newer." >&2
  echo "Checked PATH and ~/.nvm/versions/node/*." >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$PROJECT_DIR/src/index.ts</string>
    <string>--http</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/printer-mcp.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/printer-mcp.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl enable "gui/$(id -u)/$LABEL"

echo "Installed $LABEL"
echo "  node:  $NODE_BIN"
echo "  logs:  $LOG_DIR/printer-mcp.log"
echo "  token: $(cat "$HOME/.config/printer-mcp/token" 2>/dev/null || echo '(created on first run)')"
