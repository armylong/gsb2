import { Mapping, Sample, Zone, uid } from '../model/types';
import { BUILTIN_SYNTHS, builtinSample } from '../audio/synth';

/**
 * 默认映射：两个区域在 64..88 交叉，每区域 2 条变体轮转。
 * 轻区用很轻/轻的音色，重区用响/亮的音色，交叉时等功率混合，
 * 配合默认 maxVoices=4 可以直接听出过渡、轮换和连按。
 */
export function defaultMapping(): Mapping {
  const samples: Sample[] = BUILTIN_SYNTHS.map(builtinSample);
  const byId = (id: string): Sample => samples.find((s) => s.id === id)!;

  const softA = byId('synth-muffled-low');
  const softB = byId('synth-soft-thud');
  const hardA = byId('synth-wood-tap');
  const hardB = byId('synth-stone-crack');

  const zones: Zone[] = [
    {
      id: uid('z'),
      label: '轻力度',
      low: 1,
      high: 88,
      variants: [
        { id: uid('v'), sampleId: softA.id },
        { id: uid('v'), sampleId: softB.id },
      ],
    },
    {
      id: uid('z'),
      label: '重力度',
      low: 64,
      high: 127,
      variants: [
        { id: uid('v'), sampleId: hardA.id },
        { id: uid('v'), sampleId: hardB.id },
      ],
    },
  ];

  return {
    keyId: 'key-main',
    keyLabel: '试听键',
    triggerCode: 'Space',
    maxVoices: 4,
    zones,
    samples,
  };
}

/** 深拷贝（映射是纯数据，structuredClone 在所有现代浏览器可用） */
export function cloneMapping(m: Mapping): Mapping {
  return structuredClone(m);
}
