/**
 * ChainEngine：与 DOM/Canvas 无关的物理核心，基于 planck.js（Box2D 移植）。
 *
 * 负责：
 * - 构建一条由矩形刚体 + revolute 关节组成、顶端固定的链，可选末端重物；
 * - 地面与两个静态圆形障碍、链节间碰撞（相邻链节按统一规则可排除）；
 * - 临时 mouse joint 拖拽（松手即销毁，不直接改体位，不冒充关节响应）；
 * - 暂停时拆开/恢复关节（恢复要求两端连接点足够近，不瞬移）；
 * - 固定步长推进，保证不同显示帧率下模拟时间一致。
 */
import {
  Box,
  Circle,
  MouseJoint,
  RevoluteJoint,
  Vec2,
  World,
  type Contact,
  type Body,
  type Joint,
  type RevoluteJoint as RevoluteJointType,
} from 'planck';
import {
  FIXED_DT,
  GROUND_Y,
  MAX_STEPS_PER_FRAME,
  MOUSE_FORCE_FACTOR,
  OBSTACLES,
  POSITION_ITERATIONS,
  RECONNECT_THRESHOLD,
  VELOCITY_ITERATIONS,
} from './config';
import type {
  DragHandle,
  JointReadout,
  JointRecord,
  LinkRecord,
  ScenarioConfig,
  SimParams,
  StaticRecord,
} from './types';

export class ChainEngine {
  readonly world: World;
  readonly scenario: ScenarioConfig;
  params: SimParams;

  /** 顶端固定用的静态刚体 */
  readonly anchorBody: Body;
  readonly links: LinkRecord[] = [];
  readonly joints: JointRecord[] = [];
  readonly statics: StaticRecord[] = [];

  weightBody: Body | null = null;
  /** 相邻链节编号对集合，碰撞过滤的唯一数据来源（统一规则） */
  private readonly adjacentPairs = new Set<string>();
  /** 当前临时拖拽约束，松手即销毁 */
  private drag: DragHandle | null = null;
  /** 累计已推进的模拟时间（秒） */
  private simTime = 0;
  /** 累计已推进的固定步数 */
  private stepCount = 0;
  /** 跨帧时间累积器：不足一个固定步的零头结转至下一帧，避免 rAF 抖动造成漂移 */
  private accumulator = 0;
  private readonly preSolveHandler: (contact: Contact) => void;

  constructor(scenario: ScenarioConfig, params: SimParams) {
    this.scenario = scenario;
    this.params = { ...params };
    this.world = new World(new Vec2(0, -this.params.gravity));
    this.world.setContinuousPhysics(true);

    this.anchorBody = this.world.createBody({ type: 'static' });
    this.buildStatics();
    this.buildChain();

    // 统一的相邻链节碰撞排除规则：在 pre-solve 中按编号对判定。
    this.preSolveHandler = (contact: Contact) => {
      if (!this.params.adjacentFilter) return;
      const bodyA = contact.getFixtureA().getBody();
      const bodyB = contact.getFixtureB().getBody();
      const key = this.pairKey(bodyA, bodyB);
      if (key !== null && this.adjacentPairs.has(key)) {
        contact.setEnabled(false);
      }
    };
    this.world.on('pre-solve', this.preSolveHandler);
  }

  // ---------------------------------------------------------------- 构建

  private buildStatics(): void {
    // 地面：很宽的静态矩形，顶边在 GROUND_Y
    const ground = this.world.createBody({ type: 'static', position: new Vec2(0, GROUND_Y - 1) });
    ground.createFixture(new Box(30, 1), { friction: 0.6, restitution: 0.1 });
    this.statics.push({ kind: 'ground', body: ground });

    // 两个静态圆形障碍
    for (const o of OBSTACLES) {
      const body = this.world.createBody({ type: 'static', position: new Vec2(o.x, o.y) });
      body.createFixture(new Circle(o.radius), { friction: 0.4, restitution: 0.2 });
      this.statics.push({ kind: 'circle', body });
    }
  }

