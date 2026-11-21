import {
  type NodeProvenance,
  blockingNodeAt,
  canEmitSignal,
  canReceiveSignal,
  cloneLevel,
  evaluateGate,
  edgeInto,
  gateLabel,
  inputPortCount,
  isBlockingNode,
  nodeById,
  sameCell,
  type DoorNode,
  type Edge,
  type GateNode,
  type GridPos,
  type Level,
  type LogicNode,
  type NodeSourceRef,
  type Signal,
} from './model';

export type { NodeProvenance };

export type Direction = 'up' | 'down' | 'left' | 'right';

export const DIRECTION_DELTA: Record<Direction, GridPos> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export interface TickIntent {
  /** 这一步要翻转的开关; 多个开关在同一结算时刻一起生效 */
  toggleSwitchIds: string[];
  /** 这一步角色尝试走一格; 与开关翻转同时提交 */
  move: Direction | null;
}

export const EMPTY_INTENT: TickIntent = { toggleSwitchIds: [], move: null };

export interface MoveOutcome {
  direction: Direction;
  from: GridPos;
  to: GridPos;
  moved: boolean;
  blockedBy: { nodeId: string; name: string; kind: LogicNode['kind'] } | null;
  reason: string | null;
}

export interface ContactChange {
  nodeId: string;
  name: string;
  from: Signal;
  to: Signal;
}

export interface Delta {
  nodeId: string;
  name: string;
  kind: LogicNode['kind'];
  from: Signal;
  to: Signal;
  cause: 'action' | 'contact' | 'logic' | 'buffer';
  sources: NodeSourceRef[];
  note: string;
}

export interface FeedbackReport {
  id: string;
  nodes: string[];
  stable: boolean;
  conflict: boolean;
  iterations: number;
  result: Record<string, Signal>;
  history: Record<string, Signal>[];
  inputs: NodeSourceRef[];
  message: string;
}

export interface DelaySnapshot {
  nodeId: string;
  name: string;
  steps: number;
  /** 本轮 (结算末尾) 的输出值 */
  value: Signal;
  /** 等待中的采样, queue[0] 最早 */
  queue: Signal[];
  /** 本轮输入线上采到的值 */
  sampled: Signal;
  /** 输出是否在本轮开头前进 */
  advanced: boolean;
}

export interface DoorState {
  id: string;
  name: string;
  passable: boolean;
  openedAt: number | null;
}

export interface TickReport {
  step: number;
  intent: TickIntent;
  toggles: ContactChange[];
  contacts: ContactChange[];
  move: MoveOutcome | null;
  deltas: Delta[];
  feedbacks: FeedbackReport[];
  delays: DelaySnapshot[];
  doors: DoorState[];
  lamps: { id: string; name: string; on: boolean }[];
  evaluationOrder: string[][];
}

export interface TickResult {
  level: Level;
  report: TickReport;
}

interface GateScc {
  id: string;
  nodes: string[];
  cyclic: boolean;
}

const MAX_CYCLE_ITERATIONS = 64;

