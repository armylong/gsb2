// 内置场景：样例全部在程序里生成，无需外部数据文件
import type { CarConfig, Cell, SimConfig, Strategy } from './simulator';

export interface ScenarioDef {
  id: string;
  name: string;
  description: string;
  build: (strategy: Strategy, horizon: number, maxWait: number) => SimConfig;
}

// 共用地图：11 列 × 7 行
//   y=3 是横贯东西的主路，x=4,5,6 是三格窄桥
//   (2,4) 西侧等待格，(8,2) 东侧等待格（各有一条支路与主路相连）
//   (0,2)(1,2) 西侧停泊格，供西向车队到达后分流，避免在单车道终点互相堵死
export function buildMapCells(): Cell[] {
  const cells: Cell[] = [];
  for (let x = 0; x <= 10; x++) {
    const type = x >= 4 && x <= 6 ? 'bridge' : 'road';
    cells.push({ x, y: 3, type });
  }
  // 西侧等待格支路：(2,4) → (2,3)
  cells.push({ x: 2, y: 4, type: 'wait' });
  // 东侧等待格支路：(8,2) → (8,3)
  cells.push({ x: 8, y: 2, type: 'wait' });
  // 西侧停泊格支路：(0,2)(1,2) → (0,3)/(1,3)
  cells.push({ x: 0, y: 2, type: 'wait' });
  cells.push({ x: 1, y: 2, type: 'wait' });
  return cells;
}

export const MAP_WIDTH = 11;
export const MAP_HEIGHT = 7;

// 场景一：单桥对向。两台车从桥的两侧同时出发，预期东向车先预约整段桥，
// 对向车退入东侧等待格停泊，等桥清空再上桥，最终都到达。
const scenarioA: ScenarioDef = {
  id: 'opposite',
  name: '场景一：单桥对向会车',
  description:
    'A1 东向、A2 西向同时抵达桥头。同一步内重占格子与迎面交换均被预约表拦截，' +
    'A2 退入东侧等待格 (8,2) 停泊，A1 过桥后 A2 再上桥。预期：全部到达。',
  build: (strategy, horizon, maxWait) => ({
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    cells: buildMapCells(),
    horizon,
    strategy,
    maxWait,
    cars: [
      {
        id: 'A1',
        label: 'A1 东向车',
        color: '#4fc3f7',
        start: { x: 0, y: 3 },
        goal: { x: 10, y: 3 },
        priority: 5,
        siding: { x: 2, y: 4 },
      },
      {
        id: 'A2',
        label: 'A2 西向车',
        color: '#ffb74d',
        start: { x: 10, y: 3 },
        goal: { x: 0, y: 3 },
        priority: 5,
        siding: { x: 8, y: 2 },
      },
    ] satisfies CarConfig[],
  }),
};

// 场景二：弱优先车持续等待。W 在西侧等待格出发要东行过桥，四台高优先级车
// 已经排在桥东侧的单车道上结队西向过桥，桥面长时间被占。严格优先级下 W 拿不到
// 整段桥的预约，持续停泊在等待格直至被判饥饿失败；切到「优先级老化」后 W 的
// 有效优先级随等待步数上升，可反超车队长时间阻塞前先过桥。
const scenarioB: ScenarioDef = {
  id: 'starvation',
  name: '场景二：弱优先车持续等待',
  description:
    'W 优先级 2，在西侧等待格 (2,4) 等待；四台优先级 8 的 H 车排在桥东侧结队西向过桥，' +
    '桥面持续被占。严格优先级下 W 在等待格持续等待，超过 maxWait 步后报「弱车饥饿」' +
    '失败并给出原因；切到优先级老化/先到先得，或直接调高 W 的优先级后可翻盘成功。',
  build: (strategy, horizon, maxWait) => ({
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    cells: buildMapCells(),
    horizon,
    strategy,
    maxWait,
    cars: [
      {
        id: 'W',
        label: 'W 弱优先车',
        color: '#ba68c8',
        start: { x: 2, y: 4 },
        goal: { x: 10, y: 3 },
        priority: 2,
        siding: { x: 2, y: 4 },
      },
      {
        id: 'H1',
        label: 'H1 高优先车',
        color: '#ef5350',
        start: { x: 7, y: 3 },
        goal: { x: 0, y: 2 },
        priority: 8,
        siding: null,
      },
      {
        id: 'H2',
        label: 'H2 高优先车',
        color: '#e57373',
        start: { x: 8, y: 3 },
        goal: { x: 1, y: 2 },
        priority: 8,
        siding: null,
      },
      {
        id: 'H3',
        label: 'H3 高优先车',
        color: '#ef9a9a',
        start: { x: 9, y: 3 },
        goal: { x: 0, y: 3 },
        priority: 8,
        siding: null,
      },
      {
        id: 'H4',
        label: 'H4 高优先车',
        color: '#f48fb1',
        start: { x: 10, y: 3 },
        goal: { x: 1, y: 3 },
        priority: 8,
        siding: null,
      },
    ] satisfies CarConfig[],
  }),
};

export const SCENARIOS: ScenarioDef[] = [scenarioA, scenarioB];
