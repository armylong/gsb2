# 脚步采样映射试播器

一个用 TypeScript + React + 浏览器 WebAudio 做的单键力度分层采样试播工具，
用于调试"同一键按力度换素材"时的交叉过渡、变体轮换与连按并发。

## 解决的核心问题

直接按力度硬切素材时，区域边缘会出现响度突变。本工具：

- 两个区域的**交叉区内按等功率曲线（cos/sin）混合**两条素材，权重平方和恒为 1，
  避免线性交叉中点的响度凹陷与边缘突兀；
- 每条素材可单独设增益（dB），先平衡素材自身响度再谈映射。

## 功能对照

| 需求 | 实现 |
| --- | --- |
| 一键挂多条内置/本地 WAV，分配力度范围，设两区域交叉 | `ZoneEditor`：区域 low/high 可重叠；`ZoneChart` 可视化交叉区；本地 WAV 存 IndexedDB |
| 交叉区按力度混合；素材未就绪可查原因；不漏播/不重复 | `planTrigger` 纯函数出计划；素材状态机 idle/loading/ready/error 带原因；每次触发在追加式 `Ledger` 中恰好一条 `trigger-started/blocked` |
| 每区域多条变体轮流；可查选中哪条；重置后同序列同结果 | 变体按 `counter % n` 轮转，台账记录 `variantIndex`；`resetRotation` 后纯函数保证确定性（有单测） |
| 连按/松键各次播放独立；最大并发数；可见被结束的旧声音 | 每次触发一个独立 voice（独立 gain 图）；超 `maxVoices` 偷最旧声并记 `voice-ended(reason=stolen)`；松键只结束本 pressId |
| 不同音色音量的合成样例；保存后重开继续 | 5 个 OfflineAudioContext 合成音色（固定种子噪声、不同峰值 dBFS）；映射+文件存 IndexedDB，"重开恢复"按钮模拟重开 |

## 快速开始

```bash
npm install
npm run dev        # 开发
npm test           # 纯逻辑单测（交叉权重/轮转确定性/拦截原因/校验/台账）
npm run build      # 类型检查 + 生产构建
npm run e2e        # 真实 Chromium 端到端冒烟（需 npx playwright install chromium）
```

打开后先点**启用音频**（浏览器自动播放策略要求用户手势）。
默认映射：轻力度区（1..88）与重力度区（64..127）在 64..88 交叉，每区 2 条变体，maxVoices=4。

## 关键操作

- **触发**：点试听垫 / 按空格（可在顶栏改键）；垫面按住左右拖动改力度，松键结束本次声音。
- **听交叉**：把力度滑到 64..88，事件台账里每次触发显示两个 layer 及各自 weight/gain。
- **查拦截**：把某区域改窄制造力度空洞，或上传一个非 WAV 文件，触发后台账给出 `no-zone / sample-loading / sample-error…` 及详情。
- **查确定性**：连按后点"重置轮转/序列"，再点"按原时间间隔重放"，对比台账中的 variantIndex 与权重。
- **查偷声**：把 maxVoices 调到 2 后快速连按，活动声音面板与台账显示哪些 voice 被 `stolen`。
- **持久化**：编辑后 800ms 自动防抖保存，也可手动"保存映射"；"重开恢复"从 IndexedDB 重新载入并解码。

## 架构

```
src/
  model/
    types.ts          可序列化领域模型 + 原因码
    mapping.ts        纯函数：区域命中、等功率权重、轮转计划、校验（含单测）
    ledger.ts         只追加事件台账（含单测）
  audio/
    synth.ts          固定种子的 OfflineAudioContext 合成音色
    engine.ts         AudioEngine：素材状态机、voice 图、偷声、松键、序列重放、快照缓存
    storage.ts        IndexedDB（映射 kv + WAV blob）
  state/
    preset.ts edits.ts useEngine.ts   默认映射、不可变编辑、React 绑定
  components/         React UI
```

设计约束：

- 音频决策（选哪条素材、权重多少）全部在 `model/` 纯函数中完成，不依赖 AudioContext，可单测；
  `AudioEngine` 只负责把计划接到 WebAudio 图上。
- `Ledger` 只暴露 append/recent/clear，已播出事件不可改写，从结构上杜绝漏记/重复记。
- 轮转计数器在**计划阶段**就推进，即使素材没就绪被拦也不跳过，保证重置后序列可复现。
