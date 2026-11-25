/* 题面设计 / 校验工作台（不进入前端构建） npm run design */
import {
  Board,
  COLORS,
  ColorId,
  DIR_LIST,
  Dir,
  GameState,
  LevelDef,
  cellKey,
  faceColor,
  parseLevel,
  rollOri,
  initialState,
} from '../src/game/engine';
import { solveFrom, HintAction } from '../src/game/solver';

// 从标准朝向出发 BFS，生成全部 24 个合法朝向字符串
function allOris(): string[] {
  const root = 'RPYGBO'; // 任意六面不同
  const seen = new Set<string>([root]);
  const q = [root];
  while (q.length) {
    const o = q.shift()!;
    for (const d of DIR_LIST) {
      const n = rollOri(o, d);
      if (!seen.has(n)) {
        seen.add(n);
        q.push(n);
      }
    }
  }
  return [...seen];
}

function actionSeq(path: HintAction[] | null) {
  if (!path) return 'NULL';
  return path.map((a) => (a.type === 'stamp' ? '印' : { N: '↑', E: '→', S: '↓', W: '←' }[a.dir])).join(' ');
}

function simulate(board: Board, ori0: string, path: HintAction[]) {
  let s: GameState = initialState(board, ori0);
  const stampOrder: string[] = [];
  const dirVec: Record<Dir, [number, number]> = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  for (const a of path) {
    if (a.type === 'move') {
      const [dx, dy] = dirVec[a.dir];
      s = { ...s, x: s.x + dx, y: s.y + dy, ori: rollOri(s.ori, a.dir) };
    } else {
      const c = faceColor(s.ori, 'B');
      s = { ...s, stamps: { ...s.stamps, [cellKey(s.x, s.y)]: c } };
      const sc = board.cells[s.y][s.x].slotIndex;
      stampOrder.push(`${c}->#${sc}@${s.x},${s.y}`);
    }
  }
  return { end: `${s.x},${s.y}`, bottom: s.ori[1], stampOrder };
}

function makeDef(rows: string[], slotNeeds: Record<string, ColorId>, seals: Set<string>, ori: string, blocks = true): LevelDef {
  const slots: LevelDef['slots'] = {};
  for (const [ch, need] of Object.entries(slotNeeds)) slots[ch] = { need, seal: seals.has(ch) };
  return { id: 'cand', name: '候选', subtitle: '', brief: '', rows, slots, startOri: ori, stampedBlocks: blocks };
}

function fullReport(title: string, def: LevelDef, oris: { name: string; ori: string }[]) {
  console.log(`\n================ ${title} ================`);
  console.log(def.rows.join('\n'));
  for (const { name, ori } of oris) {
    const board = parseLevel({ ...def, startOri: ori });
    const path = solveFrom(board, initialState(board, ori), { stampedBlocks: def.stampedBlocks });
    console.log(`\n[${name}] ori=${ori} (顶${COLORS[ori[0] as ColorId].name} 底${COLORS[ori[1] as ColorId].name})`);
    if (!path) {
      console.log('  无解');
      continue;
    }
    const sim = simulate(board, ori, path);
    console.log(`  长度${path.length}: ${actionSeq(path)}`);
    console.log(`  盖印顺序 ${sim.stampOrder.join('  =>  ')}`);
    console.log(`  终点 ${sim.end} 最终贴底=${sim.bottom}`);
  }
}

