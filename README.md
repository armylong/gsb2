# 色度平面查看器（chroma-inspector）

本地短片查看器，用于从老视频抽取**原始八位色度平面**，核对 4:2:0 色度采样点
位置解释（chroma sample location）造成的**半像素色边偏移**。纯本地运行，
基于 Python + ffmpeg + NumPy + PySide6，不上传任何数据。

## 安装与启动

需要系统已安装 `ffmpeg` / `ffprobe`。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install -e .
.venv/bin/chroma-inspector          # 或 ./run.sh
```

测试：

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest -q
```

## 支持的输入

### 八位平面/半平面像素格式（白名单之外一律拒绝并说明原因）

| 格式 | 子采样 | 布局 | 范围 |
| --- | --- | --- | --- |
| `yuv420p` / `yuvj420p` / `nv12` / `nv21` | 4:2:0 | planar / semi-planar | 有限 / 全范围 |
| `yuv422p` / `yuvj422p` | 4:2:2 | planar | 有限 / 全范围 |
| `yuv444p` / `yuvj444p` | 4:4:4 | planar | 有限 / 全范围 |

10/12 位高位深、打包 RGB、灰度等格式会被明确拒绝（界面与异常里给出原因），
不做静默转换。容器文件通过 ffmpeg 以**原始像素格式**抽取平面字节，
不经过任何色彩转换；裸 `.yuv` 直接按字节切分，参数可手动指定或从文件名
（如 `clip_1920x1080_yuv420p.yuv`）推断。

## 功能与需求对应

1. **跳帧与三平面查看**：帧号 SpinBox / 方向键 / 首尾按钮跳转；
   分别显示 Y（全分辨率）、Cb、Cr（子采样分辨率）原始平面。
   点画面在状态栏报告该像素使用的**原始色度位置**——亮度像素给出它引用的
   色度样本坐标、双线性权重与虚拟亮度坐标；色度样本给出其在当前解释下的
   虚拟亮度网格位置。
2. **两种解释并排重建**：同一片视频、同一帧，按两种 chroma location 解释
   分别双线性上采样并 YUV→RGB 重建，细彩线的横向/纵向半像素偏移可逐像素核对，
   可附加 B−A 色度差值热力图。
3. **声明 vs 实际选用**：左侧面板同时显示媒体声明的位置（ffprobe
   `chroma_location`）与 A/B 实际选用的解释；未声明、无法识别、类型 4/5
   不支持时都给出原因。每个文件构造独立 `MediaInfo`，**打开新文件不会沿用
   上一个文件的声明**；裸 `.yuv` 明确标注“无容器、天然无声明”。
4. **锁定区域放大**：Alt+左键拖框锁定区域，对比双视图缩放/平移同步，
   像素硬边渲染（关闭平滑），横向与纵向边缘误差同屏可见。中性灰样例
   （Cb=Cr=128 恒定）在任何解释下都严格保持中性，由单元测试保证。
5. **导出与内置图案**：Ctrl+E 导出带帧号、文件名、两种解释标注的并排 PNG，
   锁定区域可单独放大导出。菜单“生成内置图案短片”产出一组 FFV1 无损片：
   - `pat_horizontal.mkv` —— 垂直色边，验证**水平**半像素偏移（声明 left）
   - `pat_vertical.mkv` —— 水平色边，验证**垂直**半像素偏移（声明 top）
   - `pat_neutral.mkv` / `.yuv` —— 中性灰，验证两解释均不变色（无声明）
   - `pat_fine_lines.mkv` —— 细彩线网格（声明 center）
   - `pat_motion.mkv` —— 逐帧滚动色边，切帧核对相位

## 色度位置解释（4:2:0）

| 名称 | H.264 类型 | 色度样本虚拟亮度坐标 |
| --- | --- | --- |
| left | 0 | (2cx, 2cy) |
| center | 1 | (2cx+0.5, 2cy+0.5) |
| top-left | 2 | (2cx, 2cy)（4:2:0 几何同 left） |
| top | 3 | (2cx+0.5, 2cy) |
| bottom-left / bottom | 4 / 5 | 需要底部外推，本工具不实现并说明 |

4:2:2 仅存在 left/center 的水平歧义；4:4:4 色度与亮度同位、无歧义。

## 安全说明

应用只通过 ffmpeg/ffprobe 子进程处理输入文件，不加载视频同目录下的任何
Python 模块；建议用 `python -I` 或虚拟环境运行。下载来的不可信视频请放在
独立目录，通过“打开视频”对话框按路径传入。

## 目录结构

```
src/chroma_inspector/
  chroma.py      色度位置枚举、虚拟坐标、双线性上采样、像素权重查询
  formats.py     八位像素格式白名单、平面切分（含 NV12/NV21）
  media.py       ffprobe 探测、ffmpeg 原始字节抽取、裸 .yuv 直读
  color.py       YUV→RGB（BT.601/709/2020，有限/全范围，中性灰严格等通道）
  reconstruct.py 单帧按指定解释重建 RGB
  patterns.py    内置验证图案短片生成
  export.py      并排画布几何（纯 numpy）
  ui/            PySide6 界面、像素视图、PNG 渲染
tests/           46 个单元/集成/GUI 冒烟测试
```
