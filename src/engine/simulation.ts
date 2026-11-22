import { buildSolids, overlap, platformBox } from './collision';
import {
  EVENT_LIMIT,
  FIXED_DT,
  type InputState,
  type PlayerState,
  type SimEvent,
  type SimState,
  type Solid,
  type TunableParams,
  type WorldPreset,
} from './types';

function pushEvent(state: SimState, type: SimEvent['type'], detail: string): void {
  state.events.push({ t: state.time, step: state.step, type, detail });
  if (state.events.length > EVENT_LIMIT) {
    state.events.splice(0, state.events.length - EVENT_LIMIT);
  }
}

function findSolid(solids: Solid[], id: string | null): Solid | undefined {
  if (id === null) return undefined;
  return solids.find((s) => s.id === id);
}

/**
 * 移动平台先于角色推进。站在平台上的角色先整体平移平台本帧位移，
 * 保证平台换向时角色与台面始终零相对漂移（不会被慢慢甩开，也不会被弹起）。
 */
function carryByPlatform(state: SimState, preset: WorldPreset): void {
  const p = state.player;
  if (!p.grounded || p.groundId === null) return;
  const def = preset.platforms.find((d) => d.id === p.groundId);
  if (!def) return;
  const before = platformBox(def, state.time);
  const after = platformBox(def, state.time + FIXED_DT);
  p.x += after.x - before.x;
  const dy = after.y - before.y;
  if (def.axis === 'vertical') {
    // 端点换向邻域平台速度趋近 0，但角色重力仍按整帧累积，角色会比台面多沉一点点
    // 而产生亚像素~2px 间隙，进而出现 leave/land 抖动。仅当平台本帧竖直速度已经
    // 小于角色单步重力速度（即处于换向停滞邻域）时，才把贴身角色吸附回台面；
    // 平台正常升降时速度更大，不进入此分支，角色靠碰撞/随动自然贴合。
    // 主动跳跃首帧向上位移 ≥ jumpSpeed*dt（≥4px），间隙远超容差，绝不会被吸附。
    const gravityStep = state.params.gravity * FIXED_DT;
    const platformSpeed = Math.abs(dy) / FIXED_DT;
    const gap = p.y + p.h - after.y;
    if (platformSpeed <= gravityStep && Math.abs(gap) <= 3) {
      p.y = after.y - p.h;
      return;
    }
  }
  p.y += dy;
}

/**
 * 平台运动把角色顶进墙体时的安全解穿透：仅沿最小穿透轴推出，
 * 不改变速度符号、不产生弹跳。
 */
function depenetrate(state: SimState): void {
  const p = state.player;
  for (const s of state.solids) {
    if (s.id === p.groundId || !overlap(p, s)) continue;
    const penLeft = p.x + p.w - s.x;
    const penRight = s.x + s.w - p.x;
    const penTop = p.y + p.h - s.y;
    const penBottom = s.y + s.h - p.y;
    const minPen = Math.min(penLeft, penRight, penTop, penBottom);
    if (minPen === penTop) {
      p.y -= penTop;
      if (p.vy > 0) p.vy = 0;
    } else if (minPen === penBottom) {
      p.y += penBottom;
      if (p.vy < 0) p.vy = 0;
    } else if (minPen === penLeft) {
      p.x -= penLeft;
      if (p.vx > 0) p.vx = 0;
    } else {
      p.x += penRight;
      if (p.vx < 0) p.vx = 0;
    }
  }
}

/** X 轴扫描移动：有限步长位移 + AABB 推出，记录左右接触 */
function moveX(state: SimState): void {
  const p = state.player;
  const dx = p.vx * FIXED_DT;
  if (dx === 0) return;
  p.x += dx;
  p.contacts.left = false;
  p.contacts.right = false;
  for (const s of state.solids) {
    if (!overlap(p, s)) continue;
    if (dx > 0) {
      p.x = s.x - p.w;
      p.contacts.right = true;
    } else {
      p.x = s.x + s.w;
      p.contacts.left = true;
    }
    p.vx = 0;
  }
}

