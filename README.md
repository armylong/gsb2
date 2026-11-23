# fmp4inspect — 分片 MP4 本地检查器

检查浏览器录制产生的分片 MP4 (fragmented MP4): 哪些片段记录全了却播不出、
哪些片段实际丢了一截。纯 Python 解析容器结构 (不依赖第三方解析库),
用 ffmpeg/ffprobe 做解码验证与导出, PySide6 图形界面。

## 功能

1. **加载** 单个完整 fMP4 文件, 或按顺序选入的初始化片段 (init.mp4) + 媒体片段 (*.m4s);
   显示轨道 (类型/编码/时间基准/参数)、每个片段的显示时间范围和样本数量。
2. **诊断** 并区分:
   - 初始化信息 (moov) 缺失, 或 init 与媒体片段轨道不匹配;
   - 片段数据不完整 (box 截断 / mdat 字节不足以覆盖样本表);
   - 时间轴重叠、回退、跳变;
   - **顺序错误 vs 数据缺失**: 按 tfdt 重排后连续 ⇒ 只是顺序错了; 重排后仍有洞 ⇒ 真丢片段。
3. **预览**: 选一个片段实际解码, 视频给出逐帧 PTS 的缩略图, 音频给出波形、
   峰值/RMS 和 PTS 范围; 时间标签以该段样本的显示时间 (tfdt + cts) 为准,
   并对比"样本表数量 vs 实际解码帧数"以暴露播不出的部分。
4. **导出**: 从连续覆盖区间导出可独立播放的 mp4 (缺失片段不计入覆盖;
   范围内有洞会被拒绝)。流拷贝 (起点对齐关键帧) 或重编码 (精确边界) 两种模式,
   导出后读回文件核对实际覆盖范围。
5. **测试材料**: 从短测试片生成 正常 / 换序 / 末尾截断 三套材料并自检。

## 安装

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
# 需要系统已安装 ffmpeg / ffprobe
```

核心解析与 CLI 不依赖 PySide6, 系统 python3 即可运行。

## 使用

```sh
# 图形界面
.venv/bin/python -m fmp4inspect gui [文件...]

# 命令行分析 (单文件 fmp4 或 init + 媒体片段)
python3 -m fmp4inspect analyze frag_full.mp4
python3 -m fmp4inspect analyze init.mp4 seg_01.m4s seg_02.m4s ...

# 导出连续范围 (输出时间轴从 0 开始, 自动读回核对)
python3 -m fmp4inspect export init.mp4 seg_*.m4s --start 1.5 --end 4.5 -o out.mp4
python3 -m fmp4inspect export ... --reencode   # 精确边界

# 生成测试材料并自检 (正常/换序/截断 + 导出读回核对)
python3 -m fmp4inspect gen-test /tmp/fmp4test
```

## 结构

| 模块 | 职责 |
|---|---|
| `fmp4inspect/boxes.py` | ISO BMFF box 解析 (moov/moof/traf/tfhd/tfdt/trun/mdat...) |
| `fmp4inspect/model.py` | 轨道/片段/样本数据模型, PTS 计算 |
| `fmp4inspect/analyze.py` | 加载、诊断 (顺序错误 vs 数据缺失)、覆盖区间 |
| `fmp4inspect/preview.py` | ffprobe/ffmpeg 解码验证、缩略图、音频波形数据 |
| `fmp4inspect/exporter.py` | 连续范围导出 + 读回核对 |
| `fmp4inspect/testgen.py` | 测试材料生成与自检 |
| `fmp4inspect/app.py` | PySide6 图形界面 |
| `fmp4inspect/cli.py` | 命令行入口 |
