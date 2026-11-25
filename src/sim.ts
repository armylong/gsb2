import * as THREE from 'three';

export const DISK_RADIUS = 0.28;
export const FIXED_DT = 1 / 120;

export type ScenarioId = 'home' | 'perch';
export type DiskMode = 'attached' | 'switching' | 'free';

export interface Panel {
  id: string;
  name: string;
  center: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  n: THREE.Vector3;
  halfU: number;
  halfV: number;
  color: number;
  attachable: boolean;
  suction: number;
  acceleration: number;
  maxSpeed: number;
  damping: number;
}

export interface BoxCollider {
  id: string;
  name: string;
  center: THREE.Vector3;
  size: THREE.Vector3;
  attachable: false;
  color: number;
}

export interface CrossingRule {
  id: string;
  fromPanelId: string;
  axis: 'u' | 'v';
  edgeValue: number;
  direction: 1 | -1;
  toPanelId: string;
  toAxis: 'u' | 'v';
  toEdgeValue: number;
  toDirection: 1 | -1;
  hingeAxis: THREE.Vector3;
  outer: boolean;
  label: string;
  reverse?: boolean;
}

export interface MissingEdge {
  panelId: string;
  axis: 'u' | 'v';
  value: number;
  direction: 1 | -1;
  label: string;
}

export interface SimEvent {
  time: number;
  type: 'info' | 'switch' | 'detach' | 'attach' | 'missing' | 'block' | 'verify';
  message: string;
}

export interface SwitchRecord {
  id: string;
  time: number;
  fromPanelId: string;
  toPanelId: string;
  outer: boolean;
  label: string;
  beforeSpeed: number;
  afterSpeed: number;
  before: THREE.Vector3;
  after: THREE.Vector3;
}

export interface DetachRecord {
  time: number;
  reason: string;
  panelId: string | null;
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
}

export interface TransitionState {
  rule: CrossingRule;
  elapsed: number;
  duration: number;
  fromPos: THREE.Vector3;
  toPos: THREE.Vector3;
  fromVel: THREE.Vector3;
  afterVel: THREE.Vector3;
  fromHeading: THREE.Vector3;
  toHeading: THREE.Vector3;
}

export interface FaceScore {
  panelId: string;
  score: number;
  planeError: number;
  boundsOutside: number;
}

