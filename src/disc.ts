import * as THREE from 'three';
import {
  ADJACENCIES,
  PANEL_MAP,
  START,
  clampCoords,
  coordsToWorld,
  edgeInward,
  getAdjacency,
  getEdge,
  nearestEdge,
  projectToPanel,
} from './panels';
import type { EdgeId, GameEvent, MoveMode, PanelDef, SwitchRecord } from './types';

const DISC_RADIUS = 0.28;
const DISC_HALF_THICK = 0.06;
const GRAVITY = 9.0;
const ACCEL = 7.5;
const MAX_SPEED = 4.2;
const DRAG = 1.6;
/** 距边多宽开始考虑跨面（面板内的边带） */
export const EDGE_BAND = 0.34;
/** 回到距边这个距离之后才允许再次换面 —— 迟滞防抖的核心 */
export const REARM_DIST = 0.45;
/** 换面后短时间禁止立刻换回，进一步压制左右抖动来回切换 */
const SWAP_COOLDOWN = 0.45;
const VOID_Y = -1.2;
/** 脱离后短暂禁止重新吸附，避免在公共边附近立刻被邻面吸回 */
const LAND_COOLDOWN = 0.22;

export interface DiscSnapshot {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  contactPoint: THREE.Vector3;
  normal: THREE.Vector3;
  heading: THREE.Vector3;
  mode: MoveMode;
  panelId: string | null;
  panelLabel: string;
  coords: { u: number; v: number } | null;
  speed: number;
  switchArmed: boolean;
  edgeCandidates: string[];
}

/**
 * 圆盘控制器。吸附时在当前面板的二维切平面内运动；
 * 靠近有邻接的公共边且保持向外速度时，用“基重映射”换到下一面，
 * 沿边方向分量与速度大小在理想正交外角下完全保持。
 */
export class Disc {
  position = new THREE.Vector3();
  velocity = new THREE.Vector3();
  mode: MoveMode = 'attached';
  panel: PanelDef = PANEL_MAP.get(START.panelId)!;
  coords = { u: START.u, v: START.v };
  switchArmed = true;
  cooldown = 0;
  detachCooldown = 0;
  /** 圆盘外观朝向（贴在面上的平面四元数） */
  orientation = new THREE.Quaternion();
  heading = new THREE.Vector3(1, 0, 0);
  lastSwitch: SwitchRecord | null = null;
  events: GameEvent[] = [];
  simTime = 0;

  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();

  reset() {
    this.mode = 'attached';
    this.panel = PANEL_MAP.get(START.panelId)!;
    this.coords = { u: START.u, v: START.v };
    coordsToWorld(this.panel, this.coords.u, this.coords.v, this.position);
    this.velocity.set(0, 0, 0);
    this.switchArmed = true;
    this.cooldown = 0;
    this.detachCooldown = 0;
    this.heading.set(1, 0, 0);
    this.alignOrientation();
    this.lastSwitch = null;
    this.events = [];
    this.log('info', '重置：圆盘回到地面 A 起点');
  }

  detach() {
    if (this.mode !== 'attached') return;
    this.mode = 'detached';
    this.panel = null as unknown as PanelDef;
    this.coords = { u: 0, v: 0 };
    // 主动脱离：保留当前速度，同时获得沿面法线向外的小速度
    this.velocity.addScaledVector(this.lastNormal(), 1.6);
    this.switchArmed = true;
    this.detachCooldown = LAND_COOLDOWN;
    this.log('detach', '主动脱离当前吸附面，进入自由飞行');
  }

  private log(kind: GameEvent['kind'], text: string) {
    this.events.push({ time: this.simTime, kind, text });
    if (this.events.length > 60) this.events.shift();
  }

  private lastNormal(): THREE.Vector3 {
    return this.panel ? this.panel.normal.clone() : new THREE.Vector3(0, 1, 0);
  }

  /** 让圆盘局部 Z 轴贴合面法线，局部 X 轴贴合 heading */
  private alignOrientation() {
    const n = this.mode === 'attached' ? this.panel.normal : new THREE.Vector3(0, 1, 0);
    const h = this.heading.lengthSq() > 1e-6 ? this.heading.clone() : this.tmp.set(1, 0, 0);
    h.addScaledVector(n, -h.dot(n)).normalize();
    if (h.lengthSq() < 1e-6) h.copy(this.panel.uAxis);
    const yAxis = new THREE.Vector3().crossVectors(n, h).normalize();
    const m = new THREE.Matrix4().makeBasis(h, yAxis, n);
    this.orientation.setFromRotationMatrix(m);
  }

