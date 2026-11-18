import {
  World,
  Vec2,
  Body,
  Circle,
  Box,
  Polygon,
  testOverlap,
} from 'planck';

/** 固定模拟步长(秒)。所有播放速度共用同一步长,保证结果一致。 */
export const DT = 1 / 120;
/** 画布比例:像素/米 */
export const SCALE = 50;
/** 动态刚体数量上限 */
export const MAX_BODIES = 40;

export type BodyKind = 'circle' | 'rect' | 'poly';

export interface BodyParams {
  mass: number;
  friction: number;
  restitution: number;
}

export interface ContactPointInfo {
  x: number;
  y: number;
  /** 穿透深度(米,>=0) */
  depth: number;
}

export interface ContactInfo {
  /** 参与接触的刚体 id;静态环境(地面/斜坡)id 为 0 */
  idA: number;
  idB: number;
  /** 接触法线(单位向量,由 A 指向 B) */
  normalX: number;
  normalY: number;
  points: ContactPointInfo[];
}

export interface BodyReadings {
  id: number;
  kind: BodyKind;
  x: number;
  y: number;
  angleDeg: number;
  vx: number;
  vy: number;
  omega: number;
  params: BodyParams;
}

interface BodyRecord {
  id: number;
  kind: BodyKind;
  body: Body;
}

/**
 * 模拟核心:不依赖 DOM,可在 Node 中独立运行(测试直接复用)。
 * 只提供固定步长 stepOnce,播放速度由外层累加器决定,
 * 因此同一初始场景推进到同一模拟时刻,结果与播放速度无关。
 */
export class Sim {
  readonly world: World;
  private records = new Map<number, BodyRecord>();
  private idOf = new Map<Body, number>();
  private nextId = 1;
  /** 模拟时间(秒) */
  time = 0;
  /** 已推进的步数 */
  steps = 0;

  constructor() {
    this.world = new World({ gravity: new Vec2(0, -10) });
  }

  /** 动态刚体数量(不含地面等静态环境) */
  get dynamicCount(): number {
    return this.records.size;
  }

  /** 推进一个固定步长 */
  stepOnce(): void {
    this.world.step(DT, 8, 3);
    this.time += DT;
    this.steps += 1;
  }

  clear(): void {
    this.world.clearForces();
    for (let b = this.world.getBodyList(); b; ) {
      const next = b.getNext();
      this.world.destroyBody(b);
      b = next;
    }
    this.records.clear();
    this.idOf.clear();
    this.nextId = 1;
    this.time = 0;
    this.steps = 0;
  }

  private register(kind: BodyKind, body: Body): number {
    const id = this.nextId++;
    this.records.set(id, { id, kind, body });
    this.idOf.set(body, id);
    return id;
  }

  /** 静态环境刚体(地面、斜坡),不计入数量上限,id 固定为 0 */
  addStaticBox(cx: number, cy: number, halfW: number, halfH: number, angle = 0, friction = 0.6): void {
    const body = this.world.createBody({ position: new Vec2(cx, cy), angle });
    body.createFixture({ shape: new Box(halfW, halfH), friction });
    this.idOf.set(body, 0);
  }

  addCircle(x: number, y: number, r = 0.5, params: Partial<BodyParams> = {}): number | null {
    if (this.dynamicCount >= MAX_BODIES) return null;
    const body = this.world.createBody({ type: 'dynamic', position: new Vec2(x, y) });
    body.createFixture({
      shape: new Circle(r),
      density: 1,
      friction: params.friction ?? 0.4,
      restitution: params.restitution ?? 0.1,
    });
    const id = this.register('circle', body);
    if (params.mass !== undefined) this.setParams(id, { mass: params.mass });
    return id;
  }

  addRect(
    x: number,
    y: number,
    halfW = 0.5,
    halfH = 0.5,
    angle = 0,
    params: Partial<BodyParams> = {},
  ): number | null {
    if (this.dynamicCount >= MAX_BODIES) return null;
    const body = this.world.createBody({ type: 'dynamic', position: new Vec2(x, y), angle });
    body.createFixture({
      shape: new Box(halfW, halfH),
      density: 1,
      friction: params.friction ?? 0.4,
      restitution: params.restitution ?? 0.1,
    });
    const id = this.register('rect', body);
    if (params.mass !== undefined) this.setParams(id, { mass: params.mass });
    return id;
  }

