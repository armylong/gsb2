#!/usr/bin/env bash
# 本地启动：纯静态站点，用 Python 内置 HTTP 服务托管（ES Module 不能用 file:// 直接打开）。
set -euo pipefail

PORT="${1:-8123}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

URL="http://localhost:${PORT}/index.html"

echo "=============================================="
echo " 表面平滑与法线检查工具"
echo " 目录: $ROOT"
echo " 访问: $URL"
echo " 停止: Ctrl+C"
echo "=============================================="

# 自动打开浏览器（macOS）；无 open 命令时只打印地址
if command -v open >/dev/null 2>&1; then
  ( sleep 1; open "$URL" ) &
fi

if command -v python3 >/dev/null 2>&1; then
  exec python3 -m http.server "$PORT"
elif command -v python >/dev/null 2>&1; then
  exec python -m SimpleHTTPServer "$PORT"
else
  echo "未找到 python3/python，可改用: npx serve . -l $PORT" >&2
  exit 1
fi
