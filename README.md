# FM 电铃合成器 (FM Bell Lab)

用浏览器原生 Web Audio 实现的调频(FM)合成小工具，用来对比不同参数下旧电铃的声音纹理。
纯前端、TypeScript、无运行时框架依赖。

## 运行

```bash
npm install
npm run dev        # 打开 http://localhost:5173
```

其他命令：

```bash
npm test           # 纯逻辑 + 渲染集成单测 (vitest)
npm run build      # 类型检查 + 生产构建到 dist/
node e2e/smoke.ts        # 端到端冒烟(需先 npm run dev)
node e2e/audio-verify.ts # 真实频谱 / 无重触发 / WAV 导出核对
```

## 实现要点与需求对照

### 1. 主音 + 一路调制音，频率比例、调制深度、分段曲线

- 信号链：调制器正弦 → 深度 GainNode → 载波 `frequency` AudioParam（真 FM，不是叠 Gain）。
- 调制比 `modRatio = fm / fc`；峰值调制指数 `I` 由滑块控制。
- **量纲**：接到频率参数的 GainNode 输出单位是 Hz，所以调度的是峰值**频率偏移**
  `Δf(t) = I(t)·fm`，而不是裸指数 I。深度曲线给出归一化的 `I(t)/I_peak`，在
  `engine.ts / scheduleDepthEnvelope` 里换算。
- 深度曲线是分段线性断点，可在 canvas 上加点 / 拖动 / 双击删除。

### 2. 固定频率 vs 跟随音高，按住时改参不重触发

- 载波有 `track`（= 所按音高）和 `fixed`（固定 Hz）两种模式，可在同一个按住的音符上来回切。
- 按住期间改任何参数都只对现有振荡器做 `AudioParam` 平滑追赶（指数/线性 ramp），
  **不新建振荡器、不重新 strike**。重复按下同一音符在 `FmEngine.noteOn` 被直接吞掉。
- 端到端测试通过计数 `createOscillator` 验证：按住重复按不增、松手重按才增。

### 3. 侧带标注与 Nyquist 提示

- FM 稳态分量幅度为贝塞尔函数 `J_n(I)`，频率为 `fc + n·fm`（`src/audio/bessel.ts` 幂级数实现）。
- 侧带表列出阶数 n、标称频率、采样后实际位置、相对电平(dB)与状态。
- 标称分量超过 Nyquist 时，按离散采样的三角折叠算出**真实别名频率**并标红，
  同时顶部给出警告；绝不把无法表示的标称频率当成可听位置谎报。负频率标为对偶分量。

### 4. WAV 导出，试听/导出包络一致，保留自然衰减

- 实时试听与离线导出共用同一个 `createFmBellVoice` 建声/包络函数，
  实时用 `AudioContext`、导出用 `OfflineAudioContext`，曲线调度完全相同。
- 导出时长 = `max(decayTime, modelTime) + 余量`，振幅包络指数衰减到约 -100dB，尾巴不截断。
- WAV 为 16-bit PCM 单声道（`src/audio/wav.ts`），文件名带音符与载波频率。

### 5. 两个内置示例 + 调制归零对照

- **近纯音**：I=0.15，非载波分量普遍低于 -20dB，接近纯正弦音叉。
- **强侧带电铃**：非谐波比 2.76 + I=4，多阶不和谐侧带形成金属铃质感。
- “调制归零”按钮把 I 设为 0：数学上 `J_0(0)=1`、其余 `J_n(0)=0`，频谱只剩载波，
  耳朵听到的也是纯正弦——频谱表、实时 FFT 与导出 WAV 三者可互相对照。

## 目录结构

```
src/audio/   纯音频逻辑(无 DOM): 贝塞尔、侧带分析、曲线、引擎(实时+离线)、WAV、预设
src/ui/      DOM 组件: 曲线编辑器、频谱视图、屏幕键盘
src/main.ts  状态与控件接线
test/        vitest 单测(含一个最小 WebAudio mock 的渲染集成测试)
e2e/         Playwright 真实浏览器端到端核对
```
