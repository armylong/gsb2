# 本地双视频同步对比播放器

两个机位拍到同一个动作时，手动调整 B 片相对 A 片的**时间偏移**，并排或叠合逐帧核对。
纯本地运行，基于 Python + PySide6 + ffmpeg，**不做任何音频自动对齐、动作识别或自动匹配**。

## 时间约定（全项目统一，最重要）

- **主时间 `t`**：以 A 片自身内容时间为基准的唯一时钟。
- **B 片内容时间 = 主时间 + 偏移**，即 `t_b = t + offset`，偏移可正可负。
  - 偏移为负：B 的内容比 A 晚开始（要让 B 的第 N 秒对上 A，得往回拨）。
- **选帧规则（floor）**：对请求时间 `r`，选择满足 `pts ≤ r` 的最后一帧，
  即“不晚于请求时间的最近帧”。因此选帧滞后恒在 `[0, 一个帧间隔)` 内。
- 两个画面共用同一个主时钟，每次刷新都按同一个 `t` 重新选帧，
  **不存在两个各自计时的播放器，不会产生持续漂移**。
- 内容区间按半开 `[0, duration)` 处理：请求到达 `duration` 即判定结束，
  显示“无画面”及原因，**不停在末帧伪装同步**。

## 功能对照

| 需求 | 实现位置与行为 |
| --- | --- |
| 两段 ≤15s、≤720p、不同帧率/时长的 mp4 | 打开时 `ffprobe` 探测并校验（超限仅警告）；显示各自帧数、时长、标称/实测帧率 |
| 显示实际帧时间与时长，保持比例 | `timings.VideoInfo.pts` 帧表 + `VideoView` 等比缩放；不要求两边帧号相同 |
| 手动/逐帧调偏移、支持负值 | 偏移输入框 + `±1帧(B)`（按 B 实测帧间隔）+ 归零；信息行实时显示两边请求时间与实际选中帧时间 |
| 共用播放/暂停/定位/A 帧步进 | `PlayerEngine` 单一主时钟驱动；步进按 A 帧间隔，B 跟随 |
| B 落在两帧之间取不晚于请求的最近帧 | `timings.choose_frame` 的 floor 规则，单测覆盖 |
| 越界显示无画面及原因 | `before/after/no-frames` 三态原因文案，画面与叠合区同时提示 |
| 标明重叠区间、仅循环该区间 | `overlap_interval` 计算主时间轴交集；无正长度重叠时禁止启动循环但仍可调偏移 |
| 并排 + 可拖动分隔线叠合 | `VideoView` / `OverlayView`，两视图共用同一位置与偏移；叠合按 A 宽高比对齐像素 |
| 声音只听 A / B / 静音 | 全局唯一 `QAudioSink`，pull 设备按主时钟即时取数；B 声音带同一偏移；切换/暂停/定位即 flush，无残留 |
| 保存/重载偏移，文件失效提示重选 | 按文件对哈希存到 `~/.syncplayer/offset_<hash>.json`，记录 size/mtime 身份；身份不符拒绝应用，绝不替换成别的文件 |
| 自生成不同帧率样例 | `tools/make_samples.py`：同运动事件 + 画内时码，A 30fps、B 24fps 且 B 晚 0.5s 起步 |

## 目录结构

```
src/syncplayer/
  timings.py      纯时间数学：帧表、floor 选帧、重叠区间（无 Qt 依赖，可独立单测）
  media.py        ffprobe 探测 + 长驻 ffmpeg rawvideo 逐帧解码（线程化、LRU、seek 重启）+ 整段音频解码
  audio.py        单路 QAudioSink + 按主时钟拉数据的虚拟设备
  player.py       主时钟引擎、循环折回、偏移设置的保存/载入与身份校验
  widgets.py      等比画面视图、无画面占位、可拖动分隔线叠合视图
  main_window.py  主窗口，把以上部件接成完整交互
  app.py          命令行入口
tools/make_samples.py  样例生成器（numpy 造帧 → rawvideo 管道 → ffmpeg 编码）
tests/            纯函数单测 + 真实 ffmpeg 集成测试 + 无头 UI 冒烟
```

