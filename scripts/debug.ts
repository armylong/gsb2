// 调试:输出若干随机布局的结算细节,定位合约过严还是仿真问题。
import { level, paradeA, paradeB, solutionA } from '../src/data.js';
import { simulate } from '../src/sim.js';

for (const [name, parade] of [['A', paradeA], ['B', paradeB]] as const) {
  console.log(`=== parade ${name} with solutionA ===`);
  const r = simulate(level, parade, solutionA);
  for (const v of r.viewers) console.log(` ${v.viewerId}: ${v.ok ? 'OK  ' : 'FAIL'} ${v.detail}`);
}
