# thumb-pack：视频缩略图预览包生成与核对工具

用 **Python 标准库 + FFmpeg/FFprobe + 本地网页** 生成可用于拖动进度条的多页 Sprite 大图、JSON/VTT 清单和可视化核对台。运行时不依赖 Pillow、Node 或前端 CDN。

它重点回答两个问题：

1. **到底少了多少个小文件**：N 个目标格 → P 张页图，清单记录 `savedFileCount = N - P`。
2. **指针有没有取错画面**：每个格子都记录最终源帧号、原始 PTS、归零 PTS、帧覆盖区间、页名和像素矩形；网页可同步对照真实视频帧。

---

## 1. 环境

需要：

- Python 3.10+
- `ffmpeg` / `ffprobe` 在 `PATH` 中；macOS 可 `brew install ffmpeg`

检查：

```bash
ffmpeg -version
ffprobe -version
python3 -m thumb_pack --help
```

无需安装 Python 依赖。也可以使用根目录启动器：

```bash
./thumb-pack --help
```

如果要安装成命令：

```bash
pip install -e .
thumb-pack --help
```

---

## 2. 30 秒自检

自检会在系统临时目录生成带帧号样片，并覆盖：

- 跨页边界（slot 9 → 10）
- 两个目标时间命中同一源帧（slot 5、6）
- 最后一页只剩一格（21 格，每页 10 格，共 3 页）
- 坏格占位且不挤位
- 页图被移走
- 矩形超出真实图像
- VFR、起始 PTS 偏移、竖幅
- 像素级回取比对
- 本地 HTTP Range 服务

运行：

```bash
python3 -m thumb_pack selftest
```

也可以走 unittest：

```bash
python3 -m unittest discover -s tests -v
```

---

## 3. 生成带帧号样片

### 普通横幅 CFR

```bash
python3 -m thumb_pack sample /tmp/tp/numbered.mp4 \
  --frames 24 --fps 10 --width 320 --height 180
```

画面中有大号零基帧号 `000`、`001`……，底部还有二进制帧号块，便于肉眼和像素检查。同时写出：

```text
/tmp/tp/numbered.mp4.frames.json
```

### 竖幅

```bash
python3 -m thumb_pack sample /tmp/tp/portrait.mp4 --vertical --frames 12 --fps 8
```

### 非恒定帧率 + 起始时刻偏移

```bash
python3 -m thumb_pack sample /tmp/tp/vfr-offset.mp4 \
  --frames 18 --vfr --start-offset 7.25
```

FFprobe 会看到原始 PTS 从约 `7.25s` 开始；工具生成清单时会减去起点，使清单和 HTML5 Player 都使用从零开始的时间线。

想模拟“长一点、适合拖进度条”的样片，可以加大帧数和帧率：

```bash
python3 -m thumb_pack sample /tmp/tp/long.mp4 \
  --frames 600 --fps 25 --width 640 --height 360

python3 -m thumb_pack generate /tmp/tp/long.mp4 \
  --out /tmp/tp/long-pack \
  --interval 1 \
  --columns 5 --rows-per-page 2
```

这会得到 24 秒样片、25 个目标格和 3 张每页 10 格的页图；加长到数千帧、调小 `--interval` 或增大每页行列数即可模拟更长的进度条预览包。

---

## 4. 先核对会采到哪一帧

正式写图前可以 dry-run：

```bash
python3 -m thumb_pack /tmp/tp/numbered.mp4 --dry-run \
  --times '0,0.12,0.24,0.48,0.51,0.57,0.96'
```

输出示例语义：

```text
slot 0001 t=0.510 -> F0005 | normalized PTS=0.500
slot 0002 t=0.570 -> F0005 | normalized PTS=0.500 COLLISION slots=1,2
```

这表示 `0.510s` 和 `0.570s` 都落在第 5 帧 `[0.500, 0.600)` 的显示区间内。

---

## 5. 生成预览包

### 按固定间隔