  private buildChain(): void {
    const cfg = this.scenario;
    const h = cfg.linkHalfHeight;
    const lean = cfg.initialLean;
    // 沿倾斜方向每节的位移（每节有效长度为 2h）
    const dir = new Vec2(Math.sin(lean), -Math.cos(lean));
    const step = new Vec2(dir.x * 2 * h, dir.y * 2 * h);

    let prevBody: Body = this.anchorBody;
    // 固定端在静态 body 上的本地锚点（静态 body 位于原点且无旋转）
    let prevLocalAnchor: Vec2 = cfg.anchor.clone();

    for (let i = 0; i < cfg.linkCount; i++) {
      // 关节 i 的世界位置（链节 i 顶端）
      const jointPos = new Vec2(cfg.anchor.x + step.x * i, cfg.anchor.y + step.y * i);
      const center = new Vec2(jointPos.x + step.x / 2, jointPos.y + step.y / 2);
      const body = this.world.createBody({
        type: 'dynamic',
        position: center,
        angle: lean,
        linearDamping: 0.05,
        angularDamping: 0.1,
      });
      body.createFixture(new Box(cfg.linkHalfWidth, h), {
        density: cfg.linkDensity,
        friction: 0.4,
        restitution: 0.05,
      });

      const localAnchorB = new Vec2(0, h); // 链节自身顶端
      const joint = this.world.createJoint(
        new RevoluteJoint({
          bodyA: prevBody,
          bodyB: body,
          localAnchorA: prevLocalAnchor.clone(),
          localAnchorB,
          // 构建时所有链节朝向相同（lean），固定端视为 0 朝向，参考角按定义取当前相对角
          referenceAngle: prevBody.isDynamic() ? body.getAngle() - prevBody.getAngle() : body.getAngle(),
          // 显式允许连接体生成 contact，再由 pre-solve 的统一规则决定是否排除
          collideConnected: true,
          enableLimit: this.params.limitEnabled,
          lowerAngle: -this.params.limitAngle,
          upperAngle: this.params.limitAngle,
        }),
      ) as RevoluteJointType;

      this.joints.push({
        index: i,
        joint,
        bodyA: prevBody,
        bodyB: body,
        localAnchorA: prevLocalAnchor.clone(),
        localAnchorB,
        referenceAngle: joint.getJointAngle(),
        broken: false,
        isWeightJoint: false,
      });
      this.links.push({ index: i, body, halfWidth: cfg.linkHalfWidth, halfHeight: h });

      if (i > 0) this.adjacentPairs.add(this.pairKeyOfIndices(i - 1, i));
      prevBody = body;
      prevLocalAnchor = new Vec2(0, -h); // 下一节连接在本节底端
    }

    // 末端重物
    if (cfg.hasWeight) {
      const last = this.links[this.links.length - 1];
      const endPos = last.body.getWorldPoint(new Vec2(0, -h));
      const weight = this.world.createBody({
        type: 'dynamic',
        position: new Vec2(endPos.x, endPos.y - cfg.weightRadius - h),
        linearDamping: 0.05,
        angularDamping: 0.1,
      });
      weight.createFixture(new Circle(cfg.weightRadius), {
        density: 1,
        friction: 0.4,
        restitution: 0.1,
      });
      // 以当前可调参数里的质量为准（滑块调整在重置后依然生效）
      this.applyWeightMass(weight, this.params.weightMass);
      this.weightBody = weight;

      // 重物挂在最后一节底端；重物本地锚点取圆心
      const localAnchorA = new Vec2(0, -h);
      const joint = this.world.createJoint(
        new RevoluteJoint({
          bodyA: last.body,
          bodyB: weight,
          localAnchorA,
          localAnchorB: new Vec2(0, 0),
          referenceAngle: weight.getAngle() - last.body.getAngle(),
          collideConnected: true,
          enableLimit: this.params.limitEnabled,
          lowerAngle: -this.params.limitAngle,
          upperAngle: this.params.limitAngle,
        }),
      ) as RevoluteJointType;
      this.joints.push({
        index: this.joints.length,
        joint,
        bodyA: last.body,
        bodyB: weight,
        localAnchorA,
        localAnchorB: new Vec2(0, 0),
        referenceAngle: joint.getJointAngle(),
        broken: false,
        isWeightJoint: true,
      });
    }
  }

  /** 通过 setMassData 直接设定目标质量（保持质心在圆心，转动惯量按比例缩放） */
  private applyWeightMass(body: Body, mass: number): void {
    const oldMass = body.getMass();
    const oldInertia = body.getInertia();
    body.setMassData({
      mass,
      center: new Vec2(0, 0),
      I: oldInertia * (mass / oldMass),
    });
  }

  // ---------------------------------------------------------------- 碰撞过滤

  private pairKeyOfIndices(i: number, j: number): string {
    return i < j ? `${i}-${j}` : `${j}-${i}`;
  }

  private bodyLinkIndex(body: Body): number | null {
    const idx = this.links.findIndex((l) => l.body === body);
    return idx >= 0 ? idx : null;
  }

