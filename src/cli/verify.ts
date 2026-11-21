// 一条命令的验证入口:  node src/cli/verify.ts   (Node >= 23.6, 无需构建)
// 覆盖: 确定性回放 / 导出导入往返 / 规则版本校验 / 快照完整性 / 分歧定位 / 左右分支回归比较

import { initialState, step, hashState, RULE_VERSION, type SimState } from "../core/sim.ts";
import { exportTape, importTape, computeChecksum, type TapeFile } from "../core/serialize.ts";
import {
  buildRegressionSamples,
  compareFinalStates,
  LEFT_BRANCH,
  RIGHT_BRANCH,
} from "../core/samples.ts";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  —  " + detail : ""}`);
  if (!cond) failures++;
}

function finalState(rec: ReturnType<typeof buildRegressionSamples>, name: string): SimState {
  const b = [...rec.branches.values()].find((x) => x.name === name)!;
  return b.states[b.states.length - 1];
}

console.log(`== 规则沙盒录像验证 (规则版本 ${RULE_VERSION}) ==\n`);

// ---- 1. 确定性: 同一输入序列, 在同一步状态一致 ----
console.log("-- 1. 确定性回放 --");
const rec1 = buildRegressionSamples();
const rec2 = buildRegressionSamples();
check("两次生成的录像导出完全一致", exportTape(rec1) === exportTape(rec2));

let replayOk = true;
for (const b of rec1.branches.values()) {
  let s = initialState();
  if (hashState(s) !== b.hashes[0]) replayOk = false;
  for (let i = 0; i < b.inputs.length; i++) {
    s = step(s, b.inputs[i]);
    if (hashState(s) !== b.hashes[i + 1]) {
      replayOk = false;
      console.log(`   分歧: 分支 ${b.name} 第 ${i + 1} 步`);
    }
  }
}
check("每条分支逐步重放, 每步指纹与记录一致", replayOk);

// ---- 2. 分支互不影响 ----
console.log("\n-- 2. 分支隔离 --");
const left = [...rec1.branches.values()].find((b) => b.name === LEFT_BRANCH)!;
const right = [...rec1.branches.values()].find((b) => b.name === RIGHT_BRANCH)!;
check(
  "左右分支共享分叉点前缀, 之后各自独立",
  left.inputs.slice(0, 4).join() === right.inputs.slice(0, 4).join() &&
    left.inputs.length !== right.inputs.length,
  `left ${left.inputs.length} 步 / right ${right.inputs.length} 步`,
);
check(
  "原分支 main 在分叉后未被改动",
  [...rec1.branches.values()].find((b) => b.name === "main")!.inputs.length === 4,
);

// ---- 3. 导出 -> 导入往返 ----
console.log("\n-- 3. 导出/导入往返 --");
const json = exportTape(rec1);
const imported = importTape(json);
check("合法数据导入成功", imported.ok);
if (imported.ok) check("导入后再导出与原文一致", exportTape(imported.recorder) === json);

// ---- 4. 规则版本校验 ----
console.log("\n-- 4. 规则版本校验 --");
const wrongVersion = JSON.parse(json) as TapeFile;
wrongVersion.ruleVersion = "0.9.0";
const r1 = importTape(JSON.stringify(wrongVersion));
check(
  "规则版本不匹配被拒绝",
  !r1.ok && r1.errors.some((e) => e.includes("规则版本不匹配")),
  r1.ok ? "" : r1.errors[0],
);

// ---- 5. 快照完整性 ----
console.log("\n-- 5. 快照完整性 --");
const truncated = JSON.parse(json) as TapeFile;
truncated.branches[1].hashes.pop(); // 撕掉一个快照
truncated.checksum = computeChecksum(truncated.branches); // 即使重封也过不了结构校验
const r2 = importTape(JSON.stringify(truncated));
check(
  "快照数量缺失被检出",
  !r2.ok && r2.errors.some((e) => e.includes("快照数量")),
  r2.ok ? "" : r2.errors[0],
);
const tamperedChecksum = JSON.parse(json) as TapeFile;
tamperedChecksum.branches[1].name = "改名";
const r3 = importTape(JSON.stringify(tamperedChecksum));
check(
  "内容被篡改(校验和不符)被检出",
  !r3.ok && r3.errors.some((e) => e.includes("校验和")),
  r3.ok ? "" : r3.errors[0],
);

// ---- 6. 分歧定位: 指出首个发生分歧的步骤 ----
console.log("\n-- 6. 分歧定位 --");
const tampered = JSON.parse(json) as TapeFile;
const target = tampered.branches.find((b) => b.name === RIGHT_BRANCH)!;
target.hashes[3] = "deadbeef"; // 篡改 right 分支第 3 步的指纹
tampered.checksum = computeChecksum(tampered.branches);
const r4 = importTape(JSON.stringify(tampered));
check(
  "首个分歧步骤被正确定位",
  !r4.ok && r4.divergence?.step === 3 && r4.divergence.branchName === RIGHT_BRANCH,
  r4.ok ? "" : `分支=${r4.divergence?.branchName} 步骤=${r4.divergence?.step} 记录=${r4.divergence?.expected} 重放=${r4.divergence?.actual}`,
);

// ---- 7. 左右分支回归比较 ----
console.log("\n-- 7. 左右分支回归样例比较 --");
const ls = finalState(rec1, LEFT_BRANCH);
const rs = finalState(rec1, RIGHT_BRANCH);
console.log("   项目       | 左分支(推离开关) | 右分支(穿门而过)");
console.log("   -----------+------------------+----------------");
for (const row of compareFinalStates(ls, rs)) {
  console.log(
    `   ${row.item.padEnd(10)} | ${row.left.padEnd(16)} | ${row.right.padEnd(16)} ${row.same ? "" : "<-- 不同"}`,
  );
}
check(
  "左分支: 箱子离开开关、开关松开、门关闭",
  ls.box.x === 7 && ls.box.y === 4 && !ls.switchOn && !ls.doorOpen,
);
check(
  "右分支: 箱子压住开关、门开、玩家穿门到达墙另一侧",
  rs.box.x === 6 && rs.box.y === 4 && rs.switchOn && rs.doorOpen && rs.player.x === 9,
);

console.log(
  failures === 0 ? "\n全部通过 ✔" : `\n${failures} 项失败 ✘`,
);
process.exitCode = failures === 0 ? 0 : 1;
