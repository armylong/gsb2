// Node 端检查入口：npm run check
// 1) 运行解析路径偏离 / 停止位置检查并打印结果
// 2) 写出 JSON 报告与两张 SVG 对照图到 tmp/check/
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runChecks, CheckResult } from '../src/core/check.js';
import { createField } from '../src/core/fields.js';
import { traceStreamline } from '../src/core/integrator.js';
import { Vec2 } from '../src/core/types.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outDir = join(repoRoot, 'tmp', 'check');

// SVG 视图参数：场景 [-500,500]x[-400,400] -> 1000x800 像素，留 40px 边距
const PAD = 40;
const W = 1080;
const H = 880;
const SX = (W - PAD * 2) / 1000;
const SY = (H - PAD * 2) / 800;

function sx(p: Vec2): { x: number; y: number } {
  return { x: PAD + (p.x + 500) * SX, y: PAD + (p.y + 400) * SY };
}

function polyline(points: Vec2[], color: string, width: number, dash = ''): string {
  const d = points.map((p, i) => {
    const s = sx(p);
    return `${i === 0 ? 'M' : 'L'}${s.x.toFixed(2)},${s.y.toFixed(2)}`;
  }).join(' ');
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
}

function circle(cx: number, cy: number, r: number, color: string, fill: string): string {
  const c = sx({ x: cx, y: cy });
  return `<circle cx="${c.x}" cy="${c.y}" r="${(r * SX).toFixed(2)}" fill="${fill}" stroke="${color}" stroke-width="1.5" stroke-dasharray="6 4"/>`;
}

function line(x1: number, y1: number, x2: number, y2: number, color: string, dash = ''): string {
  const a = sx({ x: x1, y: y1 });
  const b = sx({ x: x2, y: y2 });
  return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="1.4" ${dash ? `stroke-dasharray="${dash}"` : ''}/>`;
}

function svgWrap(body: string, title: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, sans-serif">
  <rect width="${W}" height="${H}" fill="#141412"/>
  <text x="${PAD}" y="24" fill="#f0efec" font-size="16">${title}</text>
  ${rect(-500, -400, 1000, 800)}
  ${body}
</svg>`;
}

function rect(x: number, y: number, w: number, h: number): string {
  const a = sx({ x, y });
  return `<rect x="${a.x}" y="${a.y}" width="${w * SX}" height="${h * SY}" fill="none" stroke="#3d3d3a" stroke-width="1.5" stroke-dasharray="8 5"/>`;
}

function legend(items: Array<[string, string]>): string {
  return items
    .map(([c, t], i) => {
      const y = H - 14 - (items.length - 1 - i) * 0;
      void y;
      return `<rect x="${PAD + i * 260}" y="${H - 26}" width="14" height="14" fill="${c}"/><text x="${PAD + i * 260 + 20}" y="${H - 14}" fill="#c3c2b7" font-size="12">${t}</text>`;
    })
    .join('');
}

function buildUniformSvg(): string {
  const field = createField('uniform');
  const seeds = [-220, -80, 80, 220].map((y) => ({ x: -300, y }));
  const bodies: string[] = [];
  for (const seed of seeds) {
    const t = traceStreamline(field, seed);
    bodies.push(polyline(t.points, '#5aa0ee', 2));
    // 解析参考：贯穿全场景的水平线
    bodies.push(line(-500, seed.y, 500, seed.y, 'rgba(250,178,25,0.9)', '8 6'));
  }
  bodies.push(legend([
    ['#5aa0ee', '积分流线'],
    ['#fab219', '解析参考（直线）']
  ]));
  return svgWrap(bodies.join('\n  '), '对照图 1：匀速直线场 — 积分流线 vs 解析直线路径');
}

function buildRigidSvg(): string {
  const field = createField('rigid');
  const seeds = [140, 220, 310].map((r) => ({ x: r, y: 0 }));
  const bodies: string[] = [];
  for (const seed of seeds) {
    const t = traceStreamline(field, seed);
    bodies.push(polyline(t.points, '#5aa0ee', 2));
    bodies.push(circle(0, 0, Math.hypot(seed.x, seed.y), 'rgba(250,178,25,0.9)', 'none'));
  }
  bodies.push(legend([
    ['#5aa0ee', '积分流线（应闭合）'],
    ['#fab219', '解析参考（正圆）']
  ]));
  return svgWrap(bodies.join('\n  '), '对照图 2：刚体旋转场 — 积分流线 vs 解析圆路径');
}

function fmt(n: number): string {
  return n.toFixed(3);
}

function printReport(results: CheckResult[]): void {
  console.log('\n== 本地流线检查（解析路径对照） ==');
  console.log('场景范围 x[-500,500] y[-400,400]，RK4 弧长步长 4\n');
  for (const r of results) {
    const mark = r.pass ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${r.label}`);
    console.log(`  起点 (${r.seed.x}, ${r.seed.y})  折点数 ${r.pointCount}  闭合=${r.closed}`);
    console.log(`  停止: 顺流=${r.forwardReason} 逆流=${r.backwardReason}`);
    if (r.maxDeviation > 0 || r.fieldId === 'uniform' || r.fieldId === 'rigid') {
      console.log(`  偏离解析路径: 最大 ${fmt(r.maxDeviation)}  平均 ${fmt(r.meanDeviation)}（容差 ${r.tolerance}）`);
    }
    console.log(`  停止位置误差: ${fmt(r.stopError)}`);
    console.log(`  期望: ${r.expected}\n`);
  }
}

async function main(): Promise<void> {
  const report = runChecks();
  printReport(report.results);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  await writeFile(join(outDir, 'uniform.svg'), buildUniformSvg(), 'utf8');
  await writeFile(join(outDir, 'rigid.svg'), buildRigidSvg(), 'utf8');
  console.log(`报告与对照图已写出: ${outDir}/`);
  console.log('  - report.json   结构化检查结果（含每个折点的偏离量）');
  console.log('  - uniform.svg   匀速直线对照图');
  console.log('  - rigid.svg     刚体旋转圆对照图\n');
  if (!report.allPass) {
    console.error('存在未通过的检查项');
    process.exit(1);
  }
  console.log('全部检查通过 ✔');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
