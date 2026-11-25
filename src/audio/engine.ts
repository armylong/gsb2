import { midiToFreq } from './notes';
import { sampleCurve } from './curve';
import type { FmPatch } from './types';

export interface ActiveVoice {
  midi: number;
  patch: FmPatch;
  carrier: OscillatorNode;
  modulator: OscillatorNode;
  modGain: GainNode;
  voiceGain: GainNode;
  startTime: number;
  modelTime: number;
  /** 起音时使用的载波频率, 之后平滑追赶参数变化 */
  baseCarrierHz: number;
  stopped: boolean;
}

export function carrierFreqFor(patch: FmPatch, midi: number): number {
  return patch.carrierMode === 'fixed' ? patch.fixedCarrierHz : midiToFreq(midi);
}

/**
 * 调制深度(频率偏移)包络调度。
 *
 * 量纲关键点: modGain 的输出接到 carrier.frequency (单位 Hz), 因此增益值是
 * "峰值频率偏移 Δf(t)", 而不是调制指数 I。两者关系为 Δf(t) = I(t)·fm。
 * 曲线按归一化 t∈[0,1] 展开到 [start, start+modelTime], 之后钳制在末点值。
 * 实时试听与离线导出共用此函数 => 两者的深度包络完全一致。
 */
export function scheduleDepthEnvelope(
  param: AudioParam,
  patch: FmPatch,
  start: number,
  modelTime: number,
  modulatorHz: number,
): void {
  param.cancelScheduledValues(start);
  param.setValueAtTime(patch.modDepth * patch.depthCurve[0].v * modulatorHz, start);
  for (let i = 1; i < patch.depthCurve.length; i++) {
    const p = patch.depthCurve[i];
    param.linearRampToValueAtTime(
      patch.modDepth * p.v * modulatorHz,
      start + p.t * modelTime,
    );
  }
  const last = patch.depthCurve[patch.depthCurve.length - 1];
  param.setValueAtTime(patch.modDepth * last.v * modulatorHz, start + modelTime + 0.0001);
}

/**
 * 对正在发声的声音从"当前时刻"起重排深度包络, 不重建振荡器、不重触发起音。
 * 用于按住按键时拖动深度或编辑曲线。
 */
export function rescheduleDepthFromNow(voice: ActiveVoice, now: number): void {
  const patch = voice.patch;
  const modulatorHz = voice.baseCarrierHz * patch.modRatio;
  const u = (now - voice.startTime) / voice.modelTime;
  const current = patch.modDepth * sampleCurve(patch.depthCurve, u) * modulatorHz;
  const param = voice.modGain.gain;
  param.cancelScheduledValues(now);
  param.setValueAtTime(current, now);
  for (const p of patch.depthCurve) {
    const tAbs = voice.startTime + p.t * voice.modelTime;
    if (tAbs > now) {
      param.linearRampToValueAtTime(patch.modDepth * p.v * modulatorHz, tAbs);
    }
  }
  const last = patch.depthCurve[patch.depthCurve.length - 1];
  if (now < voice.startTime + voice.modelTime) {
    param.setValueAtTime(
      patch.modDepth * last.v * modulatorHz,
      voice.startTime + voice.modelTime + 0.0001,
    );
  }
}

/**
 * 建立一个 FM 钟声声音并调度振幅包络。
 * 信号链:
 *   modOsc -> modGain(指数包络) -> carrier.frequency (AudioParam, 真 FM)
 *   carrier -> voiceGain(振幅包络) -> destination
 */
export function createFmBellVoice(
  ctx: BaseAudioContext,
  destination: AudioNode,
  midi: number,
  patch: FmPatch,
  start: number,
): ActiveVoice {
  const carrierHz = carrierFreqFor(patch, midi);
  const modulatorHz = carrierHz * patch.modRatio;

  const carrier = ctx.createOscillator();
  carrier.type = 'sine';
  carrier.frequency.setValueAtTime(carrierHz, start);

  const modulator = ctx.createOscillator();
  modulator.type = 'sine';
  modulator.frequency.setValueAtTime(modulatorHz, start);

  const modGain = ctx.createGain();
  modGain.gain.setValueAtTime(0, start);
  scheduleDepthEnvelope(modGain.gain, patch, start, patch.modelTime, modulatorHz);

  const voiceGain = ctx.createGain();
  voiceGain.gain.setValueAtTime(0, start);
  // 振幅: 短起音 + 指数自然衰减, 末值 1e-5(约 -100dB)
  voiceGain.gain.linearRampToValueAtTime(patch.outputGain, start + patch.attackTime);
  voiceGain.gain.exponentialRampToValueAtTime(
    Math.max(1e-5, patch.outputGain * 1e-5),
    start + patch.decayTime,
  );

  modulator.connect(modGain);
  modGain.connect(carrier.frequency);
  carrier.connect(voiceGain);
  voiceGain.connect(destination);

  carrier.start(start);
  modulator.start(start);

  return {
    midi,
    patch,
    carrier,
    modulator,
    modGain,
    voiceGain,
    startTime: start,
    modelTime: patch.modelTime,
    baseCarrierHz: carrierHz,
    stopped: false,
  };
}

/** 声音自然消失的时刻(振幅包络走到末值后再留一点余量) */
export function voiceEndTime(patch: FmPatch, start: number): number {
  return start + Math.max(patch.decayTime, patch.modelTime) + 0.05;
}

export function stopVoice(voice: ActiveVoice, at: number): void {
  if (voice.stopped) return;
  voice.stopped = true;
  try {
    voice.carrier.stop(at);
    voice.modulator.stop(at);
  } catch {
    /* 已停止则忽略 */
  }
  voice.carrier.onended = () => {
    voice.carrier.disconnect();
    voice.modulator.disconnect();
    voice.modGain.disconnect();
    voice.voiceGain.disconnect();
  };
}

/** 离线渲染: 与实时声音同一条建声路径, 保证导出 WAV 与试听包络一致 */
export async function renderOffline(
  patch: FmPatch,
  midi: number,
  sampleRate: number,
): Promise<AudioBuffer> {
  const duration = voiceEndTime(patch, 0);
  const ctx = new OfflineAudioContext(1, Math.ceil(duration * sampleRate), sampleRate);
  const voice = createFmBellVoice(ctx, ctx.destination, midi, patch, 0);
  stopVoice(voice, duration);
  return ctx.startRendering();
}