  private pairKey(a: Body, b: Body): string | null {
    const ia = this.bodyLinkIndex(a);
    const ib = this.bodyLinkIndex(b);
    if (ia === null || ib === null) return null;
    return this.pairKeyOfIndices(ia, ib);
  }

  // ---------------------------------------------------------------- 参数调整

  setGravity(g: number): void {
    this.params.gravity = g;
    this.world.setGravity(new Vec2(0, -g));
  }

  /** 实时更新所有现存关节的角度限制；拆开的关节在恢复时读取当前 params */
  setJointLimit(limitAngle: number, enabled: boolean): void {
    this.params.limitAngle = limitAngle;
    this.params.limitEnabled = enabled;
    for (const rec of this.joints) {
      if (!rec.joint) continue;
      rec.joint.enableLimit(enabled);
      rec.joint.setLimits(-limitAngle, limitAngle);
    }
  }

  setAdjacentFilter(enabled: boolean): void {
    this.params.adjacentFilter = enabled;
  }

  /** 重物质量实时调整（仅带重物样例） */
  setWeightMass(mass: number): void {
    this.params.weightMass = mass;
    if (this.weightBody) this.applyWeightMass(this.weightBody, mass);
  }

  // ---------------------------------------------------------------- 固定步长

  /** 推进恰好一个固定步（单步按钮使用）。暂停不改变速度状态。 */
  stepOnce(): void {
    this.world.step(FIXED_DT, VELOCITY_ITERATIONS, POSITION_ITERATIONS);
    this.simTime += FIXED_DT;
    this.stepCount += 1;
  }

  /**
   * 按真实经过时间推进固定步子步数。
   * - 持久累积器把不足一步的零头结转到下一帧，30Hz/60Hz 显示节奏或 rAF 抖动下，
   *   给定真实时间内推进的模拟时间一致；
   * - 积压超过 MAX_STEPS_PER_FRAME 步时截断（隐藏页面回来不会补出一段失控运动）。
   * 返回本帧实际执行的步数。
   */
  advance(elapsedSeconds: number): number {
    this.accumulator += Math.max(0, elapsedSeconds);
    if (this.accumulator > MAX_STEPS_PER_FRAME * FIXED_DT) {
      this.accumulator = MAX_STEPS_PER_FRAME * FIXED_DT;
    }
    let steps = 0;
    while (this.accumulator >= FIXED_DT - 1e-9 && steps < MAX_STEPS_PER_FRAME) {
      this.stepOnce();
      this.accumulator -= FIXED_DT;
      steps += 1;
    }
    return steps;
  }

  /** 清空累积零头（页面隐藏/恢复、模式切换时调用） */
  resetAccumulator(): void {
    this.accumulator = 0;
  }

  getSimTime(): number {
    return this.simTime;
  }

  getStepCount(): number {
    return this.stepCount;
  }

  // ---------------------------------------------------------------- 拖拽

  /**
   * 在世界坐标 point 处拾取动态刚体并建立临时 mouse joint。
   * 拾取失败返回 false。该约束只施加力，不直接 setTransform。
   */
  beginDrag(point: Vec2): boolean {
    const target = this.pickDynamicBody(point);
    if (!target) return false;
    const joint = this.world.createJoint(
      new MouseJoint({
        bodyA: this.anchorBody,
        bodyB: target,
        target: point.clone(),
        maxForce: MOUSE_FORCE_FACTOR * target.getMass() * Math.max(this.params.gravity, 1),
        frequencyHz: 6,
        dampingRatio: 0.8,
      }),
    );
    if (!joint) return false;
    this.drag = { joint, targetBody: target };
    return true;
  }

  updateDrag(point: Vec2): void {
    if (this.drag) {
      (this.drag.joint as unknown as { setTarget(p: Vec2): void }).setTarget(point);
    }
  }

  /** 松手：销毁临时约束，此后 body 不再受鼠标牵引 */
  endDrag(): void {
    if (!this.drag) return;
    this.world.destroyJoint(this.drag.joint);
    this.drag = null;
  }

  isDragging(): boolean {
    return this.drag !== null;
  }

  getDraggedBody(): Body | null {
    return this.drag ? this.drag.targetBody : null;
  }

  /** 小范围 AABB 查询拾取动态刚体（含链节与重物，不含静态环境） */
  pickDynamicBody(point: Vec2): Body | null {
    let picked: Body | null = null;
    const r = 0.25;
    this.world.queryAABB(
      {
        lowerBound: new Vec2(point.x - r, point.y - r),
        upperBound: new Vec2(point.x + r, point.y + r),
      },
      (fixture) => {
        const body = fixture.getBody();
        if (body.isDynamic()) {
          picked = body;
          return false; // 取第一个命中即停止
        }
        return true;
      },
    );
    return picked;
  }

