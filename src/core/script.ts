import { colorName, colorOfLayers, createGame, evaluate, previewStamp, stamp, toggleMask, undo } from './game';
import type { StampFailureReason, StampPreview } from './game';
import type {
  Action,
  Coord,
  Evaluation,
  GameState,
  GameStatus,
  InkId,
  LevelDef,
  StencilId,
} from './types';
import { orientationKey } from './types';

export interface StampExpect {
  ok: boolean;
  /** 本印结算墨量。 */
  cost?: number;
  /** 本印之后的状态。 */
  status?: GameStatus;
  /** 本印之后的该墨剩余。 */
  inkLeft?: number;
  /** 失败原因（仅在 ok=false 时检查）。 */
  reason?: StampFailureReason;
  /** 本印新弄脏的保留格。 */
  newClean?: Coord[];
  /** 本印被挡墨的格（用于验证挡墨纸来源）。 */
  masked?: Coord[];
  /** 本印出界、接触不到棋盘的孔数。 */
  offBoard?: number;
}

export interface MaskExpect {
  masked: boolean;
  /** 拿掉/贴上挡墨纸后，该格当前颜色（用于验证“原色保留”）。 */
  cellColor?: string;
}

export type ScriptStep =
  | {
      kind: 'stamp';
      label: string;
      stencilId: StencilId;
      ink: InkId;
      pivot: Coord;
      rotation: number;
      flipped: boolean;
      expect: StampExpect;
    }
  | { kind: 'mask'; label: string; x: number; y: number; expect: MaskExpect }
  | { kind: 'undo'; label: string; expect?: { ink?: InkId; inkLeft?: number; status?: GameStatus } }
  | { kind: 'reset'; label: string };

export interface ScriptCheck {
  label: string;
  pass: boolean;
  detail: string;
}

export interface StepResult {
  index: number;
  label: string;
  checks: ScriptCheck[];
  preview: StampPreview | null;
  action: Action | null;
  state: GameState;
  passed: boolean;
}

export interface ScriptRun {
  script: VerificationScript;
  steps: StepResult[];
  state: GameState;
  evaluation: Evaluation;
  checks: ScriptCheck[];
  passed: boolean;
}

export interface VerificationScript {
  id: string;
  levelId: string;
  name: string;
  description: string;
  steps: ScriptStep[];
}

function check(label: string, pass: boolean, detail = ''): ScriptCheck {
  return { label, pass, detail };
}

function sameCoord(a: Coord, b: Coord): boolean {
  return a.x === b.x && a.y === b.y;
}

