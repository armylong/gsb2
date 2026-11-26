import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scenarioMidCollision, getScenario } from '../src/core/scenarios';
import { scanCollisions } from '../src/core/collision';
import { buildPlanSVG, buildCollisionCSV } from '../src/core/export';

export function writeSamples(outDir: string): void {
  const s = scenarioMidCollision();
  const scan = scanCollisions(s.mechanism, s.obstacles, { range: [0, 1], steps: 1200 });

  writeFileSync(
    join(outDir, 'plan-top.svg'),
    buildPlanSVG({
      mechanism: s.mechanism,
      obstacles: s.obstacles,
      plane: 'top',
      range: [0, 1],
      title: '开门余量检查图 · 中途擦碰样例 · 俯视',
    }),
  );

  writeFileSync(
    join(outDir, 'plan-side.svg'),
    buildPlanSVG({
      mechanism: s.mechanism,
      obstacles: s.obstacles,
      plane: 'side',
      range: [0.2, 0.8],
      title: '开门余量检查图 · 局部区间 0.2–0.8 · 侧视',
    }),
  );

  writeFileSync(
    join(outDir, 'collision-list.csv'),
    buildCollisionCSV({ events: scan.events, mechanism: s.mechanism, range: [0, 1] }),
  );

  const clear = getScenario('clear');
  const emptyScan = scanCollisions(clear.mechanism, clear.obstacles, { range: [0, 1] });
  writeFileSync(
    join(outDir, 'collision-list-empty.csv'),
    buildCollisionCSV({ events: emptyScan.events, mechanism: clear.mechanism, range: [0, 1] }),
  );
}