```bash
python3 -m thumb_pack generate /path/to/video.mp4 \
  --out /tmp/tp/pack-interval \
  --interval 5 \
  --columns 5 --rows-per-page 2
```

### 按不等距时间清单

命令行直接给：

```bash
python3 -m thumb_pack generate /tmp/tp/numbered.mp4 \
  --out /tmp/tp/pack-core \
  --columns 5 --rows-per-page 2 \
  --thumb-width 160 --thumb-height 90 \
  --times '0,0.12,0.24,0.36,0.48,0.51,0.57,0.72,0.84,0.96,1.08,1.20,1.32,1.44,1.56,1.68,1.80,1.92,2.04,2.16,2.30'
```

或使用文件。支持：

- 文本：逗号、空格、分号、换行分隔
- 秒：`1.5`
- 时间码：`00:00:01.500`、`01:02.250`
- JSON：`[0, 1.5, 3]` 或 `{"times":[0,1.5,3]}`

```bash
python3 -m thumb_pack generate video.mp4 \
  --times-file times.json \
  --out pack
```

如果第一个参数不是已知子命令，会自动按 `generate` 处理，所以：

```bash
python3 -m thumb_pack video.mp4 -o pack --interval 2
```

等价于：

```bash
python3 -m thumb_pack generate video.mp4 -o pack --interval 2
```

---

## 6. 本地网页核对

推荐用内置服务打开，这样视频可自动载入，Canvas 像素差异也不会被 `file://` 安全策略阻止：

```bash
python3 -m thumb_pack serve /tmp/tp/pack-core \
  --video /tmp/tp/numbered.mp4 \
  --port 8765
```

浏览器打开：

```text
http://127.0.0.1:8765/viewer.html
```

也可以直接双击打开 `/tmp/tp/pack-core/viewer.html`，再点击 **“选择原视频”**。视觉对照可用；若浏览器阻止本地图片像素读取，像素差异按钮会提示改用 serve。

网页功能：

- 快速拖动时间条：立即查 `manifest.json` 并从页图 `drawImage(...)` 取格，不依赖视频 seek 完成。
- 显示目标时间、查询区间、源帧号、原始/归零 PTS、真实帧覆盖区间、页名和 `x,y,w,h`。
- 同一时刻并排对照；可开启 **叠加对照** 和不透明度滑块。
- 可计算真实视频与包内 rect 的像素差异（编码/缩放会带来正常误差，取错帧时差异通常显著升高）。
- 时间轴刻度标记所有目标时间；黄色刻度表示同帧碰撞，绿色末端刻度是最后有效时刻。
- 每页独立检查加载状态和矩形边界。
- 某页被移走/改名：只把该页及该页格子标成 `PAGE_MISSING`，其他页继续可看。
- 格子坐标超出页图真实像素尺寸：提示具体 slot、超出右边/下边多少像素。
- 底部表格可点击任意行定位并切页。

---

## 7. 命令行验证

```bash
python3 -m thumb_pack verify /tmp/tp/pack-core \
  --video /tmp/tp/numbered.mp4
```

检查内容：

- `manifest.json` 是否可解析、schema 是否正确
- 页图是否存在、真实宽高是否等于清单
- 每个 `cellRect` / `rect` 是否符合固定网格
- rect 是否超出实际页图
- 格子是否重叠
- 时间轴任意位置（包括 `0`、`duration`）是否都能查到预览格
- 重新 probe 视频后，目标时间对应的帧指针是否一致
- 用 FFmpeg 按同一几何回取源帧，和页图 rect 做像素比较

输出完整 JSON 报告：

```bash
python3 -m thumb_pack verify pack --video video.mp4 --json
```

如果使用了隐藏的故障注入参数 `--force-bad-slot 13`，验证会报告 `TILE_MARKED_ERROR`；脚本中若只关心其他结构问题可加 `--allow-error-tiles`。

---

## 8. 布局、补边和留黑调整

### 网格与补边

```bash
python3 -m thumb_pack generate video.mp4 -o pack \
  --columns 6 \
  --rows-per-page 3 \
  --thumb-width 240 \
  --thumb-height 135 \
  --padding 10 \
  --border 2 \
  --gap 12 \
  --margin 24 \
  --label-height 14
```