function sameCoordSet(a: Coord[], b: Coord[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((c) => b.some((d) => sameCoord(c, d)));
}

/** 无副作用地执行一份操作串；失败不会中断，便于一次看清每一步。 */
export function runScript(level: LevelDef, script: VerificationScript): ScriptRun {
  let state = createGame(level);
  const steps: StepResult[] = [];
  for (let i = 0; i < script.steps.length; i += 1) {
    const step = script.steps[i]!;
    const checks: ScriptCheck[] = [];
    let preview: StampPreview | null = null;
    let action: Action | null = null;
    if (step.kind === 'reset') {
      state = createGame(level);
      checks.push(check('回到初始棋盘', state.stampNo === 0, `盖印第 ${state.stampNo} 次`));
    } else if (step.kind === 'mask') {
      const result = toggleMask(level, state, step.x, step.y);
      if (!result.ok) {
        checks.push(check('挡墨操作可执行', false, result.message));
      } else {
        action = result.action;
        state = result.game;
        const nowMasked = state.mask[step.y * level.width + step.x]!;
        checks.push(
          check(
            `(${step.x + 1}, ${step.y + 1}) ${step.expect.masked ? '贴' : '收'}上挡墨纸`,
            nowMasked === step.expect.masked,
            nowMasked ? '已遮挡' : '未遮挡',
          ),
        );
        if (step.expect.cellColor) {
          const cell = state.cells[step.y * level.width + step.x];
          const color = cell ? colorOfLayers(level, cell.layers) : '';
          checks.push(
            check('该格颜色保持不变', color === step.expect.cellColor, colorName(level, color)),
          );
        }
      }
    } else if (step.kind === 'undo') {
      const undone = undo(state);
      if (!undone) {
        checks.push(check('存在可撤回的操作', false, '操作栈为空'));
      } else {
        action = undone.action;
        state = undone.game;
        checks.push(check('撤回一步', true, undone.action.kind === 'stamp' ? `返还 ${undone.action.cost} 格墨` : '收回挡墨纸'));
        if (step.expect?.ink && step.expect.inkLeft !== undefined) {
          const left = state.inkLeft[step.expect.ink];
          checks.push(check(`返还后 ${step.expect.ink} 余量`, left === step.expect.inkLeft, `余 ${left}`));
        }
        if (step.expect?.status) {
          checks.push(check('撤回后回到可印状态', state.status === step.expect.status, state.status));
        }
      }
    } else {
      preview = previewStamp(level, state, {
        stencilId: step.stencilId,
        ink: step.ink,
        pivot: step.pivot,
        orientation: { rotation: step.rotation, flipped: step.flipped },
      });
      const result = stamp(level, state, {
        stencilId: step.stencilId,
        ink: step.ink,
        pivot: step.pivot,
        orientation: { rotation: step.rotation, flipped: step.flipped },
      });
      const expect = step.expect;
      if (expect.ok) {
        if (result.ok) {
          action = result.entry;
          state = result.game;
          checks.push(check(`盖印成功（${result.entry.cost} 格）`, true));
          if (expect.cost !== undefined) {
            checks.push(check('接触格数结算', result.entry.cost === expect.cost, `实 ${result.entry.cost} / 期 ${expect.cost}`));
          }
          if (expect.inkLeft !== undefined) {
            const left = state.inkLeft[step.ink];
            checks.push(check('该墨余量', left === expect.inkLeft, `余 ${left} / 期 ${expect.inkLeft}`));
          }
          if (expect.status) {
            checks.push(check('棋盘状态', state.status === expect.status, state.status));
          }
          if (expect.masked) {
            const actual = result.entry.masked;
            checks.push(
              check(
                '挡墨纸保护了指定格',
                sameCoordSet(actual, expect.masked),
                actual.map((c) => `(${c.x + 1},${c.y + 1})`).join(' ') || '无',
              ),
            );
          }
          if (expect.offBoard !== undefined) {
            checks.push(
              check('出界孔数', result.entry.offBoard.length === expect.offBoard, `${result.entry.offBoard.length} 孔`),
            );
          }
          checks.push(
            check(
              '朝向与操作一致',
              result.entry.orientation.flipped === step.flipped &&
                ((result.entry.orientation.rotation % 4) + 4) % 4 === ((step.rotation % 4) + 4) % 4,
              `${result.entry.orientation.flipped ? '翻面' : '正面'} / 旋 ${result.entry.orientation.rotation * 90}°`,
            ),
          );
          if (expect.newClean) {
            const actual = state.failure?.newCells ?? [];
            checks.push(
              check('新增沾墨的保留格', sameCoordSet(actual, expect.newClean), actual.map((c) => `(${c.x + 1},${c.y + 1})`).join(' ') || '无'),
            );
          }
        } else {
          checks.push(check('盖印成功', false, result.message));
        }
      } else {
        if (result.ok) {
          checks.push(check('整次拒绝盖印', false, '却盖下了'));
          state = result.game;
          action = result.entry;
        } else {
          checks.push(check('整次拒绝盖印', true, result.message));
          checks.push(check('拒绝后墨量不变', state.inkLeft[step.ink] === result.preview.inkRemaining, `余 ${state.inkLeft[step.ink]}`));
          if (expect.reason) {
            checks.push(check('拒绝原因', result.reason === expect.reason, result.reason));
          }
        }
      }
      if (expect.ok && expect.cost !== undefined && action?.kind === 'stamp') {
        checks.push(
          check(
            '预览与实际结算一致',
            action.cost === preview.cost,
            `预览 ${preview.cost} / 实际 ${action.cost}`,
          ),
        );
      }
    }
    steps.push({
      index: i,
      label: step.label,
      checks,
      preview,
      action,
      state,
      passed: checks.every((c) => c.pass),
    });
  }
  const evaluation = evaluate(level, state);
  const checks: ScriptCheck[] = [];
  checks.push(
    check(
      '最终样图',
      evaluation.solved,
      evaluation.solved
        ? '所有要求色与保留格均正确'
        : `错色 ${evaluation.mismatches.length} 格 · 沾墨 ${evaluation.cleanViolations.length} 格`,
    ),
  );
  return {
    script,
    steps,
    state,
    evaluation,
    checks,
    passed: steps.every((s) => s.passed) && checks.every((c) => c.pass),
  };
}

/** 人读的方向摘要，用于验证面板。 */
export function stepSummary(step: ScriptStep): string {
  if (step.kind === 'reset') return '重新开始';
  if (step.kind === 'mask') return `${step.expect.masked ? '贴' : '收'}挡墨纸 (${step.x + 1}, ${step.y + 1})`;
  if (step.kind === 'undo') return '撤回上一步';
  return `${step.stencilId} · ${step.ink} · 定位 (${step.pivot.x + 1}, ${step.pivot.y + 1}) · ${orientationKey({
    rotation: step.rotation,
    flipped: step.flipped,
  })}`;
}
