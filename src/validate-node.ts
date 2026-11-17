/**
 * validate-node.ts —— 在 Node 下运行关键验证(无浏览器)
 *
 * 数学验证本身不依赖 DOM;只有纹理生成模块需要 Canvas。
 * 这里提供最小 Canvas 桩,使 V1–V9 与一次"六面纹理可生成、无 NaN"检查
 * 都能在命令行执行:npx vite-node src/validate-node.ts
 */

import { runValidation } from './validate';
import { FACE_ORDER } from './facemath';

class CtxStub {
  fillRect(): void { /* no-op */ }
  strokeRect(): void { /* no-op */ }
  clearRect(): void { /* no-op */ }
  beginPath(): void { /* no-op */ }
  moveTo(): void { /* no-op */ }
  lineTo(): void { /* no-op */ }
  stroke(): void { /* no-op */ }
  fill(): void { /* no-op */ }
  fillText(): void { /* no-op */ }
  strokeText(): void { /* no-op */ }
  save(): void { /* no-op */ }
  restore(): void { /* no-op */ }
  translate(): void { /* no-op */ }
  rotate(): void { /* no-op */ }
  scale(): void { /* no-op */ }
  drawImage(): void { /* no-op */ }
  clip(): void { /* no-op */ }
  arc(): void { /* no-op */ }
  set fillStyle(_v: string) { /* no-op */ }
  set strokeStyle(_v: string) { /* no-op */ }
  set font(_v: string) { /* no-op */ }
  set textAlign(_v: string) { /* no-op */ }
  set textBaseline(_v: string) { /* no-op */ }
  set lineWidth(_v: number) { /* no-op */ }
  set lineCap(_v: string) { /* no-op */ }
  set lineJoin(_v: string) { /* no-op */ }
  set globalAlpha(_v: number) { /* no-op */ }
}

class CanvasStub {
  width = 0;
  height = 0;
  getContext(): CtxStub { return new CtxStub(); }
}

(globalThis as Record<string, unknown>).document = {
  createElement: (): CanvasStub => new CanvasStub(),
};

async function main(): Promise<void> {
  // 纹理生成冒烟检查(需要 DOM 桩)
  const { generateAllFaces, TEX_SIZE } = await import('./texturegen');
  const faces = generateAllFaces();
  const okTex = FACE_ORDER.every((f) => faces[f].width === TEX_SIZE && faces[f].height === TEX_SIZE);
  console.log(`V0 纹理生成冒烟: ${okTex ? 'PASS' : 'FAIL'} — 6 个 ${TEX_SIZE}px 画布已生成`);

  const report = runValidation();
  for (const c of report.cases) {
    console.log(`${c.passed ? 'PASS' : 'FAIL'}  ${c.id}  ${c.name} — ${c.detail}`);
  }
  console.log(`\n汇总: ${report.cases.filter((c) => c.passed).length}/${report.cases.length} 通过`);
  if (!report.passed || !okTex) process.exit(1);
}

main();