export interface InputState {
  x: number;
  y: number;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const NEG_Z = new THREE.Vector3(0, 0, -1);

export const HOME_POSITION = new THREE.Vector3(-5 - DISK_RADIUS, DISK_RADIUS, 0);
export const HOME_PAD = new THREE.Vector3(-5 - DISK_RADIUS, 0.012, 0);
export const PERCH_POSITION = new THREE.Vector3(-5 - DISK_RADIUS, 2.25, 0);

function panel(
  init: Omit<Panel, 'n' | 'attachable'> & { n?: THREE.Vector3; attachable?: boolean },
): Panel {
  const u = init.u.clone().normalize();
  const v = init.v.clone().normalize();
  const n = init.n ? init.n.clone().normalize() : new THREE.Vector3().crossVectors(u, v).normalize();
  return { attachable: true, ...init, u, v, n };
}

export function createPanels(): Panel[] {
  return [
    panel({
      id: 'floor',
      name: '起点吸附地面',
      center: new THREE.Vector3(-2, 0, 0),
      u: X,
      v: NEG_Z,
      halfU: 6,
      halfV: 2.2,
      color: 0x2dd4bf,
      suction: 0.72,
      acceleration: 18,
      maxSpeed: 3.4,
      damping: 3.1,
    }),
    panel({
      id: 'w0',
      name: '一号直角吸附墙',
      center: new THREE.Vector3(-5, 2, 0),
      u: Y,
      v: NEG_Z,
      halfU: 2,
      halfV: 1.5,
      color: 0x38bdf8,
      suction: 0.95,
      acceleration: 17,
      maxSpeed: 3.4,
      damping: 3.4,
    }),
    panel({
      id: 'top',
      name: '顶部吸附桥',
      center: new THREE.Vector3(-2, 4, 0),
      u: X,
      v: NEG_Z,
      halfU: 3,
      halfV: 1.5,
      color: 0xa78bfa,
      suction: 0.9,
      acceleration: 17,
      maxSpeed: 3.4,
      damping: 3.2,
    }),
    panel({
      id: 'w1',
      name: '二号外角吸附墙',
      center: new THREE.Vector3(1, 2.7, 0),
      // local +U points downward, so entering from the top is U=-halfU.
      u: new THREE.Vector3(0, -1, 0),
      v: NEG_Z,
      halfU: 1.3,
      halfV: 1.5,
      color: 0xf59e0b,
      suction: 1,
      acceleration: 16,
      maxSpeed: 3.4,
      damping: 3.5,
    }),
  ];
}

export function createBlocker(): BoxCollider {
  return {
    id: 'blocker',
    name: '禁止吸附隔板',
    center: new THREE.Vector3(-3.15, 0.75, 1.82),
    size: new THREE.Vector3(0.18, 1.5, 1.25),
    attachable: false,
    color: 0xef4444,
  };
}

function forwardRules(): CrossingRule[] {
  return [
    {
      id: 'floor-w0',
      fromPanelId: 'floor',
      axis: 'u',
      edgeValue: -3, // internal seam x=-5 where the climbing wall meets the floor
      direction: 1,
      toPanelId: 'w0',
      toAxis: 'u',
      toEdgeValue: -2,
      toDirection: 1,
      hingeAxis: Z,
      outer: false,
      label: '地面 → 一号墙（内直角）',
    },
    {
      id: 'w0-top',
      fromPanelId: 'w0',
      axis: 'u',
      edgeValue: 2,
      direction: 1,
      toPanelId: 'top',
      toAxis: 'u',
      toEdgeValue: -3,
      toDirection: 1,
      hingeAxis: Z,
      outer: true,
      label: '外角 1：一号墙 → 顶桥',
    },
    {
      id: 'top-w1',
      fromPanelId: 'top',
      axis: 'u',
      edgeValue: 3,
      direction: 1,
      toPanelId: 'w1',
      toAxis: 'u',
      toEdgeValue: -1.3,
      toDirection: 1,
      hingeAxis: Z,
      outer: true,
      label: '外角 2：顶桥 → 二号墙',
    },
  ];
}

function reverseRule(rule: CrossingRule): CrossingRule {
  return {
    ...rule,
    id: `${rule.id}-reverse`,
    fromPanelId: rule.toPanelId,
    toPanelId: rule.fromPanelId,
    axis: rule.toAxis,
    edgeValue: rule.toEdgeValue,
    direction: (rule.toDirection * -1) as 1 | -1,
    toAxis: rule.axis,
    toEdgeValue: rule.edgeValue,
    toDirection: (rule.direction * -1) as 1 | -1,
    reverse: true,
    label: `${rule.label}（反向）`,
  };
}

export const MISSING_EDGES: MissingEdge[] = [
  {
    panelId: 'w1',
    axis: 'u',
    value: 1.3,
    direction: 1,
    label: '缺面：二号墙下段未安装',
  },
];

export class MagneticSimulation {
  readonly radius = DISK_RADIUS;
  readonly panels: Panel[];
  readonly panelById = new Map<string, Panel>();
  readonly blocker: BoxCollider;
  readonly rules: CrossingRule[];
  readonly rulesByPanel = new Map<string, CrossingRule[]>();

