import { describe, it, expect } from 'vitest';
import {
  settle,
  computeContacts,
  previewRemoval,
  Piece,
  verticalBearing,
  allDirs,
} from './engine';
import {
  TEMPLATES,
  PRESETS,
  GROUND_Y,
  makePiece,
  loadPreset,
  freshWorld,
} from './presets';

const f = (x: number, y: number): Piece => makePiece(TEMPLATES.foundation, { x, y });
const p = (x: number, y: number, capacity = 12): Piece =>
  makePiece(TEMPLATES.pillar, { x, y }, 1, false, { capacity });
const d = (x: number, y: number, length: number, capacity = 60): Piece =>
  makePiece(TEMPLATES.deck, { x, y }, length, false, { capacity });
const b = (x: number, y: number): Piece => makePiece(TEMPLATES.block, { x, y });

const findPillar = (pieces: Piece[], x: number) =>
  pieces.find((pp) => pp.kind === 'pillar' && pp.cells.some((c) => c.x === x))!;

describe('接触边与承重方向', () => {
  it('只在承重方向匹配时生成有向接触边', () => {
    // 支柱(竖向承重) 顶上加一块砌块(四向)
    const pieces = [f(0, 8), p(0, 7), b(0, 6)];
    const contacts = computeContacts(pieces);
    const pillar = pieces[1];
    const block = pieces[2];
    // 砌块接受来自南边(下方支柱)的支撑
    expect(contacts.some((c) => c.supporterId === pillar.id && c.supportedId === block.id)).toBe(true);
    // 支柱不接受侧向: 旁边放一块不应产生边
    const side = b(1, 7);
    const contacts2 = computeContacts([...pieces, side]);
    expect(
      contacts2.some((c) => c.supporterId === side.id && c.supportedId === pillar.id),
    ).toBe(false);
  });

  it('多格桥面按实际接触格产生多条边', () => {
    const pieces = [f(0, 8), f(2, 8), p(0, 7), p(2, 7), d(0, 6, 3)];
    const contacts = computeContacts(pieces);
    const deck = pieces[4];
    const deckIncoming = contacts.filter((c) => c.supportedId === deck.id);
    // 桥面在 x=0 与 x=2 两格各有一条来自支柱的边(x=1 下方为空)
    expect(deckIncoming).toHaveLength(2);
  });
});

describe('接地与悬空', () => {
  it('与地面接触即接地, 接地性沿支撑链传播', () => {
    const world = freshWorld();
    loadPreset(world, PRESETS[0]);
    const s = settle(world.pieces, GROUND_Y);
    expect(s.fallen).toHaveLength(0);
    expect(s.alive.every((r) => r.grounded)).toBe(true);
  });

  it('无任何接触的构件直接判悬空掉落', () => {
    const pieces = [f(0, 8), b(5, 2)];
    const s = settle(pieces, GROUND_Y);
    expect(s.fallen.map((x) => x.id)).toContain(pieces[1].id);
  });

  it('承重环无地基时整环悬空(环内互撑也无法接地)', () => {
    // 2x2 方块环(实际就是 2x2 四块), 不放任何锚点
    const ring = [b(3, 3), b(4, 3), b(3, 4), b(4, 4)];
    const s = settle(ring, GROUND_Y);
    expect(s.fallen).toHaveLength(4);
    expect(s.alive).toHaveLength(0);
  });

  it('同一承重环有一个锚点接地时整环接地, 移除锚点后整环掉落', () => {
    const world = freshWorld();
    loadPreset(world, PRESETS[2]);
    let s = world.settle();
    // 开局: 环+锚链接地, 只有 2x2 漂浮块(4 件)悬空
    expect(s.fallen).toHaveLength(4);
    const anchor = findPillar(world.pieces, 2);
    const pv = previewRemoval(world.pieces, anchor.id, GROUND_Y);
    // 拓扑预览: 锚点上方的连接砌块受影响, 环整体悬空
    expect(pv.simulatedFallen.length).toBeGreaterThanOrEqual(12);
    // 预览与结算一致(无超载, 纯接地性问题)
    const topoFall = pv.topoAffected.filter(
      (x) => !pv.topoStillStanding.some((y) => y.id === x.id),
    );
    expect(topoFall.map((x) => x.id).sort()).toEqual(pv.simulatedFallen.map((x) => x.id).sort());
  });
});

