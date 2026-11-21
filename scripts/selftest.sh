#!/usr/bin/env bash
# 页面内交互自测：启动 vite（若未运行）→ headless Chrome 加载 ?selftest=1 → 抓取结果。
# 数学正确性的确定性验证走 `npm run verify`（纯 Node，无需浏览器）。
set -euo pipefail

cd "$(dirname "$0")/.."
PORT=5199
URL="http://localhost:${PORT}/?selftest=1"

CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium" \
  "/usr/bin/google-chrome" \
  "/usr/bin/chromium" \
  "/usr/bin/chromium-browser"; do
  [ -x "$candidate" ] && CHROME="$candidate" && break
done
if [ -z "$CHROME" ]; then
  echo "未找到 Chrome/Chromium，跳过浏览器自测；数学验证仍可运行 npm run verify" >&2
  exit 0
fi

STARTED=0
# 端口已被占用时，确认服务的是本项目；否则仍自行启动（strictPort 冲突则报错退出）
if curl -sf "http://localhost:${PORT}/" | grep -q "相邻曲面细分裂缝观察台"; then
  :
else
  # 找到可用 node（兼容 homebrew node 动态库损坏的环境）
  if [ -x /opt/homebrew/opt/node@20/bin/node ]; then
    export PATH="/opt/homebrew/opt/node@20/bin:$PATH"
  fi
  npm run dev > /tmp/tess-lab-vite.log 2>&1 &
  VITE_PID=$!
  STARTED=1
  for _ in $(seq 1 40); do
    curl -sf "http://localhost:${PORT}/" | grep -q "相邻曲面细分裂缝观察台" && break
    sleep 0.25
  done
fi

TMP_DOM="$(mktemp)"
trap 'rm -f "$TMP_DOM"; [ "$STARTED" = "1" ] && kill "${VITE_PID:-}" 2>/dev/null || true' EXIT

"$CHROME" --headless=new --enable-unsafe-swiftshader --no-sandbox --disable-dev-shm-usage \
  --virtual-time-budget=8000 --dump-dom "$URL" > "$TMP_DOM" 2>/dev/null

echo "== 页面内自测结果 =="
# 抽取 #selftest-out 的文本行（DOM 里换行是实体/文本节点，简单按 PASS/FAIL 切）
grep -oE '(PASS|FAIL) [^<]+' "$TMP_DOM" || true
echo "-------------------"
if grep -q 'SELFTEST PASS' "$TMP_DOM"; then
  grep -oE 'SELFTEST PASS [0-9]+/[0-9]+ in [0-9]+ms' "$TMP_DOM" | head -1
  exit 0
else
  echo "浏览器自测失败（或浏览器不支持 WebGL）。DOM 摘要见 $TMP_DOM" >&2
  grep -oE 'SELFTEST FAIL [0-9]+/[0-9]+ in [0-9]+ms' "$TMP_DOM" | head -1 || true
  exit 1
fi
