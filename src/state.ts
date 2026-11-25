/** 全局应用状态与可序列化设置（导出 JSON 后重开可完全复现）。 */
import { TABLE_SIZE, buildPreset, type PresetId, type RenderMode } from './dsp/wavetable';
import { buildTestSequence, type TestSequence } from './dsp/rng';

export const DEFAULT_SEED = 20261126;

export interface AppSettings {
  version: 1;
  presetId: PresetId | 'custom';
  /** 编辑后的原始波形（未去直流），长度 TABLE_SIZE */
  rawTable: number[];
  removeDc: boolean;
  mode: RenderMode;
  abMix: number;
  baseMidi: number;
  semitoneOffset: number;
  autoSweep: boolean;
  sweepRange: number;
  sweepSpeed: number;
  loudnessAlign: boolean;
  masterGain: number;
  seed: number;
  measureMode: RenderMode;
}

export function defaultSettings(): AppSettings {
  const table = buildPreset('notched', TABLE_SIZE);
  return {
    version: 1,
    presetId: 'notched',
    rawTable: Array.from(table),
    removeDc: true,
    mode: 'bandlimited',
    abMix: 1,
    baseMidi: 60, // C4
    semitoneOffset: 0,
    autoSweep: false,
    sweepRange: 24,
    sweepSpeed: 2,
    loudnessAlign: true,
    masterGain: 0.7,
    seed: DEFAULT_SEED,
    measureMode: 'bandlimited',
  };
}

export function sequenceFromSettings(s: AppSettings, sampleRate: number): TestSequence {
  return buildTestSequence(s.seed, sampleRate);
}

/** 校验导入的设置，失败时抛错带中文说明。 */
export function validateSettings(obj: unknown): AppSettings {
  if (typeof obj !== 'function' && (typeof obj !== 'object' || obj === null)) {
    throw new Error('设置文件不是 JSON 对象');
  }
  const o = obj as Record<string, unknown>;
  if (o.version !== 1) throw new Error(`不支持的设置版本：${String(o.version)}`);
  if (!Array.isArray(o.rawTable) || o.rawTable.length !== TABLE_SIZE) {
    throw new Error(`rawTable 必须是长度 ${TABLE_SIZE} 的数组`);
  }
  if (o.rawTable.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('rawTable 含有非数值');
  }
  const s = o as unknown as AppSettings;
  if (s.mode !== 'naive' && s.mode !== 'bandlimited') throw new Error('mode 取值非法');
  if (typeof s.seed !== 'number' || !Number.isInteger(s.seed)) throw new Error('seed 必须是整数');
  return s;
}