describe('多支撑共同承重(按接触边均分)', () => {
  it('两根支柱均分光桥面负载', () => {
    const pieces = [f(5, 8), f(8, 8), p(5, 7, 40), p(8, 7, 40), d(4, 6, 6, 40)];
    const s = settle(pieces, GROUND_Y);
    const deck = pieces[4];
    const rt = s.byId.get(deck.id)!;
    // 桥面两条入边, 桥面自重 24 均分到两条边, 每条 12(边负载不含支撑方自重)
    expect(rt.supportFrom).toHaveLength(2);
    expect(rt.supportFrom[0].edgeLoad).toBeCloseTo(12, 6);
    expect(rt.supportFrom[1].edgeLoad).toBeCloseTo(12, 6);
    // 支柱总负载 = 自重 2 + 边负载 12 = 14
    const pillarLoads = pieces
      .filter((x) => x.kind === 'pillar')
      .map((x) => s.byId.get(x.id)!.totalLoad);
    expect(pillarLoads.every((v) => Math.abs(v - 14) < 1e-6)).toBe(true);
  });

  it('三条支撑链时桥面负载分成三份', () => {
    const pieces = [
      f(0, 8), f(1, 8), f(2, 8),
      p(0, 7, 40), p(1, 7, 40), p(2, 7, 40),
      d(0, 6, 3, 40),
    ];
    const s = settle(pieces, GROUND_Y);
    const deck = pieces[6];
    const rt = s.byId.get(deck.id)!;
    expect(rt.supportFrom).toHaveLength(3);
    // 桥面自重 12, 三份各 4
    expect(rt.supportFrom.every((src) => Math.abs(src.edgeLoad - 4) < 1e-6)).toBe(true);
  });
});

describe('超载与级联', () => {
  it('构件负载超过上限即失效, 上方构件级联掉落', () => {
    // 单根细支柱(上限 5)托住重桥面(自重 24): 支柱必断
    const pieces = [f(4, 8), p(4, 7, 5), d(4, 6, 6, 40)];
    const s = settle(pieces, GROUND_Y);
    expect(s.overloaded.map((x) => x.kind)).toContain('pillar');
    expect(s.fallen.map((x) => x.kind)).toContain('deck');
  });

  it('双支柱拆除一根后另一根超载断裂(预览站立 ≠ 结算站立)', () => {
    const world = freshWorld();
    loadPreset(world, PRESETS[1]);
    // 初始: 每柱总负载 14(自重 2 + 边载 12) ≤ 16, 无掉落
    let s = world.settle();
    expect(s.fallen).toHaveLength(0);
    const pillarLoads = world.pieces
      .filter((x) => x.kind === 'pillar')
      .map((x) => s.byId.get(x.id)!.totalLoad);
    expect(pillarLoads.every((v) => Math.abs(v - 14) < 1e-6)).toBe(true);

    const target = findPillar(world.pieces, 5);
    const pv = previewRemoval(world.pieces, target.id, GROUND_Y);
    // 拓扑上桥面仍被另一柱托住 → 预览中桥面属于"仍站立"
    const deck = world.pieces.find((x) => x.kind === 'deck')!;
    expect(pv.topoStillStanding.map((x) => x.id)).toContain(deck.id);
    expect(pv.topoAffected.map((x) => x.id)).toContain(deck.id);
    // 真实结算: 另一柱总负载 26(自重 2 + 桥面 24) > 16 超载, 桥面掉落
    expect(pv.simulatedOverloaded.map((x) => x.kind)).toContain('pillar');
    expect(pv.simulatedFallen.map((x) => x.kind)).toContain('deck');
    // 预览与结算范围不一致正是本场景的教学点
    const topoFall = pv.topoAffected.filter(
      (x) => !pv.topoStillStanding.some((y) => y.id === x.id),
    );
    expect(topoFall.length).toBeLessThan(pv.simulatedFallen.length);
  });
});

