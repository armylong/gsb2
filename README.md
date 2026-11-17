# 本地视频防抖工作台

一个纯本地运行的视频防抖工具，同时展示**防抖效果**与**有效画幅代价**。
Python（OpenCV/NumPy/SciPy/Flask）+ 单页网页，处理普通平移与旋转抖动，
不是全景拼接，不依赖任何账号或外部服务。

## 能力对照（对应需求条目）

| 能力 | 实现位置 |
| --- | --- |
| 导入 ≤15s、≤720p、CFR 的 mp4，单镜头或一次硬切，保留原音频 | `media.py` 校验 + ffmpeg 流拷贝音频 |
| 可调平滑强度，展示原始/平滑的水平、垂直位移与旋转路径 | `geometry.py` 趋势保持平滑 + 网页路径曲线 |
| 缓慢运镜保留、不整段定格 | `_robust_smooth`（线性趋势自适应保留，有防定格核验） |
| 原片/结果同步对比，暂停、逐帧、按时间定位，同一源帧 | 前端双 `<video>` 帧级同步 |
| 改参数后路径、画面、裁切一起更新，不残留旧结果 | 每次调参版本号递增，预览整体重渲染 |
| 逐帧有效边界、每镜头统一安全裁切、实际保留比例 | `geometry.build_geometry` + 叠加渲染 + 裁切表 |
| 不露黑边，裁切比例与导出一致，过小时告警 | 统一缩放取镜头最紧帧；保留比 <50% 红色告警 |
| 自动检测硬切并可手动校正，各镜头独立平滑/裁切 | `motion.py` 检测 + 网页切点编辑 |
| 硬切附近不跨镜头甩动/异常放大 | 切点处累积矩阵重置为单位阵，核验有专门检查 |
| 导出与预览一致的 mp4，原分辨率/帧率/帧数/音画同步 | 预览与导出共用同一 `full_warps` |
| 可重新打开输出核对同时刻画面、边界、保留比例 | 网页「重新打开核对」+ sidecar JSON |
| 本地生成带定位标记/帧号的样例及独立核对数据 | `samplegen.py`（答案只进 `ground_truth.json`） |
| 可重复的客观验证，不看主观评价 | `verify.py` 37 项像素级核验，PASS/FAIL + 退出码 |

## 目录结构

```
stabilizer/
  media.py      ffprobe/ffmpeg 封装、输入约束校验、音频提取与封装
  motion.py     角点+光流+RANSAC 帧间相似变换、ECC 回退、硬切检测
  geometry.py   分镜头路径累积、趋势保持平滑、有效区域/安全裁切几何
  pipeline.py   分析缓存、逐帧渲染、sidecar 元数据
  samplegen.py  合成测试样例（已知抖动/缓推/硬切 + ground truth）
  verify.py     独立核验（自己重估运动，不读处理中间量）
  webapp.py     Flask 本地服务与 API
  cli.py        命令行入口
  static/       单页前端
scripts/
  ui_smoke.py   无头 Chrome 驱动的 UI 冒烟测试
workspace/      运行期产物（gitignore）：tasks/、sample/、截图
```

## 1. 安装

需要本机已有的系统工具：`ffmpeg`、`ffprobe`（macOS：`brew install ffmpeg`）。

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

依赖：flask、numpy、scipy、opencv-python-headless（见 `requirements.txt`）。

## 2. 启动网页

```bash
.venv/bin/python -m stabilizer.webapp --port 8841
# 浏览器打开 http://127.0.0.1:8841
```

操作顺序：

1. 「生成合成样例」一键造数，或上传自己的 mp4；
2. 拖动「平滑强度 σ」，路径曲线、双视频预览、裁切表同步刷新；
3. 在「硬切帧」区增删/改正切点，各镜头独立处理；
4. 保留面积比低于 50% 会出现红色告警，此时应调低 σ；
5. 「按当前参数导出 MP4」，下载视频与 sidecar；
6. 用「重新打开核对」上传 `output.mp4` + `output.sidecar.json` 复核。

快捷键：空格 播放/暂停，←/→ 上一帧/下一帧。

## 3. 命令行用法

```bash
# 分析并导出（自动检测硬切，σ=8）
.venv/bin/python -m stabilizer.cli input.mp4 out_dir --sigma 8
# 手动指定硬切首帧
.venv/bin/python -m stabilizer.cli input.mp4 out_dir --sigma 10 --cuts 200
```

## 4. 生成测试样例