几何层级：

- `rect`：真正给播放器/网页裁剪的视频像素矩形，尺寸为 `thumb-width × thumb-height`
- `cellRect`：包含 border、padding、标签和 `rect` 的完整格子
- 每页尺寸固定为：

```text
pageWidth  = 2*margin + columns*cellWidth  + (columns-1)*gap
pageHeight = 2*margin + rows*cellHeight   + (rows-1)*gap
```

最后一页即使只有一格，也使用同样大小的页图；已有格子仍在原来的列/行坐标，不会因后续图片缺失或解码失败而流式移位。未占用的固定格位只画虚线提示。

### 竖幅自适应

不显式传 `--thumb-width/height` 时，工具按源片显示方向选择：

- 横幅：长边 192，按显示宽高比算高度
- 竖幅：长边 192，按显示宽高比算宽度

旋转元数据为 ±90/270 时会交换显示宽高；FFmpeg 默认 autorotate，因此取出的画面和网页中的 Player 方向一致。

### 源片留黑 / 填充方式

`--fit` 控制目标框与源宽高比不一致时的策略：

- `contain`（默认）：完整保留源画面，不足处补 `--letterbox-color`
- `cover`：放大铺满目标框并裁掉溢出部分
- `stretch`：直接拉伸到目标尺寸

例如改成 cover：

```bash
python3 -m thumb_pack generate video.mp4 -o pack \
  --fit cover --thumb-width 160 --thumb-height 160
```

调整 contain 补边颜色：

```bash
python3 -m thumb_pack generate video.mp4 -o pack \
  --fit contain --letterbox-color '#202020'
```

如果黑边是源片像素中已经存在的 letterbox，而不是目标比例补边，可尝试：

```bash
python3 -m thumb_pack generate video.mp4 -o pack \
  --black-bars crop --crop-limit 24
```

工具会调用 `cropdetect` 选择最稳定、面积最大的裁剪区，并把 `sourceCrop` 写入清单，网页像素比对会使用同一裁剪区。

### JPEG 页图

默认 PNG，便于无损像素验证。也可以：

```bash
python3 -m thumb_pack generate video.mp4 -o pack \
  --format jpg --jpeg-quality 3
```

验证器会自动放宽 JPEG 压缩误差阈值。

---

## 9. 时间线和“最后有效时刻”的定义

FFprobe 常见时间可能带起始偏移，例如原始 PTS 从 `7.25s` 开始。清单采用：

```text
timelineTime = rawPtsTime - min(rawFramePtsTime)
```

因此第一帧始终在 `0s`，与 HTML5 `<video>.currentTime` 的从零时间线一致。

### 源帧选择

对目标时刻 `t`，选择：

```text
normalizedPts <= t + 1e-6 的最后一帧
```

这等于播放器通常的显示规则：

- 非末尾 PTS 边界 `t = nextFramePts`：取新进入的那一帧
- 两帧 PTS 之间：取前一帧
- VFR 时使用每帧真实 PTS，不假设固定 FPS

### 两种区间

每个 sample 同时记录：

1. `source.frameInterval`：该真实帧的显示覆盖区间 `[normalizedPts, nextNormalizedPts)`；最后一帧的右端延伸到视频时长并按末端规则处理。
2. `scrubInterval`：快速拖进度条时该格负责的查询区间。

对于排序后的目标时间 `t0 < t1 < ... < tn`：

- 第 0 格：`[0, t1)`
- 第 i 格：`[ti, t(i+1))`，非末端右端不包含
- 最后一格：`[tn, duration]`，**右端 `duration` 包含**

所以最后有效预览时刻明确为：

```json
"lastValidPreviewTime": "<manifest.timeline.duration>"
```

拖到最右端也会取最后一格，不会出现空指针。

---

## 10. 输出结构

```text
pack/
├── manifest.json
├── thumbnails.vtt
├── viewer.html
└── pages/
    ├── page_001.png
    ├── page_002.png
    └── page_003.png
```

