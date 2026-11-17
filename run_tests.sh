#!/bin/zsh
# 一键生成样例并运行全部自动化测试（Mac 自带环境即可，无需安装任何依赖）
set -euo pipefail
cd "$(dirname "$0")"

echo "==> 1/2 生成本地短音效样例 samples/"
python3 -I tools/make_samples.py

echo "==> 2/2 运行 Node 自动化测试（含 JS/Python 交叉校验与导出回读）"
node --test tests/*.test.js
