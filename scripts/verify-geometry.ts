/**
 * 关键几何验证（命令行，无浏览器依赖）
 * 运行：npm run verify
 * 覆盖：零基线 / 会聚面零视差 / 近远符号 / 同深度一致性 /
 *       尺寸变化后的视差换算 / 近远裁剪边界 / 相机后方 / 单眼可见 / 参数校验。
 */
import { runGeometryChecks } from '../src/verify';

const results = runGeometryChecks();
let failed = 0;
for (const r of results) {
  const tag = r.pass ? 'PASS' : 'FAIL';
  if (!r.pass) failed++;
  console.log(`${tag.padEnd(4)} ${r.name}`);
  console.log(`       ${r.detail}`);
}
console.log('');
console.log(`共 ${results.length} 项，通过 ${results.length - failed} 项，失败 ${failed} 项`);
if (failed > 0) process.exit(1);
