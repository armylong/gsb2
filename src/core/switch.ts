import { type Pose, angleDelta, deg } from './geometry.ts';
import type { Connector, PortId, TrackNetwork } from './network.ts';

/**
 * 分叉 / 道岔选择。
 *
 * 需求 3 的语义在这里落地:
 * - 车辆在轨段上行进, 只有 "s 到达段末那一刻" 才真正进入节点。
 * - 未进入节点时切换道岔: 即时生效, 本次通行改走新方向。
 * - 已进入节点 (已驶上出射段) 时切换: 本次已提交的方向锁定, 只影响下一次到达。
 * - 为了可解释, 每次通过节点都把选中的出射端口写进车辆状态; UI/验证脚本用
 *   `branchStatus` + `explainBranchFlip` 判断属于哪一种并给出人话解释。
 */

export type BranchChoice = 'primary' | 'alternate';

export interface SwitchState {
  nodeId: string;
  /** 主方向: 与入射线最顺的出射端口。 */
  primaryPort: PortId | null;
  alternatePort: PortId | null;
  primarySegmentId: string | null;
  alternateSegmentId: string | null;
  choice: BranchChoice;
  /** 出射 >= 2 才可切。 */
  switchable: boolean;
}

export const segmentOfPort = (port: PortId): string => port.slice(0, port.lastIndexOf(':'));

export interface SwitchHints {
  /** nodeId -> 期望的主方向轨段 id。用于两条出射完全对称时给出确定的主/备。 */
  primaryByNode?: Record<string, string>;
}

export function computeSwitches(network: TrackNetwork, hints: SwitchHints = {}): Map<string, SwitchState> {
  const map = new Map<string, SwitchState>();
  for (const [nodeId, junction] of network.junctions) {
    const outs = junction.outgoing;
    if (outs.length === 0) continue;

    let primary: PortId | null = null;
    const hinted = hints.primaryByNode?.[nodeId];
    if (hinted) {
      primary = outs.find((c) => segmentOfPort(c.port) === hinted)?.port ?? null;
    }
    const inc = junction.incoming[0];
    if (!primary) {
      primary = outs[0]!.port;
      if (inc) {
        const inHeading = Math.atan2(inc.pose.tangent.y, inc.pose.tangent.x);
        let best = Number.POSITIVE_INFINITY;
        for (const out of outs) {
          const d = Math.abs(angleDelta(inHeading, Math.atan2(out.pose.tangent.y, out.pose.tangent.x)));
          if (d < best) {
            best = d;
            primary = out.port;
          }
        }
      }
    }
    const alternate = outs.find((c) => c.port !== primary)?.port ?? null;
    map.set(nodeId, {
      nodeId,
      primaryPort: primary,
      alternatePort: alternate,
      primarySegmentId: primary ? segmentOfPort(primary) : null,
      alternateSegmentId: alternate ? segmentOfPort(alternate) : null,
      choice: 'primary',
      switchable: outs.length > 1 && alternate !== null,
    });
  }
  return map;
}

export interface ExitDecision {
  nodeId: string;
  port: PortId;
  segmentId: string;
  isBranch: boolean;
  /** 本次实际使用的道岔位置。 */
  choice: BranchChoice;
  /** UI 解释。 */
  reason: string;
  /** false = 没有合法出射, 到站停车。 */
  ok: boolean;
}

const emptyDecision = (): ExitDecision => ({
  nodeId: '',
  port: '',
  segmentId: '',
  isBranch: false,
  choice: 'primary',
  reason: '',
  ok: false,
});

