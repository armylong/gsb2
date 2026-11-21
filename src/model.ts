export type Signal = 'on' | 'off';

export type GateOp = 'and' | 'or' | 'xor' | 'nand' | 'nor' | 'not';

export type NodeKind = 'switch' | 'plate' | 'delay' | 'gate' | 'door' | 'lamp';

export interface GridPos {
  x: number;
  y: number;
}

interface BaseNode {
  id: string;
  kind: NodeKind;
  name: string;
  pos: GridPos;
}

export interface SwitchNode extends BaseNode {
  kind: 'switch';
  value: Signal;
}

export interface PlateNode extends BaseNode {
  kind: 'plate';
  value: Signal;
}

/** 单步延时 (队列长度 = steps). value 是当前输出, queue 里是尚未到达输出的采样. */
export interface DelayNode extends BaseNode {
  kind: 'delay';
  value: Signal;
  steps: number;
  queue: Signal[];
}

export interface GateNode extends BaseNode {
  kind: 'gate';
  op: GateOp;
  value: Signal;
  a: Signal;
  b: Signal;
}

export interface DoorNode extends BaseNode {
  kind: 'door';
  value: Signal;
  /** 最近一次变为可通行时的步号, 关闭时恢复 null */
  openedAt: number | null;
}

export interface LampNode extends BaseNode {
  kind: 'lamp';
  value: Signal;
}

export type LogicNode = SwitchNode | PlateNode | DelayNode | GateNode | DoorNode | LampNode;

export interface Edge {
  id: string;
  from: string;
  to: string;
  toPort: number;
}

export interface Level {
  name: string;
  cols: number;
  rows: number;
  nodes: LogicNode[];
  edges: Edge[];
  character: GridPos;
  home: GridPos;
  step: number;
}

export interface NodeSourceRef {
  nodeId: string;
  nodeName: string;
  port: number;
  value: Signal;
  edgeId?: string;
  unconnected?: boolean;
  note?: string;
}

export interface NodeProvenance {
  nodeId: string;
  name: string;
  kind: NodeKind;
  value: Signal;
  cause: 'action' | 'contact' | 'logic' | 'buffer' | 'latched';
  inputs: NodeSourceRef[];
  note: string;
}

export const SIGNALS: readonly Signal[] = ['off', 'on'];

export function flip(signal: Signal): Signal {
  return signal === 'on' ? 'off' : 'on';
}

export function gateSymbol(op: GateOp): string {
  switch (op) {
    case 'and':
      return 'AND';
    case 'or':
      return 'OR';
    case 'xor':
      return 'XOR';
    case 'nand':
      return 'NAND';
    case 'nor':
      return 'NOR';
    case 'not':
      return 'NOT';
  }
}

export function gateLabel(op: GateOp): string {
  switch (op) {
    case 'and':
      return '与门';
    case 'or':
      return '或门';
    case 'xor':
      return '异或门';
    case 'nand':
      return '与非门';
    case 'nor':
      return '或非门';
    case 'not':
      return '非门';
  }
}

export function evaluateGate(op: GateOp, a: Signal, b: Signal): Signal {
  const x = a === 'on';
  const y = b === 'on';
  let on: boolean;
  switch (op) {
    case 'and':
      on = x && y;
      break;
    case 'or':
      on = x || y;
      break;
    case 'xor':
      on = x !== y;
      break;
    case 'nand':
      on = !(x && y);
      break;
    case 'nor':
      on = !(x || y);
      break;
    case 'not':
      on = !x;
      break;
  }
  return on ? 'on' : 'off';
}

export function inputPortCount(node: LogicNode): number {
  switch (node.kind) {
    case 'gate':
      return node.op === 'not' ? 1 : 2;
    case 'delay':
    case 'door':
    case 'lamp':
      return 1;
    case 'switch':
    case 'plate':
      return 0;
  }
}

export function canReceiveSignal(node: LogicNode): boolean {
  return node.kind === 'gate' || node.kind === 'delay' || node.kind === 'door' || node.kind === 'lamp';
}

export function canEmitSignal(node: LogicNode): boolean {
  return node.kind !== 'lamp' && node.kind !== 'door';
}

export function nodeValue(node: LogicNode): Signal {
  return node.value;
}

export function nodeSubtitle(node: LogicNode): string {
  switch (node.kind) {
    case 'switch':
      return '一位拨动开关';
    case 'plate':
      return '被角色踩住时输出 ON';
    case 'delay':
      return `${node.steps} 步缓冲 · 先入先出`;
    case 'gate':
      return `${gateLabel(node.op)} · ${inputPortCount(node)} 输入`;
    case 'door':
      return '输出 ON 时可通行';
    case 'lamp':
      return '显示输出状态';
  }
}

