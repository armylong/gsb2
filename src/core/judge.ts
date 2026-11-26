import type { Arrangement, Puzzle } from './model';
import { expandArrangement } from './sequencer';

export interface JudgeResult {
  pass: boolean;
  /** 用纸限制的违反项 */
  violations: string[];
  /** 展开失败（如返回标记顺序不成立）时的原因 */
  expandError?: string;
  /** 第一处有问题的拍（0-based）；无偏差时为空 */
  firstBadBeat?: number;
  beatDetail?: string;
}

/**
 * 通关判定：
 * 1. 展开当前摆法（展开失败直接判负，并指出停在哪一拍）；
 * 2. 检查用纸限制；
 * 3. 逐拍、逐路比对鼓点与空拍，长度不一致也算偏差（漏掉的静音拍 / 多转的圈都在这里现形）。
 */
export function judge(puzzle: Puzzle, arrangement: Arrangement): JudgeResult {
  const stripMap = new Map(puzzle.strips.map((s) => [s.id, s]));
  const tracks = puzzle.trackNames.length;
  const violations: string[] = [];

  // —— 用纸限制：每条纸带恰好用一次 ——
  const used = new Map<string, number>();
  let markers = 0;
  for (const e of arrangement) {
    if (e.kind === 'strip') used.set(e.stripId, (used.get(e.stripId) ?? 0) + 1);
    else markers++;
  }
  for (const s of puzzle.strips) {
    const n = used.get(s.id) ?? 0;
    if (n === 0) violations.push(`纸带「${s.name}」没有放进卡槽`);
    else if (n > 1) violations.push(`纸带「${s.name}」被放了 ${n} 次，每条只能用一次`);
  }
  if (markers > puzzle.returnTokens) {
    violations.push(`返回标记只有 ${puzzle.returnTokens} 枚，卡槽里却放了 ${markers} 枚`);
  }

  const exp = expandArrangement(arrangement, stripMap, tracks);
  if (!exp.ok) {
    return {
      pass: false,
      violations,
      expandError: exp.reason,
      firstBadBeat: exp.beatIndex,
      beatDetail: exp.reason,
    };
  }

  // —— 用纸限制：走纸长度 / 打孔力度 ——
  if (exp.beats.length > puzzle.maxBeats) {
    violations.push(`展开后共 ${exp.beats.length} 拍，超过走纸长度上限 ${puzzle.maxBeats} 拍`);
  }
  exp.beats.forEach((b, i) => {
    const n = b.hits.filter(Boolean).length;
    if (n > puzzle.maxSimultaneous) {
      violations.push(`第 ${i + 1} 拍同时打了 ${n} 个孔，打孔器一次最多打 ${puzzle.maxSimultaneous} 个`);
    }
  });

  // —— 逐拍比对（先找到的第一处偏差） ——
  let firstBadBeat: number | undefined;
  let beatDetail: string | undefined;
  const target = puzzle.target;
  const n = Math.max(exp.beats.length, target.length);
  for (let i = 0; i < n; i++) {
    const got = exp.beats[i];
    const want = target[i];
    if (!got) {
      firstBadBeat = i;
      beatDetail = want.hits.some(Boolean)
        ? `第 ${i + 1} 拍缺失：这里应该有鼓点`
        : `第 ${i + 1} 拍缺失：这里应该留一拍空拍（静音拍也算一拍）`;
      break;
    }
    if (!want) {
      firstBadBeat = i;
      beatDetail = got.hits.some(Boolean)
        ? `第 ${i + 1} 拍多余：目标到这里已经结束（多转了一遍？）`
        : `第 ${i + 1} 拍多余：多出了一拍空拍（多转了一遍？）`;
      break;
    }
    for (let t = 0; t < tracks; t++) {
      if (got.hits[t] !== want.hits[t]) {
        firstBadBeat = i;
        beatDetail = `第 ${i + 1} 拍 · ${puzzle.trackNames[t]}：应为${want.hits[t] ? '鼓点' : '空拍'}，实际是${got.hits[t] ? '鼓点' : '空拍'}`;
        break;
      }
    }
    if (firstBadBeat !== undefined) break;
  }

  return {
    pass: violations.length === 0 && firstBadBeat === undefined,
    violations,
    firstBadBeat,
    beatDetail,
  };
}
