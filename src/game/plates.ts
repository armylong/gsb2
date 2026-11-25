import type { PlateDef, PlateId, PuzzleDef } from './types';

// 六片公开铃片：音高与余音都是可学习的确定参数，声音由 audio/engine.ts 合成。
export const PLATES: PlateDef[] = [
  {
    id: 'cang',
    name: '苍音',
    subtitle: '青铜低音片',
    pitchLabel: 'G4 · 392.0 Hz',
    freq: 392.0,
    band: 'G',
    bandLabel: 'G4 低鸣带',
    decay: 2.6,
    decayWord: '悠长',
    partials: [
      { ratio: 1, gain: 1.0, decayFactor: 1.0, type: 'sine' },
      { ratio: 2.01, gain: 0.34, decayFactor: 0.62, type: 'sine' },
      { ratio: 2.74, gain: 0.22, decayFactor: 0.42, type: 'triangle' },
      { ratio: 5.4, gain: 0.08, decayFactor: 0.22, type: 'sine' },
    ],
    mallet: { gain: 0.16, freq: 2400, q: 1.1, dur: 0.035 },
    color: '#c98a4b',
    colorSoft: 'rgba(201,138,75,0.16)',
    learn: '音区最低，余音浑厚绵长，像远处钟声。',
    fineCode: 'G4/392/d2.6/dark',
  },
  {
    id: 'qing',
    name: '清越',
    subtitle: '白玉中音片',
    pitchLabel: 'C5 · 523.3 Hz',
    freq: 523.25,
    band: 'C',
    bandLabel: 'C5 清越带',
    decay: 1.5,
    decayWord: '中等',
    partials: [
      { ratio: 1, gain: 1.0, decayFactor: 1.0, type: 'sine' },
      { ratio: 2.0, gain: 0.28, decayFactor: 0.55, type: 'sine' },
      { ratio: 2.78, gain: 0.18, decayFactor: 0.38, type: 'triangle' },
      { ratio: 4.2, gain: 0.07, decayFactor: 0.25, type: 'sine' },
    ],
    mallet: { gain: 0.14, freq: 3200, q: 1.2, dur: 0.03 },
    color: '#7fb7a6',
    colorSoft: 'rgba(127,183,166,0.16)',
    learn: '音色干净通透，音高与余音都居中，最容易辨认。',
    fineCode: 'C5/523.25/d1.5/clear',
  },
  {
    // 近音高对之一：D5，余音极长
    id: 'shang',
    name: '悠商',
    subtitle: '紫铜长鸣片',
    pitchLabel: 'D5 · 587.3 Hz',
    freq: 587.33,
    band: 'Dn',
    bandLabel: 'D5 近邻音高带',
    decay: 3.6,
    decayWord: '极长',
    partials: [
      { ratio: 1, gain: 1.0, decayFactor: 1.0, type: 'sine' },
      { ratio: 2.0, gain: 0.42, decayFactor: 0.7, type: 'sine' },
      { ratio: 2.76, gain: 0.3, decayFactor: 0.5, type: 'triangle' },
      { ratio: 5.4, gain: 0.12, decayFactor: 0.28, type: 'sine' },
    ],
    mallet: { gain: 0.15, freq: 3600, q: 1.0, dur: 0.032 },
    color: '#9b7ed8',
    colorSoft: 'rgba(155,126,216,0.18)',
    learn: '与「浮烟」音高几乎相同，但余音极长，敲完后久久不散。',
    fineCode: 'D5/587.33/d3.6/long-dark',
  },
  {
    // 近音高对之二：比 D5 高约 15 音分，余音短促 —— 靠余音而非绝对音高区分
    id: 'fu',
    name: '浮烟',
    subtitle: '淬水短音片',
    pitchLabel: 'D5⁺ · 592.5 Hz',
    freq: 592.5,
    band: 'Dn',
    bandLabel: 'D5 近邻音高带',
    decay: 0.72,
    decayWord: '短促',
    partials: [
      { ratio: 1, gain: 1.0, decayFactor: 1.0, type: 'triangle' },
      { ratio: 2.02, gain: 0.46, decayFactor: 0.5, type: 'sine' },
      { ratio: 2.72, gain: 0.34, decayFactor: 0.34, type: 'triangle' },
      { ratio: 4.9, gain: 0.14, decayFactor: 0.2, type: 'sine' },
    ],
    mallet: { gain: 0.2, freq: 4200, q: 0.9, dur: 0.028 },
    color: '#6fa8dc',
    colorSoft: 'rgba(111,168,220,0.18)',
    learn: '与「悠商」音高近到几乎重叠，但声音干而短，余音很快消失。',
    fineCode: 'D5+/592.5/d0.72/short-bright',
  },
  {
    // 响声重叠组：其第二分音恰为 E6（1318.5），与碎星基频重叠
    id: 'quan',
    name: '鸣泉',
    subtitle: '寒玉中高音片',
    pitchLabel: 'E5 · 659.3 Hz',
    freq: 659.25,
    band: 'E',
    bandLabel: 'E5 泉声带',
    decay: 1.9,
    decayWord: '中等',
    partials: [
      { ratio: 1, gain: 1.0, decayFactor: 1.0, type: 'sine' },
      // 比值 2.0 => 1318.5 Hz，正好与碎星 E6 基频重合，形成“响声重叠”
      { ratio: 2.0, gain: 0.5, decayFactor: 0.6, type: 'sine' },
      { ratio: 2.76, gain: 0.26, decayFactor: 0.4, type: 'triangle' },
      { ratio: 5.4, gain: 0.1, decayFactor: 0.24, type: 'sine' },
    ],
    mallet: { gain: 0.15, freq: 4200, q: 1.2, dur: 0.03 },
    color: '#4fb3a9',
    colorSoft: 'rgba(79,179,169,0.18)',
    learn: '第二分音正好是 E6 高频，常与「碎星」的基频叠在一起；本体 E5 更稳。',
    fineCode: 'E5/659.25/d1.9/harm2=E6',
  },
  {
    id: 'sui',
    name: '碎星',
    subtitle: '银箔高频片',
    pitchLabel: 'E6 · 1318.5 Hz',
    freq: 1318.51,
    band: 'E6',
    bandLabel: 'E6 高频重叠带',
    decay: 2.9,
    decayWord: '悠长',
    partials: [
      // 双振微失谐，产生“碎星”般的闪烁感
      { ratio: 1, gain: 0.85, decayFactor: 1.0, type: 'sine', detune: -6 },
      { ratio: 1, gain: 0.7, decayFactor: 0.92, type: 'sine', detune: 7 },
      { ratio: 2.01, gain: 0.22, decayFactor: 0.5, type: 'sine' },
      { ratio: 2.71, gain: 0.12, decayFactor: 0.3, type: 'triangle' },
    ],
    mallet: { gain: 0.12, freq: 6800, q: 1.4, dur: 0.022 },
    color: '#e3b341',
    colorSoft: 'rgba(227,179,65,0.2)',
    learn: '音区最高，带闪烁的悠长余音；与鸣泉同响时高频会叠成一片。',
    fineCode: 'E6/1318.51/d2.9/shimmer',
  },
];

