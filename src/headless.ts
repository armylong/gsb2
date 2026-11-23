// 无头调参 / 确定性自检：不依赖浏览器与渲染帧率。
//   npx tsx src/headless.ts                 跑两个固定样例并打印事件
//   npx tsx src/headless.ts --determinism   用不同“帧步长”喂同一个仿真，比对落点与失速时刻
import { FIXED_DT, SCENARIOS, Simulation, DEFAULT_PARAMS } from './physics/sim';
import { DEFAULT_CROSSWIND, DEFAULT_THERMAL } from './physics/wind';
import { rad2deg } from './physics/vec';

function runOne(scenarioId: string, frameDt: number, maxRealSeconds = 60) {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const sim = new Simulation(scenario, DEFAULT_PARAMS, DEFAULT_THERMAL, DEFAULT_CROSSWIND);
  let frames = 0;
  let carry = 0; // 帧间隔小于物理步长时（如 144Hz 渲染 vs 100Hz 物理），零头必须累积
  const frameCap = Math.ceil((maxRealSeconds / Math.max(frameDt, 1e-4)) * 1.5) + 100;
  while (!sim.stopped && sim.simTime < maxRealSeconds && frames < frameCap) {
    carry = sim.advance(carry + frameDt);
    frames++;
  }
  return sim;
}

function printReport(sim: Simulation, frameDt: number) {
  const s = sim.state;
  console.log(`\n=== ${sim.scenario.label}（喂帧间隔 ${frameDt}s）===`);
  console.log(
    `结束 t=${s.simTime.toFixed(2)}s  停住=${s.stopped}  位置=(${s.pos.x.toFixed(1)}, ${s.pos.y.toFixed(1)})`,
  );
  console.log(
    `地速=${s.groundSpeed.toFixed(2)} m/s  空速=${s.airspeed.toFixed(2)} m/s  俯仰=${rad2deg(s.pitch).toFixed(1)}°  迎角=${rad2deg(s.alpha).toFixed(1)}°`,
  );
  for (const e of sim.events) {
    const r = Object.entries(e.readings)
      .map(([k, val]) => `${k}=${typeof val === 'number' ? val.toFixed(2) : val}`)
      .join(' ');
    console.log(`  [${e.t.toFixed(2)}s] ${e.message}  | ${r}`);
  }
}

// 不同的“渲染帧间隔”：注意 advance 内部仍按 FIXED_DT 切分，残余时间累积
const FRAME_BUCKETS = [FIXED_DT, 1 / 30, 1 / 60, 1 / 144, 0.0333, 0.05];

if (process.argv.includes('--determinism')) {
  let maxPosErr = 0;
  let maxTimeErr = 0;
  for (const scenario of SCENARIOS) {
    console.log(`\n########## 确定性比对：${scenario.label} ##########`);
    const ref = runOne(scenario.id, FIXED_DT);
    const refStall = ref.events.filter((e) => e.type === 'stall-enter').map((e) => e.t);
    console.log(
      `参考(100Hz): 落点=(${ref.state.pos.x.toFixed(3)}, ${ref.state.pos.y.toFixed(3)}) 停住t=${ref.state.simTime.toFixed(3)} 失速时刻=[${refStall.map((t) => t.toFixed(3)).join(', ')}]`,
    );
    for (const f of FRAME_BUCKETS.filter((d) => d !== FIXED_DT)) {
      const sim = runOne(scenario.id, f);
      const stall = sim.events.filter((e) => e.type === 'stall-enter').map((e) => e.t);
      const err = Math.hypot(sim.state.pos.x - ref.state.pos.x, sim.state.pos.y - ref.state.pos.y);
      const tErr = Math.abs(sim.state.simTime - ref.state.simTime);
      maxPosErr = Math.max(maxPosErr, err);
      maxTimeErr = Math.max(maxTimeErr, tErr);
      const stallMatch =
        stall.length === refStall.length &&
        stall.every((t, i) => Math.abs(t - refStall[i]) < FIXED_DT * 1.5);
      console.log(
        `帧间隔 ${f.toFixed(4)}s: 落点=(${sim.state.pos.x.toFixed(3)}, ${sim.state.pos.y.toFixed(3)}) 位置偏差=${err.toFixed(4)}m 停住t偏差=${tErr.toFixed(4)}s 失速时刻一致=${stallMatch}`,
      );
    }
  }
  console.log(`\n最大落点偏差=${maxPosErr.toFixed(4)}m，最大停住时刻偏差=${maxTimeErr.toFixed(4)}s`);
  console.log(maxPosErr < 0.05 ? 'PASS：不同绘制帧率下结果一致' : 'WARN：偏差偏大，请检查步长切分');
} else {
  for (const scenario of SCENARIOS) {
    printReport(runOne(scenario.id, 1 / 60), 1 / 60);
  }
}