// 枚举某固定配色下，24 朝向里“结果不同”的朝向对
function findOrientationPair(rows: string[], needs: Record<string, ColorId>, seals: Set<string>, blocks = true) {
  const oris = allOris();
  const infos: { ori: string; len: number; last: string; end: string; first: string; order: string }[] = [];
  for (const ori of oris) {
    const def = makeDef(rows, needs, seals, ori, blocks);
    const board = parseLevel(def);
    const p = solveFrom(board, initialState(board, ori), { stampedBlocks: blocks });
    if (!p) continue;
    const sim = simulate(board, ori, p);
    infos.push({
      ori,
      len: p.length,
      last: sim.stampOrder[sim.stampOrder.length - 1] ?? '',
      end: sim.end,
      first: actionSeq(p.slice(0, 1)),
      order: sim.stampOrder.join('>'),
    });
  }
  // 找 last 不同（最后盖的封口格不同）且都较短的一对
  let best: { a: (typeof infos)[number]; b: (typeof infos)[number]; score: number } | null = null;
  for (const a of infos) {
    for (const b of infos) {
      if (a.ori >= b.ori) continue;
      if (a.last === b.last) continue;
      const score = a.len + b.len + Math.abs(a.len - b.len);
      if (!best || score < best.score) best = { a, b, score };
    }
  }
  console.log(`\n#### 朝向对搜索：${Object.values(needs).join('/')} seals=[${[...seals]}] 可解朝向 ${infos.length}/24`);
  if (best) {
    console.log('BEST A', best.a);
    console.log('BEST B', best.b);
  } else {
    console.log('没有“最后格不同”的朝向对；列最短的几个：');
    infos.sort((x, y) => x.len - y.len);
    infos.slice(0, 5).forEach((i) => console.log(i));
  }
  return best;
}

// 自动搜索配色 + 朝向对（目标：两个朝向最后封口格不同，路径短）
function searchNeedsAndOriPair(rows: string[], chars: string[], sealChars: string[], blocks = true) {
  const seals = new Set(sealChars);
  const colors: ColorId[] = ['R', 'O', 'Y', 'G', 'B', 'P'];
  const oris = allOris();
  let shown = 0;
  const k = chars.length;
  for (let code = 0; code < Math.pow(6, k) && shown < 6; code++) {
    let n = code;
    const needs: Record<string, ColorId> = {};
    chars.forEach((ch) => {
      needs[ch] = colors[n % 6];
      n = Math.floor(n / 6);
    });
    let best: { a: any; b: any; score: number } | null = null;
    for (const oa of oris) {
      const def = makeDef(rows, needs, seals, oa, blocks);
      const board = parseLevel(def);
      const pa = solveFrom(board, initialState(board, oa), { stampedBlocks: blocks });
      if (!pa || pa.length > 22) continue;
      const sa = simulate(board, oa, pa);
      for (const ob of oris) {
        if (ob <= oa) continue;
        const pb = solveFrom(board, initialState(board, ob), { stampedBlocks: blocks });
        if (!pb || pb.length > 22) continue;
        const sb = simulate(board, ob, pb);
        const lastA = sa.stampOrder[sa.stampOrder.length - 1];
        const lastB = sb.stampOrder[sb.stampOrder.length - 1];
        if (lastA === lastB) continue;
        const score = pa.length + pb.length;
        if (!best || score < best.score)
          best = {
            score,
            a: { ori: oa, len: pa.length, seq: actionSeq(pa), sim: sa },
            b: { ori: ob, len: pb.length, seq: actionSeq(pb), sim: sb },
          };
      }
    }
    if (best) {
      console.log(`\n*** needs=[${chars.map((c) => c + ':' + needs[c]).join(' ')}] score=${best.score}`);
      console.log(' A', best.a.ori, best.a.len, best.a.seq);
      console.log('   ', best.a.sim.stampOrder.join(' => '), 'end', best.a.sim.end);
      console.log(' B', best.b.ori, best.b.len, best.b.seq);
      console.log('   ', best.b.sim.stampOrder.join(' => '), 'end', best.b.sim.end);
      shown++;
    }
  }
  if (!shown) console.log('未找到符合条件的配置');
}

// ---------------- 运行分析 ----------------

// L1 教学
fullReport(
  'L1 教学候选',
  makeDef(
    [
      '########',
      '#@1....#',
      '#......#',
      '#..~~..#',
      '#...2..#',
      '########',
    ],
    { '1': 'Y', '2': 'R' },
    new Set(),
    'RPGOYB',
    true,
  ),
  [{ name: 'default', ori: 'RPGOYB' }],
);

