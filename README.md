# bandfix — 屏幕录像横条瑕疵试修工具

本地 GUI 工具:选定一条固定窄行带,用两种局部重建方案逐帧试修,
**带外像素保证不被改写**,导出保留原音轨,并自带可计算参考误差的测试片。

## 环境准备

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# 还需要 ffmpeg(用于无损编码与音轨复用):
brew install ffmpeg
```

## 启动

```bash
# 1) 生成自带答案的测试片(瑕疵片 defect.mkv + 干净真值 clean.mkv + 音轨)
.venv/bin/python -m bandfix.cli sample --outdir samples

# 2) 打开 GUI(可直接带一个视频路径)
.venv/bin/python app.py samples/defect.mkv
```

GUI 用法:

- **条带行 y**:选区起止行(样例瑕疵带为 168–184,已预填);红框即选区
- **重建方案**:A · 空间插值(只用当前帧上下边缘行)/ B · 时域参考(同镜头邻帧中位数)
- **修复强度 / 时域半径 / 切镜阈值**:实时作用于预览;时域参考严格不跨切镜点
- **对照原片**:勾选后显示同一帧的原始画面,播放位置不动
- **导出修复**:整片处理,无损 mkv(libx264rgb crf 0)+ 原音轨 `-c copy`

## 一条可运行的验证命令

```bash
.venv/bin/python -m bandfix.cli sample --outdir samples && \
.venv/bin/python -m bandfix.cli export --src samples/defect.mkv --dst out.mkv \
    --band 168 184 --method temporal --strength 0.85 && \
.venv/bin/python -m bandfix.cli verify --export out.mkv --src samples/defect.mkv \
    --band 168 184 --gt samples/clean.mkv
```

`verify` 会重读导出文件并核对:

- 帧数 / 时长与源一致,音轨保留
- **受影响范围**:带外像素与源逐字节一致(无损导出下最大差异 = 0)
- **参考误差**:带内 MAE / PSNR(修复前后分别对真值 clean.mkv 计算)

## 结构

| 文件 | 作用 |
|---|---|
| `bandfix/core.py` | 切镜检测 + 两种条带重建(只写 `[y0,y1)` 行) |
| `bandfix/exporter.py` | 流式整片导出,时域上下文按镜头截断 |
| `bandfix/pipeline.py` | ffmpeg 无损编码 / 音轨复用 / ffprobe |
| `bandfix/samplegen.py` | 生成测试片(两镜头、硬切、注入瑕疵、正弦音轨) |
| `bandfix/verify.py` | 重读导出做核对 |
| `bandfix/cli.py` | `sample` / `export` / `verify` 三个子命令 |
| `app.py` | PySide6 GUI |
