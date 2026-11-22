import { type Pose, type TrackSegment, type Vec2, angleDelta, deg, dist, rad } from './geometry.ts';

/**
 * 网络拓扑: 节点 (Node) + "轨段端口 -> 节点" 连接。
 *
 * 通行约定 (整个沙盒一致):
 * - 每段轨道只有一个合法行车方向: A 端 (u=0) -> B 端 (u=1)。反向需求由另布一条反向段表达。
 * - 节点上 B 端端口 = 入射 (arrive), A 端端口 = 出射 (depart)。
 * - 连接合法性 = 位置重合 + 到达/离去切线满足节点规则。
 *
 * 节点规则 (需求 1 的 "端点按规则连接"):
 *   ┌ 普通接头 (1 入 1 出): 转角必须 <= JOINT_MAX (8°), 否则判 "非法转角";
 *   └ 分叉/合流 (任一侧 >= 2 条): 偏转允许到 BRANCH_MAX (40°), 因为道岔本身就有偏角。
 * 位置: 端点与节点距离必须 <= POS_EPS (1.0), 否则判 "断开"。
 *
 * 拖走一段轨道后节点不会跟着走, 于是位置检查会直接报断开 —— 需求 4 的校验入口。
 */

export const POS_EPS = 1.0;
/** 普通接头的平滑容差 (用于 "平滑" 提示)。 */
export const JOINT_TOL = rad(1.5);
/** 普通接头允许的最大转角, 超过即非法。 */
export const JOINT_MAX = rad(8);
/** 分叉/合流节点允许的最大偏转。 */
export const BRANCH_MAX = rad(40);
/** 分叉节点超过这个偏转给出 "大偏转道岔" 警告。 */
export const BRANCH_WARN = rad(25);
/** 位置重合但未合并的节点, 判定为 "伪连接"。 */
export const COINCIDENT_EPS = 2.0;

export type PortId = string;

export const portA = (segmentId: string): PortId => `${segmentId}:A`;
export const portB = (segmentId: string): PortId => `${segmentId}:B`;

export function splitPort(port: PortId): { segmentId: string; end: 'A' | 'B' } {
  const idx = port.lastIndexOf(':');
  if (idx < 0) throw new Error(`非法端口: ${port}`);
  const segmentId = port.slice(0, idx);
  const end = port.slice(idx + 1);
  if (end !== 'A' && end !== 'B') throw new Error(`非法端口: ${port}`);
  return { segmentId, end };
}

export interface NodeDef {
  id: string;
  pos: Vec2;
  label?: string;
}

export interface Node {
  id: string;
  pos: Vec2;
  label: string;
  ports: PortId[];
}

export interface TrackNetworkInit {
  segments: TrackSegment[];
  nodes: NodeDef[];
  /** 端口 -> 节点 id。未列出的端口视为断开。 */
  links: Record<PortId, string>;
  start: { segmentId: string; s?: number };
}

export interface Connector {
  port: PortId;
  nodeId: string;
  /** 段端点真实位姿; tangent 永远沿 A->B。 */
  pose: Pose;
  /** true = A 端 (离开节点), false = B 端 (驶入节点)。 */
  outgoing: boolean;
}

export interface Junction {
  node: Node;
  connectors: Connector[];
  incoming: Connector[];
  outgoing: Connector[];
  /** 该节点是否分叉/合流 (任一侧 >= 2 条)。 */
  isBranch: boolean;
  /** 该节点允许的最大转接偏角 (弧度)。 */
  maxAngle: number;
}

export type IssueCode =
  | 'disconnected'
  | 'missing-node'
  | 'missing-segment'
  | 'duplicate-link'
  | 'coincident'
  | 'angle'
  | 'kink'
  | 'no-outgoing'
  | 'no-incoming'
  | 'bad-start';

export interface LinkIssue {
  level: 'error' | 'warning';
  code: IssueCode;
  message: string;
  nodeId?: string;
  port?: PortId;
}

export class TrackNetwork {
  readonly segments: Map<string, TrackSegment>;
  readonly segmentOrder: string[];
  readonly nodes: Map<string, Node>;
  readonly links: Map<PortId, string>;
  readonly junctions: Map<string, Junction>;
  readonly issues: LinkIssue[];
  readonly start: { segmentId: string; s: number };

