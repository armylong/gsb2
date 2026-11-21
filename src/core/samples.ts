// 回归样例: main 把箱子推上开关后, 在同一历史位置分出左右两条分支。
//   left  — 继续把箱子推离开关: 开关松开, 门关闭
//   right — 绕过箱子穿过开着的门: 开关仍压住, 门保持开, 玩家到达墙另一侧

import { Recorder } from "./tape.ts";
import type { Input, SimState } from "./sim.ts";

export const MAIN_INPUTS: Input[] = ["right", "right", "right", "wait"];
export const FORK_STEP = 4; // 在 main 第 4 步 (箱子已压住开关) 分叉
export const LEFT_INPUTS: Input[] = ["right", "wait"];
export const RIGHT_INPUTS: Input[] = ["up", "right", "right", "down", "right", "right"];

export const LEFT_BRANCH = "left-推离开关";
export const RIGHT_BRANCH = "right-穿门而过";

export function buildRegressionSamples(): Recorder {
  const rec = new Recorder();
  const mainId = rec.currentId;

  for (const input of MAIN_INPUTS) rec.append(input);

  rec.seek(FORK_STEP);
  rec.fork(LEFT_BRANCH);
  for (const input of LEFT_INPUTS) rec.append(input);

  rec.switchTo(mainId);
  rec.seek(FORK_STEP);
  rec.fork(RIGHT_BRANCH);
  for (const input of RIGHT_INPUTS) rec.append(input);

  rec.switchTo(mainId);
  rec.seek(FORK_STEP);
  return rec;
}

export interface CompareRow {
  item: string;
  left: string;
  right: string;
  same: boolean;
}

export function compareFinalStates(a: SimState, b: SimState): CompareRow[] {
  const pos = (p: { x: number; y: number }) => `(${p.x},${p.y})`;
  return [
    {
      item: "箱子位置",
      left: pos(a.box),
      right: pos(b.box),
      same: a.box.x === b.box.x && a.box.y === b.box.y,
    },
    {
      item: "开关",
      left: a.switchOn ? "压住" : "松开",
      right: b.switchOn ? "压住" : "松开",
      same: a.switchOn === b.switchOn,
    },
    {
      item: "门",
      left: a.doorOpen ? "开" : "关",
      right: b.doorOpen ? "开" : "关",
      same: a.doorOpen === b.doorOpen,
    },
    {
      item: "玩家位置",
      left: pos(a.player),
      right: pos(b.player),
      same: a.player.x === b.player.x && a.player.y === b.player.y,
    },
  ];
}
