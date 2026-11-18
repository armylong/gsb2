# 时频选区音频修复工具 (Mac 本地)

针对录音中偶发的尖锐杂音, 在 **时频谱上框选区域** 做局部修复的桌面工具。
技术栈: Python + PySide6 + NumPy + SciPy + SoundFile。

## 功能边界

**做**: 时频框选、局部衰减 (窄带干扰)、邻域修补 (短暂局部异常)、
柔和边缘过渡、预览试听、撤销/重做/恢复原文件、WAV 导出。

**不做**: 批量转码、响度处理、多轨混音、生成式补全。
邻域修补是对选区邻域谱的插值估计, **不能恢复已经完全丢失的原始声音**;
当选区上下缺少有效参考频带时会直接拒绝处理并提示。

## 输入限制

- WAV, 时长 ≤ 60 秒, 单声道或立体声; 超长/多声道文件载入时拒绝并提示。
- 不改变采样率、声道数与总时长。

## Mac 运行

```bash
scripts/setup.sh      # 首次: 创建 .venv 并安装依赖 (优先 Homebrew Python 3.12)
./run.sh              # 启动 GUI
```

## 自动验证

```bash
./validate.sh         # 生成合成测试信号 + 运行全部 pytest (GUI 用 offscreen)
```

验证覆盖 (共 50 项):

| 要求 | 对应测试 |
| --- | --- |
| 不修改时的重建误差 (零强度 STFT 往返 < 1e-9) | `test_roundtrip_error_with_strength_zero` |
| 选区外样本逐样本不变 (时域 crossfade 约束) | `test_outside_region_sample_exact`, `test_outside_spectrum_preserved` |
| 边缘连续性 (无爆音、频域软掩码单调) | `test_no_edge_clicks`, `test_frequency_edge_smoothness` |
| 双通道同步/不串音/不折叠/单侧处理 | `test_unselected_channel_identical`, `test_stereo_linked_*`, `test_single_channel_touch_only_one` |
| 撤销/重做/恢复原文件/联动撤销 | `test_commit_then_undo_redo_restore`, `test_undo_restores_both_channels_together` |
| 预览不叠加、取消不留半次修改、导出只写确认态 | `test_preview_never_stacks`, `test_cancel_preview_*`, `test_export_writes_confirmed_only` |
| 空选区/越界反馈 | `test_empty_selection_rejected`, `test_out_of_range_clamped_or_rejected`, `test_tiny_drag_clears_selection` |
| 缩放不使选区漂移 | `test_selection_does_not_drift_on_zoom` |
| 首尾选区完整输出 | `test_selections_at_edges_complete[head/tail]` |
| 合成窄带干扰抑制目标 (≥15 dB, 实测约 18 dB) | `test_narrowband_suppression_target` |

抑制目标只针对 **合成的窄带干扰** 设定, 不承诺对所有真实噪声达到同样效果。

## 合成测试信号

```bash
.venv/bin/python -m tools.make_test_signals --outdir test_assets
```

- `clean.wav`: 干净立体声, 左右内容不同 (非折叠单声道);
- `damaged.wav`: 等长等采样率, 加入
  - 3.2 kHz 窄带持续音 (3.0–5.0 s, **仅左声道**, 验证不串音);
  - 两处短时宽带噪声爆发: 0.15–0.28 s 与 11.55–11.72 s (靠近首尾);
- `manifest.txt`: 噪声位置与参数说明。

## 界面操作

| 操作 | 方式 |
| --- | --- |
| 框选时间×频率 | 频谱区按住左键拖拽; 选区以绝对样本/Hz 存储, 缩放不漂移 |
| 平移 / 缩放 | 右键拖拽; 滚轮缩放时间, Shift+滚轮缩放频率 (或工具栏按钮) |
| 跳转播放头 | 频谱/波形区左键双击或单击 |
| 通道 | 立体声默认 L+R 联动, 可切仅 L / 仅 R; 联动撤销同时恢复两侧 |
| 预听 | "预听原声/预听修复" 播放选区+前后 300 ms 上下文, 统一播放头 |
| 确认/取消 | 参数调整中显示 "未确认预览"; 取消丢弃临时结果, 确认才入历史栈 |
| 导出 | 只写已确认状态; 有未确认预览时弹窗提示, 绝不写入成品 |

## 实现概要

- `audio_repair/processing.py`: STFT (2048/512) 软掩码处理。时间与频率
  双向余弦渐变; 最终再做一次时域 crossfade, 保证选区外逐样本不变。
- `audio_repair/document.py`: confirmed/preview 双状态 + 撤销重做栈
  (默认保留最近 10 次) + 原文件快照。
- `audio_repair/player.py`: QAudioSink 分段播放, 单一 `positionChanged`
  时间参数同时驱动两个视图。
- `audio_repair/widgets/spectrogram.py`: 波形概览 + 可缩放频谱,
  像素↔时间/频率映射集中管理, 视口与选区解耦。