  constructor(init: TrackNetworkInit) {
    this.segments = new Map(init.segments.map((s) => [s.id, s]));
    this.segmentOrder = init.segments.map((s) => s.id);
    this.nodes = new Map(
      init.nodes.map((n) => [n.id, { id: n.id, pos: { ...n.pos }, label: n.label ?? n.id, ports: [] }]),
    );
    this.links = new Map(Object.entries(init.links));
    this.junctions = new Map();
    this.issues = [];
    this.start = { segmentId: init.start.segmentId, s: init.start.s ?? 0 };
    this.build();
  }

  private build(): void {
    if (this.segments.size > 0 && !this.segments.has(this.start.segmentId)) {
      this.issues.push({
        level: 'error',
        code: 'bad-start',
        message: `起点轨段 ${this.start.segmentId} 不存在`,
      });
    }

    const portToNode = new Map<PortId, string>();
    for (const [port, nodeId] of this.links) {
      const node = this.nodes.get(nodeId);
      let segment: TrackSegment | undefined;
      try {
        segment = this.segments.get(splitPort(port).segmentId);
      } catch {
        segment = undefined;
      }
      if (!node) {
        this.issues.push({
          level: 'error',
          code: 'missing-node',
          port,
          message: `端口 ${port} 指向不存在的节点 ${nodeId}`,
        });
        continue;
      }
      if (!segment) {
        this.issues.push({
          level: 'error',
          code: 'missing-segment',
          port,
          message: `端口 ${port} 指向不存在的轨段`,
        });
        continue;
      }
      if (portToNode.has(port)) {
        this.issues.push({
          level: 'error',
          code: 'duplicate-link',
          port,
          message: `端口 ${port} 被重复连接`,
        });
        continue;
      }
      portToNode.set(port, nodeId);
      node.ports.push(port);
    }

    for (const segId of this.segmentOrder) {
      for (const port of [portA(segId), portB(segId)]) {
        if (!portToNode.has(port)) {
          this.issues.push({
            level: 'error',
            code: 'disconnected',
            port,
            message: `轨段 ${segId} 的 ${splitPort(port).end} 端未连接到任何节点 (断开)`,
          });
        }
      }
    }

    for (const node of this.nodes.values()) {
      const connectors: Connector[] = [];
      for (const port of node.ports) {
        const { segmentId, end } = splitPort(port);
        const segment = this.segments.get(segmentId)!;
        const pose = end === 'A' ? segment.poseAt(0) : segment.poseAt(1);
        connectors.push({ port, nodeId: node.id, pose, outgoing: end === 'A' });
      }
      connectors.sort((a, b) => a.port.localeCompare(b.port));
      const incoming = connectors.filter((c) => !c.outgoing);
      const outgoing = connectors.filter((c) => c.outgoing);
      const isBranch = outgoing.length > 1 || incoming.length > 1;
      const junction: Junction = {
        node,
        connectors,
        incoming,
        outgoing,
        isBranch,
        maxAngle: isBranch ? BRANCH_MAX : JOINT_MAX,
      };
      this.junctions.set(node.id, junction);
      this.validateJunction(junction);
    }

    this.validateCoincidentNodes();
  }

  private validateJunction(junction: Junction): void {
    const { node, connectors, incoming, outgoing, isBranch, maxAngle } = junction;
    const warnAngle = isBranch ? BRANCH_WARN : JOINT_TOL;

    for (const c of connectors) {
      const d = dist(c.pose.pos, node.pos);
      if (d > POS_EPS) {
        this.issues.push({
          level: 'error',
          code: 'disconnected',
          nodeId: node.id,
          port: c.port,
          message: `端口 ${c.port} 端点距节点 ${node.id} 偏 ${d.toFixed(2)} (容差 ${POS_EPS}), 已断开`,
        });
      }
    }

    if (incoming.length === 0) {
      this.issues.push({
        level: 'warning',
        code: 'no-incoming',
        nodeId: node.id,
        message: `节点 ${node.id} 没有驶入段 (起点节点或孤岛)`,
      });
    }
    if (outgoing.length === 0) {
      this.issues.push({
        level: 'warning',
        code: 'no-outgoing',
        nodeId: node.id,
        message: `节点 ${node.id} 没有驶出段 (终点)`,
      });
    }

    for (const inc of incoming) {
      for (const out of outgoing) {
        const d = Math.abs(
          angleDelta(
            Math.atan2(inc.pose.tangent.y, inc.pose.tangent.x),
            Math.atan2(out.pose.tangent.y, out.pose.tangent.x),
          ),
        );
        if (d > maxAngle) {
          this.issues.push({
            level: 'error',
            code: isBranch ? 'angle' : 'kink',
            nodeId: node.id,
            port: out.port,
            message: isBranch
              ? `节点 ${node.id} 道岔偏转超限 ${deg(d).toFixed(1)}° (${inc.port} -> ${out.port}, 上限 ${deg(maxAngle).toFixed(0)}°)`
              : `节点 ${node.id} 非法转角 ${deg(d).toFixed(1)}° (${inc.port} -> ${out.port}, 上限 ${deg(maxAngle).toFixed(0)}°)`,
          });
        } else if (d > warnAngle) {
          this.issues.push({
            level: 'warning',
            code: isBranch ? 'angle' : 'kink',
            nodeId: node.id,
            port: out.port,
            message: isBranch
              ? `节点 ${node.id} 大偏转道岔 ${deg(d).toFixed(1)}° (${inc.port} -> ${out.port})`
              : `节点 ${node.id} 接头有 ${deg(d).toFixed(1)}° 折角 (${inc.port} -> ${out.port})`,
          });
        }
      }
    }
  }

