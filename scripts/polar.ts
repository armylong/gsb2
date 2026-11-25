/** 帆装极线：固定真风角跑稳态，展示每个风角下不同帆索的船速/VMG。 */
import { makeBoat } from '../src/engine/physics';
import { createWorld, stepWorld } from '../src/engine/world';
import { DEFAULT_WIND } from '../src/engine/courses';
import { fromAngle, normalize, perp, rad2deg, sub } from '../src/vec';

const deg = (d: number) => (d * Math.PI) / 180;
const windFrom = DEFAULT_WIND.dir + Math.PI;
const wf = fromAngle(windFrom);

function simulate(twa: number, sheet: number) {
  const heading0 = windFrom + deg(twa);
  const boat = makeBoat({ x: 500, y: 830 }, heading0);
  const w = createWorld({ ...DEFAULT_WIND }, [], []);
  for (let i = 0; i < 60 * 45; i++) stepWorld(w, boat, { rudder: 0, sheet });
  const speed = Math.hypot(boat.vel.x, boat.vel.y);
  // VMG：速度在风眼方向上的投影。风眼单位向量 = wf，向上风（屏幕上方，-y）为正
  const vmg = boat.vel.x * wf.x + boat.vel.y * wf.y;
  const eh = fromAngle(boat.heading);
  const sv = perp(eh);
  const leeway = boat.vel.x * sv.x + boat.vel.y * sv.y;
  const apparent = sub(fromAngle(w.wind.dir, w.wind.speed), boat.vel);
  const flow = normalize({ x: -apparent.x, y: -apparent.y });
  const awa = rad2deg(Math.atan2(flow.x * sv.x + flow.y * sv.y, flow.x * eh.x + flow.y * eh.y));
  const drift = rad2deg(Math.atan2(Math.sin(boat.heading - heading0), Math.cos(boat.heading - heading0)));
  return { speed, vmg, leeway, fill: boat.fill, awa, drift };
}

for (const twa of [30, 40, 50, 70, 90, 130, 170]) {
  console.log(`\n真风角 ${twa}°（向风 VMG 越大越好 / 顺风看船速）`);
  const rows = [];
  for (const s of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    const r = simulate(twa, s);
    rows.push({ s, ...r });
  }
  for (const r of rows) {
    console.log(
      `  帆索 ${r.s.toFixed(2)} | AWA ${r.awa.toFixed(0).padStart(4)}° | 船速 ${r.speed
        .toFixed(2)
        .padStart(5)} | VMG ${r.vmg.toFixed(2).padStart(5)} | 侧漂 ${r.leeway
        .toFixed(2)
        .padStart(5)} | 航向漂移 ${r.drift.toFixed(0)}° | fill ${r.fill.toFixed(2)}`,
    );
  }
}
