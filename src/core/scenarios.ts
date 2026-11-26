/**
 * 场景模型与三个可重复样例。
 *
 * A 无遮挡:       起止都让开, 全程无碰撞
 * B 起始已接触:   t=0 门板即与竖箱贴边 (侵入 0.5mm), 打开后立刻分开
 * C 中途擦碰:     起止都让开; 途中先撞到薄条 (贴边 grazing),
 *                 随后进入中层桌板 (penetrating), 最终分开
 *
 * 基础几何 (mm):
 *   门板 30(厚 x) × 900(高 y) × 500(宽 z), 铰链在原点竖轴, 关闭时占 x∈[-15,15], z∈[0,500]
 *   托板 360(宽) × 260(长) × 18(厚), 收纳时贴门板内表面
 */
import { rad, type Mechanism, type Sequence } from './kinematics';
import type { ObstacleSpec } from './collision';
import type { Vec3 } from './math3d';

export interface Scenario {
  id: string;
  name: string;
  description: string;
  mechanism: Mechanism;
  obstacles: ObstacleSpec[];
  /** 推荐初始检查区间 */
  initialRange: [number, number];
}

const DEFAULT_DOOR_SIZE: Vec3 = [30, 900, 500];
const DEFAULT_TRAY_SIZE: Vec3 = [360, 260, 18];

function baseMechanism(
  pivot: Vec3,
  doorRangeDeg: [number, number],
  sequence: Sequence,
  trayRangeDeg: [number, number] = [0, 90],
): Mechanism {
  return {
    door: {
      pivot,
      size: [...DEFAULT_DOOR_SIZE] as Vec3,
      angleRange: [rad(doorRangeDeg[0]), rad(doorRangeDeg[1])],
    },
    tray: {
      // 门板内表面 (-x 侧), 门高中部偏下, 距铰链 120
      hingeInDoor: [-25, -120, 120],
      size: [...DEFAULT_TRAY_SIZE] as Vec3,
      angleRange: [rad(trayRangeDeg[0]), rad(trayRangeDeg[1])],
    },
    sequence,
  };
}

export function scenarioClear(): Scenario {
  // 桌板整体位于门关闭位置的 -z 侧且 x 也让开门板, 门向 +z 打开, 全程不相交
  const table: ObstacleSpec = {
    id: 'obs-table',
    name: '桌板',
    center: [-550, 400, -350],
    size: [700, 40, 500],
  };
  return {
    id: 'clear',
    name: 'A · 无遮挡',
    description: '桌板在门侧前方, 门板与托板全程让开, 无任何碰撞事件。',
    mechanism: baseMechanism([0, 0, 0], [0, 90], 'simultaneous'),
    obstacles: [table],
    initialRange: [0, 1],
  };
}

export function scenarioStartContact(): Scenario {
  // 竖箱内面位于 z=500, 门自由边在 z=500 处侵入 0.5mm => t=0 即贴边;
  // 门一旦转动, 自由边 z=500cosθ 立即减小, 随即分开。
  const box: ObstacleSpec = {
    id: 'obs-box',
    name: '竖箱',
    center: [0, 0, 545],
    size: [120, 900, 90],
  };
  return {
    id: 'start-contact',
    name: 'B · 起始已接触',
    description: '竖箱与关闭的门板自由边贴边 (侵入 0.5mm), 门刚转动即分开。',
    mechanism: baseMechanism([0, 0, 0], [0, 90], 'door-first'),
    obstacles: [box],
    initialRange: [0, 1],
  };
}

export function scenarioMidCollision(): Scenario {
  // 桌板: y∈[-440,-400] 在门下缘 (y=-450) 扫掠高度内、托板可达范围之外;
  // x∈[120,420] 让关闭门 (x∈[-15,15]); z∈[350,750] 让全开姿态 (90° 时门在 z≈0)。
  // 开门约 6°~24° 区间门体扫过桌面 => penetrating, 起止姿态均让开。
  const table: ObstacleSpec = {
    id: 'obs-shelf',
    name: '中层桌板',
    center: [270, -420, 550],
    size: [300, 40, 400],
  };
  // 薄条 (grazing): 内面 x=499.5, 只伸入门自由边扫掠圆柱 0.5mm,
  // z 窗口 [40,160] 对应开门中段; 起止姿态均不接触, 接触时深度 <= 1mm 容差。
  const strip: ObstacleSpec = {
    id: 'obs-strip',
    name: '限位薄条',
    center: [503.5, 0, 100],
    size: [8, 900, 120],
  };
  return {
    id: 'mid-collision',
    name: 'C · 中途擦碰',
    description:
      '起止姿态都让开: 开门途中门棱先贴薄条擦过 (grazing), 再进入中层桌板 (penetrating), 随后分开。',
    mechanism: baseMechanism([0, 0, 0], [0, 90], 'door-first'),
    obstacles: [table, strip],
    initialRange: [0, 1],
  };
}

export const ALL_SCENARIOS: Scenario[] = [
  scenarioClear(),
  scenarioStartContact(),
  scenarioMidCollision(),
];

export function getScenario(id: string): Scenario {
  const s = ALL_SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`未知场景: ${id}`);
  // 返回深拷贝, 避免 UI 修改污染预设
  return cloneScenario(s);
}

export function cloneScenario(s: Scenario): Scenario {
  return JSON.parse(JSON.stringify(s)) as Scenario;
}
