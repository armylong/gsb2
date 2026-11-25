# MKV 声轨 / 字幕检查编辑器

一个本地 PySide6 + FFmpeg 小工具，用来检查发行样片 MKV 里到底有哪些音轨和字幕、语言/标题是什么、`default` / `forced` 标记如何，并把修改后的标记和流顺序真正写进新 MKV。

> 所有处理都在本机进行。导出使用 `-c copy`，不重新编码所选音视频和字幕。

## 1. 安装与启动

需要本机有：

- Python 3.10+
- FFmpeg / FFprobe（命令行可执行）

macOS 安装 FFmpeg：

```bash
brew install ffmpeg
```

创建虚拟环境并启动：

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python -m mkv_tool
# 或直接打开某个文件
python -m mkv_tool path/to/release.mkv
```

也可以直接运行：

```bash
./run.sh path/to/release.mkv
```

## 2. 先生成多轨样片

一条命令生成包含 1 条视频、2 条同音语言但频率不同的音轨、4 条字幕的 MKV：

```bash
python -m mkv_tool sample --all --out samples
```

会得到：

- `samples/multitrack.mkv`
  - 源 `#1`：英语，440 Hz 正弦音，默认音轨
  - 源 `#2`：英语，880 Hz 正弦音
  - 源 `#3`：英语强制 Signs，`default + forced`
  - 源 `#4`：英语完整字幕（与 #3 同语言，靠原始索引区分）
  - 源 `#5`：中文字幕
  - 源 `#6`：无语言标记字幕
- `samples/multitrack.offsets.mkv`
  - 440 Hz 轨相对视频约 `+0.350 s`
  - 880 Hz 轨相对视频约 `-0.150 s`

只生成普通样片：

```bash
python -m mkv_tool sample --out samples/multitrack.mkv
```

只生成偏移样片：

```bash
python -m mkv_tool sample --offset-demo --out samples/multitrack.offsets.mkv
```

### 映射自检

下面的命令会生成样片、移除第一条音轨、导出、重新探测输出，并用频率分析确认剩下的是约 880 Hz 的第二条音轨，而不是字幕或其他流：

```bash
python -m mkv_tool selfcheck
```

最近一次自检结果：

```text
输出 #1 种类：audio/aac
保留音轨主频：879.9 Hz（预期约 880 Hz）
自检通过：移除 #1 后保留的是源 #2/880 Hz 音轨，没有错拿字幕。
```

## 3. 窗口里能做什么

### 流列表

打开 MKV 后，表格显示：

- 是否保留 / 导出后的输出序号
- FFprobe 原始流索引
- 种类和编码
- 语言（可编辑）
- 标题（可编辑）
- 源文件里的 `D`（default）和 `F`（forced）标记
- 导出用的默认 / 强制状态
- 相对主视频的时间偏移

两条相同语言、相同标题甚至没有语言标注的流，都会始终带着原始索引，不会被合并或认错。

### 试听和字幕预览

- 选中一条音频，点“试听选中音轨”：工具会只把该原始索引对应的音轨提取成临时 WAV 并播放。
- 选中一条文本字幕（SubRip/SRT、ASS/SSA、WebVTT 等常见文本格式），输入时刻（秒，支持 3 位小数），点“查看该时刻文本”。
- 切换表格选择只会改变预览内容，不会把语言、标题、默认、强制或顺序改回源文件状态。编辑状态保存在独立的 `TrackEditSession` 中。

### 编辑流

- “移除选中轨”：把该音轨/字幕标记为不导出；行仍保留并变灰，可用“恢复保留”撤销。
- “上移 / 下移”：在同类流中调整顺序。
- 语言单元格是可编辑下拉框，可直接输入语言代码；留空表示显式清除语言标记。
- 标题直接在表格中编辑；清空标题会显式写入空值以删除旧标题。
- “导出默认”在同类音轨或同类字幕中互斥；也可以全部取消，表示该类不写默认轨。
- “强制”是每条字幕自己的独立复选框，可与默认项落在不同字幕上。

右下方面板会实时列出预期输出顺序和标记，例如：

