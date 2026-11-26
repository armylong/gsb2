import type { PlaySettings, Project, Segment, VoiceName } from './types';
import { makeId } from './timeline';

export function defaultSettings(): PlaySettings {
  const defs: Record<VoiceName, { volume: number; pitch: number }> = {
    downbeat: { volume: 0.9, pitch: 1046.5 }, // C6
    beat: { volume: 0.6, pitch: 783.99 }, // G5
    sub: { volume: 0.32, pitch: 523.25 }, // C5
  };
  const voices = {} as PlaySettings['voices'];
  (Object.keys(defs) as VoiceName[]).forEach((name) => {
    voices[name] = { volume: defs[name].volume, pitch: defs[name].pitch, timbre: 'sine' };
  });
  return { voices, playSubdivisions: true };
}

function seg(partial: Omit<Segment, 'id'>): Segment {
  return { id: makeId(), ...partial };
}

/**
 * 内置练习:
 *  A. 3/4, 带 1 拍弱起 + 2 个满小节, 90 BPM
 *  B. 5/4, 2 小节, 突然变速到 132 BPM (边界处速度突变, 时间连续)
 *  C. 4/4, 3 小节, 100→150 BPM 线性渐快 (从渐变任意位置开始拍点都对齐)
 */
export function createExampleProject(): Project {
  const segments: Segment[] = [
    seg({
      label: 'A 三拍 (弱起)',
      meter: { numerator: 3, denominator: 4 },
      bars: 3,
      pickupBeats: 1,
      subdivision: 2,
      mode: 'constant',
      bpmStart: 90,
      bpmEnd: 90,
    }),
    seg({
      label: 'B 五拍 (突然变速 132)',
      meter: { numerator: 5, denominator: 4 },
      bars: 2,
      pickupBeats: 0,
      subdivision: 3,
      mode: 'constant',
      bpmStart: 132,
      bpmEnd: 132,
    }),
    seg({
      label: 'C 渐快 100→150',
      meter: { numerator: 4, denominator: 4 },
      bars: 3,
      pickupBeats: 0,
      subdivision: 2,
      mode: 'ramp',
      bpmStart: 100,
      bpmEnd: 150,
    }),
  ];
  return { segments, settings: defaultSettings() };
}

export function createEmptyProject(): Project {
  return {
    segments: [
      seg({
        label: '段 1',
        meter: { numerator: 4, denominator: 4 },
        bars: 4,
        pickupBeats: 0,
        subdivision: 2,
        mode: 'constant',
        bpmStart: 100,
        bpmEnd: 100,
      }),
    ],
    settings: defaultSettings(),
  };
}
