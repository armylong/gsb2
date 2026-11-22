# 伴奏移调工具 (Pitch Shift Tool)

本地运行的伴奏整体升降调工具：**保持时长不变**，处理后可与原视频同步使用。
Python + PySide6，纯本地处理，不上传任何音频。当前支持 **60 秒以内的 WAV**，
单声道 / 立体声均可。

## 实现原理

保时长移调 = 相位声码器时间拉伸 + 变采样率重采样（`pitchshift_tool/pipeline.py`）：

1. `time_stretch`：STFT → 相位积分的 phase vocoder，按比例拉伸/压缩时间而不改音高；
2. `_resample`（soxr）：重采样恢复原采样点数，频率随之移动 `2^(半音/12)` 倍。

- 输出与输入**同采样率、同声道数、同采样点数**；零偏移走快速通道，逐采样恒等。
- 立体声按声道独立处理，相同输入得到完全相同的确定结果，因此左右共有的居中声像
  不会被推到一侧。
- 处理在 `QThread` 中进行，帧边界轮询取消信号，可随时取消并上报进度。

## 安装与运行

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m pitchshift_tool
# 或直接: ./run.sh
```

## 功能对照（需求条目）

| 需求 | 实现位置 |
| --- | --- |
| 单声道/立体声读取，正负半音+音分细调，沿用原采样率/声道/点数，零偏移原样输出 | `pipeline.py`, `audio.py`, 主窗口参数区 |
| 选持续音段与起音段试听；主频随半音变化，鼓点/音头留在原时间附近 | 片段选择 + `analysis.py` 主频/起音分析 |
| 左/右单听与混合入口；考察共有声像是否偏侧；标出可能削波位置 | `player.py` 三种监听，`analysis.find_clip_regions` + 波形红色标记 |
| 长处理可取消；区分"生成中的配置"与"上次完成结果"；导出确认试听的版本 | `worker.py`、主窗口处理状态区（配置编号 + 进度） |
| 程序生成固定测试信号（固定音高、左右不同内容、短音头），对比主频/起音/长度，试听切换走到同一位置 | `synth.py` + 主窗口"生成测试信号"，切换版本/声道保持播放位置 |

### 起音检测说明

移调后的相位声码器会在持续音上产生窄带纹波，普通能量阈值会因此误报。
`onset_times` 改用**高频段（≥2 kHz）能量突增**：鼓点/音头是宽带的、会抬升高频，
而谐波音与纹波不污染高频。实测 -5～+7 半音范围内 4 个音头全部正确检出，
漂移 ≤ 15 ms，纯持续音零误报。

## 测试

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/ -q
```

- `test_pipeline.py`：恒等输出、长度/形状、主频倍率、起音漂移、立体声独立性、取消与进度；
- `test_synth_analysis.py`：测试信号确定性、各声道主频、起音时刻、削波检测、移调后防误报；
- `test_audio_io.py`：WAV 往返、单/立体声、60 秒上限；
- `test_gui_smoke.py`：offscreen 端到端走通主窗口（处理、取消、版本作废、导出）。

## 目录结构

```
pitchshift_tool/
  pipeline.py        # 相位声码器 + 重采样移调核心 (可取消)
  audio.py           # WAV 读写 (60s 限制) 与 AudioData
  synth.py           # 固定测试信号生成
  analysis.py        # 主频/起音/削波分析
  player.py          # sounddevice 播放, 左/右/混合监听
  worker.py          # 后台处理线程
  waveform_widget.py # 波形/区域/削波/播放头控件
  main_window.py     # 主窗口
tests/               # pytest 测试
```
