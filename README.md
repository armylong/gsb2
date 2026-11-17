# 本地视频取帧网页

一个完全本地运行的视频取帧工具：导入本地视频后，按固定时间间隔或画面变化
找出候选帧，从候选里挑选一组**有真实时间依据**的截图，并导出截图、带时间
标签的总览图和一一对应的清单。后端 Python + ffmpeg，前端原生 HTML/CSS/JS，
无需构建步骤，不修改原视频文件。

## 功能与需求对照

| 能力 | 实现方式 |
| --- | --- |
| 媒体信息（时长、尺寸、旋转、多视频流） | ffprobe 探测；多视频流可在页面切换处理哪一个 |
| 预览播放器 | 浏览器原生 `<video>`，后端支持 HTTP Range，可拖动进度条；只读原文件 |
| 固定间隔取帧 | 按真实时间均匀取点，时间范围 / 最多帧数 / 最小间隔可配 |
| 画面变化找候选帧 | ffmpeg `select='gt(scene,T)'`，灵敏度 1~5 可调，阈值见 `pipeline.py` |
| 真实帧时间 | 全部以 ffprobe 逐帧 `pts_time` 为准，**不使用帧序号 × 标称帧率**推算，VFR 同样准确 |
| 请求时间 vs 实际帧时间 | 请求时间落在两帧之间时取最近真实帧，界面与清单同时展示两者及偏差 |
| 候选管理 | 显示实际时间、点击跳转播放器、删除、手动补加、勾选/取消选择 |
| 重复时间去重 | 同一真实帧（按解码帧序号）全局只保留一条，重复请求记入 `merged_requests`，不产生重复截图 |
| 旋转与宽高比 | `-noautorotate` + 显式 `transpose` 校正方向；不缩放，保持原始宽高比 |
| 重新分析隔离 | 每轮分析带 generation 代次，旧轮结果一律作废；取消会 terminate 对应 ffmpeg 进程 |
| 多任务隔离 | 每个 Job 独立工作目录 `workspace/jobs/<job_id>/`，临时文件带 job_id 与代次前缀 |
| 导出 | zip 内含选中截图、`contact_sheet.png` 总览图、`manifest.json` / `manifest.csv` 清单 |
| 错误反馈 | 无视频流、损坏文件、部分帧无法解码、超出时长请求均有明确中文提示；单任务失败不影响其他任务 |
| 真实进度 | ffmpeg `-progress` 解析输出时间，按占视频时长比例展示阶段进度 |

## 环境要求

- **Python**：3.10+（开发验证版本 3.12）
- **ffmpeg / ffprobe**：**4.4 或更高版本**，需要包含以下滤镜：
  `select`、`showinfo`、`transpose`、`drawbox`、`concat`、`xfade`、`testsrc`、`color`
  （主流发行版的默认构建均包含；不依赖 `drawtext`/libfreetype）。
  代码已兼容 ffmpeg 5+ 的选项更名：
  - `-vsync passthrough` → 新版自动改用 `-fps_mode passthrough`
  - 自动旋转统一用长期可用的 `-noautorotate` 布尔开关
- Python 依赖见 `requirements.txt`：Flask、Pillow（总览图拼图）、pytest（测试）

验证本机版本：

```bash
ffmpeg -version          # 需 >= 4.4
ffmpeg -filters | grep -E 'select|transpose|xfade'
```

## 启动方法

```bash
# 1. 创建虚拟环境并安装依赖
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

# 2. 生成本地样例视频（硬切换 / 渐变 / VFR / 旋转 / 无视频流 / 损坏文件）
.venv/bin/python scripts/generate_samples.py samples

# 3. 启动服务
.venv/bin/python run.py
# 可选参数：--host 127.0.0.1 --port 8000 --workspace ./workspace --samples ./samples
```

浏览器打开 <http://127.0.0.1:8000>，直接选择本地视频，或从“加载样例视频”
下拉框选择内置样例。所有处理都在本机完成，文件只写入 `workspace/`，
原视频不会被修改或移动。

## 使用流程

1. **导入**：选择本地文件或样例。页面展示时长、封装格式、画面尺寸、旋转
   角度、帧率特征（CFR/VFR）和全部视频流；多个视频流时下拉切换。
2. **设参数**：选择“固定间隔”或“画面变化”模式，设置时间范围、最多帧数、
   相邻候选最小间隔；画面变化模式下调整 1~5 级灵敏度。
3. **分析**：后台逐块提取帧图，页面显示真实进度，可随时取消。
4. **挑帧**：候选卡片显示实际帧时间与请求时间；点击缩略图跳转播放器对应
   位置；可删除、勾选，或在“手动补加”里输入任意时间点（落在两帧之间会提示
   实际选中帧的时间）。
5. **导出**：下载 zip，或单独打开带时间标签的总览图。

## 导出内容说明

