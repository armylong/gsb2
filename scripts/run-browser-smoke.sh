#!/bin/zsh
# 浏览器端自动验证:在单条命令生命周期内启动 preview 服务器与 headless Chrome,
# 跑完 CDP 冒烟脚本后自动清理。Mac 本地使用,不依赖特定显卡与帧率。
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=4173
CDP_PORT=9334
PROFILE_DIR=$(mktemp -d /tmp/terrain-chrome-XXXXXX)

cleanup() {
  [[ -n "${CHROME_PID:-}" ]] && kill "$CHROME_PID" 2>/dev/null || true
  [[ -n "${PREVIEW_PID:-}" ]] && kill "$PREVIEW_PID" 2>/dev/null || true
  rm -rf "$PROFILE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# 1) 生产构建 + 本地 preview
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  npm run build >/dev/null
fi
npx vite preview --port "$PORT" --strictPort --host 127.0.0.1 >/tmp/terrain-preview.log 2>&1 &
PREVIEW_PID=$!

# 2) headless Chrome(独立 profile,开启 CDP;不禁用 GPU,否则 WebGL 上下文创建失败)
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new \
  --enable-unsafe-swiftshader \
  --disable-dev-shm-usage \
  --remote-debugging-port="$CDP_PORT" \
  --user-data-dir="$PROFILE_DIR" \
  --no-first-run \
  --no-default-browser-check \
  about:blank >/tmp/terrain-chrome.log 2>&1 &
CHROME_PID=$!

# 3) 等待两个端口同时就绪
READY=0
for i in {1..40}; do
  if curl -s -m 2 "http://127.0.0.1:$PORT/" >/dev/null && curl -s -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != "1" ]]; then
  echo "服务启动失败" >&2
  cat /tmp/terrain-preview.log /tmp/terrain-chrome.log >&2
  exit 1
fi
# 再给 Chrome 一点时间完成浏览器进程初始化
sleep 2

# 4) 运行冒烟验证
SMOKE_BASE="http://127.0.0.1:$PORT" SMOKE_CDP_PORT="$CDP_PORT" node scripts/browser-smoke.mjs
RC=$?

if [[ "${KEEP_ALIVE:-0}" == "1" ]]; then
  echo "KEEP_ALIVE=1,保留进程 30 分钟用于排查 (preview=$PREVIEW_PID chrome=$CHROME_PID)"
  sleep 1800
fi
exit $RC