describe('预设一 · 桥面: 冗余支撑拆除不掉', () => {
  it('拆除任一支柱后拓扑预览与真实结算均无掉落, 负载重分配', () => {
    const world = freshWorld();
    loadPreset(world, PRESETS[0]);
    expect(world.settle().fallen).toHaveLength(0);
    const target = findPillar(world.pieces, 4);
    const pv = previewRemoval(world.pieces, target.id, GROUND_Y);
    expect(pv.simulatedFallen).toHaveLength(0);
    expect(pv.simulatedOverloaded).toHaveLength(0);
    // 桥面在预览里被标为受影响(少了一条支撑边)但仍站立
    const deck = world.pieces.find((x) => x.kind === 'deck')!;
    expect(pv.topoStillStanding.map((x) => x.id)).toContain(deck.id);
    // 剩余支柱承担的份额上升
    const remaining = findPillar(world.pieces.filter((x) => x.id !== target.id), 8);
    const loadAfter = pv.settlement.byId.get(remaining.id)!.totalLoad;
    const loadBefore = settle(world.pieces, GROUND_Y).byId.get(remaining.id)!.totalLoad;
    expect(loadAfter).toBeGreaterThan(loadBefore);
  });
});

describe('World: 放置/拆除/撤销', () => {
  it('重叠与越界放置被拒绝', () => {
    const world = freshWorld();
    expect(world.add(f(1, 8))).toBe(true);
    expect(world.add(b(1, 8))).toBe(false); // 占用
    expect(world.add(b(-1, 5))).toBe(false); // 越界
    expect(world.add(b(0, GROUND_Y))).toBe(false); // 地面行不可放
  });

  it('提交拆除后可一步撤销还原(含级联掉落的构件)', () => {
    const world = freshWorld();
    loadPreset(world, PRESETS[1]);
    const before = world.pieces.length;
    const target = findPillar(world.pieces, 5);
    const { removed } = world.commitRemoval(target.id);
    expect(removed.length).toBeGreaterThan(1); // 目标 + 级联掉落
    expect(world.pieces.length).toBeLessThan(before);
    expect(world.canUndo()).toBe(true);
    expect(world.undo()).toBe(true);
    expect(world.pieces.length).toBe(before);
    // 撤销后重新结算恢复原状
    expect(world.settle().fallen).toHaveLength(0);
  });

  it('地基可移除, 移除后其支撑链悬空', () => {
    const world = freshWorld();
    const foundation = f(3, 8);
    world.add(foundation);
    world.add(p(3, 7, 20));
    world.add(d(3, 6, 1, 20));
    expect(world.settle().fallen).toHaveLength(0);
    const pv = world.preview(foundation.id);
    expect(pv.simulatedFallen.length).toBeGreaterThan(0);
    const { removed } = world.commitRemoval(foundation.id);
    expect(world.pieces.every((x) => x.id !== foundation.id)).toBe(true);
    expect(removed.length).toBeGreaterThan(0);
    // 剩余世界里所有构件都不再接地
    expect(world.settle().alive).toHaveLength(0);
  });
});

describe('方向性: 侧向承重砌块可互撑, 竖向支柱不接受侧力', () => {
  it('修改承重方向后接触边重新计算', () => {
    const pillar = p(0, 7, 20);
    const side = b(1, 7);
    const pieces = [f(0, 8), pillar, side];
    expect(
      computeContacts(pieces).some((c) => c.supporterId === side.id && c.supportedId === pillar.id),
    ).toBe(false);
    // 给支柱打开东向承重
    pillar.bearing = allDirs();
    expect(
      computeContacts(pieces).some((c) => c.supporterId === side.id && c.supportedId === pillar.id),
    ).toBe(true);
    // verticalBearing 工厂保持竖向
    expect(verticalBearing().west).toBe(false);
  });
});