  mode: DiskMode = 'attached';
  panelId: string | null = 'floor';
  position = HOME_POSITION.clone();
  velocity = new THREE.Vector3();
  heading = X.clone();
  localU = 0;
  localV = 0;
  time = 0;
  switchCooldown = 0;
  detachGrace = 0;
  inputDirection = new THREE.Vector3();
  transition: TransitionState | null = null;
  lastSwitch: SwitchRecord | null = null;
  lastDetach: DetachRecord | null = null;
  events: SimEvent[] = [];
  switchLog: SwitchRecord[] = [];
  stableFaceId: string | null = 'floor';
  stableCandidateId: string | null = null;
  stableTimer = 0;
  lastScores: FaceScore[] = [];
  blockedThisFrame = false;

  constructor() {
    this.panels = createPanels();
    for (const p of this.panels) this.panelById.set(p.id, p);
    this.blocker = createBlocker();
    this.rules = [...forwardRules(), ...forwardRules().map(reverseRule)];
    for (const rule of this.rules) {
      const list = this.rulesByPanel.get(rule.fromPanelId) ?? [];
      list.push(rule);
      this.rulesByPanel.set(rule.fromPanelId, list);
    }
    this.reset('home');
  }

  reset(scenario: ScenarioId = 'home'): void {
    this.time = 0;
    this.events = [];
    this.switchLog = [];
    this.lastSwitch = null;
    this.lastDetach = null;
    this.transition = null;
    this.switchCooldown = 0.2;
    this.detachGrace = 0;
    this.velocity.set(0, 0, 0);
    this.inputDirection.set(0, 0, 0);
    this.stableTimer = 0;
    this.stableCandidateId = null;

    if (scenario === 'perch') {
      this.mode = 'attached';
      this.panelId = 'w0';
      this.position.copy(PERCH_POSITION);
      this.heading.set(0, 1, 0);
      this.stableFaceId = 'w0';
    } else {
      this.mode = 'attached';
      this.panelId = 'floor';
      this.position.copy(HOME_POSITION);
      this.heading.set(1, 0, 0);
      this.stableFaceId = 'floor';
    }
    this.updateLocalCoordinates();
    this.emit('info', scenario === 'perch' ? '已重置到脱离回落点' : '已重置到起点');
  }

  emit(type: SimEvent['type'], message: string): void {
    this.events.push({ time: this.time, type, message });
    if (this.events.length > 80) this.events.shift();
  }

  panel(): Panel | null {
    return this.panelId ? this.panelById.get(this.panelId) ?? null : null;
  }

  distanceToHome(): number {
    const dx = this.position.x - HOME_PAD.x;
    const dz = this.position.z - HOME_PAD.z;
    return Math.hypot(dx, dz);
  }

  isAtHome(tolerance = 0.42): boolean {
    return this.mode === 'attached' && this.panelId === 'floor' && this.distanceToHome() <= tolerance;
  }

  inputDirectionForView(input: InputState, right: THREE.Vector3, up: THREE.Vector3): THREE.Vector3 {
    const p = this.panel();
    if (!p || this.mode === 'free') return this.inputDirection.set(0, 0, 0);

    const r = right.clone().projectOnPlane(p.n);
    const u = up.clone().projectOnPlane(p.n);
    if (r.lengthSq() > 1e-6) r.normalize();
    else r.set(0, 0, 0);
    if (u.lengthSq() > 1e-6) u.normalize();
    else u.set(0, 0, 0);

    const dir = new THREE.Vector3()
      .addScaledVector(r, input.x)
      .addScaledVector(u, input.y);
    if (dir.lengthSq() > 1) dir.normalize();
    this.inputDirection.copy(dir);
    return dir;
  }

  step(
    rawDt: number,
    input: InputState = { x: 0, y: 0 },
    viewRight: THREE.Vector3 = X,
    viewUp: THREE.Vector3 = Y,
  ): void {
    const dt = Math.min(rawDt, 0.033);
    this.time += dt;
    this.switchCooldown = Math.max(0, this.switchCooldown - dt);
    this.detachGrace = Math.max(0, this.detachGrace - dt);
    this.blockedThisFrame = false;

    if (this.mode === 'switching' && this.transition) {
      this.updateTransition(dt);
    } else if (this.mode === 'attached') {
      this.updateAttached(dt, input, viewRight, viewUp);
    } else {
      this.updateFree(dt);
    }

    this.resolveBlocker();
    this.selectStableFace(dt);

    if (this.mode === 'free' && this.position.y < -8) {
      this.emit('info', '坠落出界，保护复位到起点');
      this.reset('home');
    }
  }

