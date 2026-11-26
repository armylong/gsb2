# 老胶片声轨课堂实验室

一个本地运行的 Python + PySide6 + NumPy 演示：把短单声道 WAV 或程序生成的
低频、高频、静音底和短脉冲编码成**两侧暗线宽度随声音变化的竖直灰度声轨**，
再模拟扫描窗宽度、横向偏移和曝光并回读成声音。

> 这是教学模型，不是对真实光学胶片洗印/还音物理的完整仿真。标定数值刻意取整，
> 便于课堂计算：每行 `0.05 mm`，走片速度 `400 mm/s = 8000 行/s`。

## 1. 本地运行

需要 Python 3.10+。

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python main.py
# 等价于：python -m soundtrack_lab
```

macOS 如首次安装 PySide6 较慢，请等待 pip 完成；不需要联网调用任何服务。

## 2. 重新生成图声对照样例

```bash
source .venv/bin/activate
python generate_sample.py
open examples/sample_bundle/comparison.png
```

生成目录：`examples/sample_bundle/`

- `comparison.png`：正常、过宽扫描窗、短断线三栏对照和指标表。
- `soundtrack_normal.png`：正常声轨，PNG 文本块内含标定、时间段和源音元数据。
- `soundtrack_short_break.png`：短断线示例。
- `soundtrack_dirty_example.png`：脏点示例。
- `sample_source.wav`：源音。
- `readback_normal.wav`：窄窗正常回读。
- `readback_too_wide.wav`：`31` 行过宽窗回读。
- `readback_short_break.wav`：短断线回读。
- `README_sample.md`：本次生成的电平指标和检测区间。

在应用里点 **“重开导出的 PNG 解回声音”**，选择
`examples/sample_bundle/soundtrack_normal.png` 或 `soundtrack_short_break.png`
即可验证 PNG 回读。GUI 自己导出的 PNG 还会内嵌源音 WAV，因此重开后仍可做同源对照。

## 3. 课堂操作路线

1. 启动时已自动载入固定样例：
   - `440 Hz` 低频段；
   - `1320 Hz` 高频段；
   - 三段带轻微确定性噪声底的静音；
   - 三个短脉冲。
2. 中间声轨图中：
   - 时间向下增加，箭头标明走片方向；
   - 右侧标签列出每段名称和起止时间；
   - 蓝色横线是当前时刻对应的图像行；
   - `L` / `R` 标记该行左右两条暗线的位置；
   - 橙色标尺给出 `10 mm = 200 行 = 25 ms` 的标定关系。
3. 在声轨或下方波形上点击/拖动，可把源音、无改动回读、试改回读定位到同一时间。
4. 调整 **扫描窗宽**：
   - `1` 行：无改动基准；
   - `7` 行：高频明显损失，低频仍基本可恢复；
   - `31` 行：过宽，高频、脉冲峰值和细节被严重平均，静音底更低。
   窗宽说明会同时显示行数、物理距离和时间：
   `时间 = 行数 / 8000`，`距离 = 行数 × 0.05 mm`。
5. 调整 **横向偏移**：蓝色虚线门表示左右暗线的搜索范围；偏移过大时外侧暗线离开读取门，会产生钳位/丢失。
6. 调整 **曝光 EV**：极端欠曝/过曝会降低暗线对比度并触发不可靠提示。
7. “无改动回读”始终由原始干净图以 `1` 行窗、零偏移、零曝光补偿解码得到；右侧指标表保留它与试改结果的对比。
8. 在“脏点 / 断线示例”中选择类型：
   - 红色区间是检测到的核心异常；
   - 黄色外延是边界证据不足的**待查区间**；
   - 列表给出起止时间和保留的毫秒数；
   - “试听选中区间 / 对照源音区间”只播放该时间范围，不删除、不压缩这段时间。
9. 用导出按钮保存当前声轨 PNG、基准/试改回读 WAV。

## 4. 实现说明

- `soundtrack_lab/core.py`
  - 无 GUI 依赖的音频、编码、扫描窗平均、边缘判读、缺陷检测和指标计算。
  - WAV 读写使用标准库 `wave`，支持常见 8/16/24/32-bit PCM 与 float32 WAV；建议课堂素材使用导出的 16-bit 单声道 WAV。
- `soundtrack_lab/qt_support.py`
  - NumPy 灰度图与 `QImage` 转换、PNG 元数据读写、`QAudioSink` 播放。
- `soundtrack_lab/widgets.py`
  - 可点击定位的声轨视图、单行灰度剖面、共享时间标尺的三轨波形视图。
- `soundtrack_lab/gui.py`
  - PySide6 主窗口和全部交互。
- `soundtrack_lab/sample.py`
  - 可重复生成样例目录和 `comparison.png`。

### 声轨编码模型

每个时间行对应一个归一化采样值 `u ∈ [-1, 1]`：

```text
半宽 = 72 px + 50 px × u
左暗线 x = 210 - 半宽
右暗线 x = 210 + 半宽
总宽度   = 144 px + 100 px × u
```

因此零音量不是零宽度，而是保留 `144 px` 的基准宽度；回读时由
`(测得宽度 - 144) / 100` 恢复有正负的声音信号。扫描窗用居中矩形平均模拟
沿走片方向的宽缝隙：窗越宽，时间平均越强，高频和短脉冲越容易被抹掉。

## 5. 常见问题

- **没有声音？** 检查系统输出设备和 Qt 音量；可先导出 WAV 用系统播放器打开。
- **打开自己的 WAV 后没有分段名称？** 分段和低/高频指标针对程序生成的已知样例；外部 WAV 仍可编码、PNG 回读、调窗和导出。
- **PNG 经聊天软件或截图另存后无法恢复元数据？** 请使用应用直接导出的原始 PNG；标定和源音保存在 PNG 文本块中，重新编码/截图可能清除它们。
