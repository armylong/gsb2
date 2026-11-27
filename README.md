# 进场音前置混响试听工具（Reverse Reverb Preview）

戏剧进场音的制作需求：把一小段混响**逆向**摆在干声之前，湿声尾巴逐渐增长、
在目标起音处收敛，干声准时进入。本工具是一个纯本地的 PySide6 试听窗口，
不依赖任何网络服务。

## 安装与启动

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py
```

## 工作流

1. **导入干声 WAV**：支持 PCM uint8/int16/int32 与 float WAV，单声道或立体声。
   导入后在波形上**左键点击**指定干声起音（默认自动选第一个超过 -40 dB 的采样）；
   滚轮缩放，左键拖拽平移。
2. **选择混响响应（IR）**：
   - 内置「短反射」：约 0.25 s 的稀疏多 tap 早期反射；
   - 内置「一段衰减」：约 1.2 s 的指数衰减噪声尾；
   - 或从外部 wav 文件读入。
3. **调参数**：混响提前量、交界淡变时长、湿声音量；改动自动防抖重渲染。
4. **分别试听**：干声 / 前置湿声 / 合成 三个单选视图共用同一条时间轴，起音标记
   （红线）在三者里指向同一采样；白色竖线是播放光标。
5. **导出分轨**：`entrance_dry.wav`、`entrance_wet_pre.wav`、`entrance_mix.wav`
   三个等长 wav，外加 `entrance_export_info.txt` 对齐说明。

## 关键规则（界面日志区会逐条显示实际采用的决策）

### 时间对齐：干声绝不后移

干声的任何采样都不会向后挪动。若起音前的空间容不下提前量，只在**头部补静音**
（prepend），信息栏显示新增时长：

```
输出位置 = 干声内位置 + prepend        （prepend ≥ 0）
湿声尾巴 = 起音点，湿声在起音处淡出到 0
```

提前量短于 IR 时，只取反转 IR 的最后 `lead` 个采样（被切掉的是最安静的头部）；
提前量长于 IR 时，湿声前面自然留静音。

### 交界淡变（等功率余弦）

淡变窗位于起音之前，湿声按 `cos` 曲线 1→0 淡出、干声按 `sin` 曲线 0→1 淡入，
两条增益平方和恒为 1，交界没有音量凹陷；起音之后湿声严格为零，干声恢复原始幅值。
淡变设为 0 即硬切。

### 声道 / 采样率匹配（R1–R5）

| 规则 | 情形 | 处理 |
|---|---|---|
| R1 | IR 与干声采样率不同 | `scipy.signal.resample_poly` 多相重采样到干声采样率 |
| R2 | 干声单声道、IR 立体声 | 左右取均值折叠为单声道 |
| R3 | 干声立体声、IR 单声道 | 同一份 IR 复制到左右 |
| R4 | IR 多于两声道 | 只取前两声道 |
| R5 | 左右有效长度不同 | 按各声道峰值 1e-5 相对阈值判定有效长度，取最长统一，短声道尾部补零 |

### 试听与导出幅值一致

内部统一 float64 处理；试听播放与 wav 导出共用 `dsp.to_pcm16` 同一条 int16
量化路径（不做自动归一化）。合成若超过 0 dBFS，界面会给出削顶警告和采样数，
需要手动降低湿声音量。

## 验证

```bash
# 32 项无头 DSP 检查：对齐、尾巴位置、淡变连续性、分轨相加、量化一致性、R1–R5
.venv/bin/python -I verify.py

# GUI 烟囱测试（离屏平台，无需显示器/声卡）
QT_QPA_PLATFORM=offscreen .venv/bin/python -I tests/test_gui_smoke.py
QT_QPA_PLATFORM=offscreen .venv/bin/python -I tests/test_ir_and_player.py
```

窗口里「生成两次击掌验证信号…」按钮会在选定目录写出：

- `claps.wav`：立体声两次击掌，第一击故意放在 0.10 s（靠近文件头，必然触发
  向前留出），第二击在 1.20 s，全长 2.0 s；
- `clap_markers.csv`：两个击掌的采样位置与时间，载入后起音自动对准 clap1。

用它可以肉眼/耳朵核对：前置尾巴的位置、起音处交界的连续性，以及导出的一组
分轨在采样级别的对齐（`verify.py` 对同一信号做自动化核对）。

## 代码结构

```
entrance_reverb/
  dsp.py           # 纯函数 DSP：wav 读写、内置 IR、声道匹配、渲染、击掌生成
  audio_player.py  # QAudioSink 封装，直接播与导出同源的 int16 PCM
  waveform.py      # 自定义波形控件：起音标记、淡变窗、播放光标、缩放平移
  main_window.py   # 主窗口与工作流
run.py             # 启动入口
verify.py          # 无头验证（32 项检查）
tests/             # 离屏 GUI / 播放器测试
```