/** Y 轴扫描移动：落地、撞顶、支撑切换、离开全部在这里产生事件 */
function moveY(state: SimState): void {
  const p = state.player;
  const dy = p.vy * FIXED_DT;
  if (dy === 0) return;
  p.y += dy;
  p.contacts.up = false;
  p.contacts.down = false;

  const wasGrounded = p.grounded;
  const oldGround = p.groundId;
  let landedOn: Solid | null = null;
  let headSolid: Solid | null = null;

  for (const s of state.solids) {
    if (!overlap(p, s)) continue;
    if (dy > 0) {
      // 向下移动：推到最高的接触面上（同一帧多个候选时取最浅穿透）
      const top = s.y;
      if (!landedOn || top > landedOn.y) landedOn = s;
    } else {
      // 向上移动：撞低顶，停止向上的运动
      p.y = s.y + s.h;
      p.contacts.up = true;
      if (!headSolid || s.y + s.h > headSolid.y + headSolid.h) headSolid = s;
    }
  }

  // 贴身下沉吸附：上一步有支撑且本步向下，若原支撑面仍在一个重力步帧的
  // 贴身范围内（垂直平台下降转上升的换向瞬间），视为持续接触，不产生 leave/land 抖动
  if (!landedOn && dy > 0 && wasGrounded && oldGround !== null) {
    const prev = findSolid(state.solids, oldGround);
    if (prev) {
      const feet = p.y + p.h;
      const gap = prev.y - feet;
      if (gap >= 0 && gap <= Math.abs(dy) + 1e-6) {
        landedOn = prev;
      }
    }
  }

  if (headSolid && p.vy < 0) {
    p.vy = 0;
    pushEvent(state, 'head-bump', `撞顶:${headSolid.label}`);
  }

  if (landedOn) {
    p.y = landedOn.y - p.h;
    p.contacts.down = true;
    if (p.vy > 0) p.vy = 0;
    p.grounded = true;
    p.groundId = landedOn.id;
    p.coyoteTimer = state.params.coyoteTime;
    if (!wasGrounded) {
      pushEvent(state, 'land', `落地:${landedOn.label}`);
    } else if (oldGround !== landedOn.id) {
      const prev = findSolid(state.solids, oldGround)?.label ?? oldGround ?? '?';
      pushEvent(state, 'support-switch', `支撑切换:${prev} → ${landedOn.label}`);
    }
  }
}

function applyHorizontalInput(state: SimState, input: InputState): void {
  const p = state.player;
  const q = state.params;
  const accel = p.grounded ? q.groundAccel : q.airAccel;
  const decel = p.grounded ? q.groundDecel : q.airDecel;

  if (input.move !== 0) {
    p.vx += input.move * accel * FIXED_DT;
    // 朝目标速度方向加速时钳制上限；反向输入允许越过 0 再重新加速
    if (input.move > 0) p.vx = Math.min(p.vx, q.moveSpeed);
    else p.vx = Math.max(p.vx, -q.moveSpeed);
  } else if (p.vx !== 0) {
    const drop = decel * FIXED_DT;
    if (Math.abs(p.vx) <= drop) p.vx = 0;
    else p.vx -= Math.sign(p.vx) * drop;
  }
}

/**
 * 跳跃规则：
 * - jumpPressed 是边沿事件，一次按下只在一个步帧为 true，长按/键盘 repeat 不会重复触发；
 * - 起跳只消耗一次当前按下事件（jumpConsumed），缓冲队列里也只保留一次；
 * - 地面或土狼窗口内立即起跳，否则进入缓冲，落地瞬间消费；
 * - 起跳瞬间仅继承一次平台速度，之后平台运动不再改写角色水平速度。
 */
function tryJump(state: SimState, input: InputState): void {
  const p = state.player;
  const q = state.params;

  if (input.jumpPressed && !p.jumpConsumed) {
    p.jumpBufferTimer = q.jumpBufferTime;
    p.jumpConsumed = true;
  }

  const canJump = p.grounded || p.coyoteTimer > 0;
  if (p.jumpBufferTimer > 0 && canJump) {
    // 分类：当前不在地面但土狼窗口内 → 土狼跳；缓冲已经历至少一个步帧 → 缓冲跳
    const usedCoyote = !p.grounded && p.coyoteTimer > 0;
    const buffered = p.jumpBufferTimer <= q.jumpBufferTime - FIXED_DT / 2;
    const support = findSolid(state.solids, p.groundId);
    if (q.inheritPlatformVelocity && support?.moving) {
      // 仅起跳瞬间继承一次：平台水平速度并入角色，后续帧不再叠加
      p.vx += support.vx;
    }
    p.vy = -q.jumpSpeed;
    p.grounded = false;
    p.groundId = null;
    p.coyoteTimer = 0;
    p.jumpBufferTimer = 0;
    const kind = usedCoyote ? 'coyote-jump' : buffered ? 'buffered-jump' : 'jump';
    pushEvent(state, kind, `起跳 vx=${p.vx.toFixed(1)} vy=${p.vy.toFixed(1)}`);
  }
}

