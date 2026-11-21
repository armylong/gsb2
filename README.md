# 短音频片头片尾空白排查工具

本地排查"短音频导出后片头/片尾多出一段空白"的来源：是**有损编码器的帧补齐与前置延迟**，
还是**素材本身就带的原始静音**。纯 Python 标准库 + ffmpeg/ffprobe + PySide6，样例由程序自己生成。

## 它能回答什么

以一个 0.5 s、带片头/片尾定位脉冲的参考 WAV 为基准，编码成 AAC(m4a) 与 MP3 后实测：

| 问题 | 方法 |
|---|---|
| 多出来的空白是哪一段？ | ffprobe 包级侧数据 `skip_samples`（头）/ `discard_padding`（尾）+ 双模式解码样本计数，并用恒等式 `忽略标记帧数 − 头skip − 尾pad == 应用标记样本数` 闭环核对 |
| 编码补齐和原始静音各多少？ | 参考脉冲定位：忽略标记模式下脉冲前的样本 = 编码补齐 + 参考 WAV 固有静音，二者可分别量化 |
| 应用 / 忽略延迟标记差多少？ | ffmpeg 默认解码 vs `-flags2 +skip_manual` 原始帧解码，比较片头脉冲相对参考的偏差（样本数 + 毫秒） |
| 三类时长对不上？ | 同屏并列：源 PCM 实测时长、两种解码 PCM 实测时长、容器 `stream/format.duration` 声明时长，各自标注依据 |
| 证据不足怎么办？ | 只写进"无法确认事项"清单（如无参考 WAV、无延迟标记、时长字段缺失），**绝不拿样本数反推冒充封装声明，也不硬补结论** |

## 目录结构

```
audio_delay_inspector/
├── core.py        # 纯逻辑层: 样例生成 / ffprobe 取证 / 双模式解码 / 脉冲对齐 / 报告
├── gui.py         # PySide6 界面层 (QThread 后台跑 ffmpeg, 只展示 core 的事实)
├── __main__.py    # python -m audio_delay_inspector 启动 GUI
run_gui.py         # GUI 启动入口 (等价)
requirements.txt   # 仅 PySide6; 其余全部标准库
```

## 本地启动

前置：本机已装 ffmpeg（含 ffprobe；`brew install ffmpeg`）。

```bash
# 1. 建虚拟环境并装依赖
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. 启动图形界面 (二选一)
.venv/bin/python run_gui.py
.venv/bin/python -m audio_delay_inspector
```

界面操作：

1. 点 **「生成样例并分析 (AAC + MP3)」**，选一个输出目录 —— 程序自动生成参考 WAV、
   两种压缩文件，完成解码与分析；
2. 五个标签页分别看：时长对照、延迟标记与恒等式、脉冲对齐、空白分解、事实/无法确认清单；
3. 点 **「打开导出目录」** 查看 Markdown/JSON 报告和导出的解码 WAV；
4. 也可以 **「分析外部压缩音频…」**：参考 WAV 可取消选择，取消后按无参考模式运行，
   只报告可确认事实。

## 一条可运行的验证命令（无需界面，样例程序内生成）

```bash
.venv/bin/python -m audio_delay_inspector.core --selftest /tmp/adi-demo
```

实测输出（ffmpeg 9.0.2, 48 kHz 单声道）：

```
[selftest] sample.m4a: skip=1024 pad=576 applied=24000 ignored=25600 对齐偏差(应用)=+0
[selftest] sample.mp3: skip=1105 pad=239 applied=24000 ignored=25344 对齐偏差(应用)=+0
```

含义：0.5 s = 24000 样本的源音频，AAC 要补到 25 个 1024 样本帧（25600），MP3 要补到
22 个 1152 样本帧（25344）；头部跳过、尾部丢弃的样本数与容器标记逐一对上，
应用标记后脉冲与参考零偏差，忽略标记后脉冲整体后移一个头部延迟。
自检内含断言，恒等式不成立或对齐异常会直接报错退出。

分析外部文件（无参考，只报事实）：

```bash
.venv/bin/python -m audio_delay_inspector.core --input 某文件.mp3 --outdir /tmp/adi-out
# 有编码前参考 WAV 时追加: --reference 参考.wav
```

## 导出物（`exports/` 目录）

- `report.md` / `report.json`：带时间依据的对照报告，每个数字标注出处
  （ffprobe 字段、样本下标、恒等式），"可确认事实"与"无法确认事项"严格分节；
- `*.applied.decoded.wav` / `*.ignored.decoded.wav`：两种模式的完整解码音频；
- `*.head-clip.wav`：片头脉冲前 20 ms 起、长 60 ms 的定位切片，直接对比头部空白差异。

## 判定口径（报告中同步写明）

- 脉冲命中：`|样本| >= 6553`（16-bit 满幅 32767 的 20%）；静音：`|样本| < 1638`（5%）；
- 解码统一重采样到 48 kHz 单声道 s16，样本计数可直接比较；
- 延迟标记取自 ffprobe **包级** `Skip Samples` 侧数据（首包头、末包尾），
  流级 `initial_padding` 仅作旁证；
- "忽略延迟标记"使用解码器开关 `-flags2 +skip_manual`：不丢弃样本、保留完整原始帧，
  比仅对 MP4 生效的 `-ignore_editlist` 更通用（AAC/MP3 均适用）。
