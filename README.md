# 单音音高测量窗口 · Pitch Lab

本地运行的单声道单音音高测量工具，用于练吹奏时对照长音上滑的音高轨迹，
人工听原声音核对，不做自动改音。技术栈：Python + NumPy/SciPy + PySide6。

## 运行

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

测试（含离屏 UI 冒烟测试）：

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python -m unittest discover -s tests
```

## 功能与对应需求

1. **同一时间轴的波形 / 音高 / 音分三视图**，可打开短单声道 WAV
   （8/16/24/32-bit PCM、32-bit float；多声道自动混缩）。
   基准音高 A4 可调，**只改变音名与音分显示，同一帧的 Hz 读数与分析结果不变**
   （分析层根本不接收 A4，见 `pitch_lab/analysis.py`；测试
   `test_a4_does_not_change_hz`、`test_export_times_are_real_seconds_and_a4_independent`）。

2. **可设置分析音域与不确定判定**。起音段、RMS 低于音量门槛、频谱平坦度
   高于噪声门槛、综合可信分不足、八度存疑都会标为不确定（橙色点）；
   完全不可靠的帧 `f0=NaN`，曲线按连续段分别绘制，**无声/噪声段是视觉缺口，
   不会把两端连起来**（`draw_gapped_lines`，测试 `test_noise_gap_is_nan_not_connected`）。

3. **点选任意帧**查看主判断与全部候选（含低/高八度假设），给出每个候选的
   自相关峰、谐波评分、基频谱支持度和综合分。内置“弱基频 G3”样例：
   真实基频 196 Hz 而能量集中在 2f/4f，可看到 98 Hz 低八度假想如何因
   “基频谱支持≈0”被否决。

4. **拖选圈一段**可试听（QAudioSink，支持只播圈选段）并导出 CSV。
   导出列为真实秒 `time_sec` 与客观频率 `freq_hz`，争议帧保留全部候选频率、
   可信分与不确定原因。缩放、平移、换音名显示方式、改 A4 都不修改导出的
   真实秒数与 Hz（测试已覆盖）。

5. **五个内置样例 + 可核对分段参考**（右侧面板与图上绿色参考线）：
   - 滑音 C4→G4：连续上滑，观察滑过半音边界时音分曲线的锯齿重置；
   - 稳定音 A4(+12 cent)：恒定 443.06 Hz，音分应稳定在 +12 附近；
   - 稳定音中间加噪：噪声段必须是缺口；
   - 音符重现 G4/休止/E4：与滑音对照，这是重新出现有效音符而非滑过边界；
   - 弱基频 G3：八度跳判观察。

## 交互

- 图上单击：放置光标并查看该帧；拖动：圈选时间段
- 滚轮：以鼠标位置为中心缩放；Shift+拖动：平移；双击：复位视图
- 所有参数（音域、帧长/帧移、音量/噪声/可信分门槛、八度余量、起音保护）
  修改后立即重新分析

## 算法概要（`pitch_lab/analysis.py`）

每帧 Hann 加窗后计算 RMS、频谱平坦度与能量归一化自相关；在音域对应 lag
范围内取自相关峰（抛物线插值），并为每个峰补充 f/2、2f 八度假设；候选评分
`0.6*自相关峰 + 0.4*谐波能量占比`，另算“基频谱支持度”（基频处能量/二次谐波
处能量）用于否决落在谐波间隙里的低八度假想。低于任一可靠性门槛的帧不输出
f0（NaN），由绘图层保证留缺口。

## 目录

```
pitch_lab/
  notes.py        音名/音分换算（A4 只存在于这一层的显示用途）
  analysis.py     逐帧音高分析、候选评分、不确定判定
  signals.py      五个内置合成样例与分段参考真值
  wavio.py        WAV 读取
  audio.py        QAudioSink 试听
  exporter.py     圈选段 CSV 导出
  state.py        共享时间轴/光标/圈选状态
  plots.py        波形、音高（对数轴）、音分三个绘图控件
  main_window.py  主窗口
tests/            算法、导出不变性、离屏 UI 测试
main.py           入口
```
