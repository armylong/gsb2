# 验证说明

所有验证均在本机完成，不依赖网络。运行：

```bash
bash scripts/run_tests.sh
# 或：python3 -I -m unittest discover -s tests -v
```

测试会用 ffmpeg 在系统临时目录生成样例视频（彩色移动方块 + 网格 + 每秒
哔声），跑完自动保留在临时目录，可手动复查。

## 1. 关键点之间的移动（无跳变、位置正确）

| 用例 | 文件 | 验证方式 |
|---|---|---|
| 线性/平滑插值的端点保持、中点值、连续性 | `test_keyframes.py::TestInterpolation` | 关键点两侧 1ms 处取值差 ≤1px；smoothstep 起步速度≈0、全程单调 |
| ffmpeg 时间表达式与 Python 插值一致 | `test_ffmpeg_e2e.py::TestFFmpegExpressionLive`、`test_parity.py` | 生成的 `crop=x=表达式` 实跑通过；Node 执行 JS 核心与 Python 在 320 组随机时刻上逐值相等、表达式字符串完全相同 |
| 导出视频的实际取景位置 | `test_ffmpeg_e2e.py::TestExportMovementAndBounds.test_movement_matches_keyframes` | 在 5 个时刻把导出帧与“源同帧按插值 x 固定裁切”的参考帧做 PSNR，均 >30dB |
| 无单帧跳变 | `test_smoothstep_has_no_jump` | 抽 50 帧比较相邻帧差异，任一对不超过平均差异的 4 倍 |
| 逐帧几何核对（人工补充验证） | 见下方“手动复核” | 干净黑底单方块样例上，18 个抽样帧的红块左缘与参考裁切完全相同 |

## 2. 取景边界限制（不出画面、无空白）

- `test_keyframes.py::TestClamp`：越界 x 被夹到 `[0, 显示宽-裁切宽]`，
  对越界关键点插值的 50 个时刻结果始终在界内。
- `TestNormalize.test_sorts_and_clamps`：关键点 x=5000 / x=-90 被夹紧。
- ffmpeg 表达式整体包一层 `clip(...,0,上界)`，过滤器内逗号已转义，
  保证即使浮点误差也不会请求画面外像素。
- `test_no_blank_edges`：导出视频四条边缘逐像素统计，纯黑像素占比 <2%
  （testsrc2 网格/文字允许极少量黑），不存在出界造成的黑边。

## 3. 旋转视频（90/180/270）

`test_ffmpeg_e2e.py::TestRotation`：

- 三种角度生成的样例，ffprobe 读到正确的 Display Matrix 与显示尺寸；
- 烤正代理旋转为 0、像素尺寸 = 源显示尺寸；
- 导出结果旋转恒为 0、尺寸为满高 9:16；
- `test_rotated_output_content_matches_autorotated_source`：旋转源导出的
  画面与“烤正代理裁切”参考在 t=2s 的 PSNR >30dB，证明方向正确而非镜像/转置。

## 4. 导出结果与音画同步

- 尺寸/时长：`test_output_dimensions_and_duration` 断言 404×720、
  旋转 0、时长与源差 <0.12s、含音频。
- 音频存在性：源有音频时导出必须有音频（前端核对面板也会标红丢失情况）。
- 同步（`TestAudioSync`）：样例音频是每秒一次的 100ms 哔声。把源和导出
  解成 48kHz 单声道 PCM：
  - `test_beep_onsets_aligned`：能量包络检出的哔声起点逐个对齐，偏差 <40ms；
  - `test_waveform_correlation_at_zero_lag`：零延迟波形相关系数 >0.9。

## 5. 失败时保留原设置

- `test_export_rejects_invalid_keyframes`（HTTP 层）：时间超范围的关键点
  返回 400，输出文件不会被创建；前端在发起前也会先校验，失败只弹错误。
- `test_bad_output_path_reports_error`：不可写目录导出任务状态为 error 且
  带回错误信息，project 字典内容前后不变。
- 工程保存用临时文件 + 原子替换，写到一半崩溃也不会破坏旧工程
  （`TestProjectRoundTrip`）。

## 6. HTTP 接口与安全

`test_server.py`：首页/静态资源 200、视频流支持 `Range: bytes=`（206，
拖动进度条依赖它）、路径穿越返回 404、样例/代理/导出/核对/工程存取全链路、
非法扩展名与不存在文件被拒绝。

## 手动复核步骤

1. `bash scripts/start.sh`，点“生成样例视频”，选“普通横屏样例”。
2. 在 t=0 把画框拖到最左并添加关键点；t=3s 拖到最右添加关键点；
   t=5.5s 拖回中间添加关键点。播放，观察画框平滑跟随、无跳变。
3. 尝试把画框拖出左右边缘——应停在边界，竖屏预览无黑边。
4. 导出后点“重新打开导出结果并核对”，确认 404×720、6.000s、音频“有”、
   旋转 0°；用播放器打开导出文件，听到的哔声与画面秒刻度对齐。
5. 改选“带 90° 旋转元数据样例”重复一遍：界面出现旋转角标，预览方向
   正常，导出为 720×1280 显示方向下的满高 9:16。
6. 故意把某关键点时间改成超过视频时长再导出——出现错误提示且关键点不变；
   点“恢复默认取景”可回到初始居中状态。