// 固定一对朝向，枚举配色，要求“最后盖的格不同”，且总步数短
function searchFixedPair(rows: string[], chars: string[], sealChars: string[], oriA: string, oriB: string, maxLen = 18) {
  const seals = new Set(sealChars);
  const colors: ColorId[] = ['R', 'O', 'Y', 'G', 'B', 'P'];
  const k = chars.length;
  let count = 0;
  let bestAny: { needs: Record<string, ColorId>; la: number; lb: number; lastA: string; lastB: string; seqA: string; seqB: string } | null = null;
  for (let code = 0; code < Math.pow(6, k); code++) {
    let n = code;
    const needs: Record<string, ColorId> = {};
    chars.forEach((ch) => {
      needs[ch] = colors[n % 6];
      n = Math.floor(n / 6);
    });
    const boardA = parseLevel(makeDef(rows, needs, seals, oriA));
    const pA = solveFrom(boardA, initialState(boardA, oriA), { stampedBlocks: true });
    if (!pA || pA.length > maxLen) continue;
    const boardB = parseLevel(makeDef(rows, needs, seals, oriB));
    const pB = solveFrom(boardB, initialState(boardB, oriB), { stampedBlocks: true });
    if (!pB || pB.length > maxLen) continue;
    const sA = simulate(boardA, oriA, pA);
    const sB = simulate(boardB, oriB, pB);
    const lastA = sA.stampOrder[sA.stampOrder.length - 1];
    const lastB = sB.stampOrder[sB.stampOrder.length - 1];
    if (lastA === lastB) continue;
    const cand = { needs, la: pA.length, lb: pB.length, lastA, lastB, seqA: actionSeq(pA), seqB: actionSeq(pB) };
    if (!bestAny || cand.la + cand.lb < bestAny.la + bestAny.lb) bestAny = cand;
    if (count < 5) {
      console.log('  needs', JSON.stringify(needs), `A${pA.length}:`, cand.seqA, 'last', lastA, `| B${pB.length}:`, cand.seqB, 'last', lastB);
    }
    count++;
  }
  console.log(`固定朝向对 ${oriA} vs ${oriB} 共 ${count} 个分歧配置；最优:`, bestAny);
}

const compactRows = [
  '######',
  '#1..3#',
  '#.@..#',
  '#2..4#',
  '######',
];
console.log('\n### compact all-ori pair (Y/G/B/P)');
findOrientationPair(compactRows, { '1': 'Y', '2': 'G', '3': 'B', '4': 'P' }, new Set(['3', '4']), true);

const ORI_A = 'RPGOYB';
const ORI_YAW = 'RPBYGO'; // yawOri(A,1) 真·俯视顺时针 90°
console.log('\n### compact fixed yaw pair search');
searchFixedPair(compactRows, ['1', '2', '3', '4'], ['3', '4'], ORI_A, ORI_YAW, 16);

// 沿一条设计好的操作串（方向字符 + s=盖印）反推各目标格需要的颜色
function derive(rows: string[], ori: string, seq: string) {
  const board = parseLevel({ id: 'd', name: 'd', subtitle: '', brief: '', rows, slots: {}, startOri: ori, stampedBlocks: true });
  let s: GameState = initialState(board, ori);
  const needs: Record<string, ColorId> = {};
  for (const ch of seq) {
    if (ch === 's') {
      const c = faceColor(s.ori, 'B');
      const mapCh = rows[s.y][s.x];
      needs[mapCh] = c;
      s = { ...s, stamps: { ...s.stamps, [cellKey(s.x, s.y)]: c } };
      console.log(`stamp '${mapCh}' @${s.x},${s.y} = ${c}(${COLORS[c].name})`);
    } else {
      const d = ch as Dir;
      const v = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] }[d]!;
      s = { ...s, x: s.x + v[0], y: s.y + v[1], ori: rollOri(s.ori, d) };
    }
  }
  console.log('derived needs =', JSON.stringify(needs), 'end', s.x, s.y);
  return needs;
}

const l2Rows = [
  '###########',
  '#1...#....#',
  '#..~.#....#',
  '#@...5..3.#',
  '#....#.~..#',
  '#4...#..6.#',
  '###########',
];
// 计划路线：左上1 -> 左下4 -> 回到中路过断桥5 -> 右3 -> 右下封口6（途中可绕素格）
const l2Ori = 'RPGOYB';
console.log('\n### L2 derive route A');
const l2Needs = derive(l2Rows, l2Ori, 'NNs' + 'SSSSs' + 'NN' + 'EEEEs' + 'EEEs' + 'SSs');
fullReport('L2 断桥封口关', makeDef(l2Rows, l2Needs, new Set(['6']), l2Ori, true), [{ name: 'default', ori: l2Ori }]);

void searchNeedsAndOriPair;
