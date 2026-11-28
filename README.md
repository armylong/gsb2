# CueCut — 连续母带切听与分轨

本地 PySide6 小工具，处理「一个长 wav + 一张单文件 cue」的连续曲目母带：

- 先试听正式起点（INDEX 01）前那一小截前导（INDEX 00）怎么分，
- 再用两种拆法之一真正写出分轨 wav，
- 导出后重新读开文件核对头尾采样，
- 内置演示卷生成器，用来端到端验证「拆开后按区间接回原音、不漏读不重读」。

## 安装与运行

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m cuecut            # 或 .venv/bin/python -m cuecut.gui
```

macOS 上首次播放若没有声音，检查系统「声音输出」；试听走 PortAudio（sounddevice），
若该库缺失，界面仍可用（播放游标按时钟前进，仅静音）。

可选：把一对文件直接喂给程序

```bash
.venv/bin/python -m cuecut path/to/master.wav path/to/master.cue
```

## 功能对照

| 要求 | 实现 |
| --- | --- |
| 读 44.1 kHz 连续 wav + 单文件 cue；每轨 INDEX 01 + 可选 INDEX 00 | `cuecut/cue.py`，按行号报告错误，支持 UTF-8/GB18030，`MM:SS:FF`（75 fps）精确转 `Fraction` 秒 |
| 顺序错 / 指到文件外指出具体位置 | `validate_against_audio()`：`point_outside_file` 报该轨号与 cue 行号；`time_out_of_order` 同时给出上一轨行号；`lead_overlaps_previous`、`duplicate_start` 等；左侧「分轨表校验」点条目可跳到对应轨 |
| 同一根时间尺显示分轨表时间 / 采样位置 / 当前轨内时间 | `gui/widgets.py: SharedRuler + HeaderReadout + WaveformView`，三者共用同一 `[view_first, view_last]` 几何；轨内时间相对 INDEX 01，前导内为负值并单独标红 |
| 前导归属状态，从普通位置拖过去归属要对上 | `plan.py: member_track_index / in_track_offset / is_in_lead`；归属与拆法无关，只决定写入哪个文件；拖动/点击任意采样，状态胶囊与提示文本立即更新 |
| 两种拆法：前导归前一轨末尾 / 归当前轨开头 | `SplitMode.TAIL` / `SplitMode.HEAD`；`build_plan()` 生成互不重叠、完整覆盖整卷的段 |
| 整卷最前面的前导可单独保存 | `head_lead_separate`，输出 `00 - 整卷前导.wav` |
| 界面显示各段究竟写入哪个文件 | 「拆分与导出」表格逐段列出首/末采样、采样数、目标文件名、区间时间；交界面板同时列出两种拆法各自改动的文件名边界 |
| 对一个交界播放前后几秒；切拆法时原始声音不跳到另一个时间 | `PreviewPlayer` 只读**源**文件固定区间；`set_mode()` 只记录模式、绝不 seek 或换缓冲；GUI 测试 `test_mode_switch_keeps_audition_on_same_source_region` 断言 |
| 出口能重新读开 wav 检查头尾采样 | 导出时默认逐文件全量回读核对；「重新读开已导出文件核头尾」按钮独立调用 `verify_exported_head_tail()`，分别核对首/末采样并给出文件值与源值 |
| 程序生成演示卷（已知点声 + 跨边界持续音），检查拆开后按区间接回原音、无漏读/重读 | `cuecut/demo.py` 生成 130 s 24-bit 母带：每轨 INDEX 00/01 起点有不同频率短音，另有跨每个交界持续 ~14 s 的正弦音；`cuecut/selftest.py` 对 4 种组合（两种拆法 × 整卷前导分开/合并）逐文件回读 + 整卷拼接逐采样比对 |

## 演示卷自检

```bash
.venv/bin/python -m cuecut.selftest /tmp/cuecut-demo
```

输出 4 种组合下的分轨文件，并对每个文件重新读开，和源文件对应区间逐采样比较；
再把全部文件按段序拼回整卷，与源文件逐采样比较。任何漏读、重读、头尾错位都会报出具体采样号。
退出码 0 表示全部通过。

界面里也有「生成演示卷」和菜单「用演示卷自检拆分与回读」。

## 时间尺约定

- 分轨表时间：cue 的 `MM:SS:FF`（75 fps），**向下取整到帧**显示。
- 采样位置：整数采样号，`sample = floor(seconds * 44100)`。
- 轨内时间：`采样 - 该轨 INDEX 01 采样`，用 `±MM:SS.mmm`；处在 INDEX 00 前导内为负。
- 拆法只在「哪个文件接收这段采样」上有区别，**不改任何时间值**。

## 两种拆法的边界

以第 N 轨（N≥2）有 INDEX 00 为例（`L` = INDEX 00，`S` = INDEX 01）：

- **归前轨末尾**：第 N-1 轨文件 `[..., S-1]`，第 N 轨文件 `[S, ...]`。
- **归本轨开头**：第 N-1 轨文件 `[..., L-1]`，第 N 轨文件 `[L, ...]`。

第 1 轨没有上一轨，其前导（若有 INDEX 00）在两种拆法里都进 T01 文件。
整卷最前面的前导（`[0, INDEX00/01 of T01)`）若选「单独保存」，写成 `00 - 整卷前导.wav`；
否则并入 T01 文件开头。

## 错误码（可在 `cuecut/cue.py` 搜到）

`missing_index01`、`lead_after_start`、`bad_time`、`bad_track`、`bad_track_number`、
`bad_track_type`、`duplicate_index00/01`、`orphan_index`、`unknown_directive`、
`multiple_files`、`missing_file`、`point_outside_file`、`time_out_of_order`、
`duplicate_start`、`lead_overlaps_previous`。

## 测试

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests -q
```
