/**
 * OfflineRenderer —— 逐采样离线渲染整条序列。
 *
 * 渲染结果同时服务于：
 *  - 振幅曲线展示（RenderResult.amplitude，逐采样）；
 *  - 序列试听（同一份 PCM 送 AudioContext 播放）；
 *  - WAV 导出（同一份 PCM 编码）。
 *
 * 事件调度按采样索引取整（Math.round(time * sampleRate)），
 * 确定性、无时钟漂移，所以暂停后重新播放，触发点与曲线严格对齐。
 */
import type { TimbreParams } from './types';
import { VoiceEngine } from './VoiceEngine';
import type { KeySequence, SequenceEvent } from './sequence';
import { sortedEvents as sortEvents } from './sequence';

export interface RenderResult {
  sampleRate: number;
  /** 单声道输出 PCM（含振荡器波形），用于发声与 WAV 导出 */
  pcm: Float32Array;
  /** 逐采样纯振幅（包络×力度），用于曲线展示，长度与 pcm 相同 */
  amplitude: Float32Array;
  /** 每个事件实际落到的采样索引，供曲线叠加触发标记 */
  eventSamples: { event: SequenceEvent; sample: number }[];
  /** 总时长（秒），含最后一次 release 的完整尾音 */
  duration: number;
  /** 末尾静音采样数（最后一个非零采样之后），回读校验用 */
  tailSilence: number;
}

/**
 * @param tailPadding 渲染在最后事件之后额外保留的秒数，
 *                    确保任何 release 都能完整结束（默认 3 秒，足够常规包络）。
 */
export function renderSequence(
  sequence: KeySequence,
  baseParams: TimbreParams,
  sampleRate: number,
  tailPadding = 3,
): RenderResult {
  const events = sortEvents(sequence.events);
  const voice = new VoiceEngine(baseParams, sampleRate);
  voice.reset();

  // 事件 → 采样索引分桶
  const buckets = new Map<number, SequenceEvent[]>();
  let lastSample = 0;
  const eventSamples: RenderResult['eventSamples'] = [];
  for (const ev of events) {
    const s = Math.max(0, Math.round(ev.time * sampleRate));
    const list = buckets.get(s);
    if (list) list.push(ev);
    else buckets.set(s, [ev]);
    eventSamples.push({ event: ev, sample: s });
    lastSample = Math.max(lastSample, s);
  }

  const totalSamples = lastSample + Math.ceil(tailPadding * sampleRate) + 1;
  const pcm = new Float32Array(totalSamples);
  const amplitude = new Float32Array(totalSamples);

  for (let i = 0; i < totalSamples; i++) {
    const due = buckets.get(i);
    if (due) {
      for (const ev of due) {
        if (ev.type === 'noteOn') {
          voice.noteOn(ev.velocity ?? 1);
        } else if (ev.type === 'noteOff') {
          voice.noteOff();
        } else if (ev.type === 'paramChange' && ev.params) {
          if (ev.mode === 'live') voice.setParamsLive(ev.params);
          else voice.setParamsPending(ev.params);
        }
      }
    }
    pcm[i] = voice.process();
    amplitude[i] = voice.amplitude();
  }

  // 末尾静音统计：最后一个超过本底噪声的采样之后的长度
  const noiseFloor = 1e-6;
  let lastAudible = -1;
  for (let i = totalSamples - 1; i >= 0; i--) {
    if (Math.abs(pcm[i]) > noiseFloor) {
      lastAudible = i;
      break;
    }
  }
  const tailSilence = lastAudible < 0 ? totalSamples : totalSamples - 1 - lastAudible;

  return {
    sampleRate,
    pcm,
    amplitude,
    eventSamples,
    duration: totalSamples / sampleRate,
    tailSilence,
  };
}

/** 渲染单个「按住 duration 秒后松开」的音符，用于手动按键即时试听。 */
export function renderOneShot(
  params: TimbreParams,
  durationSeconds: number,
  sampleRate: number,
  velocity = 1,
): RenderResult {
  const seq: KeySequence = {
    name: 'one-shot',
    events: [
      { id: 'on', time: 0, type: 'noteOn', velocity },
      { id: 'off', time: Math.max(0, durationSeconds), type: 'noteOff' },
    ],
  };
  return renderSequence(seq, params, sampleRate);
}