```
<视频名>_frames.zip
├── frames/
│   ├── 001_t00000.000s.jpg      # 文件名带实际帧时间
│   ├── 002_t00001.520s.jpg
│   └── ...
├── contact_sheet.png            # 带 HH:MM:SS.mmm 时间标签的总览图
├── manifest.json                # 完整清单（视频摘要、参数、请求/实际时间）
└── manifest.csv                 # 同样信息的表格版
```

`manifest.json` 中每条记录包含：

- `requested_time_seconds`：策略或用户请求的时间
- `actual_frame_time_seconds`：视频中真实解码帧的展示时间戳（pts_time）
- `time_offset_seconds`：两者偏差；`merged_duplicate_requests` 记录被合并的重复请求
- `frame_index_in_stream`：真实解码帧序号（仅用于定位，不参与时间推算）

未勾选、未生成完成（含解码失败）或已取消的帧不会出现在压缩包中，
清单条目与图片严格一一对应。

## 样例视频

`scripts/generate_samples.py` 用 ffmpeg 本地合成，无需自行找素材：

| 文件 | 覆盖点 |
| --- | --- |
| `sample_cut.mp4` | 4 段画面硬切换（2s/4s/6s 附近），验证场景检测 |
| `sample_gradual.mp4` | xfade 淡入淡出渐变，验证不会被误判为硬切 |
| `sample_vfr.mp4` | 25fps/5fps/25fps 三段拼接，真实帧间隔在 0.04s 与 0.2s 间变化 |
| `sample_rotated.mp4` | 640x360 编码画面 + 顺时针 90° Display Matrix，截图应为 360x640 |
| `sample_audio_only.m4a` | 无视频流，验证明确报错 |
| `sample_corrupt.mp4` | 截断的 mp4，验证损坏文件报错 |

手动核验样例：

```bash
# VFR：帧间隔不均匀
ffprobe -v error -select_streams v:0 -show_entries frame=pts_time -of csv=p=0 samples/sample_vfr.mp4 | head -8
# 旋转：Display Matrix rotation=-90（逆时针 -90 = 顺时针 90）
ffprobe -v error -select_streams v:0 -show_streams samples/sample_rotated.mp4 | grep -A3 side_data
```

## 测试

```bash
.venv/bin/python -m pytest tests/ -v
```

16 个集成测试通过 Flask 测试客户端驱动**真实 ffmpeg**，覆盖：

- **取帧实际时间**：VFR 视频上每个候选的实际时间都能在 ffprobe 枚举的真实
  帧时间集合中找到；两帧之间的请求返回最近真实帧（如请求 0.062s → 实际 0.08s）
- **方向与宽高比**：旋转样例导出截图为 360x640 竖向，比例 9:16
- **重复时间点**：相同时间、以及命中同一真实帧的不同请求，都只产生一条候选
- **取消隔离**：取消后候选清空、无半成品；重新分析成功且不受上一轮影响；
  两代分析的 generation 严格递增，旧轮结果不会混入
- **多任务隔离**：两个 Job 的工作目录与帧文件互不相交
- **导出一致性**：zip 内图片数 = manifest 条数 = 勾选数，取消勾选的不导出，
  无选中帧时导出被拒绝
- **错误反馈**：无视频流 / 损坏文件返回 400 与中文原因；超时长请求被拒绝；
  部分帧提取失败时同块其他帧仍成功，失败帧被标记且不进导出包
- **参数约束**：非法时间范围、最小间隔、最多帧数上限均生效

## 目录结构

```
.
├── backend/
│   ├── ffmpeg_tools.py   # ffprobe/ffmpeg 封装：探测、真实帧时间、提取、场景检测
│   ├── pipeline.py       # Job 管理、分析流水线、取消、代次隔离、去重、容错
│   ├── export.py         # 总览图拼图与 zip/manifest 导出
│   └── app.py            # Flask 路由与 HTTP 接口
├── frontend/             # 原生单页应用（index.html / style.css / app.js）
├── scripts/generate_samples.py
├── tests/test_integration.py
├── run.py                # 启动入口
└── requirements.txt
```

## 设计说明与边界

- **为什么不按帧序号假设时间均匀**：VFR 视频的标称帧率只是平均值，
  `帧序号 / 帧率` 与真实展示时间可能差出几百毫秒。本工具先用 ffprobe
  `-show_frames` 枚举每一帧的 `pts_time`，所有取点都映射到最近的真实帧，
  并把请求时间与实际帧时间同时保留。
- **取消的语义**：取消只终止当前分析轮并丢弃其半成品候选，页面回到本轮
  分析前的空状态；重新分析会清空上一轮的全部候选（含手动补加帧）后按新参数重建。
- **大视频性能**：帧枚举是一次性 ffprobe 调用；帧提取按 12 帧一块分批跑
  ffmpeg，兼顾并行度与“单块损坏不影响其他块”的容错。超长视频的首次枚举
  耗时与视频帧数成正比。
