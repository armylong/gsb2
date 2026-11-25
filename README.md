# 灯光通道本地重组检查窗口

静态渲染拆出的线性光浮点通道（材质底色 / 自发光 / 漫反射光 / 镜面光），
在本地单独压某一盏灯的贡献再合回产品图。Python + PySide6 + numpy，
通道文件为浮点 `.npy`，预览与成品可导 PNG。

## 管线（关键：不在中间阶段截断高亮）

```
npy 原始通道 (float32, 可 >1)
  → 逐通道乘倍率 (仍是无界 float32, 独显开关在此过滤)
  → 线性求和 linear        无 clamp, 保留 >1 高光
  → 曝光 (2^EV 线性缩放)    仍无 clamp
  → 色调映射 (clip / Reinhard / ACES)  唯一的范围压缩, 进 [0,1]
  → sRGB 编码 → uint8 屏幕色 / PNG
```

合成语义：`final = base*mb + emission*me + diffuse*md + specular*ms`。
倍率为 0 即「压掉某盏灯」；独显（solo）打开时只保留被勾选的通道。

## 运行

```bash
./run_app.sh                      # 自动建 venv 装依赖, 直接打开内置示例
# 或手动:
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
PYTHONPATH=. .venv/bin/python -m light_recombine.app --example
```

## 通道文件约定

- 形状 `HxWx3`（RGB）或 `HxW`（灰度自动扩三通道），dtype 任意数值型，
  内部统一转 `float32`；含 NaN/Inf 或对象数组会被拒绝。
- 单路载入：每行「载入 npy…」。
- 目录批量载入：文件名包含 `base` / `emission` / `diffuse` / `specular`
  即自动识别（菜单「文件 → 从目录载入四通道 npy」）。
- 缺失或尺寸不一致的通道：状态标红、顶部横幅写明当前能预览的部分，
  预览该通道时显示棋盘格与「无数据」文字，**按 0 参与合成，不拿别的图顶替**。

## 界面能力对照需求

| 需求 | 实现 |
| --- | --- |
| 读四路同尺寸平面 + 内置几何示例 | 菜单/按钮载入；内置示例含底色为零点、纯漫反射点、峰值 4.5 的镜面热点 |
| 每路倍率 + 独显 | 通道表每行一个倍率 SpinBox（0–10）和独显复选框 |
| 合成前数值 vs 屏幕色对照 | 左侧数值表给原始 min/max、缩放后 max；底部给线性/曝光/映射/屏幕四段值；线性阶段不截断 |
| 光标像素逐路贡献 | 鼠标在预览上移动，探针表列每路原始线性值、倍率、缩放后值、屏幕 0–255 值与色样；提供三个核对点跳转按钮 |
| 底色为零 / 高反射点核对 | 示例 `(24,128)` 底色为 0 但自发光 >1；`(108,92)` 镜面原始值 4.5，屏幕端才压到 255 |
| 缺失/尺寸不符标清可预览部分 | 横幅 + 状态列 + 棋盘格，缺失按 0，不顶替 |
| 导出成品与参数、重开一致 | 导出合成 PNG / 当前预览 PNG；参数存 JSON（含来源 npy 路径、倍率、独显、曝光、色调映射），重开载入即逐像素复现 |

## 无头验证（不打开窗口）

```bash
PYTHONPATH=. .venv/bin/python -m light_recombine.headless_check \
  --example --spec-scale 0 --outdir out/
```

输出 `full.png` / `adjusted.png` / 四个单通道图 / `verify_report.json`。
报告里 `diffuse_max_abs_diff_vs_full = 0.0` 即证明：只压镜面时
漫反射贡献逐像素完全保留。真实数据用 `--npy-dir DIR --params p.json`。

## 测试

```bash
.venv/bin/python -I tests/test_pipeline.py                 # 24 项核心测试
QT_QPA_PLATFORM=offscreen .venv/bin/python -I tests/test_gui.py  # 7 项 GUI 冒烟
```

覆盖：线性求和语义、压镜面保漫反射、独显隔离、>1 高光不被提前截断、
曝光/色调映射/sRGB、探针（含底色零点与高光点）、缺失与尺寸不符不顶替、
npy/PNG/参数 JSON 往返复现。

## 目录结构

```
light_recombine/
  channels.py       通道定义与加载状态
  composite.py      合成/显示变换/像素探针 (纯 numpy)
  example_scene.py  内置几何示例
  io_npy.py         npy 读写 + 参数 JSON (allow_pickle=False)
  io_png.py         标准库 zlib 实现的 PNG 编码
  headless_check.py 无头验证 CLI
  gui/              PySide6 窗口与图像控件
tests/              无头测试 (核心 + offscreen GUI)
```
