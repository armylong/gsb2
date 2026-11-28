/**
 * 命令行验证器：读取 operations/*.ops.txt，逐步执行并打印核对结果。
 * 用法：npm run verify        全部操作串
 *      npm run verify -- heart  只跑文件名包含 heart 的操作串
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LEVELS, getLevel } from '../src/data/levels';
import { parseScript } from '../src/core/script-format';
import { runScript } from '../src/core/script';

const dir = join(process.cwd(), 'operations');
const filter = process.argv[2] ?? '';
const files = readdirSync(dir)
  .filter((file) => file.endsWith('.ops.txt') && file.includes(filter))
  .sort();

const palette = (ok: boolean) => (ok ? '\u001b[32m✓\u001b[0m' : '\u001b[31m✗\u001b[0m');
const dim = (text: string) => `\u001b[2m${text}\u001b[0m`;
const bold = (text: string) => `\u001b[1m${text}\u001b[0m`;

if (files.length === 0) {
  console.error(`没有找到匹配的操作串（operations/*${filter}*.ops.txt）`);
  process.exit(1);
}

let failures = 0;
for (const file of files) {
  const source = readFileSync(join(dir, file), 'utf8');
  let script;
  try {
    script = parseScript(source);
  } catch (error) {
    failures += 1;
    console.error(`${palette(false)} ${file} 无法解析：${(error as Error).message}`);
    continue;
  }
  const level = getLevel(script.levelId);
  const run = runScript(level, script);
  console.log(`\n${bold(script.name)}  ${dim(file)}`);
  console.log(dim(`关卡 ${level.name}（${level.id}） · ${script.steps.length} 步`));
  for (const step of run.steps) {
    const failed = step.checks.filter((check) => !check.pass);
    const summary = step.action?.kind === 'stamp' && step.action.cost >= 0
      ? step.label.includes('撤回')
        ? `返还 ${step.action.cost}`
        : `消耗 ${step.action.cost}`
      : step.action?.kind === 'mask'
        ? step.action.wasMasked ? '收回挡墨纸' : '贴挡墨纸'
        : '';
    console.log(`  ${palette(step.passed)} ${String(step.index + 1).padStart(2, ' ')}. ${step.label}${summary ? dim(` · ${summary}`) : ''}`);
    for (const check of failed) console.log(`      ${palette(false)} ${check.label}：${check.detail}`);
  }
  const final = run.checks;
  for (const check of final) {
    console.log(`  ${palette(check.pass)} ${check.label}：${dim(check.detail)}`);
  }
  console.log(`  ${run.passed ? bold('\u001b[32m通过\u001b[0m') : bold('\u001b[31m未通过\u001b[0m')}`);
  if (!run.passed) failures += 1;
}

for (const level of LEVELS) {
  if (!files.some((file) => {
    try {
      return parseScript(readFileSync(join(dir, file), 'utf8')).levelId === level.id;
    } catch {
      return false;
    }
  })) {
    console.warn(`${palette(false)} 关卡「${level.name}」缺少操作串`);
    failures += 1;
  }
}
if (failures > 0) {
  console.error(`\n${failures} 份操作串未通过。`);
  process.exit(1);
}
console.log('\n全部操作串通过。');
