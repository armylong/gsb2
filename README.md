# VidGeo — 像素形状与显示方向校正工具（macOS 本地）

解决两类老素材问题：

1. **非方形像素**：文件编码尺寸是 720×480，但 PAR（像素宽高比）是 40:33，
   播放器会把画面横向拉宽显示；直接按像素矩阵看则是“扁”的。
2. **方向元数据**：竖屏素材里存的其实是横向像素矩阵，靠容器里的
   display rotation 元数据让播放器旋转显示。

工具把 **PAR 与旋转都烘焙进实际像素**，输出方形像素（SAR=1:1）、
不带任何方向元数据的常规 mp4，播放器不会再转第二次。

## 运行环境

- macOS，Python 3.9+（已在 3.9 / PySide6 6.10 验证）
- ffmpeg / ffprobe 在 PATH 中：`brew install ffmpeg`
- 不依赖 ffmpeg 的 drawtext（测试素材画面由 PySide6 QPainter 绘制）

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
./run.sh                 # 启动图形界面
./run.sh path/to/x.mov   # 启动并直接加载文件
.venv/bin/python -m unittest discover -s tests -v   # 跑全部测试
```

## 界面与功能对应

| 需求 | 实现位置 |
| --- | --- |
| 编码尺寸 / PAR / 显示方向 / 预计显示比例分开显示 | 左栏「文件诊断」 |
| 原始像素 vs 播放器方式显示的区别 | 右栏两个预览页 + 诊断区对比文字 |
| 直角旋转与常见非方形像素组合，导出两者都落实到像素 | `geometry.bake_filter_chain` + 导出 |
| 标记点转换前后位置与比例一致 | 标记以**归一化显示坐标 (u,v)** 定义，与存储/取整无关；四角标记表 |
| 取整输出尺寸与边缘变化可见 | 「导出设置」成片尺寸 + 四向边缘 px 变化（支持最近偶/向下取偶） |
| 预览里点一处，显示成片对应位置 | 播放器预览页点击 → 归一化坐标 + 成片像素 + 源存储像素 |
| 有音轨保声音保节奏，无音轨也能导出 | 音频默认 `-c:a copy`；容器不接纳时自动回退 AAC；无音轨直接只导视频 |
| 转完回读检查尺寸/方向/音视频有效时长 | 「回读校验」面板（尺寸、SAR、残留旋转、音轨、音画时长差） |
| 内置非方形像素/旋转/两者叠加素材 | 工具栏「生成内置测试素材」，共 5 条 |
| 不支持的方向给明确提示 | 45° 样本会被标记原因并禁用导出（仅支持 0/90/180/270，镜像同样拦截） |

## 内置素材（生成在自选目录）

| 文件 | 编码尺寸 | PAR | 旋转 | 用途 |
| --- | --- | --- | --- | --- |
| `par_only.mp4` | 720×480 | 40:33 | 无 | NTSC 风格非方形像素 |
| `rot_only.mov` | 1920×1080 | 1:1 | 90° | 横画竖播 |
| `par_rot.mov` | 720×480 | 40:33 | 90° | **两种变化叠加** |
| `rot_180.mp4` | 640×480 | 1:1 | 180° | 倒置 |
| `unsupported.mov` | 640×480 | 1:1 | 45° | 验证不支持提示 |

每条素材带四角编号 1–4（按播放画面的左上/右上/左下/右下定义）、
中心十字、往返移动绿点和 440Hz 正弦音，可肉眼核对朝向、标记点与节奏。

## 关键实现说明（为什么不会被转两次）

ffmpeg 默认会自动按方向元数据旋转，且旋转矩阵在 `transpose` 后仍残留在
输出流里，导致播放器再转一次。导出命令因此固定使用：

```
ffmpeg -noautorotate -display_rotation 0 -i 输入 -vf "<PAR缩放>,setsar=1,<transpose>,setsar=1" ...
```

- `-noautorotate`：禁用自动旋转，滤镜链完全可控；
- 输入侧 `-display_rotation 0`：把显示矩阵清零（实测 ffmpeg 9 必需）；
- PAR 通过一次 `scale` 烘焙，旋转通过 `transpose` 烘焙，输出 `setsar=1`。

校验时回读成片，确认 `rotation` 为空/0 且 SAR=1:1 才算通过。

## 模块结构

```
vidgeo/
  geometry.py   几何模型：PAR/DAR/旋转换算、取整、滤镜链、坐标映射
  probe.py      ffprobe 封装：解析编码尺寸、SAR、displaymatrix、音轨、时长
  ffutils.py    ffmpeg 进程执行、预览代理片生成
  pipeline.py   导出命令构造、音频回退、回读校验报告
  samples.py    QPainter 绘制 + ffmpeg 编码的内置素材生成器
  workers.py    QThread 后台任务
  gui.py        PySide6 主界面
tests/
  test_geometry.py  纯几何单测（14 项）
  test_e2e.py       真实 ffmpeg 端到端测试（12 项）
```
