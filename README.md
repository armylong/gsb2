# 口述录音离线切分标记工具

面向口述录音整理的桌面小工具：在本地把一段 WAV 切成连续的说话段，人工校对后导出
样本级精确的切分清单和片段文件。全程离线，不上传、不联网、不依赖云端模型。

- 界面：PySide6（Qt 6）
- 音频分析：纯标准库（`wave` + `array`），支持 8/16/24/32 bit PCM WAV
- 导出：CSV + JSON 清单 + 每段一个 WAV，边界精确到样本（sample frame）

## 功能与需求对应

| 需求 | 实现 |
| --- | --- |
| 导入短 WAV，选定分析窗和开闭门限 | 「音频」打开/生成样例；「分析参数」可调分析窗、窗移、开启/关闭门限（dBFS 迟滞） |
| 短停顿保留在同一段，首尾按余量延伸 | `最短停顿切段` 以下不切；`段首余量`/`段尾余量` 自动外扩，贴边自动夹紧 |
| 边界冲突合并或截断，整体不重叠不越界 | 外扩后重叠可选 `merge`（合并）或 `truncate`（重叠中点截断）；所有结果统一断言 `0 <= start < end <= 总帧数` 且互不重叠 |
| 人工挪动后重分析可保留指定段 | 任何人工编辑都会把该段标为「锁定」；`重新分析时保留锁定段` 勾选后，锁定段原样保留，自动结果绕开它们 |
| 逐段试听与原始时间对应，导出样本精度清单和文件 | 试听只播放选中段的 PCM，但播放头显示原始时间轴位置；导出 CSV/manifest 给出 `start_sample`/`end_sample` 与秒数，WAV 按原始 PCM 字节精确切片 |

## 本地启动

需要 Python 3.10+（在 3.12 上验证）。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 启动后点「生成样例」→「重新分析」
.venv/bin/python -m oral_segmenter

# 或直接带着合成样例启动
.venv/bin/python -m oral_segmenter --demo
```

Windows 上把 `.venv/bin/python` 换成 `.venv\Scripts\python.exe` 即可。

也可以打开现有文件：

```bash
.venv/bin/python -m oral_segmenter /path/to/recording.wav
```

> WAV 需为未压缩 PCM。如果是其他格式，先转一下：
> `ffmpeg -i input.m4a -ac 1 -ar 16000 -c:a pcm_s16le output.wav`

## 验证命令

无界面、无需声卡，一条命令跑完整链路（生成样例 → 分析 → 人工编辑锁定 → 重分析 →
导出 → 逐段比对 PCM 字节）：

```bash
.venv/bin/python verify.py
```

成功时最后一行输出 `VERIFY OK`。它检查：

- 默认参数下样例切成 3 段，90/120 ms 组内短停顿没有被切开，首尾余量贴边夹紧；
- 把停顿门限降到 80 ms 后短停顿会被切开，说明门限确实生效；
- `merge` 与 `truncate` 两种冲突策略的结果都保持不重叠、不越界；
- 人工移动/缩短后的段被锁定，换参数重分析时该段边界原样保留，且结果仍不重叠不越界；
- 取消「保留锁定段」后，该段被重算结果替代；
- 空列表、重叠段、越界段导出都会被拒绝，且不留下半套目录；
- 导出的每个 WAV 帧数等于 `end_sample - start_sample`，且 PCM 字节与原始文件对应区间完全一致；
- CSV 行数、manifest 段数、总样本数三者一致。

界面本身也可用无头模式冒烟：

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python -m oral_segmenter --demo --smoke-test
```

## 使用流程

1. **载入音频**：打开 WAV，或点「生成样例」载入 4.06 秒的合成口述录音（5 个语音爆发，
   含 90/120 ms 组内短停顿和 500/700 ms 组间静音）。
2. **调参分析**：设置分析窗/窗移、开启/关闭门限、最短停顿、最短语音段、首尾余量和重叠
   策略，点「重新分析」（`Ctrl+R`）。
3. **人工校对**：
   - 波形区：拖动段块整体平移；拖两端改边界；在空白处按住拖拽新建段；单击空白定位播放头；
   - 也可以直接改「人工校对」里的起点/终点样本，或在表格里选中段；
   - 删除选段（焦点在波形区或表格时按 `Delete`），切换锁定，全部解锁；
     焦点在波形区/表格时 `Cmd/Ctrl+Z` 撤销；
   - 拖拽被相邻段或文件边界挡住时，会在允许范围内夹紧，不会产生重叠。
4. **逐段试听**：选中段后点「播放选中段」（`Ctrl+P`；焦点在波形区时也可按空格）。
   播放从播放头开始（若播放头在选中段内），界面上的红色播放头始终显示**原始时间轴**
   样本位置；可勾选循环。
5. **导出**（`Ctrl+E`）：选择目录后生成 `<源文件名>_segments/`，内含
   `segments.csv`、`manifest.json` 和 `<源文件名>_0001.wav` 等片段。

## 参数说明

| 参数 | 含义 |
| --- | --- |
| 分析窗 / 窗移 | 计算 RMS 电平的窗长与步进（ms）；窗移应不大于窗长 |
| 开启门限 / 关闭门限 | 迟滞门限（dBFS）。电平升过开启门限进入语音，降到关闭门限以下进入静音；开启必须高于关闭 |
| 最短停顿切段 | 静音持续达到该时长才切段；更短的停顿留在同一段 |
| 最短语音段 | 自动检测出的原始语音段短于该值时丢弃。人工编辑不受此限制 |
| 段首/段尾余量 | 每段向前/向后外扩的时长，贴到 0 或文件末尾时自动夹紧 |
| 边界冲突 | `merge` 把外扩后重叠的相邻段合并；`truncate` 在重叠区中点截断 |
| 重新分析时保留锁定段 | 勾选后，所有人工编辑过的段原样保留，自动结果从其两侧裁开 |

## 导出格式

`segments.csv`（UTF-8 with BOM，Excel 可直接打开）：

| 列 | 说明 |
| --- | --- |
| `index` | 从 1 开始的段号 |
| `file` | 对应 WAV 文件名 |
| `start_sample` / `end_sample` | 半开区间 `[start, end)`，单位是 sample frame |
| `start_seconds` / `end_seconds` | 与样本一一对应的秒数（9 位小数） |
| `duration_samples` / `duration_seconds` | 段长 |
| `pinned` | 是否人工锁定 |
| `adjusted` | 边界是否被人工改过或受约束夹紧 |
| `origin` | `auto` / `manual` / `pinned` / `merged` / `auto-trimmed` |

`manifest.json` 另外记录源文件参数、分析参数和时间单位约定（`sample_unit: frame`，
`boundary_semantics: [start, end)`）。

## 代码结构

```
oral_segmenter/
  audio.py          WAV 读取、PCM 解码、按帧切片
  segmentation.py   包络计算、迟滞检测、余量扩展、冲突消解、锁定段保留
  editing.py        人工平移/改边界/新建/删除的约束逻辑（纯函数）
  export.py         CSV/manifest/WAV 导出与回读校验
  player.py         QAudioSink 逐段试听与格式转换
  demo.py           合成样例生成
  ui/waveform.py    波形与段标记画布
  ui/main_window.py 主窗口
verify.py           端到端自检
```

## 已知边界

- 只接受未压缩 PCM WAV；压缩 WAV、MP3、M4A 等需先转码。
- 立体声导出保留原声道；分析和试听使用下混后的单声道。
- 重采样只在声卡不支持源格式时发生（用于试听）；导出的片段永远不重采样。
