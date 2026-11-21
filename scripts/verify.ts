/**
 * 命令行验证入口：npm run verify
 * 以解析解对比截面面积/周长，并检查退化情形与破面检测。
 */
import { runAllVerifications } from "../src/verify";

const report = runAllVerifications();

const header = ["用例", "指标", "计算值", "期望值", "容差", "结果"];
const lines: string[] = [];
for (const row of report.rows) {
  const fmt = (x: number) => (Math.abs(x) >= 1e4 || (x !== 0 && Math.abs(x) < 1e-3) ? x.toExponential(4) : x.toFixed(6));
  lines.push(
    [
      row.caseName.padEnd(22),
      row.metric.padEnd(20),
      fmt(row.actual).padStart(12),
      fmt(row.expected).padStart(12),
      row.tolerance === 0 ? "      -     " : row.tolerance.toExponential(1).padStart(12),
      row.pass ? "PASS" : "FAIL",
    ].join("  ")
  );
}

console.log(header.join("  "));
console.log("-".repeat(92));
console.log(lines.join("\n"));
if (report.rows.some((r) => !r.pass)) {
  const failed = report.rows.filter((r) => !r.pass);
  console.log(`\n${report.passCount}/${report.total} 通过，失败 ${failed.length} 项：`);
  for (const f of failed) console.log(`  - [${f.caseName}] ${f.metric}: 实际 ${f.actual}，期望 ${f.expected}（容差 ${f.tolerance}）`);
  process.exit(1);
}
console.log(`\n全部 ${report.total} 项验证通过 ✔`);