```bash
mkdir -p workspace/sample
.venv/bin/python -m stabilizer.samplegen workspace/sample
# 产物:
#   sample_input.mp4    1280x720, 30fps, 360帧(12s), 含 AAC 正弦音频
#   ground_truth.json   每帧已知的有意运镜与抖动分量、硬切位置(帧200)
```

样例内容：两套不同纹理的场景、网格与十字定位标记、逐帧帧号；
镜头0 含右移 110px/上移 40px 的缓推，镜头1 含右移 90px/下移 55px/旋转 2.5°；
两镜头都叠加 1.7–6.1Hz 的平移/旋转抖动；第 200 帧硬切。
**正常处理链路（motion/geometry/pipeline/webapp/cli）不读取 ground_truth.json，
该文件只允许 verify.py 作为评分基准读取。**

## 5. 关键行为验证（可重复核对）

一条命令跑完整闭环（生成 → 防抖 → 独立核验）：

```bash
mkdir -p workspace/sample workspace/runs
.venv/bin/python -m stabilizer.samplegen workspace/sample
.venv/bin/python -m stabilizer.cli workspace/sample/sample_input.mp4 \
    workspace/runs --sigma 8
.venv/bin/python -m stabilizer.verify \
    --source workspace/sample/sample_input.mp4 \
    --output workspace/runs/output.mp4 \
    --sidecar workspace/runs/output.sidecar.json \
    --gt workspace/sample/ground_truth.json
```

`verify.py` 输出 37 项 PASS/FAIL，任一硬性检查失败则退出码为 1。
核验不是主观判断，而是重新打开输出视频做独立像素级测量：

- **规格一致**：分辨率/帧率/帧数/时长与源一致，sidecar 帧数完整；
- **无黑边**：输出最外圈像素近黑占比 <2%（字幕角标区域剔除）；
- **残余抖动**：对输出重新做光流运动估计，分镜头比较去趋势 RMS，
  三个通道高频抖动均需降低 ≥60%（实测 86–91%）；
- **缓动保留**：输出路径跨度对照 GT 有意运镜，保留 60–160%，
  并有独立的「未整段定格」检查；
- **硬切**：自动检测切点与 GT 容差 ±2 帧；输出无额外异常切换；
  镜头首帧校正量受限（≤15px、≤0.5°），两侧缩放差 ≤15%；
- **裁切自洽**：安全框铺满输出帧、保留比 = 1/zoom²、
  抽样帧安全框始终落在有效四边形内；
- **预览/导出同源**：用 sidecar 参数独立重算几何，与记录的逐帧四边形
  偏差 <0.05px、缩放一致，证明预览和导出走的是同一套变换；
- **硬切重置**：切点处累积矩阵必须为单位阵，杜绝跨镜头继承运动；
- **音频**：解码两端 PCM，流拷贝时逐样本一致，否则相关系数 ≥0.99；
- **闭环**：输出可重开、可按帧定位、可再次被运动分析。

最近一次实测结果（σ=8）：37/37 全部通过；两镜头统一缩放约 1.085×/1.091×，
保留面积比约 85%/84%，抖动降低 86–91%，缓动保留 80–112%。

UI 层冒烟（需要本机装有 Google Chrome）：

```bash
.venv/bin/pip install websocket-client
.venv/bin/python scripts/ui_smoke.py workspace/ui_smoke.png
```

它会用无头 Chrome 真实点击：生成样例 → 调参 → 等待预览/图表/裁切表 →
逐帧 → 导出 → 截图，并断言无页面运行时错误。

## 6. 算法与边界说明

- 运动模型为带单尺度的部分仿射（平移+旋转+均匀缩放），覆盖轻微平移/旋转抖动；
  不处理强透视变化、滚动快门、严重运动模糊。
- 硬切判据：RANSAC 内点率 <0.25 且有效匹配点不足，配合灰度差；
  ECC 相关系数 ≥0.5 时回退为同镜头；最小镜头长度 8 帧。
- 平滑：高斯低通为基准，用逐帧增量中位数与高斯斜率的一致性判断真实运镜，
  按显著性补回被核函数衰减的线性趋势——既压高频抖动，又不把缓推抹掉。
- 黑边消除：每帧求校正后有效四边形内、与输出同长宽比的最大居中矩形，
  镜头内取最紧一帧得统一缩放 S；所有帧用同一 S，保证全镜头无黑边且无呼吸缩放。
- 音频优先 `-acodec copy` 原样保留；遇到容器不兼容时回退 AAC 重编码，
  核验会如实报告是「逐样本一致」还是「高相关」。
