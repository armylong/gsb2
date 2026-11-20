# BandViewer — 灰阶量化色带观察器

把**连续高光**图像量化到一组**指定灰阶**，用来观察和比较由此产生的**色带（banding）**。
核心算法只依赖 numpy，图形界面使用 PySide6；PNG 读写用标准库自实现，因此无头环境也能完整验证。

## 功能对照

| 需求 | 实现位置 / 说明 |
| --- | --- |
| 程序生成渐变、暗角、小字，也支持灰度图 | `bandviewer/patterns.py`：水平均匀坡度、径向暗角、尖锐边缘+硬台阶、点阵小字、综合样例、纯灰度斜坡；GUI 可再打开外部 PNG |
| 不同间距的自定义灰阶 + 数种量化比较 | `bandviewer/levels.py`（等距 / gamma 暗部密集 / gamma 亮部密集 / 任意自定义值），`bandviewer/quantize.py`（最近邻、向下取级、Bayer 有序抖动、Floyd-Steinberg、随机抖动 5 种）；GUI 有“并排比较全部方法” |
| 局部放大按真实像素显示同一位置，显示每级像素数及色带边界 | `ZoomDialog`：原图/量化图同位置并排、最近邻无平滑、像素网格、中心十字、悬停读像素值；主界面下方有每级像素数表和色带边界列表，边界可在图上红色叠加 |
| 保留透明区 | 噪声、量化、分析、PNG 导出全程携带 alpha，透明像素不参与量化/统计/边界判定，导出 PNG 保留透明通道 |
| 可调噪声扰动并按种子复现 | `add_noise(strength, seed)`，高斯噪声只作用于不透明像素；同种子结果逐像素一致 |
| 输出灰阶图和误差图，用均匀坡度和尖锐边缘检查 | 导出量化灰阶 PNG 与红-蓝有符号误差 PNG（均保留透明）；内置“水平均匀坡度”和“尖锐边缘+硬台阶”样例 |

## 目录结构

```
bandviewer/
  font5x7.py    内置 5x7 点阵字（小字图案，无外部字体依赖）
  levels.py     等距/gamma/自定义灰阶的生成与解析
  quantize.py   5 种量化算法 + 可复现噪声
  patterns.py   6 种内置测试图（含透明切角）
  analysis.py   每级像素数、色带边界、误差统计、扫描线
  pngio.py      纯标准库(zlib/struct) 的 8-bit PNG 读写
  workers.py    后台量化线程（避免界面卡顿）
  imageutils.py numpy -> QImage 转换
  app.py        PySide6 主界面、局部放大、方法比较
  cli.py        --selftest 无头验证 / 启动 GUI
tests/
  test_core.py  核心算法单元测试（不依赖 Qt）
  smoke_gui.py  offscreen 界面冒烟测试
run.py          统一入口
```

## 本地启动

需要 Python 3.10+（开发验证环境为 3.12）。

```bash
# 1. 创建并激活虚拟环境
python3 -m venv .venv
source .venv/bin/activate

# 2. 安装依赖（numpy + PySide6）
pip install -r requirements.txt

# 3. 启动图形界面
python run.py
```

界面操作：左侧四个分组依次选择测试图 → 设置灰阶 → 选择量化方法与噪声 →
查看/导出。在图像上**双击**任意位置即可打开该位置的真实像素局部放大；
“并排比较全部量化方法”会在同一级别设置下同时给出 5 种结果及各自 MAE/RMSE/边界数。

## 验证命令

一条可运行的端到端验证（不启动 GUI，样例全部由程序内部生成，产物写入 `tmp/selftest`）：

```bash
python run.py --selftest --outdir tmp/selftest --size 256
```

它会覆盖：6 种测试图生成、3 种间距方案与自定义级别解析、5 种量化方法输出合法性、
噪声种子复现、硬色带边界计数、每级像素数求和、误差统计、PNG 往返读写与透明保留，
全部通过时退出码为 0 并打印 `selftest 0 failure(s)`。

其它验证：

```bash
# 核心算法单元测试（14 项，无需 Qt 显示）
python -m unittest tests.test_core -v

# 界面冒烟测试（用 Qt offscreen 平台，无需真实显示器）
QT_QPA_PLATFORM=offscreen python tests/smoke_gui.py
```

## 设计要点

- **透明区一等公民**：内部统一用 `(gray[0,1], alpha[0,1])` 两个浮点数组表示图像，
  所有算法先判 `alpha > 0`；透明像素既不被加噪/量化，也不会被误报成色带边界。
- **量化值严格落在级别集合上**：分析模块按精确匹配把像素归类到级别，直方图求和恒等于不透明像素数。
- **重算在后台线程**：Floyd-Steinberg 为逐像素蛇形扫描，放到 `QThread` 中执行，
  期间连续改参数会自动合并为一次最新重算。
- **无第三方图像库**：PNG 编解码只用 zlib/struct，便于在精简环境或 CI 中无头验证。
