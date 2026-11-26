# SlitScan 本地切缝取图工具

从有规律经过镜头的物体生成"时间长条图"：每个时刻只取视频中一条竖直缝
（slit）内的像素，按时间从左到右拼接，横轴即时间、纵轴保留视频高度，
方便比较物体随时间排开的形状。

纯本地运行，依赖 **Python + ffmpeg/ffprobe + PySide6**，不上传任何数据。

## 安装

需要系统已安装 `ffmpeg` 与 `ffprobe`（macOS：`brew install ffmpeg`）。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

启动图形界面：

```bash
./run_gui.sh
# 或
.venv/bin/python -m slitscan.app
```

## 功能与需求对照

| # | 需求 | 实现位置 |
|---|------|----------|
| 1 | 导入单条短视频，帧预览里设置竖缝位置/宽度，用两个时间点让缝平移，暂停并查看本帧像素范围 | `app.py` 的 `VideoPreview`（可拖动缝、左右沿）、`SlitConfig.start/end_center` 线性插值；绿色=真实像素，红色=补边列 |
| 2 | 横轴时间、纵轴视频高度；每帧挨着排或固定时间间隔排，可对照两种结果 | `core.select_moments` 的 `frame` / `interval` 两种布局；界面"对照两种布局"按钮各建一个标签页 |
| 3 | 点长图一列回到原片对应画面与切缝；从帧预览定位输出段；找不到原片像素时标出 | `core.x_to_block` / `frame_to_block`；`StripView` 点击回链；无像素块红色填充、合成块橙色顶条 |
| 4 | 缝接近边缘时明确补边；调整起止范围或剪掉区间后长图与索引一起重算 | `core.resolve_slit` 四种模式 edge/reflect/zero/limit；修剪与跳过区间驱动 250ms 防抖重建 |
| 5 | 保存 PNG 和可重新定位的时间/坐标清单；超长输出分页且接头不重列、不少列 | `output.save_result` 写分页 PNG + `.manifest.json`；页容量取缝宽整数倍保证接缝精确 |
| 6 | 内置恒速、换向、不均匀帧时间三种条纹样片，并提供本地核对办法 | `synth.py` 的 constant/reverse/vfr；`cli verify` 做接缝、回链、像素与条形码核对 |

## 四种补边模式

- **edge 边缘拉伸**：越界列复制最靠边的真实像素列。
- **reflect 镜像反射**：越过边界的部分按镜像取列（如 `-1 → 1`）。
- **zero 黑边**：越界列填黑，并在清单里记为 `-1`（无原片像素）。
- **limit 限制在画面内**：不补边，直接把缝平移回合法范围。

## 分页与清单

单页宽度默认上限 8000 px。页容量自动取"缝宽的整数倍"，因此任意一条缝
都不会被页接缝切开，多页拼接后既不重复一列也不丢失一列（由
`output.verify_pages` 与 CLI `verify` 双重保证）。

`.manifest.json` 记录：

- 源视频路径、宽高、**每一帧的 PTS 时间戳**（VFR 也精确）
- 缝宽、起止中心、补边模式、布局、间隔、修剪/跳过区间
- 每个块（一个时刻的一条缝）：所在页与页内 x、全局 x、源帧号、时间戳、
  缝左沿，以及逐列的源像素列号（`-1` 表示该列是补边/无原片像素）

## 命令行用法

```bash
# 生成内置样片（constant / reverse / vfr）
python -m slitscan.cli synth vfr sample_vfr.mp4

# 构建长图：缝宽 8，中心从 x=20 平移到 x=140，edge 补边
python -m slitscan.cli build sample_vfr.mp4 strip.png \
    --width 8 --start-center 20 --end-center 140 --padding edge

# 固定 0.2s 时间间隔排布，跳过 [0.5,1.5) 这段，单页最大 2000 px
python -m slitscan.cli build sample_vfr.mp4 grid.png \
    --layout interval --interval 0.2 --skip 0.5 1.5 --max-page-width 2000

# 本地核对：接缝、回链、逐像素一致；--check-ids 额外核对样片条形码
python -m slitscan.cli verify strip.manifest.json --check-ids
```

## 不均匀帧时间（VFR）

时间戳通过 `ffprobe -show_frames` 逐帧读取，不假设恒定帧率；解码用
`-fps_mode passthrough` 保留全部原始帧。因此 interval 布局是按真实秒数
网格化时间，而非按帧序号——同一时长的 VFR 与 CFR 视频会得到不同的列数，
这正是对照两种布局想观察的差异。

## 样片自检原理

每个样片帧的顶行包含一个**亮度条形码**（暗色起始位 + 亮色同步时钟 +
5 位帧号），只依赖亮度，能扛住 h264/yuv420p 的有损压缩。`verify
--check-ids` 从长图每个切片读条码并与清单记录的源帧号比对，验证
"这一列确实来自它声称的那一帧"。

## 测试

```bash
.venv/bin/python -m pytest tests/ -q
```

39 个测试覆盖：缝几何与四种补边、修剪/跳过、两种布局、分页接缝精确性、
双向回链、ffmpeg 解码与 VFR 时间戳、端到端构建/保存/校验、篡改检测，
以及离屏 GUI 冒烟（无需显示器）。

## 模块结构

```
slitscan/
  core.py    纯计算：缝几何、补边、时刻选择、长图拼装、分页、回链映射
  video.py   ffmpeg 解码 + ffprobe 逐帧 PTS（含 VFR）
  synth.py   三种内置条纹样片与帧号条形码
  output.py  分页 PNG、manifest 读写、结构自检
  cli.py     无界面 build / synth / verify
  app.py     PySide6 图形界面
tests/       pytest 测试套件
```

## 内存说明

解码会把整段视频读进内存（uint8 RGB），并有 4 GB 上限保护。请用较短的
片段；超限会报错并提示缩短时间范围。
