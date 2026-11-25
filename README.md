# ADSR 短包络编辑器 · 断音与再触发检查

给动画段落配背景音之前，先用它检查一套合成音的**断音（staccato）与再次触发（retrigger）**。
一次只管一种音色（一个振荡器波形 + 一条 ADSR 包络），用 TypeScript + React + 浏览器音频实现。

## 核心设计：只有一个声音过程

整条链路只有一份逐采样代码 `src/audio/VoiceEngine.ts`，它同时跑在三个地方：

| 用途 | 运行位置 | 说明 |
| --- | --- | --- |
| 振幅曲线、序列回放、WAV 导出 | `OfflineRenderer` 离线逐采样渲染 | 产出同一份 `pcm`（发声）与 `amplitude`（曲线） |
| 手动按键实时试听 | `AudioWorklet`（音频线程） | worklet 内 `new VoiceEngine(...)`，与离线同源 |
| 单元测试 | Node | 直接驱动状态机断言行为 |

因此「听到的」和「曲线画出来的」振幅严格出自同一个过程，不存在两套实现漂移。

## 五条需求的落实位置

1. **画 ADSR 包络并同步发声**
   `EnvelopeEditor`（可拖拽拐点 + 曲线形状）与 `VoiceEngine` 的
   attack/decay/sustain/release 四段状态机；每段带 -1（凹）…+1（凸）的形状参数，
   端点恒为 0/1，相邻段连接处电平不变。

2. **提前松键 / 保持后松 / 刚松又按，试听与曲线同源**
   `noteOff()` 从当前电平进 release；release 途中 `noteOn()` 从当前电平重新 attack
   （振荡器相位不复位）。内置示例：断音、保持后松开、刚松开又按下。

3. **改包络：只影响下一次 vs 当前声音过渡**
   - `setParamsPending`：参数挂起，当前声音保持旧包络，下一次 `noteOn` 才采用；
   - `setParamsLive`：以当前电平为锚点重建当前段（sustain 改值走 8ms 短滑），
     平滑过渡、无无缘由瞬时跳变；唯一允许的跳变来自用户刻意设置的零时长段。

4. **精确时刻回放、暂停重播一致、零时长段可验证**
   事件按 `Math.round(time * sampleRate)` 分桶调度，逐采样确定；
   `PcmPlayer` 暂停只记录偏移，恢复后触发点相对位置不变。
   零时长段在同一采样内连锁推进（`advanceFromZeroLength`），
   同时刻 noteOn+noteOff 的零长度音也能正常渲染。内置「零时长段与零长度音」示例。

5. **导出 WAV 并回读对照，含弱长音接强短音示例**
   `wav.ts` 纯 TS 实现 16-bit PCM 编码与多 chunk 宽容解码；
   `WavVerifyPanel` 回读校验：采样率/格式/采样数、包络形状相关度（Pearson r > 0.995）、
   逐采样最大偏差、结尾静音长度差、起始对齐。内置「弱长音接强短音」示例
   （velocity 0.3 长音保持中，velocity 1.0 短音再触发）。

## 目录结构

```
src/audio/
  VoiceEngine.ts        逐采样 ADSR 状态机（唯一声音过程）
  OfflineRenderer.ts    序列 → pcm + amplitude 的确定性渲染
  RealtimeVoice.ts      AudioWorklet 主线程封装 + PcmPlayer（暂停/跳转）
  envelope-worklet.ts   worklet 处理器（Vite ?worker 管线打成单文件）
  wav.ts                WAV 编码 / 解码 / 尾静音统计
  sequence.ts           按键事件模型与确定性排序
  presets.ts            五个内置检查示例
  types.ts              音色/包络参数与钳制
src/components/
  EnvelopeEditor.tsx    可拖拽 ADSR 模板图
  AmplitudeChart.tsx    实际振幅曲线（事件标记/播放头/十字线）
  EventTable.tsx        精确时刻事件编辑
  WavVerifyPanel.tsx    导出与回读对照
e2e/smoke.mjs           Playwright 端到端冒烟（真实 Chromium + AudioWorklet）
```

## 命令

```bash
npm install
npm run dev        # 本地开发
npm test           # 26 个单元测试（Vitest）
npm run build      # 类型检查 + 生产构建
npm run e2e        # 端到端冒烟（需先 npm run dev；使用本机缓存的 Chromium）
```

操作：拖动包络拐点（Shift 拖动改曲线凹凸）、空格或按钮按住发声、
事件表精确到毫秒录入、点击振幅曲线移动播放头。
