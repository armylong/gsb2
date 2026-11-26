import {
  acquireCandidate,
  createInitialState,
  filterLabel,
  simulate,
  stepState,
} from './engine';
import { angleAt, isInsideArc } from './geometry';
import { DEMO_LEVEL, LEVELS } from './levels';
import type { CheckResult, Command, LevelDef } from './types';

const results: CheckResult[] = [];

function check(name: string, ok: boolean, detail: string): void {
  results.push({ name, ok, detail });
}

function makeFixture(overrides: Partial<LevelDef> = {}): LevelDef {
  return {
    id: 'fixture',
    name: '核对夹具',
    tagline: '',
    brief: [],
    totalBeats: 4,
    cycleBeats: 4,
    dayBeats: 0,
    aimTolerance: 10,
    windows: [
      { id: 'w0', name: '零窗', short: '0', centre: 0, halfWidth: 20, eave: { from: -2, to: 2, label: '檐' } },
      { id: 'w1', name: '背窗', short: '1', centre: 180, halfWidth: 20, eave: { from: 80, to: 81, label: '远檐' } },
    ],
    scopes: [
      { id: 0, name: '1号镜', short: '1', startCell: 'w0', startHeading: 0, slew: 15, filter: 'clear' },
      { id: 1, name: '2号镜', short: '2', startCell: 'w1', startHeading: 180, slew: 15, filter: 'clear' },
    ],
    bodies: [
      {
        id: 'target',
        name: '夹具星',
        color: '#fff',
        shape: 'star',
        initialAngle: -20,
        speed: 10,
        dir: 1,
        orbitRadius: 220,
        designated: true,
        filter: 'clear',
        requiredBeats: 2,
        hint: '',
      },
    ],
    script: [],
    ...overrides,
  };
}

function codes<T extends { code?: string }>(items: T[]): string[] {
  return items.map((x) => x.code ?? '');
}

// 1. Window boundary: inclusive junction catches, the next sample outside does not.
{
  const centre = 35;
  const half = 12;
  check(
    '窗口交界：边界算可见',
    isInsideArc(centre + half, centre, half) && isInsideArc(centre - half, centre, half),
    `centre=${centre}°, halfWidth=${half}°，±${half}° 均按闭区间处理。`,
  );
  check(
    '窗口交界：跨出 1e-6° 即不可见',
    !isInsideArc(centre + half + 1e-6, centre, half),
    '交界外的采样不会被窗口捡到。',
  );

  const level = makeFixture({
    windows: [
      { id: 'edge', name: '交界窗', short: '边', centre: 0, halfWidth: 20, eave: { from: 99, to: 100, label: '无檐' } },
      { id: 'w1', name: '背窗', short: '1', centre: 180, halfWidth: 20, eave: { from: 80, to: 81, label: '远檐' } },
    ],
  });
  const boundaryAngle = angleAt(330, 10, 1, 5); // beat index 4, elapsed 5 => exactly 20
  const state = createInitialState(level);
  state.scopes[0].heading = 20;
  const candidate = acquireCandidate(level, { ...state, bodies: [{ id: 'target', angle: boundaryAngle }] }, state.scopes[0]);
  check(
    '窗口交界：准星在边界且天体在边界时可锁定',
    candidate.ok && candidate.bodyId === 'target',
    `boundaryAngle=${boundaryAngle.toFixed(3)}°, ${candidate.message}`,
  );

  const outside = simulate(
    makeFixture({
      totalBeats: 2,
      bodies: [
        {
          id: 'target', name: '界外星', color: '#fff', shape: 'star',
          initialAngle: 15, speed: 10, dir: 1, orbitRadius: 220,
          designated: true, filter: 'clear', requiredBeats: 1, hint: '',
        },
      ],
    }),
    [{ type: 'start', scopeId: 0 }],
  );
  // elapsed 1 angle = 25, outside halfWidth 20; heading starts 0, distance 25.
  check(
    '窗口交界：界外一拍开始观测会被拒绝并给出理由',
    outside.reports[0].rejectionCode === 'no-target-in-crosshair',
    outside.reports[0].rejection ?? '未返回拒绝理由',
  );
}

// 2. Eave blocks exactly one beat and breaks the first streak; a later segment qualifies.
{
  const level = makeFixture({ totalBeats: 4 });
  const result = simulate(level, [
    { type: 'start', scopeId: 0 }, // angle elapsed1=-10, credit 1
    null, // elapsed2=0, eave
    null, // elapsed3=10, new streak 1
    null, // elapsed4=20, streak 2 and record
  ]);
  const eaveLosses = result.losses.filter((l) => l.code === 'eave');
  const record = result.records.find((r) => r.targetId === 'target');
  check(
    '屋檐：恰好遮住一拍',
    eaveLosses.length === 1 && eaveLosses[0]?.beat === 1,
    `eaveLosses=${JSON.stringify(eaveLosses.map((l) => l.beat + 1))}`,
  );
  check(
    '屋檐：中断后可重新攒出连续记录',
    !!record && record.startBeat === 2 && record.endBeat === 3,
    record ? `合格记录为第 ${record.startBeat + 1}–${record.endBeat + 1} 拍。` : '没有合格记录',
  );
}