  // ---------------------------------------------------------------- 拆/接关节

  /** 拆开指定关节：销毁物理约束，下游刚体保持自身速度成为自由物体 */
  breakJoint(index: number): void {
    const rec = this.joints[index];
    if (!rec || rec.broken || !rec.joint) return;
    if (this.world.isLocked()) throw new Error('物理步进中不能拆关节');
    this.world.destroyJoint(rec.joint);
    rec.joint = null;
    rec.broken = true;
  }

  /**
   * 恢复指定关节。仅当两个连接点当前世界距离 <= 阈值时允许，
   * 否则返回 false 且保持拆开（不瞬移、不改体位）。
   */
  restoreJoint(index: number): boolean {
    const rec = this.joints[index];
    if (!rec || !rec.broken) return false;
    if (this.world.isLocked()) throw new Error('物理步进中不能恢复关节');
    const anchorA = rec.bodyA.getWorldPoint(rec.localAnchorA);
    const anchorB = rec.bodyB.getWorldPoint(rec.localAnchorB);
    if (Vec2.distance(anchorA, anchorB) > RECONNECT_THRESHOLD) {
      return false;
    }
    rec.joint = this.world.createJoint(
      new RevoluteJoint({
        bodyA: rec.bodyA,
        bodyB: rec.bodyB,
        localAnchorA: rec.localAnchorA.clone(),
        localAnchorB: rec.localAnchorB.clone(),
        // 在当前姿态上重建，参考角归零，不修改任何 body 的位姿
        referenceAngle: 0,
        collideConnected: true,
        enableLimit: this.params.limitEnabled,
        lowerAngle: -this.params.limitAngle,
        upperAngle: this.params.limitAngle,
      }),
    ) as RevoluteJointType;
    rec.broken = false;
    rec.referenceAngle = 0;
    return true;
  }

  /** 当前两个连接点的世界距离（米） */
  anchorDeviation(index: number): number {
    const rec = this.joints[index];
    if (!rec) return Number.NaN;
    return Vec2.distance(
      rec.bodyA.getWorldPoint(rec.localAnchorA),
      rec.bodyB.getWorldPoint(rec.localAnchorB),
    );
  }

  /** 选中关节的完整读数，HUD 与辅助线共用同一份数据 */
  getJointReadout(index: number): JointReadout | null {
    const rec = this.joints[index];
    if (!rec) return null;
    const anchorA = rec.bodyA.getWorldPoint(rec.localAnchorA);
    const anchorB = rec.bodyB.getWorldPoint(rec.localAnchorB);
    const deviation = Vec2.distance(anchorA, anchorB);
    // 拆开后没有 joint 角度：用两 body 当前朝向差展示相对转角（标注为断开状态）
    const angle = rec.joint
      ? rec.joint.getJointAngle()
      : rec.bodyB.getAngle() - (rec.bodyA.isDynamic() ? rec.bodyA.getAngle() : 0);
    return {
      index: rec.index,
      broken: rec.broken,
      angle,
      lower: -this.params.limitAngle,
      upper: this.params.limitAngle,
      limitEnabled: this.params.limitEnabled,
      anchorDeviation: deviation,
      anchorA,
      anchorB,
      reconnectThreshold: RECONNECT_THRESHOLD,
      canReconnect: rec.broken && deviation <= RECONNECT_THRESHOLD,
    };
  }

  /** 按世界坐标拾取关节（取最近的、距离在阈值内的关节编号） */
  pickJoint(point: Vec2): number | null {
    let best: number | null = null;
    let bestDist = Infinity;
    for (const rec of this.joints) {
      const p = rec.bodyA.getWorldPoint(rec.localAnchorA);
      const d = Vec2.distance(p, point);
      if (d < bestDist) {
        bestDist = d;
        best = rec.index;
      }
    }
    return best !== null && bestDist <= 0.45 ? best : null;
  }

  // ---------------------------------------------------------------- 清理

  dispose(): void {
    this.world.off('pre-solve', this.preSolveHandler);
  }

  /** 测试辅助：列出当前世界中的所有 joint */
  get activeJoints(): Joint[] {
    const out: Joint[] = [];
    let j = this.world.getJointList();
    while (j) {
      out.push(j);
      j = j.getNext();
    }
    return out;
  }
}
