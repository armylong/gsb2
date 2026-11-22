import { createRng } from './rng.ts';
import type { CategoryId, ScenarioDef, ScenarioId, Specimen } from './types.ts';

/**
 * 三个内置回合（含预置选择，载入即全部确认，可直接开牌；改动任一选择则该队需重新确认）
 *  + 一个自由沙盒（自动队按种子与偏好在开局时生成选择）。
 */

interface SpecSeed {
  id: string;
  label: string;
  category: CategoryId;
  value: number;
}

const ROCK_NAMES = ['玛瑙片', '页岩片', '萤石小块', '翡翠原石', '琥珀原石', '玄武岩', '砂岩', '花岗岩', '黑曜石', '云母片'];
const INSECT_NAMES = ['金龟子', '竹节虫', '螽斯标本', '凤蝶标本', '闪蝶', '瓢虫壳', '蜂鸟鹰蛾', '独角仙', '蜻蜓标本', '螳螂标本'];
const PLANT_NAMES = ['蕨叶压片', '松球果', '苔藓压片', '银杉压片', '石斛花', '银杏叶', '芦苇穗', '地衣贴片', '睡莲切片', '树皮标本'];

export const SCENARIOS: Record<ScenarioId, ScenarioDef> = {
  // —— 回合一：三件首选相撞，落败者走备用 ——
  collisionPrimary: {
    id: 'collisionPrimary',
    label: '内置一 · 首选相撞',
    description: '三队首选都押「玛瑙片」，按优先顺序 A→B→C 处理，落败两队依次尝试各自备用。',
    totalRounds: 1,
    seed: 1492301,
    rounds: [
      {
        specimens: [
          { id: 'cp1-r1', label: '玛瑙片', category: 'rock', value: 3 },
          { id: 'cp1-i1', label: '金龟子', category: 'insect', value: 3 },
          { id: 'cp1-p1', label: '蕨叶压片', category: 'plant', value: 2 },
          { id: 'cp1-r2', label: '页岩片', category: 'rock', value: 2 },
          { id: 'cp1-i2', label: '竹节虫', category: 'insect', value: 2 },
          { id: 'cp1-i3', label: '螽斯标本', category: 'insect', value: 1 },
          { id: 'cp1-p2', label: '松球果', category: 'plant', value: 1 },
        ],
        presets: {
          A: { primaryId: 'cp1-r1', backupId: 'cp1-i1', confirmed: true },
          B: { primaryId: 'cp1-r1', backupId: 'cp1-p1', confirmed: true },
          C: { primaryId: 'cp1-r1', backupId: 'cp1-r2', confirmed: true },
        },
      },
    ],
  },

  // —— 回合二：备用再相撞 + 两种空手原因 ——
  collisionBackup: {
    id: 'collisionBackup',
    label: '内置二 · 备用相撞',
    description:
      '第一轮 B、C 备用都押「琥珀原石」，C 的备用被 B 拿走（备选已被别人拿走）；第二轮 C 首选被抢且未交备用（没有合适备选）。',
    totalRounds: 2,
    seed: 1492302,
    rounds: [
      {
        specimens: [
          { id: 'cb1-s1', label: '翡翠原石', category: 'rock', value: 3 },
          { id: 'cb1-s2', label: '琥珀原石', category: 'rock', value: 2 },
          { id: 'cb1-s3', label: '萤石小块', category: 'rock', value: 1 },
          { id: 'cb1-s4', label: '凤蝶标本', category: 'insect', value: 2 },
          { id: 'cb1-s5', label: '苔藓压片', category: 'plant', value: 1 },
        ],
        presets: {
          A: { primaryId: 'cb1-s1', backupId: 'cb1-s4', confirmed: true },
          B: { primaryId: 'cb1-s1', backupId: 'cb1-s2', confirmed: true },
          C: { primaryId: 'cb1-s1', backupId: 'cb1-s2', confirmed: true },
        },
      },
      {
        specimens: [
          { id: 'cb2-t1', label: '独角仙', category: 'insect', value: 3 },
          { id: 'cb2-t2', label: '石斛花', category: 'plant', value: 2 },
          { id: 'cb2-t3', label: '花岗岩', category: 'rock', value: 2 },
          { id: 'cb2-t4', label: '蜻蜓标本', category: 'insect', value: 1 },
          { id: 'cb2-t5', label: '芦苇穗', category: 'plant', value: 1 },
        ],
        // 本轮优先顺序轮换为 B→C→A
        presets: {
          A: { primaryId: 'cb2-t2', backupId: 'cb2-t3', confirmed: true },
          B: { primaryId: 'cb2-t1', backupId: 'cb2-t4', confirmed: true },
          C: { primaryId: 'cb2-t1', backupId: null, confirmed: true },
        },
      },
    ],
  },

  // —— 回合三：两轮后平分 ——
  tieScore: {
    id: 'tieScore',
    label: '内置三 · 平分',
    description: '两轮结束红隼队与蓝雀队同为 6 分并列第一，积分榜高亮平分；第一轮同样含首选相撞。',
    totalRounds: 2,
    seed: 1492303,
    rounds: [
      {
        specimens: [
          { id: 'ts1-r1', label: '玄武岩', category: 'rock', value: 3 },
          { id: 'ts1-i1', label: '闪蝶', category: 'insect', value: 3 },
          { id: 'ts1-p1', label: '银杉压片', category: 'plant', value: 2 },
          { id: 'ts1-r2', label: '砂岩', category: 'rock', value: 2 },
          { id: 'ts1-i2', label: '瓢虫壳', category: 'insect', value: 1 },
        ],
        presets: {
          A: { primaryId: 'ts1-r1', backupId: null, confirmed: true },
          B: { primaryId: 'ts1-r1', backupId: 'ts1-i1', confirmed: true },
          C: { primaryId: 'ts1-r1', backupId: 'ts1-p1', confirmed: true },
        },
      },
      {
        specimens: [
          { id: 'ts2-r3', label: '花岗岩', category: 'rock', value: 3 },
          { id: 'ts2-i3', label: '蜂鸟鹰蛾', category: 'insect', value: 3 },
          { id: 'ts2-p2', label: '石斛花', category: 'plant', value: 2 },
          { id: 'ts2-r4', label: '黑曜石', category: 'rock', value: 1 },
        ],
        // 优先顺序轮换为 B→C→A，三队各取一件，无撞选
        presets: {
          A: { primaryId: 'ts2-r3', backupId: 'ts2-r4', confirmed: true },
          B: { primaryId: 'ts2-i3', backupId: null, confirmed: true },
          C: { primaryId: 'ts2-p2', backupId: null, confirmed: true },
        },
      },
    ],
  },

  // —— 自由沙盒：占位，标本由 buildSandboxGame 按种子生成 ——
  sandbox: {
    id: 'sandbox',
    label: '自由沙盒',
    description: '自动队按种子与两种偏好自动定选；可改种子重建，同种子同选择结果完全一致。',
    totalRounds: 2,
    seed: 20261122,
    rounds: [],
  },
};

