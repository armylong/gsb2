# 短片字幕避让窗口

用 Python + PySide6 + FFmpeg 做的本地字幕避让小工具：打开短片和 SRT 后，可以在原视频坐标系里标出带起止时间的禁放矩形；程序按字幕真实折行后的字框选择上方/下方候选位，优先沿用上一条的安全位置，并支持冲突标记、逐变化点检查、人工指定和位置一致的 MP4 导出。

## 安装

需要本机已有 `ffmpeg` / `ffprobe`，并使用 Python 3.11+：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

macOS 可直接用 Homebrew 安装 FFmpeg：`brew install ffmpeg`。也可以通过 `FFMPEG_BIN`、`FFPROBE_BIN` 环境变量指定可执行文件。

## 启动界面

```bash
.venv/bin/python -m subtitle_avoidance
```

典型流程：

1. 点“打开视频”和“打开 SRT”。
2. 在“禁放矩形”页保持“拖拽绘制/移动禁放矩形”，直接在画面上拖出角板或滑入图区域。
3. 在右侧表单里把矩形的开始、结束时间改准确；坐标始终保存为原视频像素坐标，缩放预览窗口只改变显示映射。
4. 在“字幕与增量结果”页选择字幕、修改文本，点“应用修改并增量重排”。状态栏会显示重算了几条、实际改变了哪几条。
5. 用传输栏的“上一变化点 / 下一变化点”或下拉框，在字幕起止、禁放区起止导致的候选安全集变化时刻之间步进；勾选“显示当前时刻候选框”可查看绿色/红色候选位。
6. 如果某条字幕的所有候选位都与它整个显示区间内出现过的禁区相碰，“冲突与步进”页会出现红色记录和标记时间。点该记录会切到人工模式，直接拖动画面里的字幕框即可指定位置；双击字幕框可清除人工位置。
7. 点“导出带字成片”。导出前仍有未处理冲突时会停止并提示；人工位置即使仍有碰撞提示也会尊重你的决定导出。

工程可保存为 JSON，里面包含禁放矩形、人工位置、修改后的字幕和视频信息。导出时还会在 MP4 旁边写一份当前字幕 SRT。

## 内置短片端到端自检

仓库提供了一个不依赖外部素材的课程短片生成器。脚本会用 PySide6 绘制 12 秒 1280×720 的示例画面（固定角板、中途滑入图片、临时上下题板），再用 FFmpeg 编码成 MP4 和 SRT，随后自动完成标区、冲突复现、人工指定、预览截图、成片导出和抽帧时间校验：

```bash
.venv/bin/python -m subtitle_avoidance.demo --out examples/demo
```

只想运行全部自动化检查：

```bash
./scripts/self_check.sh
```

常用产物：

- `examples/demo/builtin_lesson.mp4` / `.srt`：内置短片和字幕
- `examples/demo/demo_project.json`：标区与人工位置工程
- `examples/demo/preview_*_widget.png`：PySide6 预览控件截图
- `examples/demo/preview_*_source_coords.png`：源视频坐标系预览
- `examples/demo/subtitled_demo.mp4`：带字成片
- `examples/demo/e2e_report.json`：每个字幕的位置、变化点、抽帧差异等验证结果

加 `--show` 会显示窗口；默认自动化运行使用 `QT_QPA_PLATFORM=offscreen`。

## 实现要点

- `model.py`：`Rect`、`Cue`、`Obstacle`、`Placement`、`Project` 等状态和 JSON 持久化。
- `srt.py`：SRT 时间码解析/序列化。
- `coordinates.py`：保持宽高比的预览矩形，以及控件坐标和原视频坐标互转。
- `layout.py`：用 `QTextLayout` / `QFontMetricsF` 按真实字体宽度和中英混排规则折行；预览和导出共用 `render_subtitle()`。
- `planner.py`：
  - 上、下各三个候选位置；
  - 一条字幕只得到一个静态位置，不会在播放中来回跳；
  - 检查字幕整个 `[start, end)` 时间窗内所有曾活跃的禁放区，因此禁区在句子中途开始或消失也不会漏检；
  - 优先使用上一条的安全槽位；
  - `PlacementStore.cue_text_edited()` 从被改字幕向后传播，遇到输出结果与旧结果完全一致的字幕即停止。
- `video_view.py`：`QMediaPlayer` + `QVideoSink` 预览、坐标映射、拖矩形、移动禁区、拖字幕人工定位。
- `exporter.py`：把每条字幕用同一个布局/绘制器渲染成透明 PNG，再由 FFmpeg overlay 按 SRT 时间区间叠加。
- `sample_video.py` / `demo.py`：内置素材和端到端验证。

## 一致性说明

预览和导出没有各自实现一套换行：两者都调用 `LayoutEngine.layout()` 得到相同的行数、行宽、内边距和整数源坐标字框，并调用 `render_subtitle()` 绘制。预览窗口缩放时先计算等比目标矩形，再把源坐标系整体 scale 到控件；导出则直接在 1280×720（或实际视频分辨率）的透明画布上使用同一组坐标。字幕显示区间统一按半开区间 `[start, end)` 生成 FFmpeg 表达式 `gte(t,start)*lt(t,end)`。