/** 车辆走到 segmentId 段末时应当进入的下一段。 */
export function resolveExit(
  network: TrackNetwork,
  switches: Map<string, SwitchState>,
  segmentId: string,
  preferChoice?: BranchChoice,
): ExitDecision | null {
  const nodeId = network.exitNodeOf(segmentId);
  if (!nodeId) return null;
  const junction = network.junctions.get(nodeId);
  if (!junction) return null;
  const outs = junction.outgoing;
  const isBranch = junction.isBranch;

  if (outs.length === 0) {
    return {
      ...emptyDecision(),
      nodeId,
      isBranch: false,
      reason: `节点 ${nodeId} 没有驶出段, 车辆在此停车`,
      ok: false,
    };
  }
  if (outs.length === 1) {
    const only = outs[0]!;
    return {
      nodeId,
      port: only.port,
      segmentId: segmentOfPort(only.port),
      isBranch: false,
      choice: 'primary',
      reason: `节点 ${nodeId} 唯一驶出段 ${segmentOfPort(only.port)}`,
      ok: true,
    };
  }

  const sw = switches.get(nodeId);
  const choice = preferChoice ?? sw?.choice ?? 'primary';
  const desired = choice === 'alternate' ? sw?.alternatePort : sw?.primaryPort;
  const match = desired ? outs.find((c) => c.port === desired) : undefined;
  if (match) {
    return {
      nodeId,
      port: match.port,
      segmentId: segmentOfPort(match.port),
      isBranch,
      choice,
      reason:
        choice === 'alternate'
          ? `分叉 ${nodeId}: 道岔在备选位 -> 走 ${segmentOfPort(match.port)}`
          : `分叉 ${nodeId}: 道岔在主位 -> 走 ${segmentOfPort(match.port)}`,
      ok: true,
    };
  }

  // 道岔目标端口失效 (例如轨段被删/改): 回退到最顺向出射, 并明确说明。
  const best = mostAlignedOutgoing(junction.incoming[0], outs);
  return {
    nodeId,
    port: best.port,
    segmentId: segmentOfPort(best.port),
    isBranch,
    choice,
    reason: `分叉 ${nodeId}: 道岔目标端口失效, 回退到最顺向出射 ${segmentOfPort(best.port)}`,
    ok: true,
  };
}

export function mostAlignedOutgoing(inConnector: Connector | undefined, outs: Connector[]): Connector {
  const first = outs[0];
  if (!first) throw new Error('mostAlignedOutgoing: 没有出射');
  if (!inConnector || outs.length <= 1) return first;
  const inHeading = Math.atan2(inConnector.pose.tangent.y, inConnector.pose.tangent.x);
  let best = first;
  let bestAbs = Number.POSITIVE_INFINITY;
  for (const out of outs) {
    const d = Math.abs(angleDelta(inHeading, Math.atan2(out.pose.tangent.y, out.pose.tangent.x)));
    if (d < bestAbs) {
      bestAbs = d;
      best = out;
    }
  }
  return best;
}

/** 节点处每个出射相对入射线的偏角 (度), 供 UI 展示。 */
export function outgoingAngles(network: TrackNetwork, nodeId: string): Array<{ port: PortId; deg: number }> {
  const j = network.junctions.get(nodeId);
  const inc = j?.incoming[0];
  if (!j || !inc) return [];
  const inHeading = Math.atan2(inc.pose.tangent.y, inc.pose.tangent.x);
  return j.outgoing.map((o) => ({
    port: o.port,
    deg: deg(angleDelta(inHeading, Math.atan2(o.pose.tangent.y, o.pose.tangent.x))),
  }));
}

/**
 * "已进节点 / 未进节点" 解释器 (需求 3)。
 */
export interface FlipContext {
  nodeId: string;
  /** 车辆是否正朝该节点行驶 (当前段末端 == 该节点)。 */
  approaching: boolean;
  /** 距节点入口的剩余弧长; <= 0 表示车头已到节点入口。 */
  remainingToNode: number;
  /** 已从该节点驶出时, 本次提交的出射端口; null = 尚未提交。 */
  committedPort: PortId | null;
  from: BranchChoice;
  to: BranchChoice;
}

export interface FlipExplanation {
  /** true = 本次通行会走新方向。 */
  affectsCurrentPass: boolean;
  message: string;
}

export function explainBranchFlip(ctx: FlipContext): FlipExplanation {
  const dir = (c: BranchChoice) => (c === 'alternate' ? '备选' : '主');
  const change = `${dir(ctx.from)} -> ${dir(ctx.to)}`;
  // 先判 "已进节点": 只要已经驶上出射段, 本次方向即锁定。
  if (ctx.committedPort !== null) {
    return {
      affectsCurrentPass: false,
      message: `车辆已进入节点 ${ctx.nodeId}${ctx.committedPort ? ` (锁定 ${ctx.committedPort})` : ''}; 切换只对下一次到达生效 (${change})。`,
    };
  }
  if (!ctx.approaching) {
    return {
      affectsCurrentPass: false,
      message: `道岔 ${ctx.nodeId} 已切到${dir(ctx.to)}方向 (${change}); 车辆当前不在驶向该节点的段上, 本次不受影响。`,
    };
  }
  return {
    affectsCurrentPass: true,
    message: `车辆尚未进入节点 ${ctx.nodeId} (还差 ${ctx.remainingToNode.toFixed(1)} 单位), 本次通行改用${dir(ctx.to)}方向 (${change})。`,
  };
}

export function poseText(pose: Pose): string {
  return `(${pose.pos.x.toFixed(1)}, ${pose.pos.y.toFixed(1)}) @ ${deg(Math.atan2(pose.tangent.y, pose.tangent.x)).toFixed(1)}°`;
}
