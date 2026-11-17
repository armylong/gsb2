# 本地视频拼接工具（Video Joiner）

一个完全在本机运行的顺序视频拼接工具。把最多 6 段**尺寸/帧率不一、部分无声音**的短视频，
按时间线顺序拼成一个可正常播放的 MP4，并在导出前检查片段交界、导出后回读成品核对。

- 仅依赖本机 `ffmpeg` / `ffprobe`，Python 部分**只用标准库**，无需 pip 安装任何包
- 不做转场、不做多轨自由编辑，只有一条顺序时间线
- 所有处理发生在 `127.0.0.1` 本机服务与本地 ffmpeg 进程，文件不上传任何外部服务

## 1. 环境要求

- Python 3.10+（开发验证使用 3.12）
- ffmpeg / ffprobe 在 PATH 中，且带 `libx264` 与 `aac` 编码器
  - macOS：`brew install ffmpeg`
  - 验证：`ffmpeg -version`、`ffprobe -version`

## 2. 本地启动

### 方式 A：Web 界面（推荐）

```bash
./run.sh
# 等价于：
python3 -m videojoiner.server --host 127.0.0.1 --port 8765 --work-dir .videojoiner_work
```

浏览器打开终端提示的地址（默认 http://127.0.0.1:8765/ ）。
服务只绑定本机回环地址；`--work-dir` 存放上传文件、缩略图、中间片、样例和工程文件。

界面操作：

1. **片段列表**：「添加视频」选择本机文件（可多选），或在输入框填本机绝对路径回车；
   可上移/下移调整顺序、移除、单独替换。每段显示时长、画面尺寸、帧率、是否含声音。
2. **输出设置与预览**：设置输出宽/高/帧率（留 0 沿用首段）与画面适配方式；
   画布按真实等比规则预览，绝不拉伸。
3. **导出前检查**：显示预计总时长、最终输出设置、每个交界的帧率/尺寸/声音变化说明。
4. **导出与回读校验**：导出后点「导出后回读校验」，独立读取成品文件核对
   实际时长、尺寸、帧率、片段顺序、交界黑帧/重复帧、分段音频电平。

### 方式 B：命令行

```bash
# 生成 6 个程序化样例（不同尺寸/帧率，含 1 个无声片段）
python3 -m videojoiner.cli samples ./demo_samples

# 按顺序拼接（--fit contain 黑边填充 / cover 居中裁切），导出后自动回读校验
python3 -m videojoiner.cli export \
  demo_samples/clip1_1280x720_30.mp4 \
  demo_samples/clip2_854x480_24.mp4 \
  demo_samples/clip6_1280x720_30_silent.mp4 \
  -o out.mp4 --width 1280 --height 720 --fps 30 --fit contain

# 对已有成品做独立回读校验（工程文件在 work-dir/project.json）
python3 -m videojoiner.cli verify out.mp4 --project-json .videojoiner_work/project.json

# 探测单个文件元数据
python3 -m videojoiner.cli probe demo_samples/clip1_1280x720_30.mp4
```

## 3. 内置样例说明

无需自备素材。`samples` 命令（或 Web 界面「生成并载入内置样例」）用 ffmpeg 的
`color` / `sine` 虚拟源程序化生成 6 个 2 秒 MP4：

| 文件 | 尺寸 | 帧率 | 声音 | 画面特征色 |
|---|---|---|---|---|
| clip1_1280x720_30.mp4 | 1280x720 | 30 | 220Hz 正弦音 | 红 |
| clip2_854x480_24.mp4 | 854x480 | 24 | 330Hz | 绿 |
| clip3_720x1280_25.mp4 | 720x1280（竖屏） | 25 | 440Hz | 蓝 |
| clip4_640x360_2997.mp4 | 640x360 | 29.97 | 550Hz | 黄 |
| clip5_1920x1080_15.mp4 | 1920x1080 | 15 | 660Hz | 紫 |
| clip6_1280x720_30_silent.mp4 | 1280x720 | 30 | **无声音** | 青 |

特征色用于导出后核对片段顺序，声音有无用于核对静音补齐规则。

## 4. 关键设计：如何保证拼接连续、不错位

