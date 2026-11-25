# 需求与实现对照

## 1. 同一入口两种有损编码, 先展示时长/响度差异, 可补静音并限制在共同有效范围
- `audio.full_process`: 参考 WAV 经两个 `EncodeSetting` 分别编码再解码 (`encode_decode`)。
- `measure_loudness`: ffmpeg `ebur128` (BS.1770) 集成响度 + 本地采样峰值。
- `active_range`: 20ms 窗 RMS、-50 dBFS 门限检测有效区间与头尾静音。
- `estimate_offset` + `align_buffers`: 归一化 FFT 互相关估计编码延迟样点偏移,
  取三路有效区间交集裁成等长; 不可信时退回有效起点对齐。
- 主窗口「处理结果」区同时给原始解码差异 (Δ时长/Δ响度/头静音/偏移) 与对齐后指标。

## 2. 同位置 A/B/X 切换, 试听片段与循环边界同步, 无额外跳停
- `player.GaplessPlayer`: 一个常驻 `QAudioSink` + 自定义拉流 `QIODevice`;
  `switch_source` 只替换缓冲字典中的 active key, 不 stop/start 设备, 读位置不变。
- 三路等长共用时间轴; 循环起止在设备层统一维护, 对任何音源生效, 回绕在 `readData` 内完成。
- 测试 `test_player.py`: 切换后位置不变且读出字节确属新源、跨边界回绕字节级正确。

## 3. 每轮 X 独立随机, 提交才揭示, 轮内重听来源不变
- `session.Session.start_round` 用 `secrets.choice(["A","B"])` 独立选源,
  存入 `Round.x_is`; 试听期间 UI 只能通过 X 槽位访问, 答案在 `submit` 后揭示。
- 轮次未结束前同一 Round 对象的 `x_is` 不变 (重新试听还是它)。
- 测试覆盖: 轮内恒定、40 轮抽样覆盖 A/B 两种结果、空提交/重复开始被拒绝。

## 4. 盲听/对齐/响度开关的前后变化可对比; 轮次中只能取消整轮换参数, 旧结果保留原设置
- 对齐/响度切换走 `rebuild_final`, 只从已解码原始缓冲重建, 不重新编码;
  指标区与增益区显示开关前后的数值。
- 盲听开关只改标签可见性, 不动音频。
- `_set_controls_locked(True)` 在轮次中锁死素材/编码/三个开关与处理按钮;
  `_option_changed`/`_blind_toggled` 检测到轮次中会拒绝并恢复勾选态。
- 每个 Round 快照 `SessionSettings`; 设置变化后另起 Session,
  导出按会话分组, 旧轮次保留作答时的设置。

## 5. 内置敲击/安静尾音样例; 导出只含已答轮次、分数与编码设置; 未开始不算错
- `build_sample_transients` (指数衰减瞬态+高频 ping)、`build_sample_quiet_tail`
  (长衰减和弦 + -60 dBFS 噪声底), 程序合成, 无外部素材依赖。
- `Session.export_record`: 仅 `status == "answered"` 的轮次进入 `rounds`,
  summary 给已答数、答对数、正确率; 取消轮次只在界面标注, 不进导出。
- 导出 JSON schema: `blindabx-export/v1`, 含每轮 settings 快照 (ffmpeg 参数、开关)。
