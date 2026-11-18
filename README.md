# 选段倒放工具

本地小工具: 把短片中选中的一段**画面和声音一起倒过来**, 片头片尾保持正常播放。
Python + PySide6 + PyAV(FFmpeg)。单次只处理一段倒放, 不做交叉淡化, 便于核对区间边界有没有多取或漏取。

## 功能

- 导入 ≤10 秒、≤720p、恒定帧率的 mp4, 至多一条音轨; 无音轨也能处理(不会凭空添加声音)
- 显示实际帧时间、帧率、音频采样率、声道数与总时长
- 用画面定位设置倒放区间, 边界吸附到实际视频帧; **起点包含、终点不包含**;
  区间至少两帧; 终点可以取"最后一帧之后"的片尾位置
- 只反转区间内视频帧的顺序, 区间前后保持原顺序; 音频按相同内容时间换算到
  采样边界后反转采样, 立体声不交换左右; 界面显示吸附后的时间/帧范围、
  音频实际采样边界及不足一个采样点的舍入差
- 原片/结果切换、播放/暂停、逐帧步进、当前位置 ±1s 短段试听;
  画面下方显示"输出帧 i ← 原帧 j", 输出时间轴始终递增
- 导出 mp4(h264 + AAC): 帧数与总时长不变, 音视频覆盖一致
  (容器末端误差在一个视频帧以内)

## mac 依赖与安装

```sh
brew install python@3.12 ffmpeg   # ffmpeg 供 ffprobe 检查用; 编解码由 PyAV 自带
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt   # PySide6 / av / numpy
```

## 启动

```sh
.venv/bin/python -m app.main              # 打开窗口
.venv/bin/python -m app.main some.mp4     # 启动并直接导入
```

窗口里可以直接点 **"生成并打开样例"**, 或用命令行生成:

```sh
.venv/bin/python -m app.sample /tmp/sample.mp4
```

样例为 90 帧 / 30fps / 3s: 每帧有大号帧号和匀速移动的方块;
立体声短音在 0.5s / 2.0s / 3.5s(440/660/880 Hz, 右声道频率为左声道 1.5 倍,
用于验证短音逆序且左右不交换)。

## 使用

1. 导入 mp4(或生成样例)
2. 播放/逐帧找到边界, 点 **"当前帧→起点" / "当前帧→终点"**, 或直接输入帧号;
   下方会显示吸附后的时间、帧范围、音频采样边界和舍入差
3. 切换 **原片 / 结果** 核对; 用 **"试听当前位置 ±1s"** 听边界附近的声音
4. **导出 mp4…**

## 验证

验证脚本从**导出文件实际解码的数据**出发核对(允许有损编码误差,
用最近邻帧匹配和相对误差/相关度, 不要求字节相同):

```sh
# 1) 生成样例并做一次倒放(区间 [45,75), 覆盖 2.0s 的短音)
.venv/bin/python -m app.sample /tmp/sample.mp4
.venv/bin/python - <<'EOF'
from app.media import load_media, export_media
from app.core import FrameRange, video_frame_mapping, audio_sample_bounds, reverse_audio_segment
m = load_media('/tmp/sample.mp4')
rng = FrameRange(45, 75)
frames = [m.frames[i] for i in video_frame_mapping(m.n_frames, rng)]
ab = audio_sample_bounds(rng, m.fps, m.sample_rate, m.audio.shape[1])
export_media('/tmp/out.mp4', frames, m.fps,
             reverse_audio_segment(m.audio, ab.s0, ab.s1), m.sample_rate)
EOF

# 2) 核对: 帧数/时长不变、区间外不变、区间内逆序、短音逆序、左右不交换
.venv/bin/python -m app.verify /tmp/sample.mp4 /tmp/out.mp4 45 75
```

输出示例(末行 `全部验证通过 ✔`):

```
帧匹配最大平均差: 0.30/255 (有损编码误差)
音频采样边界: [72000, 120000) / 144000, 舍入差 err0=+0.000 err1=+0.000 采样点
音频相对误差: 区间前 0.00055 | 区间后 0.00000 | 区间内(对反转原音) 0.00518 (相关度 1.0000) | 同声道 1.0000 vs 交换 0.0011
全部验证通过 ✔
```

## 代码结构

| 文件 | 说明 |
| --- | --- |
| `app/core.py` | 纯逻辑: 帧映射、采样边界换算、区间反转(可独立测试) |
| `app/media.py` | PyAV 解码/校验/导出 |
| `app/sample.py` | 样例生成(帧号 + 运动方块 + 立体声短音) |
| `app/verify.py` | 导出结果验证 |
| `app/main.py` | PySide6 界面 |