// 3. Filter switch cannot also observe on the same beat; one-beat-earlier switch is enough.
{
  const body: LevelDef['bodies'][number] = {
    id: 'blue-target', name: '蓝片星', color: '#7dd3fc', shape: 'planet',
    initialAngle: -10, speed: 5, dir: 1, orbitRadius: 220,
    designated: true, filter: 'blue', requiredBeats: 2, hint: '',
  };
  const lateLevel = makeFixture({
    totalBeats: 3,
    aimTolerance: 12,
    windows: [
      { id: 'clear0', name: '无檐窗', short: '0', centre: 0, halfWidth: 30, eave: { from: 99, to: 100, label: '无檐' } },
      { id: 'w1', name: '背窗', short: '1', centre: 180, halfWidth: 20, eave: { from: 80, to: 81, label: '远檐' } },
    ],
    scopes: [
      { id: 0, name: '1号镜', short: '1', startCell: 'w0', startHeading: 0, slew: 15, filter: 'clear' },
      { id: 1, name: '2号镜', short: '2', startCell: 'w1', startHeading: 180, slew: 15, filter: 'clear' },
    ],
    bodies: [body],
  });
  const late = simulate(lateLevel, [
    { type: 'start', scopeId: 0 }, // wrong filter, no streak
    { type: 'filter', scopeId: 0, filter: 'blue' }, // switch beat cannot observe
    null, // only one credited beat remains
  ]);
  check(
    '切滤片来不及：晚切导致无法凑足两连测',
    !late.passed && !late.records.some((r) => r.targetId === 'blue-target'),
    `loss codes=${codes(late.losses).join(',')}`,
  );
  check(
    '切滤片来不及：切换拍有明确 filter-switch 结算',
    late.reports[1].ticks.some((t) => t.code === 'filter-switch'),
    late.reports[1].ticks.map((t) => t.message).join(' / ') || '无观测 tick',
  );

  const early = simulate(lateLevel, [
    { type: 'filter', scopeId: 0, filter: 'blue' },
    { type: 'start', scopeId: 0 },
    null,
  ]);
  check(
    '滤片提前一拍：切换后可完成两连测',
    early.passed && early.records.some((r) => r.targetId === 'blue-target'),
    `records=${early.records.length}, passed=${early.passed}`,
  );
}

// 4. Shared catwalk conflict and incomplete path.
{
  const result = simulate(DEMO_LEVEL, DEMO_LEVEL.script);
  const conflict = result.reports[0];
  check(
    '共用走台：有镜占用时进入会冲突并说明理由',
    conflict.rejectionCode === 'walkway-occupied',
    conflict.rejection ?? '缺少冲突理由',
  );
  const walkStartLevel = makeFixture({
    scopes: [
      { id: 0, name: '1号镜', short: '1', startCell: 'walk', startHeading: 0, slew: 15, filter: 'clear' },
      { id: 1, name: '2号镜', short: '2', startCell: 'w1', startHeading: 180, slew: 15, filter: 'clear' },
    ],
  });
  const walkStart = simulate(walkStartLevel, [{ type: 'start', scopeId: 0 }]);
  check(
    '走台途中：路径未走完不能开始观测',
    walkStart.reports[0].rejectionCode === 'on-walkway',
    walkStart.reports[0].rejection ?? '未拒绝',
  );
}

// 5. Built-in levels and demo scripts are solvable / deterministic.
for (const level of LEVELS) {
  const a = simulate(level, level.script);
  const b = simulate(level, level.script);
  check(
    `确定性：${level.name} 两次快进结果完全一致`,
    JSON.stringify(a) === JSON.stringify(b),
    `passed=${a.passed}, records=${a.records.length}, losses=${a.losses.length}`,
  );
  if (level.id !== 'short-demo') {
    check(
      `内置关卡可通关：${level.name}`,
      a.passed,
      a.passed
        ? `已提交 ${a.records.length} 份记录`
        : `缺少：${level.bodies.filter((body) => !a.records.some((r) => r.targetId === body.id)).map((b) => b.name).join('、')}`,
    );
  } else {
    const eave = a.losses.filter((l) => l.code === 'eave').length;
    check(
      '短演示：固定脚本可完成全部核对目标',
      a.passed && eave >= 1 && a.reports[0].rejectionCode === 'walkway-occupied',
      `passed=${a.passed}, eaveLosses=${eave}, records=${a.records.length}`,
    );
  }
}

// Same bearing, two successive targets in level 1.
{
  const level = LEVELS[0];
  const zhuque = level.bodies.find((b) => b.id === 'zhuque')!;
  const qingshi = level.bodies.find((b) => b.id === 'qingshi')!;
  const a1 = angleAt(zhuque.initialAngle, zhuque.speed, zhuque.dir, 6);
  const a2 = angleAt(qingshi.initialAngle, qingshi.speed, qingshi.dir, 15);
  check(
    '同窗先后：两颗目标会经过相同方位',
    Math.abs(a1 - 20) < 1e-6 && Math.abs(a2 - 20) < 1e-6,
    `朱雀 elapsed6=${a1}°, 青使 elapsed15=${a2}°，均为 20°。`,
  );
}

// Stepwise execution equals one bulk simulation.
{
  const level = LEVELS[1];
  const bulk = simulate(level, level.script);
  let state = createInitialState(level);
  const stepwiseStates = [state];
  for (let beat = 0; beat < level.totalBeats; beat += 1) {
    const command: Command | null = level.script[beat] ?? null;
    const report = stepState(level, state, command, beat);
    state = report.state;
    stepwiseStates.push(state);
  }
  check(
    '单步/快进同源：逐拍 stepState 与 simulate 状态一致',
    JSON.stringify(stepwiseStates) === JSON.stringify(bulk.states),
    `共核对 ${level.totalBeats + 1} 个状态快照。`,
  );
}

export function runChecks(): CheckResult[] {
  return results.map((r) => ({ ...r }));
}

// Keep filterLabel referenced for future UI/debug output tree-shaking symmetry.
void filterLabel;