  addPoly(x: number, y: number, radius = 0.6, sides = 6, params: Partial<BodyParams> = {}): number | null {
    if (this.dynamicCount >= MAX_BODIES) return null;
    const verts: Vec2[] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2;
      verts.push(new Vec2(radius * Math.cos(a), radius * Math.sin(a)));
    }
    const body = this.world.createBody({ type: 'dynamic', position: new Vec2(x, y) });
    body.createFixture({
      shape: new Polygon(verts),
      density: 1,
      friction: params.friction ?? 0.4,
      restitution: params.restitution ?? 0.1,
    });
    const id = this.register('poly', body);
    if (params.mass !== undefined) this.setParams(id, { mass: params.mass });
    return id;
  }

  removeBody(id: number): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.world.destroyBody(rec.body);
    this.records.delete(id);
    this.idOf.delete(rec.body);
    return true;
  }

  getBody(id: number): Body | null {
    return this.records.get(id)?.body ?? null;
  }

  getKind(id: number): BodyKind | null {
    return this.records.get(id)?.kind ?? null;
  }

  listIds(): number[] {
    return [...this.records.keys()];
  }

  /** 修改质量/摩擦/弹性,作用于指定刚体 */
  setParams(id: number, p: Partial<BodyParams>): void {
    const rec = this.records.get(id);
    if (!rec) return;
    if (p.mass !== undefined && p.mass > 0) {
      const cur = rec.body.getMass();
      if (cur > 0) {
        const k = p.mass / cur;
        for (let f = rec.body.getFixtureList(); f; f = f.getNext()) {
          f.setDensity(f.getDensity() * k);
        }
        rec.body.resetMassData();
      }
    }
    for (let f = rec.body.getFixtureList(); f; f = f.getNext()) {
      if (p.friction !== undefined) f.setFriction(p.friction);
      if (p.restitution !== undefined) f.setRestitution(p.restitution);
    }
    rec.body.setAwake(true);
  }

  getParams(id: number): BodyParams | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    const f = rec.body.getFixtureList();
    return {
      mass: rec.body.getMass(),
      friction: f ? f.getFriction() : 0,
      restitution: f ? f.getRestitution() : 0,
    };
  }

  getReadings(id: number): BodyReadings | null {
    const rec = this.records.get(id);
    if (!rec) return null;
    const pos = rec.body.getPosition();
    const v = rec.body.getLinearVelocity();
    const params = this.getParams(id)!;
    return {
      id,
      kind: rec.kind,
      x: pos.x,
      y: pos.y,
      angleDeg: (rec.body.getAngle() * 180) / Math.PI,
      vx: v.x,
      vy: v.y,
      omega: rec.body.getAngularVelocity(),
      params,
    };
  }

  /** 对指定刚体质心施加一次线性冲量 */
  applyImpulse(id: number, jx: number, jy: number): void {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.body.applyLinearImpulse(new Vec2(jx, jy), rec.body.getWorldCenter(), true);
  }

  /**
   * 暂停时尝试把刚体放到 (x,y)。
   * 与任何其他刚体重叠时拒绝并返回 false,刚体保持原位。
   */
  tryMoveBody(id: number, x: number, y: number): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    // getPosition 返回内部向量的引用,必须克隆后再做临时移动
    const pos = rec.body.getPosition().clone();
    const angle = rec.body.getAngle();
    rec.body.setTransform(new Vec2(x, y), angle);
    const overlap = this.overlapsAnything(rec.body);
    if (overlap) {
      rec.body.setTransform(pos, angle);
      return false;
    }
    rec.body.setLinearVelocity(new Vec2(0, 0));
    rec.body.setAngularVelocity(0);
    return true;
  }

  /** 仅检查放到 (x,y) 是否会重叠,不移动刚体 */
  wouldOverlap(id: number, x: number, y: number): boolean {
    const rec = this.records.get(id);
    if (!rec) return false;
    const pos = rec.body.getPosition().clone();
    const angle = rec.body.getAngle();
    rec.body.setTransform(new Vec2(x, y), angle);
    const overlap = this.overlapsAnything(rec.body);
    rec.body.setTransform(pos, angle);
    return overlap;
  }

  private overlapsAnything(body: Body): boolean {
    const xfA = body.getTransform();
    for (let other = this.world.getBodyList(); other; other = other.getNext()) {
      if (other === body) continue;
      const xfB = other.getTransform();
      for (let fa = body.getFixtureList(); fa; fa = fa.getNext()) {
        for (let fb = other.getFixtureList(); fb; fb = fb.getNext()) {
          if (testOverlap(fa.getShape(), 0, fb.getShape(), 0, xfA, xfB)) return true;
        }
      }
    }
    return false;
  }

  /** 当前所有正在接触的接触对(暂停时世界不变,标记自然保留) */
  getContacts(): ContactInfo[] {
    const out: ContactInfo[] = [];
    for (let c = this.world.getContactList(); c; c = c.getNext()) {
      if (!c.isTouching()) continue;
      const wm = c.getWorldManifold(null);
      if (!wm) continue;
      const bodyA = c.getFixtureA().getBody();
      const bodyB = c.getFixtureB().getBody();
      const idA = this.idOf.get(bodyA) ?? 0;
      const idB = this.idOf.get(bodyB) ?? 0;
      const points: ContactPointInfo[] = [];
      for (let i = 0; i < wm.points.length; i++) {
        points.push({
          x: wm.points[i].x,
          y: wm.points[i].y,
          depth: Math.max(0, -(wm.separations[i] ?? 0)),
        });
      }
      out.push({ idA, idB, normalX: wm.normal.x, normalY: wm.normal.y, points });
    }
    return out;
  }

  /** 状态快照,用于不同播放速度的结果对比 */
  snapshot(): { id: number; x: number; y: number; angle: number; vx: number; vy: number; omega: number }[] {
    return this.listIds()
      .sort((a, b) => a - b)
      .map((id) => {
        const b = this.records.get(id)!.body;
        const p = b.getPosition();
        const v = b.getLinearVelocity();
        return { id, x: p.x, y: p.y, angle: b.getAngle(), vx: v.x, vy: v.y, omega: b.getAngularVelocity() };
      });
  }
}

/** 用固定步长累加器按指定播放速度推进,与 UI 主循环同一套逻辑 */
export function advanceWithSpeed(sim: Sim, realDt: number, speed: number, accumulator: { acc: number }): void {
  accumulator.acc += realDt * speed;
  while (accumulator.acc >= DT) {
    sim.stepOnce();
    accumulator.acc -= DT;
  }
}