export function nodeKindLabel(node: LogicNode): string {
  switch (node.kind) {
    case 'switch':
      return '开关';
    case 'plate':
      return '压力板';
    case 'delay':
      return '延时';
    case 'gate':
      return '门电路';
    case 'door':
      return '门';
    case 'lamp':
      return '指示灯';
  }
}

export function defaultNodeName(kind: NodeKind, op?: GateOp): string {
  switch (kind) {
    case 'switch':
      return '开关';
    case 'plate':
      return '压力板';
    case 'delay':
      return '单步延时';
    case 'gate':
      return op ? gateSymbol(op) : '逻辑门';
    case 'door':
      return '门';
    case 'lamp':
      return '指示灯';
  }
}

export function makeNode(
  kind: NodeKind,
  id: string,
  pos: GridPos,
  opts: { name?: string; op?: GateOp; steps?: number } = {},
): LogicNode {
  const name = opts.name ?? defaultNodeName(kind, opts.op);
  switch (kind) {
    case 'switch':
      return { id, kind, name, pos: { ...pos }, value: 'off' };
    case 'plate':
      return { id, kind, name, pos: { ...pos }, value: 'off' };
    case 'delay': {
      const steps = Math.max(1, Math.min(8, Math.floor(opts.steps ?? 1)));
      return {
        id,
        kind,
        name,
        pos: { ...pos },
        value: 'off',
        steps,
        queue: [],
      };
    }
    case 'gate':
      return { id, kind, name, pos: { ...pos }, op: opts.op ?? 'and', value: 'off', a: 'off', b: 'off' };
    case 'door':
      return { id, kind, name, pos: { ...pos }, value: 'off', openedAt: null };
    case 'lamp':
      return { id, kind, name, pos: { ...pos }, value: 'off' };
  }
}

export function cloneNode(node: LogicNode): LogicNode {
  if (node.kind === 'delay') {
    return { ...node, pos: { ...node.pos }, queue: [...node.queue] };
  }
  return { ...node, pos: { ...node.pos } };
}

export function cloneLevel(level: Level): Level {
  return {
    name: level.name,
    cols: level.cols,
    rows: level.rows,
    nodes: level.nodes.map(cloneNode),
    edges: level.edges.map((edge) => ({ ...edge })),
    character: { ...level.character },
    home: { ...level.home },
    step: level.step,
  };
}

/** 保留接线与位置, 把全部运行态恢复到基线, 供重置 / 重放使用. */
export function resetLevelState(level: Level): Level {
  const reset = cloneLevel(level);
  for (const node of reset.nodes) {
    node.value = 'off';
    if (node.kind === 'gate') {
      node.a = 'off';
      node.b = 'off';
    } else if (node.kind === 'delay') {
      node.queue = [];
    } else if (node.kind === 'door') {
      node.openedAt = null;
    }
  }
  reset.character = { ...reset.home };
  reset.step = 0;
  return reset;
}

export function nodeById(level: Level, id: string): LogicNode | undefined {
  return level.nodes.find((node) => node.id === id);
}

export function incomingEdges(level: Level, nodeId: string): Edge[] {
  return level.edges.filter((edge) => edge.to === nodeId);
}

export function edgeInto(level: Level, nodeId: string, port: number): Edge | undefined {
  return level.edges.find((edge) => edge.to === nodeId && edge.toPort === port);
}

export function sameCell(a: GridPos, b: GridPos): boolean {
  return a.x === b.x && a.y === b.y;
}

export function cellKey(pos: GridPos): string {
  return `${pos.x},${pos.y}`;
}

export function blockingNodeAt(level: Level, pos: GridPos): LogicNode | undefined {
  return level.nodes.find((node) => sameCell(node.pos, pos) && isBlockingNode(node));
}

export function isBlockingNode(node: LogicNode): boolean {
  switch (node.kind) {
    case 'switch':
    case 'gate':
    case 'delay':
    case 'lamp':
      return true;
    case 'plate':
      return false;
    case 'door':
      return node.value === 'off';
  }
}

export function occupiedNodeAt(level: Level, pos: GridPos): LogicNode | undefined {
  return level.nodes.find((node) => sameCell(node.pos, pos));
}

export function makeLevel(params: {
  name: string;
  cols: number;
  rows: number;
  nodes: LogicNode[];
  edges: Edge[];
  home: GridPos;
}): Level {
  return {
    name: params.name,
    cols: params.cols,
    rows: params.rows,
    nodes: params.nodes,
    edges: params.edges,
    character: { ...params.home },
    home: { ...params.home },
    step: 0,
  };
}
