# 主备信号切换回放器

一个纯本地的 TypeScript + 浏览器媒体 API 练习工具：用两段自生成的 A/B 测试视频模拟导播在主路停顿、掉线、恢复和快进追赶时的切换决策。所有故障、选举和时间轴事件都由程序模拟，不依赖外部视频或后端服务。

## 快速开始

```bash
npm install
npm run dev
```

打开 Vite 输出的 `http://127.0.0.1:5173/`。

生产构建与本地预览：

```bash
npm run build
npm run preview
```

## 验证

核心状态机单测：

```bash
npm test
```

真实 Chrome 端到端验证（会自动构建、启动 `vite preview`，检查实际 `<video>.currentTime/paused/readyState`、Canvas 颜色、DOM 提示、拖动复现和截图）：

```bash
npm run verify:browser
```

如 Chrome 不在默认位置：

```bash
CHROME_PATH="/path/to/Google Chrome" npm run verify:browser
```

截图输出到 `tmp/browser-verification/`。

## 自生成视频

仓库已包含生成好的：

- `public/media/program-a.mp4`：蓝色 A 主路
- `public/media/backup-b.mp4`：橙色 B 备路

两段视频都有相同的 30fps 帧号 `Fxxxx`、内容时间 `T+x.xxxs`、移动标记和统一时间基准。可重新生成：

```bash
npm run generate:media
MEDIA_DURATION=30 npm run generate:media
```

生成脚本 `scripts/generate-media.mjs` 会启动本机 Chrome，使用 Canvas 逐帧绘制，再通过 `MediaRecorder` 编码为 MP4（不支持时自动选择 WebM）。

## 已实现的导播规则

1. **故障确认**：掉线确认窗 `450ms`，停顿确认窗 `650ms`，避免瞬时抖动触发切换。
2. **同 PTS 切换**：主路故障后，以主路最后有效 PTS 为目标选择备路帧；核心记录 `Δ前 → Δ后`，界面同时显示从真实 `<video>` 采集的 `实测 Δ前 / seek 后 Δ`。
3. **快进追赶**：恢复路以 `4×` 追赶广播时间轴；差距超过 `7.5s` 时，预计无法在 `2.5s` 操作窗口内追上，界面显示红色“追不上”反馈，并可手动硬对齐。
4. **稳定防抖**：备路在播时，主路必须同步且连续稳定 `1.15s`，并经过 `0.8s` 切换保持窗，才按主优先规则回切，避免反复横跳。
5. **锁定规则**：可锁定自动 / A / B。锁定期间不自动逃走；锁定路故障时显示 `LOCKED-BAD`，取消锁定后立即重新选举。
6. **同时恢复并列规则**：锁定路优先 → 当前在播路优先 → 固定主路 A 优先。
7. **两路均故障**：节目 Canvas 保留最后帧并压暗，DOM/Canvas 显示 `NO SIGNAL`，时间轴继续前进，任一路恢复后按规则恢复。

## 回放、拖动与复现

- 内置 **片段 1：仅主路掉线** 和 **片段 2：先后两路掉线并同时恢复**。
- 时间轴是确定性的事件溯源状态机：内置脚本和手动操作都是带内容时间的 Cue；任意位置都由 `deriveState(cues, duration, time)` 重新计算。
- 暂停后拖动到故障附近，会暂停并 seek 两路真实视频，可检查：
  - 实测 `currentTime`、`paused`、`seeking`、`readyState`、`playbackRate`
  - 核心 PTS、帧号、差值、稳定时长、追赶状态
- 从故障前再次播放，会重新经过同一组 Cue 和切换判定；同一切换的“复现次数”和实测时间差会累积显示。
- 时间轴标记和事件流水列出每次掉线、锁定、切换、无信号和恢复原因；点击事件可跳到对应时刻，详情面板提供“从该切换前 0.85s 复现”。

也可通过浏览器控制台访问调试 API：

```ts
window.__switchReplay.getState()       // 确定性核心状态
window.__switchReplay.getActual()      // 两个真实 video 元素状态
window.__switchReplay.getEvidence()    // 实测切换时间差
window.__switchReplay.seek(3, true)    // 跳到 3s 并播放
```

## 代码结构

```text
src/core/       纯 TS 类型、场景 Cue、确定性切换状态机、时间轴事件
src/media/      HTMLVideoElement 同步与节目 Canvas 绘制
src/ui/         DOM 布局和 HUD/事件详情渲染
scripts/        视频生成与真实 Chrome 验证脚本
tests/          切换规则单测
public/media/   自生成 A/B 视频
```