  /** 位置重合却没有共享同一节点的端点, 最容易骗过逐节点校验, 单独查。 */
  private validateCoincidentNodes(): void {
    const nodes = [...this.nodes.values()];
    const flagged = new Set<string>();
    for (let i = 0; i < nodes.length; i += 1) {
      for (let j = i + 1; j < nodes.length; j += 1) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        if (a.ports.length === 0 || b.ports.length === 0) continue;
        if (dist(a.pos, b.pos) > COINCIDENT_EPS) continue;
        const key = `${a.id}|${b.id}`;
        if (flagged.has(key)) continue;
        flagged.add(key);
        this.issues.push({
          level: 'error',
          code: 'coincident',
          nodeId: a.id,
          message: `节点 ${a.id} 与 ${b.id} 位置重合 (${dist(a.pos, b.pos).toFixed(2)}) 却没有合并连接, 轨道实际是断开的`,
        });
      }
    }
  }

  get errors(): LinkIssue[] {
    return this.issues.filter((i) => i.level === 'error');
  }

  get warnings(): LinkIssue[] {
    return this.issues.filter((i) => i.level === 'warning');
  }

  isBlocked(): boolean {
    return this.errors.length > 0;
  }

  /** 车辆走完 segmentId 后进入的节点 (B 端)。 */
  exitNodeOf(segmentId: string): string | undefined {
    return this.links.get(portB(segmentId));
  }

  /** 车辆出发前所在节点 (A 端)。 */
  entryNodeOf(segmentId: string): string | undefined {
    return this.links.get(portA(segmentId));
  }

  junction(nodeId: string): Junction | undefined {
    return this.junctions.get(nodeId);
  }

  outgoingFor(incPort: PortId): Connector[] {
    const nodeId = this.links.get(incPort);
    if (!nodeId) return [];
    return this.junctions.get(nodeId)?.outgoing ?? [];
  }

  /** 从 segIn 经节点到 segOut 的瞬时转角 (度); 段不存在返回 null。 */
  transitionAngle(segIn: string, segOut: string): number | null {
    const a = this.segments.get(segIn);
    const b = this.segments.get(segOut);
    if (!a || !b) return null;
    const ta = a.poseAt(1).tangent;
    const tb = b.poseAt(0).tangent;
    return Math.abs(deg(angleDelta(Math.atan2(ta.y, ta.x), Math.atan2(tb.y, tb.x))));
  }

  /** 该转接是否满足节点规则 (按两端所属节点取分叉/普通接头上限)。 */
  isTransitionValid(segIn: string, segOut: string): boolean {
    const angle = this.transitionAngle(segIn, segOut);
    if (angle === null) return false;
    const nodeId = this.exitNodeOf(segIn) ?? this.entryNodeOf(segOut);
    const junction = nodeId ? this.junctions.get(nodeId) : undefined;
    const maxDeg = deg(junction?.maxAngle ?? JOINT_MAX);
    return angle <= maxDeg + 1e-9;
  }

  /** 节点允许的最大转接偏角 (度)。 */
  transitionLimitDeg(nodeId: string): number {
    return deg(this.junctions.get(nodeId)?.maxAngle ?? JOINT_MAX);
  }

  bounds(): { min: Vec2; max: Vec2 } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const seg of this.segments.values()) {
      for (const p of seg.sample(seg.kind === 'arc' ? 64 : 2)) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
    if (!Number.isFinite(minX)) return { min: { x: 0, y: 0 }, max: { x: 100, y: 100 } };
    return { min: { x: minX, y: minY }, max: { x: maxX, y: maxY } };
  }
}