export const PLATE_MAP: Record<PlateId, PlateDef> = Object.fromEntries(
  PLATES.map((p) => [p.id, p]),
) as Record<PlateId, PlateDef>;

export const POSITION_LABELS = ['左格', '中格', '右格'] as const;

// 两组固定题：写死真实摆放，不使用随机数；重开 / 刷新都回到同一组。
export const PUZZLES: PuzzleDef[] = [
  {
    id: 'easy-clear',
    index: 0,
    groupName: '第一组',
    title: '清响三音',
    difficulty: 'easy',
    tagline: '易辨认 · 音区拉开',
    truth: ['cang', 'qing', 'sui'],
    budget: 3,
    briefing:
      '木盒三格里是三片音高拉开的铃片。先用下方试听栏认识六片铃片，再敲响木盒。次数有限，已保留的试听条件可随时免费回放。',
    debrief: {
      decisive:
        '苍音(G4)、清越(C5)、碎星(E6) 音高带完全分离，一次全响的声纹即可唯一锁定组合。',
    },
  },
  {
    id: 'ambiguous-fog',
    index: 1,
    groupName: '第二组',
    title: '近音与叠响',
    difficulty: 'ambiguous',
    tagline: '开始有歧义 · 余音 / 压制可解',
    // 左：悠商（与浮烟音高极近、余音极长）；中：鸣泉；右：碎星（鸣泉二分音与其基频重叠）
    truth: ['shang', 'quan', 'sui'],
    budget: 3,
    briefing:
      '这一组里有两片音高几乎相同的铃片，还有一对响声会重叠。混合声起初难以定论——但余音长短和“压住一个位置”的敲法会给出确定依据，不靠猜运气。',
    debrief: {
      closePair:
        '悠商(587.3Hz) 与浮烟(592.5Hz) 音高仅差约 15 音分，混合声纹同属 D5 近邻带；但悠商余音 3.6 秒、浮烟仅 0.72 秒。全响后聆听 D5 音带的尾巴，或用「全响 ↔ 压住该格」的差分声纹，都能确定是悠商。',
      overlap:
        '鸣泉的第二分音正好是 1318.5Hz（E6），与碎星的基频重合，所以同响时高频叠成一片。压住鸣泉所在格，E5 本体消失、重叠层变薄变短；压住碎星所在格，闪烁的 E6 长尾巴消失而鸣泉 E5 仍在——两种压法都能拆开它们。',
      decisive:
        '声纹面板会指出压制哪一格能区分剩余组合；若三次机会用在了别的格子上，仍可凭试听栏学到的余音特征手动排除「浮烟」组合。',
    },
  },
];

export const PUZZLE_MAP: Record<string, PuzzleDef> = Object.fromEntries(
  PUZZLES.map((p) => [p.id, p]),
);