/** 遍历图中的门→门边, 找强连通分量并给出缩合图拓扑序. */
export function findGateSccs(level: Level): GateScc[] {
  const gates = level.nodes.filter((node): node is GateNode => node.kind === 'gate');
  const gateIds = new Set(gates.map((gate) => gate.id));
  const adjacency = new Map<string, string[]>();
  for (const gate of gates) adjacency.set(gate.id, []);
  for (const edge of level.edges) {
    if (gateIds.has(edge.from) && gateIds.has(edge.to)) {
      adjacency.get(edge.from)?.push(edge.to);
    }
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const raw: string[][] = [];

  const strongConnect = (id: string): void => {
    indices.set(id, index);
    lowlinks.set(id, index);
    index += 1;
    stack.push(id);
    onStack.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        lowlinks.set(id, Math.min(lowlinks.get(id)!, lowlinks.get(next)!));
      } else if (onStack.has(next)) {
        lowlinks.set(id, Math.min(lowlinks.get(id)!, indices.get(next)!));
      }
    }
    if (lowlinks.get(id) === indices.get(id)) {
      const group: string[] = [];
      let popped: string | undefined;
      do {
        popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        group.push(popped);
      } while (popped !== id);
      raw.push(group.sort((a, b) => a.localeCompare(b)));
    }
  };

  for (const gate of [...gates].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!indices.has(gate.id)) strongConnect(gate.id);
  }

  const componentOf = new Map<string, number>();
  raw.forEach((group, compIndex) => {
    group.forEach((id) => componentOf.set(id, compIndex));
  });

  // 缩合图按依赖顺序 (源 SCC 在前) 排序
  const incoming = new Map<number, Set<number>>();
  raw.forEach((_, compIndex) => incoming.set(compIndex, new Set()));
  for (const edge of level.edges) {
    if (!gateIds.has(edge.from) || !gateIds.has(edge.to)) continue;
    const fromComp = componentOf.get(edge.from);
    const toComp = componentOf.get(edge.to);
    if (fromComp === undefined || toComp === undefined || fromComp === toComp) continue;
    incoming.get(toComp)?.add(fromComp);
  }

  const sortedComps: number[] = [];
  const remaining = new Set(raw.map((_, compIndex) => compIndex));
  while (remaining.size > 0) {
    let ready: number | undefined;
    for (const compIndex of remaining) {
      const deps = incoming.get(compIndex)!;
      if ([...deps].every((dep) => !remaining.has(dep))) {
        ready = compIndex;
        break;
      }
    }
    if (ready === undefined) {
      // 理论上缩合图无环; 保险起见收尾
      ready = [...remaining][0];
    }
    const chosen = ready as number;
    remaining.delete(chosen);
    sortedComps.push(chosen);
  }

  return sortedComps.map((compIndex) => {
    const nodes = raw[compIndex] ?? [];
    const cyclic =
      nodes.length > 1 ||
      nodes.some((from) =>
        level.edges.some(
          (edge) => edge.from === from && edge.to === from && gateIds.has(edge.to),
        ),
      );
    return { id: `F:${nodes[0] ?? compIndex + 1}`, nodes, cyclic };
  });
}

/** 仅做静态反馈环预检, 不读写节点运行态, 所以暂停时调用是安全的. */
export function staticFeedbackLoops(level: Level): FeedbackReport[] {
  return findGateSccs(level)
    .filter((scc) => scc.cyclic)
    .map((scc) => ({
      id: scc.id,
      nodes: scc.nodes,
      stable: false,
      conflict: false,
      iterations: 0,
      result: {},
      history: [],
      inputs: [],
      message: `存在无延时反馈环 (${scc.nodes.map((id) => nodeName(level, id)).join(' ↔ ')}), 结算后将给出稳定值或冲突.`,
    }));
}

function nodeName(level: Level, id: string): string {
  return nodeById(level, id)?.name ?? id;
}

function rawValue(_level: Level, node: LogicNode): Signal {
  switch (node.kind) {
    case 'switch':
    case 'plate':
      return node.value;
    case 'delay':
      return node.value;
    case 'gate':
      return node.value;
    case 'door':
      return node.value;
    case 'lamp':
      return node.value;
  }
}

function sourceRef(level: Level, node: LogicNode, port: number): NodeSourceRef {
  const edge = edgeInto(level, node.id, port);
  if (!edge) {
    return {
      nodeId: '',
      nodeName: '(未连接)',
      port,
      value: 'off',
      unconnected: true,
      note: `${portName(node, port)} 未接线, 按 OFF 处理`,
    };
  }
  const source = nodeById(level, edge.from);
  return {
    nodeId: edge.from,
    nodeName: source?.name ?? edge.from,
    port,
    value: source ? inputValueFor(level, source) : 'off',
    edgeId: edge.id,
    note: `${source?.name ?? edge.from} → ${portName(node, port)}`,
  };
}

function inputValueFor(level: Level, node: LogicNode): Signal {
  return rawValue(level, node);
}