  update(dt: number, intentWorld: THREE.Vector3) {
    this.simTime += dt;
    if (this.cooldown > 0) this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.detachCooldown > 0) this.detachCooldown = Math.max(0, this.detachCooldown - dt);
    if (this.mode === 'attached') this.updateAttached(dt, intentWorld);
    else this.updateDetached(dt);
  }

  // ---------------- 吸附状态 ----------------

  private updateAttached(dt: number, intentWorld: THREE.Vector3) {
    const panel = this.panel;

    // 输入投影到切平面
    const tangent = this.tmp
      .copy(intentWorld)
      .addScaledVector(panel.normal, -intentWorld.dot(panel.normal));
    if (tangent.lengthSq() > 1) tangent.normalize();

    this.velocity.addScaledVector(tangent, ACCEL * dt);
    // 线性阻尼
    this.velocity.multiplyScalar(Math.max(0, 1 - DRAG * dt));
    // 去掉法向漂移并限速
    this.velocity.addScaledVector(panel.normal, -this.velocity.dot(panel.normal));
    if (this.velocity.length() > MAX_SPEED) this.velocity.setLength(MAX_SPEED);

    // 位置积分到面内 (u, v)
    const du = this.velocity.dot(panel.uAxis) * dt;
    const dv = this.velocity.dot(panel.vAxis) * dt;
    let u = this.coords.u + du;
    let v = this.coords.v + dv;

    // 边带检测：是否靠近某条边、是否存在可跨邻接
    const near = nearestEdge(panel, projectToPanel(
      coordsToWorld(panel, u, v, this.tmp2),
      panel,
    ));
    const outwardSpeed = -this.velocity.dot(edgeInward(panel, near.edge));

    // 迟滞防抖：换面后强制解除武装，只有回到距边 REARM_DIST 以外的内部区才重新武装。
    // 不能在进入边带时解除武装 —— 盘从内部接近边时本来就先穿过 REARM_DIST 线。
    if (near.dist >= REARM_DIST) this.switchArmed = true;

    const adj = getAdjacency(panel.id, near.edge);

    // 条件：边带内 + 仍在向外移动 + 邻接存在 + 已重新武装 + 冷却结束
    if (
      near.dist < EDGE_BAND &&
      outwardSpeed > 0.25 &&
      adj &&
      this.switchArmed &&
      this.cooldown <= 0
    ) {
      this.swapAcrossEdge(adj.fromEdge, adj.toPanel, adj.toEdge);
      return;
    }

    // 无邻接的自由边（缺面 / 场边）：跨出即脱离坠落
    if (
      !adj &&
      near.dist < EDGE_BAND &&
      outwardSpeed > 0.25 &&
      (u < -panel.halfU || u > panel.halfU || v < -panel.halfV || v > panel.halfV)
    ) {
      const edgeName = near.edge;
      this.detach();
      this.log('detach', `从 ${panel.id} 的 ${edgeName} 边跨出（缺面/场边），开始坠落`);
      return;
    }

    // 普通边界约束
    const clamped = clampCoords(panel, u, v);
    if (clamped.u !== u) this.velocity.addScaledVector(panel.uAxis, -this.velocity.dot(panel.uAxis));
    if (clamped.v !== v) this.velocity.addScaledVector(panel.vAxis, -this.velocity.dot(panel.vAxis));
    u = clamped.u;
    v = clamped.v;

    // 禁止吸附隔板碰撞（仅地面运动路径上）
    if (panel.id === 'floor') this.resolveBarrier(u, v);

    this.coords.u = u;
    this.coords.v = v;
    coordsToWorld(panel, u, v, this.position);
    this.updateHeading(dt);
  }

  /** 地面隔板：在地面局部坐标内判定，进入其 u 区间且 v 越过边界时挡回，绝不吸附 */
  private resolveBarrier(u: number, v: number) {
    const barrier = PANEL_MAP.get('barrier')!;
    // 隔板在地面局部系内的包围范围（center.x=-2，z 向半宽 0.8，v 向前 2.5）
    const uMin = barrier.center.x - barrier.halfU - DISC_RADIUS;
    const uMax = barrier.center.x + barrier.halfU + DISC_RADIUS;
    const vLimit = barrier.center.z + barrier.halfV + DISC_RADIUS;
    if (u < uMin || u > uMax) return;
    if (this.coords.v < vLimit && v >= vLimit) {
      this.coords.v = vLimit;
      this.velocity.addScaledVector(this.panel.vAxis, -this.velocity.dot(this.panel.vAxis));
      this.log('block', '被禁止吸附隔板挡住（不会被吸上）');
    }
  }

  /**
   * 外角换面：以公共边为轴做基重映射。
   * 沿边方向的位置/速度分量保持，垂直边方向按“过冲量”镜像到新面内部，
   * 理想正交面下速度大小不变。
   */
  private swapAcrossEdge(fromEdge: EdgeId, toPanelId: string, toEdge: EdgeId) {
    const from = this.panel;
    const to = PANEL_MAP.get(toPanelId)!;
    const fromSeg = getEdge(from, fromEdge);
    const toSeg = getEdge(to, toEdge);

    // 公共边方向（两边方向可能相反，统一到 from 系）
    const edgeDir = fromSeg.dir;
    const toDirSign = Math.sign(toSeg.dir.dot(edgeDir)) || 1;

    // 公共边上的接触点：圆盘位置在边线上的最近点
    const edgeLen = fromSeg.b.distanceTo(fromSeg.a);
    const t = THREE.MathUtils.clamp(
      this.position.clone().sub(fromSeg.a).dot(edgeDir),
      0,
      edgeLen,
    );
    const contact = fromSeg.a.clone().addScaledVector(edgeDir, t);

    // 过冲量：圆盘越过边的“深度”，沿旧面内朝向外部方向为正
    const inwardOld = edgeInward(from, fromEdge);
    const overshoot = Math.max(0, -this.position.clone().sub(contact).dot(inwardOld));

    const inwardNew = edgeInward(to, toEdge);
    const newPosition = contact
      .clone()
      .addScaledVector(inwardNew, EDGE_BAND * 0.5 + overshoot);

    // 速度重映射：沿边分量 + 垂直边分量（反向到新面内部）
    const along = this.velocity.clone().projectOnVector(edgeDir);
    const acrossOld = this.velocity.clone().addScaledVector(edgeDir, -this.velocity.dot(edgeDir));
    const acrossSpeed = acrossOld.length();
    const newVelocity = along
      .clone()
      .multiplyScalar(toDirSign)
      .addScaledVector(inwardNew, acrossSpeed);

    const velBefore = this.velocity.clone();
    const posBefore = this.position.clone();
    const speedBefore = velBefore.length();

    // heading / 外观朝向同步重映射
    const headingAlong = this.heading.clone().projectOnVector(edgeDir).multiplyScalar(toDirSign);
    const headingAcross = this.heading.clone().addScaledVector(edgeDir, -this.heading.dot(edgeDir));
    const headingAcrossLen = headingAcross.length();
    this.heading = headingAlong
      .addScaledVector(inwardNew, headingAcrossLen)
      .normalize();

    this.panel = to;
    const c = projectToPanel(newPosition, to);
    this.coords = { u: c.u, v: c.v };
    this.position.copy(newPosition);
    this.velocity.copy(newVelocity);
    this.switchArmed = false;
    this.cooldown = SWAP_COOLDOWN;
    this.alignOrientation();

    const speedAfter = newVelocity.length();
    this.lastSwitch = {
      time: this.simTime,
      fromPanel: from.id,
      toPanel: to.id,
      edge: `${from.id}.${fromEdge} → ${to.id}.${toEdge}`,
      posBefore,
      posAfter: newPosition.clone(),
      velBefore,
      velAfter: newVelocity.clone(),
      speedBefore,
      speedAfter,
      retention: speedBefore > 1e-4 ? speedAfter / speedBefore : 1,
    };
    this.log('switch', `换面 ${from.id} → ${to.id}（公共边 ${fromEdge}/${toEdge}）`);
  }

  // ---------------- 脱离状态 ----------------

  private updateDetached(dt: number) {
    const prevPos = this.position.clone();
    this.velocity.y -= GRAVITY * dt;
    this.position.addScaledVector(this.velocity, dt);

    // 扫掠式落地检测：用上一帧→当前帧的线段与面板平面求交，
    // 避免高速下落时一帧跨过薄薄的吸附窗口。
    // 冷却期内跳过（刚脱离时贴着邻面，不能被立刻吸回）。
    if (this.detachCooldown <= 0) {
      for (const panel of PANEL_MAP.values()) {
        if (!panel.stickable) continue;
        const segment = this.position.clone().sub(prevPos);
        const denom = segment.dot(panel.normal);
        if (denom >= -1e-9) continue; // 没有朝面运动
        // 吸附面在圆盘半厚处的平行平面
        const target = panel.center
          .clone()
          .addScaledVector(panel.normal, DISC_HALF_THICK);
        const f = target.clone().sub(prevPos).dot(panel.normal) / denom;
        if (f < 0 || f > 1) continue;
        const hit = prevPos.clone().addScaledVector(segment, f);
        const c = projectToPanel(hit, panel);
        if (Math.abs(c.u) > panel.halfU || Math.abs(c.v) > panel.halfV) continue;
        // 吸附：贴回表面，速度投影到新面，法向分量清除
        this.position.copy(hit);
        this.panel = panel;
        this.mode = 'attached';
        this.coords = { u: c.u, v: c.v };
        this.velocity.addScaledVector(panel.normal, -this.velocity.dot(panel.normal));
        if (this.velocity.length() > MAX_SPEED) this.velocity.setLength(MAX_SPEED);
        this.switchArmed = false;
        this.cooldown = SWAP_COOLDOWN;
        this.heading
          .copy(this.velocity.lengthSq() > 0.05 ? this.velocity : panel.uAxis)
          .normalize();
        this.alignOrientation();
        this.log('land', `坠落后吸附到 ${panel.id}`);
        return;
      }
    }

    // 坠出场外：落回起点
    if (this.position.y < VOID_Y) {
      this.reset();
      this.log('void-reset', '坠入缺面/场外，按脱离状态落回起点');
    }
  }

  private updateHeading(dt: number) {
    if (this.velocity.lengthSq() > 0.15) {
      const target = this.velocity.clone().normalize();
      // 平滑转向运动方向（保持在切平面内）
      this.heading.lerp(target, Math.min(1, dt * 8)).normalize();
      this.heading.addScaledVector(this.panel.normal, -this.heading.dot(this.panel.normal));
      if (this.heading.lengthSq() > 1e-6) this.heading.normalize();
      this.alignOrientation();
    }
  }

  /** 当前可能被跨过的边（HUD/调试用） */
  edgeCandidates(): string[] {
    if (this.mode !== 'attached') return [];
    const near = nearestEdge(this.panel, {
      u: this.coords.u,
      v: this.coords.v,
      point: this.position,
      inside: true,
    });
    const out: string[] = [];
    if (near.dist < EDGE_BAND * 2) {
      const adj = getAdjacency(this.panel.id, near.edge);
      out.push(adj ? `${this.panel.id}.${near.edge} → ${adj.toPanel}` : `${this.panel.id}.${near.edge}（无邻接/缺面）`);
    }
    return out;
  }

  snapshot(): DiscSnapshot {
    const contact =
      this.mode === 'attached'
        ? coordsToWorld(this.panel, this.coords.u, this.coords.v, new THREE.Vector3())
        : this.position.clone();
    return {
      position: this.position.clone(),
      velocity: this.velocity.clone(),
      contactPoint: contact,
      normal: this.mode === 'attached' ? this.panel.normal.clone() : new THREE.Vector3(0, 1, 0),
      heading: this.heading.clone(),
      mode: this.mode,
      panelId: this.mode === 'attached' ? this.panel.id : null,
      panelLabel: this.mode === 'attached' ? this.panel.label : '自由飞行（无吸附面）',
      coords: this.mode === 'attached' ? { ...this.coords } : null,
      speed: this.velocity.length(),
      switchArmed: this.switchArmed,
      edgeCandidates: this.edgeCandidates(),
    };
  }

  /** 校验所有邻接边确实是同一条物理线段（启动自检） */
  static validateAdjacencies(): string[] {
    const errors: string[] = [];
    for (const adj of ADJACENCIES) {
      const a = getEdge(PANEL_MAP.get(adj.fromPanel)!, adj.fromEdge);
      const b = getEdge(PANEL_MAP.get(adj.toPanel)!, adj.toEdge);
      const d1 = a.mid.distanceTo(b.mid);
      const d2 = a.a.distanceTo(b.a) + a.b.distanceTo(b.b);
      const d3 = a.a.distanceTo(b.b) + a.b.distanceTo(b.a);
      if (d1 > 1e-4 || Math.min(d2, d3) > 1e-4) {
        errors.push(`邻接边不重合: ${adj.fromPanel}.${adj.fromEdge} ↔ ${adj.toPanel}.${adj.toEdge}`);
      }
    }
    return errors;
  }
}
