# 本地代理核对工具 (proxy_check)

剪辑前生成低分辨率代理素材时，用这个工具确认代理**没有少帧、错位，或指向另一份原片**。
工具只处理**一对短视频**（一个原片 + 一个代理），不实现剪辑工程或素材库。

技术栈：Python + PySide6（界面）+ ffmpeg/ffprobe（解码、转码、取真实帧/PTS）+ numpy + Pillow。

---

## 1. 它核对什么、不核对什么

| 维度 | 处理方式 |
| --- | --- |
| 关联（是不是这一份原片的代理） | 用**文件 sha256 + 画面内容指纹**双重判断，写在 `*.sidecar.json`；**绝不靠文件名相同**判定同一原片 |
| 实际帧数 | 以 ffprobe 视频 **packet 计数**为准（排序到呈现顺序），不信容器元数据里可能为 -1 的 `nb_frames` |
| 时间戳间隔 | 检查两边是否同为恒定帧率（CFR）、帧率一致、PTS 间隔无抖动 |
| 首尾覆盖 | 比较首帧 PTS 与末帧结束时间，偏差超过一个源帧即 FAIL |
| 音画长度 | 音轨有无、音轨长度差、代理自身音画长度差，AAC 编码填充给常规容差 |
| 画面内容 | 全片统一缩到 32×18 灰度网格，在 9 个分布全片（含首尾）的检查点算 MAE，并做整段错位搜索 |
| 分辨率 / 压缩 | **属于预期差异**，只记为 INFO，**不要求像素一致** |

画面判定阈值（0..1 灰度 MAE）：`< 0.08` 通过，`0.08–0.16` 警告，`≥ 0.16` 失败。
同片缩小转码实测 MAE 约 0.0005；另一份内容的视频整体 MAE 约 0.15–0.19，能被明确区分。

结论分四档：`PASS`（通过）、`WARN`（可追查警告，如时间错位）、`FAIL`（明确失败）、
`PENDING`（缺关联信息，**不能声称通过**）。

---

## 2. Mac 依赖与安装

需要系统自带或 Homebrew 安装的 ffmpeg（含 ffprobe）：

```bash
brew install ffmpeg
ffmpeg -version    # 确认可用
```

Python 3.11+（开发验证用 3.12），建议虚拟环境：

```bash
cd repo
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

依赖：PySide6、numpy、Pillow、pytest（见 `requirements.txt`）。

> 注意：本机 ffmpeg 若未编入 `drawtext` 滤镜不影响使用——样例的帧号/图形由
> Pillow 在 Python 侧逐帧绘制，再通过管道喂给 ffmpeg，不依赖 drawtext。

---

## 3. 启动

### 图形界面

```bash
python run_gui.py
```

工具栏操作顺序：

1. **导入原片…**：选择 `≤15s、≤1080p、CFR 的 mp4`（不满足会被拒绝并说明原因）。
2. 二选一：
   - **生成 360p 代理**：保持帧率与宽高比缩到 360 高（不放大），保留音频，
     同时写 sidecar 关联文件；
   - **换入已有代理…**：核对外部已有的代理。缺 sidecar 时关联项标 **PENDING 待核对**。
3. **执行核对**：右侧表格逐项给出 PASS/WARN/FAIL/PENDING 与依据，下方是检查点证据。
4. **导出核对记录…**：导出与当前这一对文件绑定的 JSON，外加一张检查点双画面证据 PNG。

播放区支持：播放/暂停（空格）、上一帧/下一帧（←/→，按**原片帧**单步）、
拖动滑块、**单画面切换（Tab）/ 并排对照**。切换显示哪一路时**帧位置不变、不回到开头**，
两个画面都显示各自真实帧号、PTS 与显示时间，并给出两边 PTS 差（≤ 一个源帧）。
检查点列表双击可直接跳到该帧的双画面对照。

### 命令行（无界面环境/脚本）

```bash
# 生成整套自包含测试素材（无需任何附件）
python -m proxy_check.cli samples ./samples_out

# 单独生成代理
python -m proxy_check.cli build 原片.mp4 代理.mp4

