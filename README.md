# 双通道到达时差 · 手调对照台

验证两路采样的声音到达时间差（TDOA）。Python + PySide6 桌面程序，内嵌 pyqtgraph 交互图；
DSP 只依赖 numpy / scipy，同一套代码被界面、命令行自检和测试共用。

## 功能对应

| 需求 | 实现 |
|---|---|
| 从双通道 wav 挑一小段 | 顶部「导入双通道 wav…」；在总览图上拖动绿色选区即可更换分析片段 |
| 已知时差与不同信噪比的样例 | 「样例」下拉框内置 7 个，全部在程序里合成，无需外部文件：<br>`clean` 7 采样 / 24 dB、`low_snr` −12.6 采样 / 2 dB、`very_noisy` 3.25 采样 / −6 dB、`inverted` 反相 4 采样、`rhythmic` 40 ms 周期撞击、`mic` 类语音 + 增益差 + 回声 18.4 采样、`drift` 时变 18→62 采样 |
| 展示时差候选及置信程度 | 左侧「候选时差」表：整采样 lag、小数修正、归一化相关值、0–1 置信度（高/中/低）和类别（主峰 / 近似等高候选 / 次峰 / 弱候选）。右上互相关图同步标出候选点，橙色 = 当前选用 |
| 查看两边局部波形重叠 | 右侧「局部波形重叠」把两路对齐后叠画，灰色是残差；「跳到冲击处」自动定位能量最大处；Shift + 拖动（或对齐量输入框 / 滑杆 / ±0.1、±1 按钮）可按小数采样微调 |
| 区分反相和时间变化 | 自动比较同相/反相归一化互相关，反相时整段按 −1 对齐并在结论里标注；「局部时差随时间变化」图按滑动窗重估时差，发现漂移时标题与徽标变红并给出斜率（采样/秒） |
| 重复节奏多个近似峰 | 保留所有超过阈值的候选；近似等高时标黄、提示间距（如「约 1920 采样 / 40.0 ms，符合重复节奏特征」），并说明单段互相关无法唯一确定；**单击表格行**即可改用该候选作为对齐量与报告结论 |
| 报告检测误差和参考区间 | 底部一行常驻摘要 + 导出 JSON/文本报告：检测值、参考真值（样例自动带入，导入文件可手填）、误差（采样与 µs）、95% 参考区间（分块重估 + t 分布）、是否落在区间内、时变判断、所有候选与警示 |
| 输出对齐后的短音频 | 「导出对齐音频 + 报告」写出 `*_aligned.wav`（左 ch0、右 ch1，ch1 已按小数时差与极性对齐）、`*_residual.wav`（差值）与 `*_report.json` 到 `out/` 目录 |

## 本地启动

需要 Python ≥ 3.10（已在 3.12 上验证）。

```bash
# 1. 依赖（任选其一）
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
# 或者： python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 2. 打开对照页
.venv/bin/python -m tdoa_lab
```

也可以 `uv pip install --python .venv/bin/python -e .` 后直接用 `tdoa-lab` 启动。

界面布局：

- **顶栏**：样例选择 / 导入 wav / 参考真值输入 / 重新分析 / 导出
- **总览**：整段双通道波形，绿色选区 = 当前分析片段（拖动两端或整体移动即自动重算）
- **左栏**：检测结论、候选表、小数对齐（输入框 / 滑杆 / 微调按钮 / 极性）、检测参数
- **右栏**：归一化互相关、局部波形重叠、局部时差随时间变化、报告摘要

操作要点：

- 反相样例会自动识别并补偿；把「极性」改成「同相」可以看误判时会发生什么
- 重复节奏样例里单击 `+1923` 那一行，对齐量和结论会切换到该候选，残差会明显变差——这正是“无法唯一确定”的可视证据
- 片段越短、信噪比越低，参考区间越宽；`very_noisy` 与 `low_snr` 可以直接对比

## 验证命令

一条命令跑完全部样例的无界面自检：检查检测误差是否在容差内、极性与时变判定是否正确、多候选是否被保留，
然后把每个样例的“对齐后音频”导回重新估计，确认残留时差接近 0 且同相，并写出 JSON 报告。

```bash
.venv/bin/python -m tdoa_lab verify
```

预期输出（全部 `OK`，退出码 0）：

```
[OK  ] clean      真值   +7.000  检测   +7.000  误差  +0.000  置信 0.79  极性 +1  候选 6  时变 否
[OK  ] low_snr    真值  -12.600  检测  -12.675  误差  -0.075  置信 0.79  极性 +1  候选 6  时变 否
...
全部通过。对齐音频与报告在 .../out
```

产物：`out/verify_<样例>_aligned.wav`、`out/verify_<样例>_residual.wav`、`out/verify_<样例>_report.json`、
`out/verify_summary.json`（每例的真值、检测值、误差、参考区间、回读校验结果）。

其他命令：

```bash
.venv/bin/python -m tdoa_lab list                       # 列出内置样例
.venv/bin/python -m tdoa_lab report --preset rhythmic   # 打印单个样例的文本报告
.venv/bin/python -m tdoa_lab report --preset clean --export --out out
.venv/bin/python -m tdoa_lab report --wav my_stereo.wav --start 1.2 --duration 0.5 --truth 3.5
.venv/bin/python -m tdoa_lab snapshot --path out/gui.png  # 离屏渲染界面截图
.venv/bin/python -m pytest tests -q                     # 单元测试
```

## 约定与口径

- 时差单位默认**采样点**：`ch1[n] ≈ ch0[n − delay]`，正值表示 ch1 晚到；界面同时给出毫秒与微秒。
- 估计方法：Hann 窗 + FFT 归一化互相关（NCC），按重叠区局部能量归一化；峰值用三点抛物线插值到小数采样。
- 置信度是启发式 0–1 分值（峰高比、与噪声底分离度、峰形尖锐度），**不是统计概率**。
- 95% 参考区间由片段内分块重估的离散度 + t 分布得到，只描述“换一段数据时估计会怎么变”，不是物理真值的概率保证。
- 回声、增益差和时变会让“单一常数值”本身失真：`mic` 有约 +0.8 采样的系统偏差，`drift` 的误差会更大——界面会把这些标出来，而不是假装精确。

## 文件

```
tdoa_lab/
  dsp.py     互相关、峰搜索、亚采样插值、极性、时变分析、读写 wav
  synth.py   7 个可复现样例（固定随机种子）
  models.py  Peak / TdoaResult / DriftResult
  report.py  片段分析编排、报告生成、对齐音频导出、回读校验
  gui.py     PySide6 主界面
  cli.py     verify / report / list / snapshot
tests/test_dsp.py
```

仅支持 PCM wav（8/16/32-bit）；导入时使用前两个通道。
