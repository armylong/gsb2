# alpha_lab — 透明 PNG 混合像素检查工具

排查"透明 PNG 叠深色底出现一圈脏边"的小工具 (Python + PySide6)。

## 功能

1. **内置样例**: 一键生成带高斯半透明边缘的彩色图 + 深/浅双色背景,
   可切换 A=0 区域的 RGB 污染模式 (干净 / 白污染 / 黑污染) 复现脏边;
   也可导入自己的透明 PNG。
2. **两种透明度存储约定**: 同一数据可按"直通 (straight)"或"预乘 (premultiplied)"
   解读, 并排展示颜色、覆盖度 α 与混合结果, 直观看到误读格式的后果。
3. **两种计算空间合成**: sRGB 空间 vs 线性光空间并排对比, 附差异放大图;
   面板内解释对中间灰的影响 (50% 覆盖白叠黑: 128 vs 188)。
4. **A=0 像素通道可见**: "前景原始 RGB"视图忽略 α 显示隐藏数据;
   滚轮缩放 (≥8x 出像素网格)、六视图联动平移, 悬停状态栏显示
   该像素的直通/预乘/u8 数值, 方便逐像素对比边界。
5. **导出与自检**: 合成结果可导出 PNG (可选合成空间);
   内置 8 项数值小样, 核对 over 混合、直通↔预乘转换、sRGB↔线性转换。

## 本地启动

```bash
cd <本仓库目录>
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m alpha_lab          # 启动图形界面
```

## 验证命令 (无需显示器)

```bash
.venv/bin/python -m alpha_lab --selftest
```

预期输出 8 项全部 PASS, 退出码 0。另可用
`.venv/bin/python -m alpha_lab --smoke` 离屏验证 GUI 能正常构建。

## 目录结构

```
alpha_lab/
  core.py      混合/色彩空间数学 (纯 numpy, 不依赖 Qt)
  samples.py   内置样例图生成
  selftest.py  数值自检
  app.py       PySide6 界面
  __main__.py  命令行入口
```
