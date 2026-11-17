#!/usr/bin/env bash
# 一键验证：生成素材（如缺失）→ 构建前端 → 运行 Playwright 场景测试。
# Playwright 会自动启动 server/index.js 与 vite preview，无需手动开服务。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f media/sample/master.m3u8 ]; then
  echo "[verify] 未找到素材，先生成…"
  bash scripts/generate-media.sh
fi

echo "[verify] 构建前端…"
npm --prefix web run build

echo "[verify] 确认 Chromium 可用…"
npx playwright install chromium >/dev/null

echo "[verify] 运行场景测试…"
npx playwright test