`manifest.json` 关键结构：

```jsonc
{
  "schema": "thumb-pack@1",
  "timeline": {
    "startsAt": 0,
    "duration": 2.4,
    "lastValidPreviewTime": 2.4,
    "originRawPtsTime": 0.0,
    "lookupRule": "..."
  },
  "geometry": {
    "thumbWidth": 160,
    "thumbHeight": 90,
    "columns": 5,
    "rowsPerPage": 2,
    "capacityPerPage": 10,
    "pageWidth": 946,
    "pageHeight": 284
  },
  "pages": [
    {"index": 1, "file": "pages/page_001.png", "width": 946, "height": 284}
  ],
  "samples": [
    {
      "slot": 5,
      "requestedTime": 0.51,
      "pageIndex": 1,
      "pageFile": "pages/page_001.png",
      "rect": {"x": 25, "y": 169, "width": 160, "height": 90},
      "cellRect": {"x": 18, "y": 147, "width": 174, "height": 119},
      "scrubInterval": {"start": 0.51, "end": 0.57, "endExclusive": true},
      "source": {
        "frameIndex": 5,
        "rawPtsTime": 0.5,
        "normalizedPtsTime": 0.5,
        "frameInterval": {"start": 0.5, "end": 0.6}
      },
      "sameFrameSlots": [5, 6],
      "status": "ok"
    }
  ],
  "frameGroups": [
    {"frameIndex": 5, "slots": [5, 6], "requestedTimes": [0.51, 0.57], "count": 2}
  ],
  "savings": {
    "requestedTargets": 21,
    "slots": 21,
    "uniqueSourceFrames": 20,
    "pageCount": 3,
    "unpackedImageFiles": 21,
    "actualImageFiles": 3,
    "savedFileCount": 18
  }
}
```

`thumbnails.vtt` 使用标准 sprite 片段：

```webvtt
00:00:00.510 --> 00:00:00.570
pages/page_001.png#xywh=25,169,160,90
```

---

## 11. 故障注入：验证坏图不挤位

正常视频很少逐格解码失败，但可以主动注入坏格来检查 UI/布局：

```bash
python3 -m thumb_pack generate video.mp4 -o pack-bad \
  --times '0,0.2,0.4,0.6' \
  --columns 2 --rows-per-page 2 \
  --force-bad-slot 2
```

工具不会因为单格失败而中断，而是：

- 在该格固定 `rect` 内画 `BAD` 占位图
- manifest 中写 `"status": "error"` 和具体原因
- 后续格仍使用原来的固定坐标，不会向前补位

---

## 12. 项目文件

```text
thumb_pack/
├── __main__.py          # python -m thumb_pack
├── cli.py               # 命令行
├── probe.py             # FFprobe、时间归零、选帧
├── targets.py           # 时间清单/间隔/scrub 区间
├── ffmpegops.py         # crop/scale/pad/raw 抽帧
├── imagetools.py        # 无依赖 RGB/PNG/字体
├── packer.py            # 固定网格、页图、manifest/VTT/viewer
├── verifier.py          # 结构、指针、缺页、越界、像素验证
├── samplegen.py         # 带帧号 CFR/VFR/offset/竖幅样片
├── server.py            # 本地 loopback 服务和 Range
├── selftest.py          # 端到端本地验证
└── web/viewer.html      # 自包含核对台模板
tests/test_selftest.py
```

## 设计取舍

- **每个目标时间一个固定格**：即使两个目标命中同一源帧，也保留两个格并明确标黄，避免“格子消失导致指针对不上”。同时统计唯一帧数和重复格数。
- **不使用流式排版**：所有位置由 `slot / columns / rows` 数学计算，坏图只在自己的矩形内占位。
- **运行时零 Python 依赖**：PNG 用标准库 `zlib/struct` 编码；JPEG 交给 FFmpeg。
- **网页不依赖网络**：没有 CDN、前端包或外部字体，适合本地保密样片。
