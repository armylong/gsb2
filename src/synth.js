// 程序化声源：三种可区分的音色全部由振荡器与滤波噪声实时合成，不使用任何外部录音素材。
// 调度全部走音频时钟（setValueCurveAtTime），不依赖 setInterval：
// 既兼容 OfflineAudioContext 的挂起渲染（自动化测试），也不会在页面切到后台时丢节拍。
// 每个合成器返回 { output: GainNode, stop(): void }，输出接到各自的声像节点。

// 生成一段周期为 period、时长 duration、按 curve 函数成形的增益曲线
function makePeriodicCurve(duration, period, curve, sampleRate) {
  const length = Math.max(2, Math.floor(duration * sampleRate));
  const data = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const phase = (i / sampleRate) % period / period;
    data[i] = curve(phase, i / sampleRate);
  }
  return data;
}

// 声源 A：有节奏的低频脉冲（正弦波 + 周期性指数感衰减包络），便于辨别远近与节拍
function createPulseSynth(ctx) {
  const output = ctx.createGain();
  output.gain.value = 1;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 220;
  // 音高随周期轻微下滑，增强“脉冲”质感
  const pitchCurve = makePeriodicCurve(
    64, 0.48,
    (phase) => 320 - 200 * phase,
    ctx.sampleRate,
  );
  osc.frequency.setValueCurveAtTime(pitchCurve, ctx.currentTime, 64);

  // 每 0.48s 一个快速起振、指数衰减的包络
  const envCurve = makePeriodicCurve(
    64, 0.48,
    (phase) => (phase < 0.5 ? Math.max(0.0001, Math.exp(-phase * 14) * 0.9) : 0.0001),
    ctx.sampleRate,
  );
  const env = ctx.createGain();
  env.gain.setValueCurveAtTime(envCurve, ctx.currentTime, 64);

  osc.connect(env).connect(output);
  osc.start();
  return {
    output,
    stop() {
      try { osc.stop(); } catch { /* 已停止 */ }
      output.disconnect();
    },
  };
}

// 声源 B：持续和声垫（三个失谐三角波 + 慢速 LFO 调制），便于辨别左右方位
function createPadSynth(ctx) {
  const output = ctx.createGain();
  output.gain.value = 0.5;
  const oscs = [];
  [220, 277.18, 329.63].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    osc.detune.value = i === 0 ? -6 : 6;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.25 + i * 0.13;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 2.5;
    lfo.connect(lfoGain).connect(osc.frequency);
    osc.connect(output);
    osc.start();
    lfo.start();
    oscs.push(osc, lfo);
  });
  return {
    output,
    stop() {
      oscs.forEach((o) => {
        try { o.stop(); } catch { /* 已停止 */ }
      });
      output.disconnect();
    },
  };
}

// 声源 C：滤波噪声颗粒（白噪声 + 带通 + 周期性随机颗粒门控），高频丰富，距离衰减最容易听出
function createGrainSynth(ctx) {
  const output = ctx.createGain();
  output.gain.value = 0.4;

  const bufferSize = 2 * ctx.sampleRate;
  const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = noiseBuffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  const bandpass = ctx.createBiquadFilter();
  bandpass.type = 'bandpass';
  bandpass.frequency.value = 1800;
  bandpass.Q.value = 1.2;

  // 每 0.13s 一个颗粒：窗口前 8% 起振，随后指数衰减，其余时间静音
  const gateCurve = makePeriodicCurve(
    64, 0.13,
    (phase) => (phase < 0.08 ? phase / 0.08 * 0.8 : phase < 0.85 ? Math.max(0.0001, 0.8 * Math.exp(-(phase - 0.08) * 12)) : 0.0001),
    ctx.sampleRate,
  );
  const gate = ctx.createGain();
  gate.gain.setValueCurveAtTime(gateCurve, ctx.currentTime, 64);

  noise.connect(bandpass).connect(gate).connect(output);
  noise.start();

  return {
    output,
    stop() {
      try { noise.stop(); } catch { /* 已停止 */ }
      output.disconnect();
    },
  };
}

const SYNTH_FACTORIES = {
  pulse: createPulseSynth,
  pad: createPadSynth,
  grain: createGrainSynth,
};

export function createSynth(ctx, type) {
  const factory = SYNTH_FACTORIES[type];
  if (!factory) throw new Error(`未知声源类型: ${type}`);
  return factory(ctx);
}