  private updateLocalCoordinates(): void {
    const p = this.panel();
    if (!p) return;
    const rel = this.position.clone().sub(p.center);
    this.localU = rel.dot(p.u);
    this.localV = rel.dot(p.v);
  }

  private updateAttached(
    dt: number,
    input: InputState,
    viewRight: THREE.Vector3,
    viewUp: THREE.Vector3,
  ): void {
    const p = this.panel();
    if (!p) {
      this.detach('丢失接触面', 0);
      return;
    }

    const dir = this.inputDirectionForView(input, viewRight, viewUp);
    const hasInput = dir.lengthSq() > 0.002;
    if (hasInput) {
      this.velocity.addScaledVector(dir, p.acceleration * dt);
      this.heading.lerp(dir, 1 - Math.exp(-14 * dt)).normalize();
    }

    const damping = hasInput ? p.damping * 0.42 : p.damping;
    this.velocity.multiplyScalar(Math.exp(-damping * dt));
    this.velocity.addScaledVector(p.n, -this.velocity.dot(p.n));
    const speed = this.velocity.length();
    if (speed > p.maxSpeed) this.velocity.multiplyScalar(p.maxSpeed / speed);

    this.position.addScaledVector(this.velocity, dt);
    this.snapToPanel(p);
    this.updateLocalCoordinates();

    if (this.tryStartCrossing(p)) return;
    if (this.checkMissingEdge(p)) return;

    this.constrainToPanelBounds(p);
    this.snapToPanel(p);
    this.updateLocalCoordinates();
  }

  private snapToPanel(p: Panel): void {
    const rel = this.position.clone().sub(p.center);
    const lu = rel.dot(p.u);
    const lv = rel.dot(p.v);
    this.position
      .copy(p.center)
      .addScaledVector(p.u, lu)
      .addScaledVector(p.v, lv)
      .addScaledVector(p.n, this.radius);
  }

  private tryStartCrossing(p: Panel): boolean {
    if (this.switchCooldown > 0) return false;
    const rules = this.rulesByPanel.get(p.id) ?? [];
    for (const rule of rules) {
      const localAxis = rule.axis === 'u' ? this.localU : this.localV;
      const travel = p[rule.axis].clone().multiplyScalar(rule.direction as number);
      const crossSpeed = this.velocity.dot(travel);
      const inputOut = this.inputDirection.dot(travel);
      const remaining = (rule.edgeValue - localAxis) * rule.direction;
      const proximityCommit = remaining <= 0.06;
      if (
        remaining <= 0.34 &&
        remaining > -0.55 &&
        (crossSpeed > 0.08 || inputOut > 0.55 || proximityCommit)
      ) {
        this.startTransition(rule, p);
        return true;
      }
    }
    return false;
  }

  private checkMissingEdge(p: Panel): boolean {
    for (const edge of MISSING_EDGES) {
      if (edge.panelId !== p.id) continue;
      const localAxis = edge.axis === 'u' ? this.localU : this.localV;
      const remaining = (edge.value - localAxis) * edge.direction;
      if (remaining <= 0.04) {
        this.emit('missing', edge.label);
        this.detach(edge.label, 0.05);
        return true;
      }
    }
    return false;
  }