function portName(node: LogicNode, port: number): string {
  if (inputPortCount(node) <= 1) return 'IN';
  return port === 0 ? 'IN A' : 'IN B';
}

export function nodeSources(level: Level, node: LogicNode): NodeSourceRef[] {
  const count = inputPortCount(node);
  const refs: NodeSourceRef[] = [];
  for (let port = 0; port < count; port += 1) refs.push(sourceRef(level, node, port));
  return refs;
}

export function describeNode(level: Level, nodeId: string): NodeProvenance | null {
  const node = nodeById(level, nodeId);
  if (!node) return null;
  const inputs = nodeSources(level, node);
  switch (node.kind) {
    case 'switch':
      return {
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        value: node.value,
        cause: 'action',
        inputs: [],
        note: '拨动开关: 只在单步结算时由玩家动作翻转.',
      };
    case 'plate':
      return {
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        value: node.value,
        cause: 'contact',
        inputs: [],
        note: '压力板: 结算时按角色所在的格子得出 ON/OFF, 不是独立记忆.',
      };
    case 'delay':
      return {
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        value: node.value,
        cause: 'buffer',
        inputs,
        note: `单步延时: 输入采样入队, 当前输出取自 ${node.steps} 步队列头. 队列 ${node.queue
          .map((signal) => (signal === 'on' ? '1' : '0'))
          .join(' · ')}.`,
      };
    case 'gate': {
      const a = inputs[0]?.value ?? 'off';
      const b = inputs[1]?.value ?? 'off';
      const expr = node.op === 'not' ? `¬${signalShort(a)}` : `${signalShort(a)} ${gateOpSymbol(node.op)} ${signalShort(b)}`;
      return {
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        value: node.value,
        cause: 'logic',
        inputs,
        note: `${gateLabel(node.op)}: ${expr} = ${signalShort(node.value)}.`,
      };
    }
    case 'door':
      return {
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        value: node.value,
        cause: 'logic',
        inputs,
        note:
          node.value === 'on'
            ? `可通行${node.openedAt !== null ? ` · 自第 ${node.openedAt} 步打开` : ''}.`
            : '不可通行: 角色无法进入此格.',
      };
    case 'lamp':
      return {
        nodeId: node.id,
        name: node.name,
        kind: node.kind,
        value: node.value,
        cause: 'logic',
        inputs,
        note: '指示灯只显示接线末端的结算值.',
      };
  }
}

function signalShort(signal: Signal): string {
  return signal === 'on' ? '1' : '0';
}

function gateOpSymbol(op: GateNode['op']): string {
  switch (op) {
    case 'and':
      return '∧';
    case 'or':
      return '∨';
    case 'xor':
      return '⊕';
    case 'nand':
      return '¬∧';
    case 'nor':
      return '¬∨';
    case 'not':
      return '¬';
  }
}

/**
 * 推进一个结算时刻. 纯函数: 不修改传入 level; 只有显式调用才会产生变化.
 *
 * 结算顺序:
 * 1. 同时施加所有输入 (开关翻转 + 角色移动 + 压力板接触结果)
 * 2. 门电路按 SCC 拓扑序结算; 含环的无延时反馈迭代到不动点, 不收敛则判冲突并冻结
 * 3. 门/灯读取已稳定的信号
 * 4. 延时节点采样输入并入队, 输出前进一格 (跨步反馈因此至少隔一步)
 * 5. 整个结算作为一个原子结果写回 level
 */