const SANDBOX_COUNTS: Record<CategoryId, number> = { rock: 3, insect: 2, plant: 2 };
const SANDBOX_VALUES = [3, 2, 2, 2, 1, 1, 1];

/** 沙盒每轮 7 件标本，只由种子决定，保证可重复 */
export function generateSandboxRound(seed: number, roundIndex: number): Specimen[] {
  const rng = createRng((seed ^ (roundIndex + 1) * 0x9e3779b9) >>> 0);
  const pools: Record<CategoryId, string[]> = {
    rock: [...ROCK_NAMES],
    insect: [...INSECT_NAMES],
    plant: [...PLANT_NAMES],
  };
  const pickName = (cat: CategoryId): string => {
    const pool = pools[cat];
    const idx = Math.floor(rng() * pool.length);
    return pool.splice(idx, 1)[0];
  };
  const out: Specimen[] = [];
  let serial = 0;
  (Object.keys(SANDBOX_COUNTS) as CategoryId[]).forEach((cat) => {
    for (let i = 0; i < SANDBOX_COUNTS[cat]; i += 1) {
      const value = SANDBOX_VALUES[serial] ?? 1;
      out.push({
        id: `sb-r${roundIndex}-${serial}`,
        label: pickName(cat),
        category: cat,
        value,
      });
      serial += 1;
    }
  });
  return out;
}

export function sandboxSpecSeeds(seed: number, totalRounds: number): SpecSeed[][] {
  return Array.from({ length: totalRounds }, (_, r) => generateSandboxRound(seed, r));
}