  private constrainToPanelBounds(p: Panel): void {
    const rel = this.position.clone().sub(p.center);
    let lu = rel.dot(p.u);
    let lv = rel.dot(p.v);

    if (lu > p.halfU) {
      const outward = p.u;
      const vn = this.velocity.dot(outward);
      if (vn > 0) this.velocity.addScaledVector(outward, -vn);
      lu = p.halfU;
    } else if (lu < -p.halfU) {
      const outward = p.u.clone().negate();
      const vn = this.velocity.dot(outward);
      if (vn > 0) this.velocity.addScaledVector(outward, -vn);
      lu = -p.halfU;
    }

    if (lv > p.halfV) {
      const outward = p.v;
      const vn = this.velocity.dot(outward);
      if (vn > 0) this.velocity.addScaledVector(outward, -vn);
      lv = p.halfV;
    } else if (lv < -p.halfV) {
      const outward = p.v.clone().negate();
      const vn = this.velocity.dot(outward);
      if (vn > 0) this.velocity.addScaledVector(outward, -vn);
      lv = -p.halfV;
    }

    this.position
      .copy(p.center)
      .addScaledVector(p.u, lu)
      .addScaledVector(p.v, lv)
      .addScaledVector(p.n, this.radius);
  }

  private startTransition(rule: CrossingRule, fromPanel: Panel): void {
    const toPanel = this.panelById.get(rule.toPanelId);
    if (!toPanel) return;

    const before = this.velocity.clone();
    const beforeSpeed = before.length();
    const oldCross = fromPanel[rule.axis].clone().multiplyScalar(rule.direction as number);
    const newCross = toPanel[rule.toAxis].clone().multiplyScalar(rule.toDirection as number);
    const hinge = rule.hingeAxis.clone().normalize();
    const hingeSpeed = before.dot(hinge);
    const crossSpeed = before.dot(oldCross);
    const after = hinge.clone().multiplyScalar(hingeSpeed).addScaledVector(newCross, crossSpeed);
    if (after.lengthSq() < 1e-8 && beforeSpeed > 0.1) after.copy(newCross).multiplyScalar(beforeSpeed);

    const otherAxis = rule.axis === 'u' ? 'v' : 'u';
    const along = otherAxis === 'u' ? this.localU : this.localV;
    const edgePoint = fromPanel.center
      .clone()
      .addScaledVector(fromPanel[rule.axis], rule.edgeValue)
      .addScaledVector(fromPanel[otherAxis], along);

    const innerInset = rule.outer ? 0.04 : this.radius * 0.82;
    const toPos = edgePoint
      .clone()
      .addScaledVector(toPanel.n, this.radius)
      .addScaledVector(newCross, innerInset);

    const toHeading = after.lengthSq() > 1e-6 ? after.clone().normalize() : newCross.clone().normalize();
    const record: SwitchRecord = {
      id: rule.id,
      time: this.time,
      fromPanelId: fromPanel.id,
      toPanelId: toPanel.id,
      outer: rule.outer,
      label: rule.label,
      beforeSpeed,
      afterSpeed: after.length(),
      before: before.clone(),
      after: after.clone(),
    };
    this.lastSwitch = record;
    this.switchLog.push(record);
    if (this.switchLog.length > 30) this.switchLog.shift();
    this.emit('switch', `${rule.label}；速度 ${beforeSpeed.toFixed(2)} → ${after.length().toFixed(2)} m/s`);

    this.mode = 'switching';
    this.transition = {
      rule,
      elapsed: 0,
      duration: 0.18,
      fromPos: this.position.clone(),
      toPos,
      fromVel: before.clone(),
      afterVel: after,
      fromHeading: this.heading.clone(),
      toHeading,
    };
    this.velocity.copy(after);
  }