export function tick(level: Level, intent: TickIntent): TickResult {
  const next = cloneLevel(level);
  const step = next.step + 1;
  const before = new Map<string, Signal>();
  for (const node of next.nodes) before.set(node.id, rawValue(next, node));

  // ---- 0. 延时输出先前进一格 (只使用上一步已采样的队列, 不读取本步输入) ----
  const delayAdvanced: DelaySnapshot[] = [];
  for (const node of next.nodes) {
    if (node.kind !== 'delay') continue;
    let advanced = false;
    if (node.queue.length >= node.steps) {
      const head = node.queue.shift();
      if (head !== undefined) {
        node.value = head;
        advanced = true;
      }
    }
    delayAdvanced.push({
      nodeId: node.id,
      name: node.name,
      steps: node.steps,
      value: node.value,
      queue: [...node.queue],
      sampled: 'off',
      advanced,
    });
  }
  for (const snapshot of delayAdvanced) {
    const node = nodeById(next, snapshot.nodeId);
    if (node?.kind === 'delay') snapshot.queue = [...node.queue];
  }

  // ---- 1. 同时施加原始输入 ----
  const toggles: ContactChange[] = [];
  for (const id of [...intent.toggleSwitchIds].sort((a, b) => a.localeCompare(b))) {
    const node = nodeById(next, id);
    if (!node || node.kind !== 'switch') continue;
    const from = node.value;
    node.value = from === 'on' ? 'off' : 'on';
    if (node.value !== from) {
      toggles.push({ nodeId: node.id, name: node.name, from, to: node.value });
    }
  }

  let move: MoveOutcome | null = null;
  if (intent.move) {
    const delta = DIRECTION_DELTA[intent.move];
    const target: GridPos = { x: next.character.x + delta.x, y: next.character.y + delta.y };
    const from = { ...next.character };
    let reason: string | null = null;
    let blockedBy: MoveOutcome['blockedBy'] = null;
    if (target.x < 0 || target.y < 0 || target.x >= next.cols || target.y >= next.rows) {
      reason = '目标超出场景边界';
    } else {
      const blocker = blockingNodeAt(next, target);
      if (blocker) {
        blockedBy = { nodeId: blocker.id, name: blocker.name, kind: blocker.kind };
        reason = blocker.kind === 'door' ? '门当前关闭, 不可通行' : `被 ${blocker.name} 挡住`;
      }
    }
    if (!reason) {
      next.character = target;
    }
    move = { direction: intent.move, from, to: reason ? from : target, moved: reason === null, blockedBy, reason };
  }

  const contacts: ContactChange[] = [];
  for (const node of next.nodes) {
    if (node.kind !== 'plate') continue;
    const from = node.value;
    node.value = sameCell(next.character, node.pos) ? 'on' : 'off';
    if (node.value !== from) contacts.push({ nodeId: node.id, name: node.name, from, to: node.value });
  }

  // ---- 2. 无延时门网结算 ----
  const gateValues = new Map<string, Signal>();
  for (const node of next.nodes) {
    if (node.kind === 'gate') gateValues.set(node.id, node.value);
  }

  const valueOfSource = (id: string, withinScc: Map<string, Signal> | null): Signal => {
    const node = nodeById(next, id);
    if (!node) return 'off';
    if (node.kind === 'gate') {
      const candidate = withinScc?.get(node.id);
      return candidate ?? gateValues.get(node.id) ?? node.value;
    }
    return rawValue(next, node);
  };

  const gateInputAt = (
    gate: GateNode,
    port: number,
    withinScc: Map<string, Signal> | null,
  ): Signal => {
    const edge = edgeInto(next, gate.id, port);
    if (!edge) return 'off';
    return valueOfSource(edge.from, withinScc);
  };

  const computeGate = (gate: GateNode, withinScc: Map<string, Signal> | null): Signal => {
    const a = gateInputAt(gate, 0, withinScc);
    const b = inputPortCount(gate) > 1 ? gateInputAt(gate, 1, withinScc) : 'off';
    return evaluateGate(gate.op, a, b);
  };

  const feedbacks: FeedbackReport[] = [];
  const evaluationOrder: string[][] = [];

  for (const scc of findGateSccs(next)) {
    evaluationOrder.push([...scc.nodes]);
    if (!scc.cyclic) {
      for (const id of scc.nodes) {
        const gate = nodeById(next, id);
        if (gate?.kind !== 'gate') continue;
        gateValues.set(id, computeGate(gate, null));
      }
      continue;
    }

    const gatesInScc = scc.nodes
      .map((id) => nodeById(next, id))
      .filter((node): node is GateNode => node?.kind === 'gate');
    let candidate = new Map<string, Signal>();
    for (const gate of gatesInScc) candidate.set(gate.id, gateValues.get(gate.id) ?? gate.value);

    const history: Record<string, Signal>[] = [];
    const seen = new Set<string>();
    let iterations = 0;
    let stable = false;
    let reason: 'repeated' | 'limit' | null = null;
    const signature = (values: Map<string, Signal>, ids: string[]): string =>
      ids.map((id) => `${id}:${values.get(id) ?? 'off'}`).join('|');

    const frozen = new Map(candidate);

    for (let round = 0; round < MAX_CYCLE_ITERATIONS; round += 1) {
      const snapshot = new Map(candidate);
      const stateRecord: Record<string, Signal> = {};
      for (const id of scc.nodes) stateRecord[id] = snapshot.get(id) ?? 'off';
      history.push(stateRecord);
      seen.add(signature(snapshot, scc.nodes));

      const computed = new Map<string, Signal>();
      for (const gate of gatesInScc) computed.set(gate.id, computeGate(gate, snapshot));
      iterations += 1;

      const computedSig = signature(computed, scc.nodes);
      if (computedSig === signature(snapshot, scc.nodes)) {
        candidate = computed;
        stable = true;
        break;
      }
      if (seen.has(computedSig)) {
        reason = 'repeated';
        break;
      }
      candidate = computed;
      if (round === MAX_CYCLE_ITERATIONS - 1) reason = 'limit';
    }


    if (stable) {
      for (const [id, value] of candidate) gateValues.set(id, value);
      const state: Record<string, Signal> = {};
      for (const id of scc.nodes) state[id] = gateValues.get(id) ?? 'off';
      // 最终一轮的输入引用只用于展示
      const preview = new Map(gateValues);
      const inputs: NodeSourceRef[] = [];
      for (const gate of gatesInScc) {
        for (let port = 0; port < inputPortCount(gate); port += 1) {
          const edge = edgeInto(next, gate.id, port);
          const ref = sourceRef(next, gate, port);
          if (edge) {
            const src = nodeById(next, edge.from);
            ref.value =
              src && src.kind === 'gate'
                ? preview.get(src.id) ?? ref.value
                : ref.value;
          }
          ref.nodeName = `${gate.name} · ${portName(gate, port)} ← ${ref.nodeName}`;
          inputs.push(ref);
        }
      }
      feedbacks.push({
        id: scc.id,
        nodes: scc.nodes,
        stable: true,
        conflict: false,
        iterations,
        result: state,
        history,
        inputs,
        message: `${scc.nodes.length} 个节点的无延时反馈在 ${iterations} 轮内到达不动点.`,
      });
    } else {
      // 冲突: 不采用振荡中的值, 整体冻结回结算前的值, 保证下游可预期.
      for (const [id, value] of frozen) gateValues.set(id, value);
      const state: Record<string, Signal> = {};
      for (const id of scc.nodes) state[id] = frozen.get(id) ?? 'off';
      feedbacks.push({
        id: scc.id,
        nodes: scc.nodes,
        stable: false,
        conflict: true,
        iterations,
        result: state,
        history,
        inputs: [],
        message:
          reason === 'limit'
            ? `无延时反馈在 ${iterations} 轮内仍未收敛 (超过上限). 涉及节点维持结算前值.`
            : `无延时反馈冲突: 振荡 (${iterations} 轮后出现重复状态). 涉及节点维持结算前值.`,
      });
    }
  }

  // 写回门的输入/输出 (供"查来源"和渲染使用)
  for (const node of next.nodes) {
    if (node.kind !== 'gate') continue;
    node.value = gateValues.get(node.id) ?? node.value;
    node.a = gateInputAt(node, 0, null);
    node.b = inputPortCount(node) > 1 ? gateInputAt(node, 1, null) : 'off';
  }

  // 门/灯是汇点, 与组合逻辑同一结算时刻读取; 此时延时仍输出其寄存值.
  for (const node of next.nodes) {
    if (node.kind === 'door' || node.kind === 'lamp') {
      const source = nodeSources(next, node)[0];
      node.value = source?.value ?? 'off';
    }
  }

  // ---- 4. 延时在结算末尾采样输入入队, 下一步开头才成为输出 ----
  const sampled = new Map<string, Signal>();
  for (const node of next.nodes) {
    if (node.kind !== 'delay') continue;
    const source = nodeSources(next, node)[0];
    sampled.set(node.id, source?.value ?? 'off');
  }
  const delays: DelaySnapshot[] = [];
  for (const node of next.nodes) {
    if (node.kind !== 'delay') continue;
    const sample = sampled.get(node.id) ?? 'off';
    node.queue.push(sample);
    while (node.queue.length > node.steps) node.queue.shift();
    delays.push({
      nodeId: node.id,
      name: node.name,
      steps: node.steps,
      value: node.value,
      queue: [...node.queue],
      sampled: sample,
      advanced: delayAdvanced.find((item) => item.nodeId === node.id)?.advanced ?? false,
    });
  }

  // ---- 5. 门打开步号/状态 ----
  const doors: DoorState[] = [];
  for (const node of next.nodes) {
    if (node.kind !== 'door') continue;
    const door = node as DoorNode;
    if (door.value === 'on' && door.openedAt === null) door.openedAt = step;
    if (door.value === 'off') door.openedAt = null;
    doors.push({ id: door.id, name: door.name, passable: door.value === 'on', openedAt: door.openedAt });
  }

  // ---- 变化清单 ----
  const deltas: Delta[] = [];
  for (const node of next.nodes) {
    const old = before.get(node.id) ?? 'off';
    const now = rawValue(next, node);
    if (old === now) continue;
    const cause: Delta['cause'] =
      node.kind === 'switch'
        ? 'action'
        : node.kind === 'plate'
          ? 'contact'
          : node.kind === 'delay'
            ? 'buffer'
            : 'logic';
    deltas.push({
      nodeId: node.id,
      name: node.name,
      kind: node.kind,
      from: old,
      to: now,
      cause,
      sources: node.kind === 'gate' || node.kind === 'door' || node.kind === 'lamp' || node.kind === 'delay'
        ? nodeSources(next, node)
        : [],
      note:
        node.kind === 'delay'
          ? `采样 ${signalShort(sampled.get(node.id) ?? 'off')} 入队, 输出前进 1 格`
          : node.kind === 'door'
            ? now === 'on'
              ? '门已打开, 角色可通行'
              : '门已关闭'
            : '',
    });
  }

  next.step = step;

  return {
    level: next,
    report: {
      step,
      intent: { toggleSwitchIds: [...intent.toggleSwitchIds], move: intent.move },
      toggles,
      contacts,
      move,
      deltas,
      feedbacks,
      delays,
      doors,
      lamps: next.nodes
        .filter((node) => node.kind === 'lamp')
        .map((node) => ({ id: node.id, name: node.name, on: node.value === 'on' })),
      evaluationOrder,
    },
  };
}

/** 校验一条新接线能否建立; 不修改 level. */
export function canConnect(level: Level, from: string, to: string, toPort: number): string | null {
  const source = nodeById(level, from);
  const target = nodeById(level, to);
  if (!source) return '源节点不存在';
  if (!target) return '目标节点不存在';
  if (!canEmitSignal(source)) return `${source.name} 没有输出`;
  if (!canReceiveSignal(target)) return `${target.name} 不能接收信号`;
  const ports = inputPortCount(target);
  if (toPort < 0 || toPort >= ports) return `${target.name} 没有这个输入端口`;
  if (from === to && target.kind !== 'gate') return '只有门电路允许自指接线';
  return null;
}

export function isBlockingCell(level: Level, pos: GridPos): boolean {
  const node = level.nodes.find((candidate) => sameCell(candidate.pos, pos));
  return node ? isBlockingNode(node) : false;
}

export function hasEdge(level: Level, edgeId: string): Edge | undefined {
  return level.edges.find((edge) => edge.id === edgeId);
}