# 核对并导出 JSON（退出码：0=PASS/WARN/PENDING，2=FAIL，1=工具错误）
python -m proxy_check.cli verify 原片.mp4 代理.mp4 -o report.json
```

---

## 4. 自生成样例说明

`python -m proxy_check.cli samples ./samples_out` 会生成：

| 文件 | 内容 | 预期核对结果 |
| --- | --- | --- |
| `source.mp4` | 960×540 / 30fps / 10s，逐帧帧号 + 横移圆形 + 每秒一次 0.15s 蜂鸣 | — |
| `proxy_good.mp4` (+`.sidecar.json`) | 同片 640×360 正常代理 | **PASS** |
| `proxy_offset.mp4` | 丢掉开头 15 帧、尾部补黑帧，帧数/帧率/尺寸不变 | **WARN 时间错位**，精确报出错位 15 帧（0.5s） |
| `proxy_different.mp4` | 另一份棋盘格内容，元数据（帧数/帧率/尺寸/时长）与正常代理完全一致 | **FAIL 错片** |

在 GUI 里导入 `source.mp4`，再分别“换入已有代理”选后三者即可看到三种结论。

---

## 5. 关键验证点（为什么结论可信）

- **真实输出帧，不只比配置**：帧数取自 ffprobe packet 列表并排序到呈现顺序；
  内容比对基于 ffmpeg 实际解码出的灰度帧，而非读取编码参数。
- **文件名相同 ≠ 同一原片**：关联只认 sha256 与内容指纹。把另一份内容改名成
  `source.mp4` 顶替，关联检查直接 FAIL（测试 `test_same_named_different_file`）。
- **错位能定位而非笼统报警**：整段 ±N 帧搜索找最小 MAE 的偏移量，错位代理精确报 15 帧，
  且对齐后 MAE≈0，明确区分“时间错位”与“错片”。
- **元数据相近也能识破错片**：错片代理与正常代理同帧数/帧率/分辨率/时长，
  仅靠结构检查会全 PASS，内容检查给出 9 个 FAIL 检查点。
- **失败仍可查证据**：FAIL 也导出完整 JSON 与双画面证据 PNG；缺 sidecar 时是 PENDING
  而非 PASS。
- **失败不沿用旧结果**：新一轮生成/载入开始即清空代理侧状态与旧结论，生成失败只留原片，
  不会让旧代理冒充成功（测试 `test_state_reset_clears_stale_proxy`）。

---

## 6. 跑测试

```bash
QT_QPA_PLATFORM=offscreen python -m pytest   # GUI 测试用 offscreen，无需真实显示器
```

35 个测试覆盖（均基于真实 ffmpeg 生成/解码的媒体，非 mock）：

- `tests/test_ffmedia.py`：CFR packet 判定、真实帧数/尺寸/时长/音轨、灰度解码、
  内容指纹稳定性与区分度、错位代理的帧对应、VFR 文件被拒。
- `tests/test_proxy.py`：宽高比/不放大、真实 mp4+sidecar 产出、时长/分辨率/容器约束、
  生成失败不留半成品、同名不同片关联失败。
- `tests/test_verification.py`：正常关联 PASS、缺 sidecar PENDING、15 帧时间错位、
  错片 FAIL、少 30 帧 FAIL、原片被替换 FAIL、sidecar 被篡改 FAIL、导出与文件对绑定、
  失败仍含证据。
- `tests/test_player.py`：帧单步/夹边界、切换不丢位置、帧时间/PTS、播放到末帧自停、
  代理更短时帧引用不越界。
- `tests/test_gui.py`：offscreen 下真实加载/播放/单步/切换/核对/导出/证据拼图、
  检查点跳转、失败态不显示成功、状态重置、文件对 key 用哈希。

---

## 7. 目录结构

```
proxy_check/
  errors.py        领域异常
  ffmedia.py       ffprobe/ffmpeg 封装: 探测、packet PTS、灰度解码、内容指纹
  proxy.py         360p 代理生成、导入约束、sidecar 读写
  verification.py  关联 + 结构 + 画面内容核对, 报告与导出
  player.py        与 Qt 无关的帧精确播放模型(可单测)
  samples.py       自生成原片与三类测试代理
  cli.py           命令行入口
  app.py           GUI 启动
  gui/             主窗口、播放视图、结果面板、状态、后台线程、帧/音频准备
tests/             pytest 套件
run_gui.py         图形界面入口
```

## 8. 范围限制

- 仅处理一对短视频、mp4 容器、CFR、≤15s、≤1080p 的原片。
- 画面检查针对“同片缩小转码”与“明显错片/整体错位”两类问题；
  **不承诺识别任意重剪、局部特效或复杂二次编辑版本**。
- 全片帧驻留内存是为帧精确与实现简单，按 15s/1080p 以内的短视频设计，不适合长片。
