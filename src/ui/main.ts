// Canvas 界面: 键盘录入 / 逐步快进回跳 / 历史分叉 / 导出导入

import { Recorder } from "../core/tape.ts";
import { exportTape, importTape } from "../core/serialize.ts";
import { buildRegressionSamples } from "../core/samples.ts";
import {
  WIDTH,
  HEIGHT,
  WALL_X,
  DOOR,
  SWITCH,
  RULE_VERSION,
  hashState,
  type Input,
  type SimState,
} from "../core/sim.ts";

const CELL = 60;
const cv = document.getElementById("cv") as HTMLCanvasElement;
const ctx = cv.getContext("2d")!;
const statusEl = document.getElementById("status")!;
const logEl = document.getElementById("log")!;
const seekEl = document.getElementById("seek") as HTMLInputElement;
const branchSel = document.getElementById("branchSel") as HTMLSelectElement;
const playBtn = document.getElementById("playBtn") as HTMLButtonElement;

let rec = buildRegressionSamples(); // 预置左右两条回归分支
let playing = false;
let timer: number | undefined;

function log(msg: string): void {
  logEl.textContent = `[${new Date().toLocaleTimeString()}] ${msg}\n` + logEl.textContent;
}

function draw(state: SimState): void {
  ctx.clearRect(0, 0, cv.width, cv.height);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const px = x * CELL;
      const py = y * CELL;
      const isDoorCell = x === DOOR.x && y === DOOR.y;
      const wall = x === WALL_X && !isDoorCell;
      ctx.fillStyle = wall ? "#444" : (x + y) % 2 === 0 ? "#eef1f4" : "#e2e7ec";
      ctx.fillRect(px, py, CELL, CELL);
      ctx.strokeStyle = "#c8cfd6";
      ctx.strokeRect(px, py, CELL, CELL);
      if (isDoorCell) {
        ctx.fillStyle = state.doorOpen ? "#7bd88a" : "#d86a6a";
        ctx.fillRect(px + 4, py + 4, CELL - 8, CELL - 8);
        ctx.fillStyle = "#222";
        ctx.font = "12px sans-serif";
        ctx.fillText(state.doorOpen ? "门·开" : "门·关", px + 10, py + CELL / 2 + 4);
      }
    }
  }
  // 开关
  ctx.beginPath();
  ctx.arc(SWITCH.x * CELL + CELL / 2, SWITCH.y * CELL + CELL / 2, 14, 0, Math.PI * 2);
  ctx.fillStyle = state.switchOn ? "#f5c542" : "#fff3d0";
  ctx.fill();
  ctx.strokeStyle = "#b58a1e";
  ctx.stroke();
  // 箱子
  ctx.fillStyle = "#a06a2c";
  ctx.fillRect(state.box.x * CELL + 8, state.box.y * CELL + 8, CELL - 16, CELL - 16);
  ctx.strokeStyle = "#6e4718";
  ctx.strokeRect(state.box.x * CELL + 8, state.box.y * CELL + 8, CELL - 16, CELL - 16);
  // 玩家
  ctx.beginPath();
  ctx.arc(state.player.x * CELL + CELL / 2, state.player.y * CELL + CELL / 2, 18, 0, Math.PI * 2);
  ctx.fillStyle = "#3b7dd8";
  ctx.fill();
}

function refreshBranchSelect(): void {
  branchSel.innerHTML = "";
  for (const b of rec.branches.values()) {
    const opt = document.createElement("option");
    opt.value = b.id;
    opt.textContent = `${b.name} (${b.inputs.length} 步${b.parentId ? `, 派生自 ${rec.branches.get(b.parentId)?.name}@${b.forkStep}` : ""})`;
    branchSel.appendChild(opt);
  }
  branchSel.value = rec.currentId;
}