## macOS 启动

前置：`brew install ffmpeg`（Python 3.10+）。

```bash
# 方式一：双击或命令行运行，首次自动建 .venv 并装依赖
./run.command                      # 启动后在界面选 A、B
./run.command path/a.mp4 path/b.mp4

# 方式二：手动
python3 -m venv .venv
./.venv/bin/pip install -r requirements.txt
./.venv/bin/python -m syncplayer path/a.mp4 path/b.mp4

# 一键演示：生成样例 + 跑测试 + 直接载入样例启动
./demo.command
```

## 生成样例并核对

```bash
./.venv/bin/python -m tools.make_samples --out samples
```

产出 `samples/sample_a.mp4`（30fps，场景时间从 0 起）与
`samples/sample_b.mp4`（24fps，场景时间从 **+0.500s** 起），两路都带正弦音频。
画面烧录 `EVENT=...s` 时码、帧号和一个做周期运动的黄色方块。

**标准答案：把 B 偏移调到 `-0.5000s`**（由 `t_b = t + offset`，B 晚 0.5s 起步推出）。
此时两边方块同位姿、画内 EVENT 时码一致，而帧号不同（帧率不同，属正常）。

手动核对流程：
1. `./run.command samples/sample_a.mp4 samples/sample_b.mp4`
2. 偏移框输入 `-0.5`，或用 `−1帧(B)` 逐步逼近（一步 = 1/24 秒）。
3. 用 `±1帧(A)` 逐帧步进，观察信息行“请求时间 vs 实际选中帧时间”，
   两侧滞后都应小于各自一个帧间隔（A<33.3ms，B<41.7ms）。
4. 把主时间拖到重叠区外，B（或 A）画面变为“无画面 + 原因”。
5. 切到“叠合”，拖动黄色分隔线左右揭片，比较方块边缘是否重合。
6. 勾“仅循环重叠区”，播放会在重叠区间内无缝循环；先把偏移调到完全无重叠，
   复选框会被拒绝并提示。
7. 声音在 A/B/静音间切换，确认只有一路出声，暂停后无残余声音。

## 关键验证（证据来自实际解码帧与时钟，不是两个进度条数字）

```bash
./.venv/bin/pip install -r requirements-dev.txt   # pytest
QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/ -q
QT_QPA_PLATFORM=offscreen .venv/bin/python tests/smoke_app.py
```

- `tests/test_timings.py`：floor 选帧边界、负/正偏移的重叠区间、无重叠返回 None、
  循环半开折回、越界不夹取末帧。
- `tests/test_media_integration.py`：用真实 ffmpeg 样例验证
  探测帧数/帧率与生成参数一致；**偏移 −0.5 时实际选中帧烧录的事件时码逐点一致
  （误差 ≤ 各自一个帧间隔）**；重叠边界外 B 明确无画面；解码线程实际吐出的帧
  尺寸/顺序与帧表对应；设置往返与文件身份守卫；音频缓冲覆盖全长。
- `tests/smoke_app.py`：无头驱动真实主窗口，验证偏移、共用步进、循环守卫、
  越界占位、视图共用状态、音频单路切换与偏移跟随、重开还原。
- 另有一次人工像素级检查（开发时执行）：正确偏移下两路实际解码帧中黄色方块
  质心相差约 1px；偏移归零后相差上百像素，反证核对方法确实能区分对错。

## 设计取舍与边界

- 解码走长驻 `ffmpeg -f rawvideo` 进程顺序读帧，向后跳用输入 seek 重启进程，
  配合 90 帧 LRU；对 ≤15s、≤720p 的片段足够流畅，且时间判定只信 ffprobe 帧表。
- 叠合视图按 A 的宽高比把两路缩放至同一矩形以保证像素对齐；若两路宽高比不同，
  B 会有轻微形变（并排视图始终保持各自原始比例，不受影响）。
- 音频整段解码为 48kHz 立体声 f32（15s 数据量很小），由主时钟决定播哪一段，
  从架构上保证任意时刻最多一路出声。
- 不导出合成视频、不做多机位剪辑、不做任何自动分析。
