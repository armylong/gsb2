/**
 * 确定性随机数与可复现测试序列。
 * mulberry32：同种子永远产出同一序列，保证“重开设置可重复得到同一序列”。
 */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 在 [min, max] 整数上均匀取一个。 */
export function randInt(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export interface SeqNote {
  midi: number;
  name: string;
  freq: number;
  /** 相对序列起点的开始时间（秒） */
  start: number;
  duration: number;
}

export interface TestSequence {
  seed: number;
  sampleRate: number;
  notes: SeqNote[];
  totalDuration: number;
}

/**
 * 生成短音高测试序列：以 C3 为基准，8 个音，
 * 半音偏移由种子决定（范围 -24..+36，跨 5 个八度），每音 0.45s、间隔 0.12s。
 * 同设置（同种子/采样率）输出逐 bit 一致。
 */
export function buildTestSequence(seed: number, sampleRate: number): TestSequence {
  const rng = mulberry32(seed);
  const baseMidi = 48; // C3
  const noteCount = 8;
  const duration = 0.45;
  const gap = 0.12;
  const notes: SeqNote[] = [];
  // 动态导入会破坏 node 测试的简单性，这里就地用 A440 公式
  for (let i = 0; i < noteCount; i++) {
    const offset = randInt(rng, -24, 36);
    const midi = baseMidi + offset;
    const start = i * (duration + gap);
    notes.push({
      midi,
      name: midiNameLocal(midi),
      freq: 440 * Math.pow(2, (midi - 69) / 12),
      start,
      duration,
    });
  }
  return {
    seed,
    sampleRate,
    notes,
    totalDuration: noteCount * (duration + gap) - gap,
  };
}

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function midiNameLocal(midi: number): string {
  return `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}