1. **先逐段统一规格，再流拷贝拼接**。每个片段先转码成完全一致的中间片：
   相同分辨率、帧率（`fps` 滤镜恒定帧率化）、像素格式 `yuv420p`、SAR=1、
   AAC 48kHz 立体声音轨。随后用 ffmpeg `concat` demuxer 以 `-c copy` 直接拼接，
   不重新编码，机制上避免交界补帧、时间戳重排导致的黑帧或重复片段。
2. **画面适配只做等比变换，不拉伸**：
   - `contain`：`scale=...:force_original_aspect_ratio=decrease` + `pad` 居中补黑边；
   - `cover`：`scale=...:force_original_aspect_ratio=increase` + `crop` 居中裁切。
3. **无声音片段统一补等长静音轨**（`anullsrc`），与有声片段同样输出 AAC 音轨，
   保证每段都有音轨、拼接后音轨连续。
4. **音画等长对齐**：有声片段经 `apad`（不足补静音）+ `atrim`（超长裁切），
   以画面时长为准；每段再用 `-t` 限定输出时长，避免某段音轨偏长挤占后续、
   造成后续声音提前或整体偏移。
5. **导出后独立回读**：校验只依赖成品文件本身，不信任导出过程的中间变量。

## 5. 失败处理与片段替换

- 上传/探测阶段：无法识别的文件会被拒绝并给出 ffprobe 原因，不会进入时间线。
- 导出阶段：错误按「统一规格化（normalize）/ 拼接（concat）」阶段定位，
  并记录出错片段 ID 与原因。已成功片段的中间片保留在 `intermediates/`。
- 在界面或工程中**只替换出错片段**后重新导出，其他片段复用既有中间片，不必全部重来。

## 6. 导出后校验项（verify）

| 检查 | 方法 |
|---|---|
| 输出尺寸/帧率/音轨 | ffprobe 回读成品，与输出设置逐项比对 |
| 总时长 | 实际容器时长 vs 各段时长之和（容差=每段 1 帧 + 60ms 编码余量） |
| 片段顺序 | 在每段时间窗中心抽帧，按主导通道色相特征与样例期望比对 |
| 交界黑帧 | 每个交界两侧各取一帧，用 `signalstats` 查平均亮度是否异常接近全黑 |
| 交界重复帧 | 比对交界两侧帧的平均 RGB，过近判定为重复片段 |
| 分段音频 | 逐段用 `astats` 读 RMS：源有声段应有能量，源无声段应保持静音 |

## 7. 自动化测试

```bash
python3 -m unittest tests.test_videojoiner -v
```

共 23 个用例，全部使用程序生成的本地样例，覆盖：

- 元数据探测（尺寸/帧率/声音/时长）与坏文件、缺失文件报错
- 不同尺寸、不同帧率（含 29.97 分数帧率）、无声片段的统一与拼接
- contain / cover 两种适配（黑边填充、居中裁切、滤镜层面保证不拉伸）
- 成品回读：时长、尺寸、帧率、片段顺序、交界黑帧/重复帧、分段音频 RMS
- 片段上移/重排改变输出顺序、移除、6 段上限、非法设置拦截
- 出错片段定位、单独替换后重新导出、工程文件保存/加载
- multipart 解析、HTTP 上传/移动/设置/删除/路径穿越拦截/完整导出校验接口

## 8. 目录结构

```
videojoiner/
  probe.py      ffprobe 元数据探测
  normalize.py  逐段统一规格（尺寸/帧率/像素格式/音频/静音补齐）
  concat.py     concat demuxer 流拷贝拼接
  project.py    时间线模型、导出流水线、工程持久化
  verify.py     成品回读校验
  samples.py    程序化样例生成、缩略图
  runner.py     ffmpeg 子进程与进度解析
  server.py     标准库 HTTP 服务（127.0.0.1）
  cli.py        命令行入口
  web/          前端页面（原生 HTML/CSS/JS，无外部依赖）
tests/
  test_videojoiner.py
run.sh          一键启动 Web 界面
```

## 9. 边界与约束

- 单条顺序时间线，最多 6 段；无转场、无多轨、无特效。
- 输出固定为 MP4（H.264 + AAC），输出宽高需为偶数（yuv420p 限制）。
- 工具面向本地可信文件；Web 服务仅监听回环地址，不要暴露到公网。
