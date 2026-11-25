import type { Cue, ScenarioId } from './types';

let cueSequence = 0;

export function cueId(prefix = 'cue'): string {
  cueSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${cueSequence}`;
}

export function resetCueIdsForTests(): void {
  cueSequence = 0;
}

export function primaryOnlyCues(): Cue[] {
  return [
    {
      id: 'scn1-a-drop',
      at: 3.2,
      kind: 'health',
      route: 'A',
      health: 'offline',
      label: '主路掉线',
    },
    {
      id: 'scn1-a-return',
      at: 8.0,
      kind: 'health',
      route: 'A',
      health: 'ok',
      recovery: 'ff',
      label: '主路恢复并 4× 快进追赶',
    },
  ];
}

export function bothSequentialCues(): Cue[] {
  return [
    {
      id: 'scn2-a-drop',
      at: 2.8,
      kind: 'health',
      route: 'A',
      health: 'offline',
      label: '主路先掉线',
    },
    {
      id: 'scn2-b-drop',
      at: 6.6,
      kind: 'health',
      route: 'B',
      health: 'offline',
      label: '备路随后掉线',
    },
    {
      id: 'scn2-both-return',
      at: 10.8,
      kind: 'health',
      route: 'A',
      health: 'ok',
      recovery: 'seek',
      label: '主备同时恢复并对齐',
    },
    {
      id: 'scn2-b-return',
      at: 10.8,
      kind: 'health',
      route: 'B',
      health: 'ok',
      recovery: 'seek',
      label: '主备同时恢复并对齐',
    },
  ];
}

export function cuesForScenario(id: ScenarioId): Cue[] {
  if (id === 'primary-only') return primaryOnlyCues();
  if (id === 'both-sequential') return bothSequentialCues();
  return [];
}
