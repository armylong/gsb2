# 本地彩色负片转换工作台

用 Python + NumPy + PySide6 做的单张本地负片转换窗口。支持普通 8-bit PNG，以及 8/16-bit TIFF；16-bit 整数数据会保留到导出阶段，交互预览使用降采样数据，导出时始终从完整原图重新计算。

## 运行

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python main.py
# 或
python -m negative_converter

# macOS/Linux 也可以使用仓库脚本（会优先使用 ./.venv）
./run.sh
```

也可以使用 [uv](https://docs.astral.sh/uv/)：

```bash
uv run --with-requirements requirements.txt python main.py
```

运行测试：

```bash
pytest -q
```

## 操作流程

1. 启动后会自动载入内置「彩色片基 + 双灰阶」程序样片；也可以点 **打开 PNG / TIFF** 载入自己的扫描件或翻拍文件。
2. 保持 **框选片底色**，在多块未曝光、均匀的片边区域上拖框；也可以直接单击生成固定大小样本。
   - 青色框：正常片底，参与底色估计。
   - 红色框：检测到灰尘/离群点或溢出/死白，默认排除在底色估计之外。
   - 黄色框：当前选中。
   - 在列表中选中样本后点 **删除选中样本**，或在列表聚焦时按 `Delete` / `Backspace`。
3. 调整 **暗端、亮端、Gamma、R/G/B 灰倍率**，或先点 **自动估计亮暗端**。
4. 切到 **框选中性细节**，框住已知应为灰/白/黑中性的物体，点 **用中性样本校正**。表格会分别显示：
   - 原片 RGB 色差；
   - 去橙底/密度反相后的色差；
   - 当前成片色差；
   - 校正后近中性像素比例和截断比例。
5. 三个视图分别是原片、正像和诊断标记。缩放、平移、十字线和样本框位置联动。`Ctrl/⌘ + 滚轮` 缩放；普通滚轮/触控板可滚动，也可切到 **平移** 模式拖拽。
6. 在导出区选择：
   - PNG 8-bit RGB；
   - TIFF 8-bit RGB；
   - TIFF 16-bit RGB；
   - 完整灰度范围，或 16–235（8-bit 当量）的缩限灰度范围。
7. 点 **导出正片并自动回读核对**。程序会重新从磁盘打开导出文件，显示真实数据类型、各通道最小/最大值、全局码值范围以及是否覆盖目标范围。也可以用 **选择已导出文件回读核对** 检查任意旧输出。

## 标记含义

诊断视图将不同风险分开：

- **蓝色**：输入信号接近估计黑场/底噪；
- **红色**：原片已有饱和/溢出，属于输入阶段丢失，通常无法靠拉参数恢复；
- **黄色**：亮端或灰平衡倍率导致的输出截断；
- **青色**：暗端端点过重导致的暗部压死。

所有滑块都不会把调整“烘焙”进原始数据。每次更新都从保留的源数组重新计算，因此把亮/暗端点或灰倍率拉回时，未在输入阶段永久丢失的层次会重新出现。测试 `test_extreme_parameters_are_recoverable_by_recomputing_from_source` 锁定了这一行为。

## 内置程序样片

菜单和首页按钮提供两个确定性 NumPy 样片，不需要外部图片：

- **彩色片基 + 双灰阶程序负片**：橙色片基、干净片边、灰尘样本、溢出样本、色卡、中性细节，以及内置的两个灰度范围（暗部到中间调、中间调到亮部）。
- **输出范围核对样片**：已知密度的无噪声灰阶，包含确切暗端/亮端条，适合验证 8/16-bit 和 full/limited range 导出。

## 处理模型简述

底色估计取所有正常片底样本中位 RGB 的跨块中位数。转换使用片基相对密度：

```text
ratio_c   = input_c / base_c
density_c = -log10(max(ratio_c, 1e-7))
positive  = ((density_c - black) / (white - black))^(1/gamma) * gray_c
```

这比直接 `255 - RGB` 更适合彩色负片的橙色 mask 和密度响应。核心函数均在 `negative_converter/core.py`，不依赖 Qt，便于脚本化或测试。

## 支持的输入

- `.png`：普通 8-bit RGB/RGBA/灰度 PNG，也尽力支持 Pillow 能返回的 16-bit 灰度 PNG。
- `.tif` / `.tiff`：通过 `tifffile` 读取常见 8/16-bit RGB/灰度 TIFF；多页文件取第一个序列/页面。

## 主要文件

```text
main.py                         # 启动入口
negative_converter/core.py      # IO、样本检测、转换、诊断、导出、回读
negative_converter/samples.py   # 确定性程序样片
negative_converter/gui.py       # PySide6 主窗口和联动视图
tests/                          # NumPy 核心与 offscreen GUI 冒烟/行为测试
```
