#!/usr/bin/env bash
# 端到端浏览器验证: 启动 dev server 与无头 Chrome(CDP), 跑 browser-verify.ts。
set -euo pipefail
cd "$(dirname "$0")/.."

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PORT=9222
PROFILE_DIR="$(mktemp -d)"
trap 'kill ${CHROME_PID:-} ${VITE_PID:-} 2>/dev/null || true; rm -rf "$PROFILE_DIR"' EXIT

# 若已有调试 Chrome 在跑则复用, 否则启动一个
if ! curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
  "$CHROME" --headless --disable-gpu --no-sandbox \
    --remote-debugging-port=$PORT --user-data-dir="$PROFILE_DIR" about:blank >/tmp/chrome-cdp.log 2>&1 &
  CHROME_PID=$!
  for _ in $(seq 1 20); do
    curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

# dev server(若未运行)
if ! curl -s http://localhost:5174/ >/dev/null 2>&1; then
  npx vite --port 5174 >/tmp/vite-verify.log 2>&1 &
  VITE_PID=$!
  for _ in $(seq 1 20); do
    curl -s http://localhost:5174/ >/dev/null 2>&1 && break
    sleep 0.5
  done
fi

node --no-warnings src/verify/browser-verify.ts
