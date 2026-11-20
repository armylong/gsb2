/**
 * 无浏览器的验证入口:
 *   npm run verify
 * 直接运行内置示例, 打印真实事件记录与断言结果。
 * 退出码非 0 表示有断言失败。
 */
import { createDemoConfig } from '../src/engine/demo';
import { runDemoScenarios } from '../src/engine/scenarios';
import { runPreviewSideEffectChecks } from './preview-check';
import { runConfigChecks } from './config-check';

function main(): number {
  const config = createDemoConfig();
  let failures = 0;

  console.log('══════════════════════════════════════════════════════════');
  console.log('动画状态机 · 内置示例验证');
  console.log(`配置: ${config.name} · ${config.states.length} 状态 / ${config.transitions.length} 过渡`);
  console.log('══════════════════════════════════════════════════════════\n');

  for (const report of runDemoScenarios(config)) {
    console.log(`▶ ${report.name} (${report.id})`);
    console.log(`  ${report.description}\n`);
    console.log('  真实事件记录:');
    for (const line of report.lines) console.log(`    ${line}`);
    console.log('\n  断言:');
    for (const check of report.checks) {
      const mark = check.pass ? '  ✓' : '  ✕';
      console.log(`${mark} ${check.label}`);
      console.log(`      ${check.detail}`);
      if (!check.pass) failures += 1;
    }
    console.log(`\n  结果: ${report.passed ? '通过' : '失败'}\n`);
    console.log('──────────────────────────────────────────────────────────\n');
  }

  const preview = runPreviewSideEffectChecks(config);
  console.log('▶ 预览无副作用');
  for (const check of preview.checks) {
    console.log(`${check.pass ? '  ✓' : '  ✕'} ${check.label}`);
    console.log(`      ${check.detail}`);
    if (!check.pass) failures += 1;
  }
  console.log('');

  const configChecks = runConfigChecks(config);
  console.log('▶ 配置校验与保留');
  for (const check of configChecks.checks) {
    console.log(`${check.pass ? '  ✓' : '  ✕'} ${check.label}`);
    console.log(`      ${check.detail}`);
    if (!check.pass) failures += 1;
  }
  console.log('');

  console.log('══════════════════════════════════════════════════════════');
  console.log(failures === 0 ? '全部断言通过' : `${failures} 项断言失败`);
  console.log('══════════════════════════════════════════════════════════');
  return failures === 0 ? 0 : 1;
}

process.exitCode = main();
