import type { RoomDef, Wall } from './types.ts';

const T = 40;

function outerWalls(w: number, h: number, t: number): Wall[] {
  return [
    { x: 0, y: 0, w, h: t, tag: 'ceiling' },
    { x: 0, y: h - t, w, h: t, tag: 'floor' },
    { x: 0, y: 0, w: t, h, tag: 'left-wall' },
    { x: w - t, y: 0, w: t, h, tag: 'right-wall' },
  ];
}

/**
 * 房间 1：可正常完成。
 * 检验槽在右上方天花板凹槽内（需要重力向上）。
 * 中部有一块悬空窄台，翻转后会成为新的“地面”，制造窄角与贴墙场景。
 */
const room1: RoomDef = {
  id: 'room-1',
  name: '房间 1 · 上翻送箱（可完成）',
  width: 880,
  height: 560,
  wallThickness: T,
  startGravity: 1,
  hint: '把箱子推到右上天花板凹槽正下方，按 W 翻转，箱入槽并停稳即完成。',
  walls: [
    ...outerWalls(880, 560, T),
    // 天花板凹槽两侧竖壁（凹槽开口 x 620..760，内部即检验槽空间，槽比开口略窄）
    { x: 620, y: T, w: T, h: 60, tag: 'alcove-left' },
    { x: 760, y: T, w: T, h: 60, tag: 'alcove-right' },
    // 中部悬空窄台：下重力时是悬空障碍，上重力时是落脚台面
    { x: 360, y: 260, w: 80, h: 28, tag: 'floating-ledge' },
  ],
  slots: [
    // 槽宽 100、箱宽 36：对准窗口 64px（约 18 帧），槽缘距凹槽壁各 20px 容差
    { x: 640, y: T, w: 100, h: 52, gravity: 'up' },
  ],
  box: { x: 150, y: 520 - 36, w: 36, h: 36 },
  player: { x: 96, y: 520 - 44, w: 28, h: 44 },
};

/**
 * 房间 2：接触压力测试。
 * 开局重力向上，箱子与玩家并排贴在天花板凹槽内并互相接触、同贴天花板
 * （箱-人-墙同时接触）。凹槽入口较窄，专门看翻转后两者一起换方向坠落时
 * 会不会卡成重叠。默认以暂停态进入，可单步核对。
 */
const room2: RoomDef = {
  id: 'room-2',
  name: '房间 2 · 箱人墙同时接触（逐步核对）',
  width: 880,
  height: 560,
  wallThickness: T,
  startGravity: -1,
  hint: '开局即箱-人-天花同时接触。空格暂停、N 单步，观察翻转时是否互相穿透或挤出墙。',
  walls: [
    ...outerWalls(880, 560, T),
    // 天花板凹槽：开口 x 700..800，仅容一箱一人，入口为窄角
    { x: 660, y: T, w: T, h: 60, tag: 'alcove-left' },
    { x: 800, y: T, w: T, h: 60, tag: 'alcove-right' },
  ],
  slots: [
    // 左侧地板槽：左缘与墙面齐平，箱被墙顶住时即完整在槽内；玩家在箱右侧向左长推
    { x: 40, y: 520 - 48, w: 52, h: 48, gravity: 'down' },
  ],
  // 箱贴天花顶并贴凹槽左壁；玩家贴箱右缘并同贴天花（墙-箱-人同时接触），
  // 翻转落地后玩家在箱右侧，可以向左推箱
  box: { x: 700, y: T, w: 40, h: 40 },
  player: { x: 740, y: T, w: 28, h: 44 },
};

export const ROOMS: RoomDef[] = [room1, room2];
