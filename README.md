# Drum Loop Chopper

本地小工具: 导入一段不超过 8 秒的鼓循环 wav, 自动给出起音候选, 手动微调切点,
然后把切片排进 16 格十六分音符序列, 试听后导出成品 wav.

- 切片按**原速**播放, 不拉伸; 跨格的尾音保留并叠加
- 音量过载时对整段做一次统一衰减, 试听与导出使用同一份渲染结果
- 立体声保持立体声; 所有位置都以整数采样计

## 依赖 (macOS)

需要 Python 3.10+ 与 PortAudio (sounddevice 的底层库):

```bash
brew install python portaudio
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

依赖: `numpy` `scipy` (起音检测峰值) / `soundfile` (wav 读写) /
`sounddevice` (试听) / `PySide6` (界面) / `pytest` (验证).
不需要 librosa、ffmpeg 或任何外部录音素材.

## 启动

```bash
.venv/bin/python run_app.py                 # 打开空窗口
.venv/bin/python run_app.py 你的循环.wav     # 直接载入素材
```

也可以用无界面的导出入口:

```bash
.venv/bin/python -m drumchopper.export 素材.wav out.wav --bpm 130 \
    --steps "0-1-2-0-1-2-3-0-"
```

`--steps` 是 16 项: 可写紧凑串 `0-1-2-0-1-2-3-0-` (每字符一格), 也可写空格分隔
的 16 项 `0 - - - 1 - - - 2 - - - 0 - - -`; 数字是切片序号 (从 0 起), `-`/`.` 是空格.
省略 `--slices` 时自动检测切点. 导出同时写一个同名 `.json`, 记录切点、每格采样偏移、
保护增益与真实长度.

## 样例与验证

```bash
# 生成 3.2 秒立体声样例和已知起音位置
.venv/bin/python -m drumchopper.samples samples/demo_drums.wav

# 全部自动化测试 (80 项)
.venv/bin/python -m pytest
```

样例里的每一次击打都落在精确的整数采样上, 起音列表写入
`samples/demo_drums_onsets.json`, 测试只把它当参考, 不依赖检测器本身.
界面上点 "生成样例…" 也会同时写出 wav 和这份 json.

几个可以手工复核的点 (对应自动化测试的思路):

1. **切点与切片**: 双击波形空白处新增切点, 拖动移动, 右键删除.
   切片 `i` 是 `[切点 i, 切点 i+1)`, 第一片从 0 开始, 最后一片到素材末尾,
   左右声道共用边界; 界面右侧显示当前切片的真实起止采样.
2. **拍位**: 每格显示该格真实开始毫秒数. 改 BPM 后数字立即更新;
   导出 json 的 `step_samples` 与 `i × 60/BPM/4 × 采样率` 之差不超过 0.5 采样.
3. **跨格尾音**: 把一段带长尾的切片放进第 1 格, 后面留空,
   导出的第 2、3 格仍能听到尾巴; 导出文件长度始终是 16 格总时长, 不会因为尾巴变长.
4. **过载保护**: 同一片反复叠加直到超过 0 dBFS, 波形下方面板显示 "保护衰减 x dB",
   导出文件峰值等于 0.98 且所有采样按同一比例缩小.
5. **换速度/改切点后重放**: 播放中改速度或切点会立即用新参数重新渲染并重启,
   不会残留上一轮声音; `停止` 会清空声卡队列.

命令行抽查导出结果:

```bash
.venv/bin/python - <<'PY'
import json, soundfile as sf, numpy as np
m = json.load(open("out.json"))
info = sf.info("out.wav")
print("frames", info.frames, "expected", m["frames"], "channels", info.channels)
print("steps", m["step_samples"])
data, sr = sf.read("out.wav")
print("peak", np.max(np.abs(data)), "gain", m["gain"])
PY
```

## 界面操作速查

| 操作 | 方式 |
| --- | --- |
| 新增切点 | 在波形空白处双击 (或单击虚线显示的建议位置采用该建议) |
| 移动切点 | 拖动橙色切点线 |
| 删除切点 | 右键切点线 |
| 选择切片 | 单击该切片所在的波形区域 |
| 切片起止 | 右侧 "切片" 面板直接输入采样位置, 自动限制在相邻切点之间 |
| 试听切片 | "试听该切片" |
| 填格 | 单击格子循环 空 → S1 → S2 … → 空; 右键清空; 滚轮微调 |
| 画笔 | 打开画笔后左键连续涂当前切片, 再点同一格取消 |
| 播放/停止 | 空格 / Esc, 或走带按钮 |
| 循环 | "循环" 按钮, 与单次播放共用同一条序列时间轴 |
| 导出 | "导出 wav…" (会同时写同名 json) |

## 结构

```
drumchopper/
  audio.py      读写 wav, 起音检测, SliceModel (切点/切片), 序列时间与离线渲染
  player.py     sounddevice 播放, 统一缓冲 + 代际计数, 停止即丢弃队列
  samples.py    合成鼓样例 + 已知起音位置
  export.py     无界面导出 CLI
  ui/           波形/切点编辑, 16 格网格, 切片面板, 主窗口
tests/          80 个测试: 切片、时序、播放、界面流程与导出文件实测
```

自动化测试中有相当一部分是**从导出的 wav 读回数据**再比对的:
逐采样核对切片是否原样出现在拍位上、空格处是否只有前一片的尾巴、
重复切片是否叠加、末尾是否精确截断, 而不是只检查格子里的配置.