function syncUI(): void {
  const b = rec.current;
  const s = b.states[b.cursor];
  draw(s);
  seekEl.max = String(b.inputs.length);
  seekEl.value = String(b.cursor);
  branchSel.value = rec.currentId;
  statusEl.innerHTML =
    `规则版本 <b>${RULE_VERSION}</b> · 分支 <b>${b.name}</b> · 第 <b>${b.cursor}</b> / ${b.inputs.length} 步` +
    ` · 指纹 <code>${hashState(s)}</code><br>` +
    `箱子 (${s.box.x},${s.box.y}) · 开关 ${s.switchOn ? "压住" : "松开"} · 门 ${s.doorOpen ? "开" : "关"}` +
    (b.cursor < b.inputs.length ? "<br><em>正在查看历史: 此时录入将截断当前分支的未来, 或先「新建分支」</em>" : "");
}

function record(input: Input): void {
  const wasMid = rec.current.cursor < rec.head;
  rec.append(input);
  if (wasMid) log("在历史中间录入, 当前分支的未来已截断");
  syncUI();
}

function stopPlay(): void {
  playing = false;
  playBtn.textContent = "▶ 播放";
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

// ---- 控件绑定 ----

document.getElementById("backBtn")!.addEventListener("click", () => {
  rec.seek(rec.current.cursor - 1);
  syncUI();
});
document.getElementById("fwdBtn")!.addEventListener("click", () => {
  rec.seek(rec.current.cursor + 1);
  syncUI();
});
playBtn.addEventListener("click", () => {
  if (playing) {
    stopPlay();
    return;
  }
  playing = true;
  playBtn.textContent = "⏸ 暂停";
  timer = window.setInterval(() => {
    if (rec.current.cursor >= rec.head) {
      stopPlay();
      return;
    }
    rec.seek(rec.current.cursor + 1);
    syncUI();
  }, 150);
});
seekEl.addEventListener("input", () => {
  rec.seek(Number(seekEl.value));
  syncUI();
});
branchSel.addEventListener("change", () => {
  stopPlay();
  rec.switchTo(branchSel.value);
  log(`切换到分支 ${rec.current.name}`);
  syncUI();
});
document.getElementById("forkBtn")!.addEventListener("click", () => {
  const name = window.prompt("新分支名称", `branch@${rec.current.cursor}`);
  if (!name) return;
  const nb = rec.fork(name);
  refreshBranchSelect();
  log(`在 ${nb.parentId ? "父分支" : ""} 第 ${nb.forkStep} 步新建分支「${nb.name}」, 原分支未受影响`);
  syncUI();
});
document.getElementById("exportBtn")!.addEventListener("click", () => {
  const blob = new Blob([exportTape(rec)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sandbox-tape.json";
  a.click();
  URL.revokeObjectURL(a.href);
  log("已导出录像 JSON");
});
(document.getElementById("importFile") as HTMLInputElement).addEventListener("change", async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const result = importTape(await file.text());
  if (result.ok) {
    stopPlay();
    rec = result.recorder;
    refreshBranchSelect();
    log(`导入成功: ${rec.branches.size} 条分支, 校验全部通过`);
  } else {
    const d = result.divergence;
    log(
      "导入被拒绝:\n" +
        result.errors.map((x) => "  · " + x).join("\n") +
        (d ? `\n  首个分歧: 分支「${d.branchName}」第 ${d.step} 步 (记录 ${d.expected} / 重放 ${d.actual})` : ""),
    );
  }
  (e.target as HTMLInputElement).value = "";
  syncUI();
});
document.getElementById("resetBtn")!.addEventListener("click", () => {
  stopPlay();
  rec = buildRegressionSamples();
  refreshBranchSelect();
  log("已重置为内置回归样例 (main + 左右分支)");
  syncUI();
});

const KEYMAP: Record<string, Input> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
  " ": "wait",
};
window.addEventListener("keydown", (e) => {
  const input = KEYMAP[e.key];
  if (!input || (e.target as HTMLElement).tagName === "SELECT") return;
  e.preventDefault();
  stopPlay();
  record(input);
});

refreshBranchSelect();
syncUI();
log(`就绪: 预置回归样例 (main 4 步后分出左右两支), 规则版本 ${RULE_VERSION}`);