```text
#4  <- 源#4 subtitle/subrip lang=eng D=1 F=0 ...
音频默认项：源#2 ...
字幕默认项：源#4 ...
强制字幕：源#3, 源#5
```

这样可以在导出前核对“默认字幕”和“强制字幕”的播放器预期。

### 支持范围

当前明确面向：

- 恰好一个主视频流（封面图不计入主视频）
- 任意多条音频
- 常见文本字幕：`subrip`、`ass`、`ssa`、`webvtt`、`mov_text` 等

位图字幕（PGS/DVB/DVD）、数据流、附件或多个主视频会被标为超出范围。默认阻止导出；如果确认丢弃这些流，需要勾选窗口中的确认项。

## 4. 导出、写入和复核

点“导出新 MKV 并复核…”选择新文件。工具会：

1. 再次确认源文件仍在原路径且可读。
2. 为每个待保留流计算编码包哈希，锁定“源索引 → 输出位置”的映射。
3. 生成显式 `-map 0:<原始索引>` 列表，按表格顺序映射。
4. 使用 `-c copy` 保留原编码。
5. 为每个输出流显式写入语言、标题和 disposition：
   - 音频默认项
   - 字幕默认项
   - 字幕强制项
   - 其他源 disposition 尽量保留
6. 先写到同目录临时 `.tmp.mkv`。
7. FFmpeg 成功后重新 `ffprobe` 临时文件，按**实际输出流顺序**核对：
   - 流数量和每个位置的源映射
   - `codec_type` / `codec_name`
   - 语言和标题
   - `default` / `forced`
   - 相对时间偏移
   - 编码包哈希
8. 核对通过后原子替换到目标路径。
9. 再重新打开最终发布路径复核一次。

如果源文件已被移走、FFmpeg 封装失败、缺少预期目标流、标记/内容/时间核对失败，工具会删除临时文件或未通过复核的输出并报错；不会把它提示为成功成品。已经存在的旧目标文件只会在新临时文件全部核对通过后被替换。

成功对话框可以：

- 在当前窗口重新打开最终输出；
- 用系统播放器打开，人工切换音轨/字幕确认；
- 在 Finder / 文件管理器中定位文件。

## 5. 命令行查看流

不打开窗口也可以快速列出：

```bash
python -m mkv_tool inspect samples/multitrack.mkv
```

## 6. 测试

```bash
pip install pytest
pytest -q
```

测试覆盖：

- 重复语言和无语言标注流的区分
- 指定时刻字幕文本
- 移除第一条音轨后，输出 #1 仍是 AAC 音频且主频约 880 Hz
- 重排、语言、标题、默认和强制标记写入后重新探测
- 正负相对偏移导出后仍可判断谁早谁晚
- 源文件消失时不生成成功输出
- FFmpeg 封装失败时清理临时文件
- 复核器能发现缺失目标
- PySide6 中切换选择不会重置已编辑标题/语言/默认项

## 7. 主要文件

```text
mkv_tool/media.py         ffprobe 数据模型、语言/标题/标记/时间偏移
mkv_tool/edits.py         与 Qt 无关的编辑状态和导出计划
mkv_tool/subtitles.py     字幕提取、SRT 解析、时刻查询
mkv_tool/audio.py         WAV 提取和样片频率分析
mkv_tool/content.py       FFmpeg streamhash 内容映射校验
mkv_tool/exporter.py      FFmpeg 命令、临时文件、原子发布
mkv_tool/verification.py 重新探测输出并按实际顺序核对
mkv_tool/sample.py        多轨/偏移样片生成命令
mkv_tool/selftest.py      “移除第一条后仍是 880 Hz 音轨”的自检命令
mkv_tool/gui.py           PySide6 窗口
tests/                    核心集成测试和 offscreen GUI 测试
```

## 备注

- 不同播放器对 `default`、`forced` 和偏好语言的选择策略不完全相同，但本工具写入的是 MKV/FFmpeg 标准流标记；用 FFprobe、MKVToolNix 或另一个播放器重新打开都应能看到这些位。
- 时间偏移显示为相对主视频或最早流的差值，因此 FFmpeg/封装器统一平移零点不会影响“谁比谁早、早多少”的核对。