/** 检测移动平台换向，写入接触变化记录 */
function detectPlatformReverse(state: SimState, preset: WorldPreset): void {
  for (const def of preset.platforms) {
    const cur = state.solids.find((s) => s.id === def.id);
    const prevBox = platformBox(def, state.time - FIXED_DT);
    const curBox = platformBox(def, state.time);
    if (!cur) continue;
    const vPrev = def.axis === 'horizontal' ? (curBox.x - prevBox.x) / FIXED_DT : (curBox.y - prevBox.y) / FIXED_DT;
    const vCur = def.axis === 'horizontal' ? cur.vx : cur.vy;
    if (vPrev !== 0 && vCur !== 0 && Math.sign(vPrev) !== Math.sign(vCur)) {
      pushEvent(state, 'platform-reverse', `${def.label} 换向 (${vPrev.toFixed(0)} → ${vCur.toFixed(0)})`);
    }
  }
}

/** 推进一个固定步长（1/60s）。输入为本步边沿状态，整个过程完全确定性。 */
export function stepSim(state: SimState, preset: WorldPreset, input: InputState): void {
  const p = state.player;
  state.step += 1;
  state.time = state.step * FIXED_DT;

  // 1. 移动平台推进到新时刻，并带动有支撑关系的角色
  state.solids = buildSolids(preset, state.time, FIXED_DT);
  carryByPlatform(state, preset);
  detectPlatformReverse(state, preset);
  depenetrate(state);

  // 2. 水平加减速 + X 轴碰撞（先于跳跃，避免移动速度钳制削掉继承来的平台速度）
  p.prevGroundId = p.groundId;
  applyHorizontalInput(state, input);
  moveX(state);

  // 3. 跳跃（土狼 / 缓冲）：起跳瞬间一次性并入平台速度，之后不再受输入钳制
  tryJump(state, input);

  // 4. 重力 + Y 轴碰撞（落地 / 撞顶 / 支撑切换）
  const vyBeforeMove = Math.min(p.vy + state.params.gravity * FIXED_DT, 1200);
  p.vy = vyBeforeMove;
  moveY(state);
  // 撞顶把 vy 清零后，本帧不再立即重新施加重力（下一帧再恢复），
  // 保证撞顶当帧 vy===0，读数与接触方向一致
  if (p.contacts.up && vyBeforeMove < 0) {
    p.vy = 0;
  }

  // 5. 离地收尾：贴身支撑保持、土狼计时、离开事件、接触标记
  if (!p.contacts.down) {
    // 换向停滞邻域的贴身保持：本步未跳跃，且步首支撑面仍是角色下方最高、
    // 间隙在 3px 内的台面，则吸附回去并保持接地，避免亚像素 leave/land 抖动。
    const support = findSolid(state.solids, p.groundId);
    const jumped = state.events.some((e) => e.step === state.step && (e.type === 'jump' || e.type === 'coyote-jump' || e.type === 'buffered-jump'));
    let reattached = false;
    if (!jumped && support) {
      const gap = support.y - (p.y + p.h);
      const isHighestBelow = !state.solids.some((s) => s.id !== support.id && s.y > support.y && s.y < p.y + p.h && p.x + p.w > s.x && p.x < s.x + s.w);
      if (gap >= 0 && gap <= 3 && isHighestBelow) {
        p.y = support.y - p.h;
        p.contacts.down = true;
        p.grounded = true;
        p.vy = 0;
        reattached = true;
      }
    }
    if (!reattached) {
      p.grounded = false;
      if (p.groundId !== null) {
        const left = findSolid(state.solids, p.groundId);
        pushEvent(state, 'leave', `离开支撑:${left?.label ?? p.groundId}`);
        p.groundId = null;
      }
      if (p.coyoteTimer > 0) {
        p.coyoteTimer = Math.max(0, p.coyoteTimer - FIXED_DT);
      }
    }
  }
  if (p.jumpBufferTimer > 0) {
    p.jumpBufferTimer = Math.max(0, p.jumpBufferTimer - FIXED_DT);
  }
  // 按下事件只活一个步帧；松开后才允许下一次起跳
  if (!input.jumpPressed) {
    p.jumpConsumed = false;
  }
}

export function createPlayer(preset: WorldPreset): PlayerState {
  return {
    x: preset.player.x,
    y: preset.player.y,
    w: preset.player.w,
    h: preset.player.h,
    vx: 0,
    vy: 0,
    grounded: false,
    groundId: null,
    prevGroundId: null,
    contacts: { left: false, right: false, up: false, down: false },
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpConsumed: false,
  };
}

export function createSim(preset: WorldPreset, params: TunableParams): SimState {
  const state: SimState = {
    time: 0,
    step: 0,
    params: { ...params },
    player: createPlayer(preset),
    solids: buildSolids(preset, 0, FIXED_DT),
    events: [],
  };
  return state;
}

export function resetSim(state: SimState, preset: WorldPreset): void {
  const fresh = createSim(preset, state.params);
  state.time = fresh.time;
  state.step = fresh.step;
  state.player = fresh.player;
  state.solids = fresh.solids;
  state.events.length = 0;
}
