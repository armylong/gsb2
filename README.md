# 两段视频交接转场编辑器

本地运行的两段短视频接触式转场编辑工具: 各选一段保留区间, 在交接处应用
**叠化 / 水平推移 / 淡黑** 转场, 重叠区音画同步交接, 可预览、试听、逐帧检查并导出。

- 输出统一 720p(1280×720)、30 帧, 保持原比例并补黑边
- 转场时长 0.2–2.0s, 占用前段末尾与后段开头的重叠区
- 成品时长 = 两段保留长度之和 − 转场时长
- 视频用 ffmpeg `xfade`、音频用 `acrossfade`, 共用同一 offset/duration, 音画同起止

## 依赖安装(macOS)

```bash
brew install ffmpeg python@3.12   # 需要 ffmpeg 与 ffprobe
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt    # PySide6 + Pillow
```

## 启动

```bash
python main.py
```

界面流程: 载入 A(前)/B(后)两段不超过 8 秒的 mp4 → 各选保留区间 →
选转场类型/方向/时长 → **生成预览** → 查看三点抽帧、播放试听 → **导出 mp4**。

- 参数有任何改动, 预览立即标记"已过期", 导出被禁用, 必须重新生成 —— 旧结果不会冒充新结果
- "从交接前试听"从转场起点前 1 秒开始播放; "循环交接"在交接前后各 1 秒内循环
- "◀ 帧 / 帧 ▶"按 1/30s 步进定位, 时间读数与帧号对应同一版参数
- 界面实时显示两路声音在输出时间轴上的范围与重叠区
- 导出后自动回读实际时长/帧数/音频末端, 与预计值对比(限 1 帧内), 不会覆盖原始素材

## 生成样例

```bash
python -m transition_editor.samples --out-dir samples
```

生成 `sample_a.mp4`(红底、方块左移、880Hz 音)与 `sample_b.mp4`
(蓝底、方块右移、440Hz 音), 各 6 秒, 带帧号与每秒定时短音, 无需外部素材。

## 关键验证

```bash
python -m transition_editor.verify
```

对样例真实渲染叠化、推移(双向)、淡黑并逐项核对(全部来自真实输出):

1. 成品总时长/帧数/音频末端与预计值偏差 ≤ 1 个输出帧
2. 转场中点画面: 叠化为两色混合、推移两侧颜色方向正确、淡黑接近全黑
3. 首帧为 A 底色、末帧为 B 底色(转场外完整保留, 无意外空帧)
4. B 路声音在转场起点进入且不提前, A 路声音在转场终点消失

最近一次实跑结果(4 个用例 × 7 项, 全部 PASS, 详见 `python -m transition_editor.verify` 输出):

```
== fade ==        总时长 11.0000s/330帧 偏差0帧 · 中点 R=121 B=122 · B音起点 5.2s(期望5.0±0.3)
== slide-left ==  总时长 11.0000s/330帧 偏差0帧 · 中点左红右蓝 · B音起点 5.2s
== slide-right == 总时长 11.0000s/330帧 偏差0帧 · 中点左蓝右红 · B音起点 5.2s
== fadeblack ==   总时长 11.0000s/330帧 偏差0帧 · 中点亮度 19.2(<40) · B音起点 5.2s
== 汇总 == 全部通过
```

## 结构

```
main.py                     启动入口
transition_editor/
  media.py                  ffmpeg/ffprobe 封装与常量
  render.py                 转场方案、滤镜图、渲染、回读校验
  samples.py                样例生成(Pillow 绘帧 + ffmpeg 合成)
  verify.py                 无界面自动化核对
  app.py                    PySide6 界面
```
