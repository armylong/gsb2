// 把程序生成的样例写成 OBJ 文件到 samples/ 目录，供文件导入流程测试。
// 运行：node scripts/generate-sample-files.js

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShadedMesh } from '../src/core/smoothing.js';
import { exportOBJ } from '../src/io/meshio.js';
import {
  makeCube, makeSphere, makeLShape, makeGrid,
  makeTetraWithReversedFace, makeCubeWithDegenerateFace,
  makeOrientationDiscontinuity, makeDuplicateVertexCube,
  makeNonManifold, makeOpenPatch, makeAllDegenerate,
} from '../src/samples/generators.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const good = [
  ['cube.obj', makeCube()],
  ['sphere.obj', makeSphere()],
  ['l_shape.obj', makeLShape()],
  ['grid.obj', makeGrid()],
];
const bad = [
  ['tetra_reversed.obj', makeTetraWithReversedFace()],
  ['cube_degenerate.obj', makeCubeWithDegenerateFace()],
  ['orientation_seam.obj', makeOrientationDiscontinuity()],
  ['duplicate_vertex.obj', makeDuplicateVertexCube()],
  ['non_manifold.obj', makeNonManifold()],
  ['open_patch.obj', makeOpenPatch()],
  ['all_degenerate.obj', makeAllDegenerate()],
];

// 坏样例导出源网格（保留问题）；全退化模型只写原始面，不经过 shaded（其有效面为 0）
const writeSource = (mesh) => {
  const lines = [`# 问题样例：${mesh.meta.fileName}`, ...(mesh.meta.warnings.map((w) => `# ${w}`))];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lines.push(`v ${mesh.positions[i]} ${mesh.positions[i + 1]} ${mesh.positions[i + 2]}`);
  }
  for (const [a, b, c] of mesh.faces) lines.push(`f ${a + 1} ${b + 1} ${c + 1}`);
  return lines.join('\n') + '\n';
};

for (const [name, mesh] of good) {
  const shaded = buildShadedMesh(mesh, { mode: 'smooth', creaseAngleDeg: 35 });
  const dir = resolve(root, 'samples/good');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), exportOBJ(shaded, name));
  console.log('written samples/good/' + name);
}
for (const [name, mesh] of bad) {
  const dir = resolve(root, 'samples/bad');
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, name), writeSource(mesh));
  console.log('written samples/bad/' + name);
}
console.log('done.');