  private updateTransition(dt: number): void {
    const tr = this.transition;
    if (!tr) return;
    tr.elapsed += dt;
    const raw = Math.min(1, tr.elapsed / tr.duration);
    const t = raw * raw * (3 - 2 * raw);
    this.position.lerpVectors(tr.fromPos, tr.toPos, t);
    this.velocity.lerpVectors(tr.fromVel, tr.afterVel, t);
    this.heading.lerpVectors(tr.fromHeading, tr.toHeading, t).normalize();

    if (raw >= 1) {
      const toPanel = this.panelById.get(tr.rule.toPanelId)!;
      this.mode = 'attached';
      this.panelId = toPanel.id;
      this.position.copy(tr.toPos);
      this.velocity.copy(tr.afterVel);
      this.heading.copy(tr.toHeading);
      this.transition = null;
      this.switchCooldown = 0.34;
      this.snapToPanel(toPanel);
      this.updateLocalCoordinates();
      this.stableFaceId = toPanel.id;
      this.stableTimer = 0;
    }
  }

  detach(reason = '主动脱离', outwardImpulse = 0.22): void {
    if (this.mode === 'free') return;
    const p = this.panel();
    if (p && outwardImpulse > 0) this.velocity.addScaledVector(p.n, outwardImpulse);
    this.lastDetach = {
      time: this.time,
      reason,
      panelId: this.panelId,
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      speed: this.velocity.length(),
    };
    this.mode = 'free';
    this.panelId = null;
    this.transition = null;
    this.detachGrace = 0.3;
    this.emit('detach', `圆盘脱离：${reason}`);
  }

  tryAttach(): boolean {
    const best = this.scoreFaces(this.position)[0];
    if (!best || best.planeError > 0.45 || best.boundsOutside > 0.35) return false;
    const p = this.panelById.get(best.panelId)!;
    this.mode = 'attached';
    this.panelId = p.id;
    this.detachGrace = 0.2;
    this.snapToPanel(p);
    this.velocity.addScaledVector(p.n, -this.velocity.dot(p.n));
    this.updateLocalCoordinates();
    this.emit('attach', `主动吸附到 ${p.name}`);
    return true;
  }

  private updateFree(dt: number): void {
    this.velocity.y -= 9.8 * dt;
    this.position.addScaledVector(this.velocity, dt);

    if (this.detachGrace <= 0) {
      for (const p of this.panels) {
        if (this.collideFreeWithPanel(p)) return;
      }
    } else {
      // Still collide with the floor during grace; magnetic reattachment is simply immediate.
      const floor = this.panelById.get('floor');
      if (floor) this.collideFreeWithPanel(floor, true);
    }
  }

  private collideFreeWithPanel(p: Panel, forceAttach = false): boolean {
    const rel = this.position.clone().sub(p.center);
    const d = rel.dot(p.n);
    const lu = rel.dot(p.u);
    const lv = rel.dot(p.v);
    if (Math.abs(lu) > p.halfU + 0.12 || Math.abs(lv) > p.halfV + 0.12) return false;

    const vn = this.velocity.dot(p.n);
    // Only an inward-moving body contacts. Tangential motion at exactly R must not reattach.
    if (d < this.radius && vn < -0.02) {
      this.position.addScaledVector(p.n, this.radius - d);
      const impact = -vn;
      this.velocity.addScaledVector(p.n, -vn);
      if (impact > 1.2) this.velocity.addScaledVector(p.n, impact * 0.08);
      this.velocity.multiplyScalar(0.92);

      if (p.attachable && (this.detachGrace <= 0 || forceAttach)) {
        this.mode = 'attached';
        this.panelId = p.id;
        this.velocity.addScaledVector(p.n, -this.velocity.dot(p.n));
        this.snapToPanel(p);
        this.updateLocalCoordinates();
        this.stableFaceId = p.id;
        this.emit('attach', `重力回落并吸附到 ${p.name}`);
        return true;
      }
    }
    return false;
  }

