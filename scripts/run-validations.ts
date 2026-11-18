/**
 * 非浏览器环境下执行页面侧四个验证入口(与页面按钮调用的是同一套函数),
 * 把实测结果打印出来。运行: npx vite-node scripts/run-validations.ts
 */
import { VALIDATORS } from '../src/ui/validation';

let allPass = true;
for (const v of VALIDATORS) {
  const report = v.run();
  allPass = allPass && report.passed;
  console.log(`\n===== ${report.id} · ${report.title} [${report.passed ? '全部通过' : '存在失败'}] =====`);
  for (const c of report.checks) {
    console.log(`${c.pass ? '  ✓' : '  ✗'} ${c.name}`);
    console.log(`      ${c.detail}`);
  }
}
console.log(`\n总结: ${allPass ? '四个验证入口全部通过' : '存在失败项, 见上方 ✗'}`);
if (!allPass) process.exit(1);
