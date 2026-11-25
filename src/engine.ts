import type {
  ActionResult,
  Book,
  Cart,
  Color,
  GameState,
  OpCode,
  Pos,
  Scenario,
  Simulation,
  TickRecord,
} from './types.ts';
import { dirDelta, turn } from './scenarios.ts';

const samePos = (a: Pos, b: Pos): boolean => a.x === b.x && a.y === b.y;

function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

export function initialState(scenario: Scenario): GameState {
  return {
    carts: scenario.carts.map((c) => ({ ...c, pos: { ...c.pos } })),
    books: scenario.books.map((b) => ({ ...b })),
  };
}

interface MoveIntent {
  cart: Cart;
  op: OpCode;
  /** 本拍希望占据的格；非前进类就是当前格 */
  target: Pos;
  moving: boolean;
  blocked: boolean;
  reason: string;
}

function tableAt(scenario: Scenario, pos: Pos) {
  return scenario.tables.find((t) => samePos(t.pos, pos));
}

/** 每拍的完整推演：同时提动作 → 阻挡仲裁 → 拿放仲裁 → 过关判定 */
function runTick(scenario: Scenario, before: GameState, tick: number,
  programs: Record<string, OpCode[]>): TickRecord {
  const state = cloneState(before);
  const carts = state.carts;
  const results: Record<string, ActionResult> = {};

  // ---- 1. 两车按当前格同时提出本拍动作（缺失指令按等待处理）----
  const intents: MoveIntent[] = carts.map((cart) => {
    const op = programs[cart.id]?.[tick - 1] ?? 'W';
    const moving = op === 'F';
    let target = { ...cart.pos };
    let blocked = false;
    let reason = '';
    if (moving) {
      const d = dirDelta(cart.dir);
      target = { x: cart.pos.x + d.x, y: cart.pos.y + d.y };
      const hitWall = target.x < 0 || target.y < 0
        || target.x >= scenario.width || target.y >= scenario.height
        || scenario.walls.some((w) => samePos(w, target));
      if (hitWall) {
        blocked = true;
        reason = '前方是墙或边界，前进被挡';
      }
    }
    return { cart, op, target, moving, blocked, reason };
  });

  // ---- 2a. 明示的成对阻挡规则：同拍抢同一格、迎面交换，双方都挡 ----
  for (let i = 0; i < intents.length; i++) {
    for (let j = i + 1; j < intents.length; j++) {
      const a = intents[i];
      const b = intents[j];
      if (!a.moving || !b.moving || a.blocked || b.blocked) continue;
      if (samePos(a.target, b.target)) {
        a.blocked = true;
        b.blocked = true;
        a.reason = `与 ${b.cart.label} 同拍抢同一格，按规则双双阻挡`;
        b.reason = `与 ${a.cart.label} 同拍抢同一格，按规则双双阻挡`;
      } else if (samePos(a.target, b.cart.pos) && samePos(b.target, a.cart.pos)) {
        a.blocked = true;
        b.blocked = true;
        a.reason = `与 ${b.cart.label} 迎面交换位置，按规则双双阻挡`;
        b.reason = `与 ${a.cart.label} 迎面交换位置，按规则双双阻挡`;
      }
    }
  }

  // ---- 2b. 连锁阻挡（固定点）：移动目标撞上被挡/静止车辆的最终格 ----
  // 明示例外：台面是可共享工位，目标格为台面且对方只是静止停留（本拍不移动）时，
  // 后到的车可以并入同格，以便两车在同一台面上同拍拿/放；同拍一起挤进台面已在 2a 判阻挡。
  while (true) {
    let progressed = false;
    for (const intent of intents) {
      if (!intent.moving || intent.blocked) continue;
      for (const other of intents) {
        if (other.cart.id === intent.cart.id) continue;
        const otherStays = !other.moving || other.blocked;
        const otherFinal = otherStays ? other.cart.pos : other.target;
        if (samePos(intent.target, otherFinal)) {
          const shareable = otherStays && tableAt(scenario, intent.target) !== undefined;
          if (shareable) continue; // 台面并入：不阻挡
          intent.blocked = true;
          intent.reason = `${other.cart.label} 停在目标格，前进被挡`;
          progressed = true;
          break;
        }
      }
    }
    if (!progressed) break;
  }

  // ---- 3. 结算移动与转向（被挡的前进原地不动；拿/放/等都不移动）----
  for (const intent of intents) {
    const { cart, op, target, moving, blocked, reason } = intent;
    if (moving) {
      if (blocked) {
        results[cart.id] = {
          op, success: false, status: 'blocked', reason, targetPos: { ...target },
        };
      } else {
        cart.pos = { ...target };
        results[cart.id] = {
          op, success: true, status: 'ok', reason: '前进一步', targetPos: { ...target },
        };
      }
    } else if (op === 'L' || op === 'R') {
      cart.dir = turn(cart.dir, op);
      results[cart.id] = { op, success: true, status: 'ok', reason: op === 'L' ? '左转一下' : '右转一下' };
    } else {
      results[cart.id] = { op, success: true, status: 'ok', reason: '原地等待' };
    }
  }

  // ---- 4. 拿/放：只与当拍所在格的台面互动，按 A→B 顺序仲裁同拍争抢 ----
  for (const cart of carts) {
    const op = programs[cart.id]?.[tick - 1] ?? 'W';
    if (op !== 'PICK' && op !== 'DROP') continue;
    const table = tableAt(scenario, cart.pos);

    if (op === 'PICK') {
      if (cart.carrying !== null) {
        results[cart.id] = { op, success: false, status: 'failed', reason: '书箱已满（至多一格），不能再拿' };
        continue;
      }
      if (!table) {
        results[cart.id] = { op, success: false, status: 'failed', reason: '当前格没有台面，无书可拿' };
        continue;
      }
      const book = state.books.find((b) => b.tableId === table.id && b.cartId === null);
      if (!book) {
        results[cart.id] = { op, success: false, status: 'failed', reason: `台面 ${table.id} 上没有可拿的书（可能同拍已被另一辆车拿走）` };
        continue;
      }
      book.tableId = null;
      book.cartId = cart.id;
      cart.carrying = book.id;
      results[cart.id] = { op, success: true, status: 'ok', reason: `从台面拿起一本${colorText(book.color)}书` };
    } else {
      if (cart.carrying === null) {
        results[cart.id] = { op, success: false, status: 'failed', reason: '书箱是空的，无书可放' };
        continue;
      }
      if (!table) {
        results[cart.id] = { op, success: false, status: 'failed', reason: '当前格没有台面，不能放书' };
        continue;
      }
      const book = state.books.find((b) => b.id === cart.carrying);
      if (!book) {
        results[cart.id] = { op, success: false, status: 'failed', reason: '内部错误：找不到车箱里的书' };
        continue;
      }
      if (table.acceptColor !== null && table.acceptColor !== book.color) {
        results[cart.id] = {
          op, success: false, status: 'failed',
          reason: `${colorText(table.acceptColor)}色角落台面只收${colorText(table.acceptColor)}书，${colorText(book.color)}书放不进去`,
        };
        continue;
      }
      book.cartId = null;
      book.tableId = table.id;
      cart.carrying = null;
      const delivered = table.acceptColor === book.color;
      results[cart.id] = {
        op, success: true, status: 'ok',
        reason: delivered
          ? `把${colorText(book.color)}书放进正确的${colorText(book.color)}色角落台面`
          : '把书放到普通台面上',
      };
    }
  }

  // ---- 5. 过关：每一个角落台面都由一次成功放书得到同色书 ----
  const won = scenario.tables
    .filter((t) => t.acceptColor !== null)
    .every((shelf) => state.books.some((b) => b.color === shelf.acceptColor && b.tableId === shelf.id));

  return { tick, before, after: state, results, won };
}

function colorText(c: Color): string {
  return c === 'red' ? '红' : '蓝';
}

/** 整条重算：改任何一拍指令都从初始局面重新推演，旧运行拿到的书不会残留 */
export function simulate(scenario: Scenario, programs: Record<string, OpCode[]>): Simulation {
  const initial = initialState(scenario);
  const maxLen = Math.max(1, ...scenario.carts.map((c) => programs[c.id]?.length ?? 0));
  const ticks: TickRecord[] = [];
  let state = initial;
  let winTick: number | null = null;
  for (let tick = 1; tick <= maxLen; tick++) {
    const record = runTick(scenario, state, tick, programs);
    ticks.push(record);
    state = record.after;
    if (winTick === null && record.won) winTick = tick;
  }
  return { scenarioId: scenario.id, initial, ticks, winTick };
}

/** 查看第 n 拍结束后的局面（n=0 为初始局面） */
export function stateAt(sim: Simulation, tick: number): GameState {
  if (tick <= 0) return sim.initial;
  return sim.ticks[Math.min(tick, sim.ticks.length) - 1].after;
}

export function booksOnTables(state: GameState): Book[] {
  return state.books.filter((b) => b.tableId !== null);
}