  scoreFaces(position: THREE.Vector3): FaceScore[] {
    const scores: FaceScore[] = this.panels.map((p) => {
      const rel = position.clone().sub(p.center);
      const lu = rel.dot(p.u);
      const lv = rel.dot(p.v);
      const normalOffset = rel.dot(p.n);
      const boundsOutside = Math.max(0, Math.abs(lu) - p.halfU, Math.abs(lv) - p.halfV);
      const planeError = Math.abs(normalOffset - this.radius);
      return {
        panelId: p.id,
        planeError,
        boundsOutside,
        score: planeError + boundsOutside * 1.35 - p.suction * 0.08,
      };
    });
    scores.sort((a, b) => a.score - b.score);
    this.lastScores = scores;
    return scores;
  }

  private selectStableFace(dt: number): string | null {
    const scores = this.scoreFaces(this.position).filter(
      (s) => s.planeError < 0.72 && s.boundsOutside < 0.75,
    );
    if (scores.length === 0) {
      this.stableCandidateId = null;
      this.stableTimer = 0;
      return this.stableFaceId;
    }

    const best = scores[0];
    const incumbent = scores.find((s) => s.panelId === this.stableFaceId);
    const incumbentScore = incumbent ? incumbent.score : Number.POSITIVE_INFINITY;
    const challengerWins = best.panelId !== this.stableFaceId && best.score < incumbentScore - 0.16;

    if (challengerWins) {
      if (this.stableCandidateId !== best.panelId) {
        this.stableCandidateId = best.panelId;
        this.stableTimer = 0;
      } else {
        this.stableTimer += dt;
      }
      if (this.stableTimer >= 0.14) {
        this.stableFaceId = best.panelId;
        this.stableTimer = 0;
      }
    } else {
      this.stableCandidateId = null;
      this.stableTimer = 0;
      if (!incumbent && best.score < 0.22) this.stableFaceId = best.panelId;
    }
    return this.stableFaceId;
  }

  private resolveBlocker(): void {
    const b = this.blocker;
    const min = b.center.clone().sub(b.size.clone().multiplyScalar(0.5));
    const max = b.center.clone().add(b.size.clone().multiplyScalar(0.5));
    const closest = this.position.clone();
    closest.x = THREE.MathUtils.clamp(closest.x, min.x, max.x);
    closest.y = THREE.MathUtils.clamp(closest.y, min.y, max.y);
    closest.z = THREE.MathUtils.clamp(closest.z, min.z, max.z);

    const delta = this.position.clone().sub(closest);
    let distance = delta.length();
    if (distance >= this.radius) return;

    let normal: THREE.Vector3;
    if (distance < 1e-5) {
      // Degenerate center-inside-box case: push along smallest penetration.
      const px = Math.min(this.position.x - min.x, max.x - this.position.x);
      const py = Math.min(this.position.y - min.y, max.y - this.position.y);
      const pz = Math.min(this.position.z - min.z, max.z - this.position.z);
      if (px <= py && px <= pz) normal = X.clone().multiplyScalar(this.position.x < b.center.x ? -1 : 1);
      else if (py <= pz) normal = Y.clone().multiplyScalar(this.position.y < b.center.y ? -1 : 1);
      else normal = Z.clone().multiplyScalar(this.position.z < b.center.z ? -1 : 1);
      distance = 0;
    } else {
      normal = delta.divideScalar(distance);
    }

    this.position.addScaledVector(normal, this.radius - distance + 0.001);
    const vn = this.velocity.dot(normal);
    if (vn < 0) {
      this.velocity.addScaledVector(normal, -vn * 1.05);
      this.velocity.multiplyScalar(0.82);
    }
    this.blockedThisFrame = true;
    if (this.mode === 'attached') this.snapToPanel(this.panel()!);
  }

  /** Convenience for deterministic scripts and tests. */
  runFor(seconds: number, input: InputState, right?: THREE.Vector3, up?: THREE.Vector3): void {
    let remaining = seconds;
    while (remaining > 0) {
      const dt = Math.min(FIXED_DT, remaining);
      this.step(dt, input, right, up);
      remaining -= dt;
    }
  }
}

export const SIDE_VIEW_RIGHT = X.clone();
export const SIDE_VIEW_UP = Y.clone();
