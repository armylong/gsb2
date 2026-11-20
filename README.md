# 卡顿冻结检测器（ffmpeg + PySide6）

定位演示视频里"因卡顿掉出的停住画面"：逐帧比较画面相似度，按**每帧真实展示时长**
（容器 PTS 差值，而不是按恒定帧率推算）判定停住区间，并导出帧范围、截图和 CSV/JSON 报告。

## 功能

- **逐帧真实时长**：用 `ffprobe` 读每帧 `pts_time` / `duration_time`，不等间隔帧(VFR)、
  掉帧、单帧长驻留都按实际展示时间计算，不假设 CFR。
- **相似度 + 最短持续时间可调**：相邻帧相似度、最短持续毫秒数、相对锚点帧的累计漂移容差
  （用于区分"停住"和"慢速变化/慢摇"，避免把慢速变化误报成冻结）。
- **前后帧检查**：每段命中区间前后各 N 帧一并列出、并在导出截图中给出，方便人工复核。
- **人工标注 + 复检保留**：命中段可标为「正常冻结 / 静态画面 / 黑场 / 忽略」；标注存成
  `<视频名>.annotations.json`，重新检测（哪怕换了参数导致段边界变化）会自动按时间重叠迁移回来。
- **不等间隔 / 开头结尾冻结**：时间范围一律由真实帧时长累加得到，开头冻结从 0 开始、
  结尾冻结覆盖到最后一帧的结束时间。
- **测试片 + 导出**：内置合成测试片（插入冻结、开头/结尾冻结、慢速变化、静态画面、黑场、
  短于阈值的小停顿），导出 CSV / JSON / 每段截图（可选视频切片）。

## 环境要求

- Python ≥ 3.9
- `ffmpeg` / `ffprobe` 在 `PATH` 中（开发验证用的是 ffmpeg 9.x）
- 图形界面需要 PySide6（Qt 6.5+）；纯命令行检测不依赖 Qt

## 本地启动

```bash
# 1) 建虚拟环境并装依赖
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt      # 含 numpy / PySide6 / pytest

# 2) 启动图形界面（无参数即启动 GUI）
python -m freeze_detect

# 或者纯命令行：生成样例 + 检测 + 导出
python -m freeze_detect sample --out ./freeze_samples --analyze --export ./freeze_samples/report
```

Linux 无显示器环境跑 GUI 自测时可以加 `QT_QPA_PLATFORM=offscreen`。

## 命令行用法

```bash
# 检测一个视频，导出 CSV/JSON/截图
python -m freeze_detect detect demo.mp4 --export ./out

# 调参数：相似度、最短持续时间、前后检查帧数、单帧驻留阈值
python -m freeze_detect detect demo.mp4 \
    --similarity 0.997 --min-duration-ms 800 \
    --context-before 6 --context-after 6 \
    --hold-duration-ms 250 --export ./out --clips

# 生成合成测试片（会在程序内生成，无需外部素材）
python -m freeze_detect sample --out ./freeze_samples
```

`detect` 的常用参数：

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--similarity` | 0.995 | 相邻帧相似度阈值（0~1]，越大越严格 |
| `--min-duration-ms` | 500 | 停住画面的最短**实际展示时长** |
| `--hold-duration-ms` | 200 | 单帧长驻留阈值：某帧被展示超过该时长即视为冻结 |
| `--drift-tolerance` | 自动 | 相对锚点帧的累计漂移容差，默认 `2.5×(1-相似度)` |
| `--context-before/after` | 4 / 4 | 每段前后各检查、导出的帧数 |
| `--black-luma` | 0.08 | 平均亮度不高于该值判为黑场 |
| `--export DIR` | — | 导出 `*.freeze.csv`、`*.freeze.json`、`*.frames/`（截图） |
| `--clips` | 关 | 额外导出每段前后带 padding 的视频切片 |
| `--save-annotations` | 关 | 把标注写回 `<视频名>.annotations.json` |

## 一条可运行的验证命令

```bash
python -m freeze_detect selftest
```

它会**在程序内合成测试片**，然后依次校验：VFR 逐帧时长、开头/结尾冻结的时间范围、
中段插入冻结、慢速变化不被误报、短于阈值的停顿不检出、静态/黑场标注在换参数复检后仍保留、
CSV/JSON/截图导出完整。全部通过时退出码为 0，并打印产物目录。

等价地也可以用单元测试：

```bash
python -m pytest
```

## 检测原理

1. **逐帧时间轴**：`ffprobe -show_entries frame=pts_time,duration_time` 取每帧开始时间与展示时长；
   缺 `duration_time` 的容器用相邻 PTS 补齐，末帧用容器流时长兜底。
2. **画面比较**：解码时缩放到分析宽度并转灰度，压成 `tile×tile` 的块均值网格，
   同时算块均值的平均差与 99 分位差。块均值抑制编码噪声与亚像素抖动，又能保留结构变化，
   因此"慢速平移/慢摇"会被识别为持续变化而不是停住。
3. **分段规则**：相邻帧距离 ≤ `1-相似度`，且相对本段锚点帧的漂移 ≤ `drift_tolerance`
   时才视为同一段；段的展示时长 = 段内各帧真实时长之和。
4. **两类冻结**：
   - 连续相同/近似画面（多帧停住）；
   - 单帧长驻留（某一帧展示时长 ≥ `hold_duration_ms` 且明显长于典型帧间隔）——
     这是解码器卡住后跳帧的典型信号。
5. **标注**：静态画面（时长 ≥ `static_hint_ms` 的停住画面）与黑场（亮度 ≤ `black_luma`）
   自动提示，人工确认后标记为忽略，不计入问题段；标注按段的时间范围持久化并支持复检迁移。

## 导出内容

- `*.freeze.csv`：时间码、起止毫秒、时长、帧区间、帧数、最小相邻相似度、最大漂移、
  平均亮度、自动分类、人工标注、是否计入问题、备注。
- `*.freeze.json`：同上，外加完整参数、VFR 标记、每帧前后上下文帧号。
- `*.frames/`：每段的首帧截图，以及前后各一帧的上下文截图，文件名带毫秒时间戳。
- `*.clips/`（`--clips`）：每段 ±150ms 的复核切片。

## 项目结构

```
freeze_detect/
  timeline.py     # ffprobe 逐帧时间轴（真实展示时长 / VFR 判定）
  frames.py       # 解码、灰度特征网格、相似度
  detect.py       # 分段、单帧驻留、静态/黑场分类、上下文帧
  annotations.py  # 标注持久化 / 复检迁移 / CSV·JSON·截图·切片导出
  sample.py       # 合成测试片与真值（VFR）
  cli.py          # 命令行：detect / sample / selftest
  gui.py          # PySide6 界面
tests/
  test_freeze_detect.py
```

## 说明与边界

- 冻结判定基于灰度结构；整段纯色渐变等极端情况可调低 `--similarity` 或调大分析宽度。
- 视频流起始时间不为 0 时，内部时间会平移到相对时间轴，导出的切片/截图会自动加回绝对
  起点，因此 `-ss` 定位始终正确。
- 标注文件默认与视频同目录、同名；视频被移动时把 `*.annotations.json` 一起带走即可。
