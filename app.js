"use strict";
(() => {
  // src/engine.ts
  var OUTCOME_TEXT = {
    [-1]: "右盘更重",
    0: "天平平衡",
    [1]: "左盘更重"
  };
  function sumOf(weights, ids) {
    let s = 0;
    for (const i of ids) s += weights[i];
    return s;
  }
  function outcomeOf(weights, w) {
    const d = sumOf(weights, w.left) - sumOf(weights, w.right);
    return d === 0 ? 0 : d > 0 ? 1 : -1;
  }
  function enumerateAssignments(count, candidates) {
    const c = [...new Set(candidates)].sort((a, b) => a - b);
    const out = [];
    const cur = new Array(count).fill(c[0] ?? 0);
    const walk = (pos) => {
      if (pos === count) {
        out.push(cur.slice());
        return;
      }
      for (const value of c) {
        cur[pos] = value;
        walk(pos + 1);
      }
    };
    walk(0);
    return out;
  }
  function matchesWeighing(assignment, record) {
    return outcomeOf(assignment, record) === record.outcome;
  }
  function survivingAssignments(count, candidates, records) {
    return enumerateAssignments(count, candidates).filter(
      (a) => records.every((r) => matchesWeighing(a, r))
    );
  }
  function possibilitiesByPackage(count, candidates, survivors) {
    const c = [...new Set(candidates)].sort((a, b) => a - b);
    return Array.from({ length: count }, (_, p) => {
      const supportCount = /* @__PURE__ */ new Map();
      for (const w of c) supportCount.set(w, 0);
      for (const a of survivors) {
        const w = a[p];
        supportCount.set(w, (supportCount.get(w) ?? 0) + 1);
      }
      const possible = c.filter((w) => (supportCount.get(w) ?? 0) > 0);
      return { packageId: p, possible, supportCount };
    });
  }
  function evaluatePartition(survivors, left, right) {
    if (survivors.length === 0) return { kind: "no-possibility" };
    let counterexample;
    let counterSums;
    let equalExample;
    let equalSums;
    let allEqual = true;
    for (const a of survivors) {
      const ls = sumOf(a, left);
      const rs = sumOf(a, right);
      if (ls === rs) {
        if (!equalExample) {
          equalExample = a.slice();
          equalSums = { left: ls, right: rs };
        }
      } else {
        allEqual = false;
        if (!counterexample) {
          counterexample = a.slice();
          counterSums = { left: ls, right: rs };
        }
      }
    }
    if (allEqual && equalExample && equalSums) {
      const sumSet = /* @__PURE__ */ new Set();
      for (const a of survivors) sumSet.add(sumOf(a, left));
      return {
        kind: "necessary-equal",
        survivorCount: survivors.length,
        possibleEqualSums: [...sumSet].sort((x, y) => x - y)
      };
    }
    if (equalExample && equalSums && counterexample && counterSums) {
      return {
        kind: "contingent-equal",
        survivorCount: survivors.length,
        equalExample,
        equalSums,
        counterexample,
        counterSums
      };
    }
    return {
      kind: "never-equal",
      survivorCount: survivors.length,
      counterexample,
      counterSums
    };
  }

  // src/levels.ts
  var LEVELS = [
    {
      id: "first-balance",
      name: "初平之秤",
      tag: "入门",
      highlight: "入门",
      brief: "三只外形完全相同的编号包裹，重量只可能是 1、2、3 千克（允许同重）。把它们分成两个总重相同的货架。先用天平试几次，再提交分组。",
      packageCount: 3,
      candidates: [1, 2, 3],
      trueWeights: [1, 2, 3],
      maxWeighings: 4,
      intendedPartition: { left: [2], right: [0, 1] },
      scriptedWeighings: [
        { left: [0], right: [1], outcome: -1 },
        { left: [1], right: [2], outcome: -1 }
      ],
      hints: [
        "先单称 ① 对 ②，再单称 ② 对 ③：如果两次都是一边轻，而候选只有 1、2、3，三只包裹的重量就被顺序锁死了。",
        "重量确定后，最重的 ③ 单独一架，① 和 ② 合放另一架。",
        "也可以直接把你打算提交的分组摆上天平称一次：若平衡，这条记录本身就保证了它必然等重。"
      ],
      designNote: "两次链式单称即可在三个候选中唯一排序，教学「记录会共同收缩可能性」。"
    },
    {
      id: "combined-proof",
      name: "连环不等式",
      tag: "组合称量",
      highlight: "组合称量",
      brief: "五只编号包裹，重量候选为 1、2、3 千克（允许同重）。线索藏在两次「组合对组合」的称量里——任何一次单独的结果都不足以证明答案，必须把两条记录合在一起推理。你有 3 次确认机会。",
      packageCount: 5,
      candidates: [1, 2, 3],
      trueWeights: [1, 1, 1, 2, 3],
      maxWeighings: 3,
      intendedPartition: { left: [0, 1, 3], right: [2, 4] },
      scriptedWeighings: [
        // ②+④ (1+2=3) > ①+③ (1+1=2)
        { left: [1, 3], right: [0, 2], outcome: 1 },
        // ③+⑤ (1+3=4) > ②+④ (1+2=3)
        { left: [2, 4], right: [1, 3], outcome: 1 }
      ],
      hints: [
        "第一次：把 ②、④ 放左盘，①、③ 放右盘。记住哪边重。",
        "第二次：把 ③、⑤ 放左盘，②、④ 放右盘。",
        "在「可能性」面板查看：两条记录同时成立的完整重量组合只剩 7 种，① 必为 1、⑤ 必为 3，其余仍有悬念——但分组 ①②④ 对 ③⑤ 在全部 7 种下都等重。"
      ],
      designNote: "两条严格不等式形成 ①+③ < ②+④ < ③+⑤ 的夹逼；联合后目标分组在全部 7 个剩余分配下必然等重，单条均不成立。"
    },
    {
      id: "two-shot-fog",
      name: "两称迷局",
      tag: "限次未定",
      highlight: "限次未定",
      brief: "四只编号包裹，重量候选为 1、2、3、4 千克（允许同重）。天平只给你 2 次确认机会——确认才消耗次数，摆来摆去不消耗。机会用尽时真相很可能仍未锁定；这时提交分组，系统会用反例告诉你它是否只是「碰巧」相等。",
      packageCount: 4,
      candidates: [1, 2, 3, 4],
      trueWeights: [1, 3, 2, 4],
      maxWeighings: 2,
      intendedPartition: { left: [1, 2], right: [0, 3] },
      scriptedWeighings: [
        { left: [0], right: [1], outcome: -1 },
        { left: [2], right: [3], outcome: -1 }
      ],
      hints: [
        "试试最自然的两次单称：① 对 ②，③ 对 ④。两次都会看到左轻。",
        "两次确认后次数耗尽，仍有 36 种完整重量组合同时成立——每个包裹都还有多个候选重量。",
        "此时提交 ②③ 对 ①④：真实重量下恰好都是 5，但系统会找出一个反例分配证明这并非必然。看完反例，点「重新开始」即可还原次数与记录再挑战。"
      ],
      designNote: "a<b 且 c<d 留下 36 个联合分配；真实等重划分 ②③|①④ 仅为 contingent-equal，必然收到反例。专门展示「用光次数仍不确定」与重开还原。"
    }
  ];

  // src/game.ts
  function createInitialState(levelIndex, resetCount = 0) {
    const level = LEVELS[levelIndex] ?? LEVELS[0];
    return {
      levelIndex: LEVELS[levelIndex] ? levelIndex : 0,
      records: [],
      tray: new Array(level.packageCount).fill(null),
      shelf: new Array(level.packageCount).fill(null),
      viewing: "draft",
      verdict: null,
      verdictSignature: null,
      won: false,
      resetCount
    };
  }
  var GameStore = class {
    constructor(levelIndex = 0) {
      this.listeners = /* @__PURE__ */ new Set();
      this.state = createInitialState(levelIndex);
    }
    get level() {
      return LEVELS[this.state.levelIndex];
    }
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    }
    emit() {
      for (const fn of this.listeners) fn(this.state);
    }
    /* ---------------- 关卡 / 重开 ---------------- */
    selectLevel(index) {
      if (index < 0 || index >= LEVELS.length || index === this.state.levelIndex) {
        return;
      }
      this.state = createInitialState(index);
      this.emit();
    }
    /** 重新开始：尝试次数（由 records 推导）与全部记录、摆法、分组、判定都还原。 */
    restart() {
      this.state = createInitialState(this.state.levelIndex, this.state.resetCount + 1);
      this.emit();
    }
    /* ---------------- 天平摆法（不消耗次数） ---------------- */
    /** 循环：未上秤 → 左盘 → 右盘 → 未上秤 */
    cycleTray(pkg) {
      if (this.state.won) return;
      const cur = this.state.tray[pkg];
      this.state.tray[pkg] = cur === null ? "left" : cur === "left" ? "right" : null;
      this.state.viewing = "draft";
      this.emit();
    }
    setTray(pkg, slot) {
      if (this.state.won) return;
      this.state.tray[pkg] = slot;
      this.state.viewing = "draft";
      this.emit();
    }
    clearTray() {
      if (this.state.won) return;
      this.state.tray.fill(null);
      this.state.viewing = "draft";
      this.emit();
    }
    draftSides() {
      const left = [];
      const right = [];
      this.state.tray.forEach((slot, i) => {
        if (slot === "left") left.push(i);
        else if (slot === "right") right.push(i);
      });
      return { left, right };
    }
    attemptsLeft() {
      return this.level.maxWeighings - this.state.records.length;
    }
    canConfirm() {
      if (this.state.won) return { ok: false, reason: "本局已通关，可重开或进入下一关" };
      if (this.attemptsLeft() <= 0) return { ok: false, reason: "称量次数已用完，请提交分组或重新开始" };
      const { left, right } = this.draftSides();
      if (left.length === 0 || right.length === 0) {
        return { ok: false, reason: "天平两盘都至少要放一个包裹" };
      }
      return { ok: true };
    }
    /** 确认称量：只有这里新增记录并消耗一次机会。结果由真实重量公正计算。 */
    confirmWeighing() {
      const check = this.canConfirm();
      if (!check.ok) return null;
      const { left, right } = this.draftSides();
      const record = {
        left: [...left].sort((a, b) => a - b),
        right: [...right].sort((a, b) => a - b),
        outcome: outcomeOf(this.level.trueWeights, { left, right })
      };
      this.state.records = [...this.state.records, record];
      this.state.viewing = this.state.records.length - 1;
      this.state.verdict = null;
      this.state.verdictSignature = null;
      this.emit();
      return record;
    }
    viewRecord(index) {
      this.state.viewing = index;
      this.emit();
    }
    /* ---------------- 可能性推导 ---------------- */
    survivors() {
      return survivingAssignments(
        this.level.packageCount,
        this.level.candidates,
        this.state.records
      );
    }
    possibilities() {
      return possibilitiesByPackage(
        this.level.packageCount,
        this.level.candidates,
        this.survivors()
      );
    }
    /* ---------------- 货架分组与提交 ---------------- */
    cycleShelf(pkg) {
      if (this.state.won) return;
      const cur = this.state.shelf[pkg];
      this.state.shelf[pkg] = cur === null ? "A" : cur === "A" ? "B" : null;
      this.state.verdict = null;
      this.state.verdictSignature = null;
      this.emit();
    }
    setShelf(pkg, slot) {
      if (this.state.won) return;
      this.state.shelf[pkg] = slot;
      this.state.verdict = null;
      this.state.verdictSignature = null;
      this.emit();
    }
    shelfSides() {
      const A = [];
      const B = [];
      this.state.shelf.forEach((slot, i) => {
        if (slot === "A") A.push(i);
        else if (slot === "B") B.push(i);
      });
      return { A, B };
    }
    shelfComplete() {
      return this.state.shelf.every((s) => s !== null);
    }
    shelfSignature() {
      return this.state.shelf.map((s) => s === "A" ? "L" : s === "B" ? "R" : "?").join("");
    }
    /** 提交分组：按全部剩余可能检验必然性。 */
    submitPartition() {
      if (!this.shelfComplete()) return null;
      const { A, B } = this.shelfSides();
      const verdict = evaluatePartition(this.survivors(), A, B);
      this.state.verdict = verdict;
      this.state.verdictSignature = this.shelfSignature();
      if (verdict.kind === "necessary-equal") this.state.won = true;
      this.emit();
      return verdict;
    }
  };

  // src/render.ts
  var VW = 760;
  var VH = 440;
  var PIVOT_X = 380;
  var PIVOT_Y = 168;
  var BEAM_HALF = 226;
  var PAN_DROP = 84;
  var ScaleRenderer = class {
    constructor(canvas2) {
      this.raf = 0;
      this.angle = 0;
      this.targetAngle = 0;
      this.view = { left: [], right: [], outcome: null };
      this.hits = [];
      this.cssW = VW;
      this.cssH = VH;
      this.dpr = 1;
      this.hoverPkg = null;
      this.onPackageClick = null;
      this.resizeObs = null;
      this.handleClick = (e) => {
        const { x, y } = this.toLogical(e);
        for (let i = this.hits.length - 1; i >= 0; i--) {
          const h = this.hits[i];
          if (Math.abs(x - h.x) <= h.size / 2 + 4 && Math.abs(y - h.y) <= h.size / 2 + 4) {
            this.onPackageClick?.(h.pkg);
            return;
          }
        }
      };
      this.handleMove = (e) => {
        const { x, y } = this.toLogical(e);
        let hover = null;
        for (let i = this.hits.length - 1; i >= 0; i--) {
          const h = this.hits[i];
          if (Math.abs(x - h.x) <= h.size / 2 + 4 && Math.abs(y - h.y) <= h.size / 2 + 4) {
            hover = h.pkg;
            break;
          }
        }
        this.hoverPkg = hover;
        this.canvas.style.cursor = hover !== null ? "pointer" : "default";
      };
      this.handleLeave = () => {
        this.hoverPkg = null;
      };
      this.canvas = canvas2;
      const ctx = canvas2.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D context unavailable");
      this.ctx = ctx;
      this.resize();
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(canvas2);
      canvas2.addEventListener("click", this.handleClick);
      canvas2.addEventListener("pointermove", this.handleMove);
      canvas2.addEventListener("pointerleave", this.handleLeave);
      const loop = () => {
        this.angle += (this.targetAngle - this.angle) * 0.16;
        if (Math.abs(this.targetAngle - this.angle) < 4e-4) this.angle = this.targetAngle;
        this.draw();
        this.raf = requestAnimationFrame(loop);
      };
      this.raf = requestAnimationFrame(loop);
    }
    destroy() {
      cancelAnimationFrame(this.raf);
      this.resizeObs?.disconnect();
      this.canvas.removeEventListener("click", this.handleClick);
      this.canvas.removeEventListener("pointermove", this.handleMove);
      this.canvas.removeEventListener("pointerleave", this.handleLeave);
    }
    setView(view, animate = true) {
      this.view = view;
      const maxTilt = 0.17;
      this.targetAngle = view.outcome === null ? 0 : view.outcome === 1 ? -maxTilt : view.outcome === -1 ? maxTilt : 0;
      if (!animate) this.angle = this.targetAngle;
    }
    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.cssW = Math.max(280, rect.width || VW);
      this.cssH = Math.max(300, rect.height || VH);
      this.dpr = Math.min(2.5, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.cssW * this.dpr);
      this.canvas.height = Math.round(this.cssH * this.dpr);
    }
    toLogical(e) {
      const rect = this.canvas.getBoundingClientRect();
      const scale = Math.min(this.cssW / VW, this.cssH / VH);
      const ox = (this.cssW - VW * scale) / 2;
      const oy = (this.cssH - VH * scale) / 2;
      const x = (e.clientX - rect.left - ox) / scale;
      const y = (e.clientY - rect.top - oy) / scale;
      return { x, y };
    }
    /* ---------------- 绘制 ---------------- */
    draw() {
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.cssW, this.cssH);
      const scale = Math.min(this.cssW / VW, this.cssH / VH);
      const ox = (this.cssW - VW * scale) / 2;
      const oy = (this.cssH - VH * scale) / 2;
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      this.hits = [];
      this.drawGround();
      this.drawPost();
      this.drawBeamAndPans();
    }
    drawGround() {
      const ctx = this.ctx;
      ctx.save();
      ctx.fillStyle = "rgba(60, 44, 28, 0.10)";
      ctx.beginPath();
      ctx.ellipse(PIVOT_X, 418, 190, 20, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createLinearGradient(0, 392, 0, 420);
      g.addColorStop(0, "#8a6238");
      g.addColorStop(1, "#5f4124");
      ctx.fillStyle = g;
      this.roundRect(PIVOT_X - 118, 392, 236, 22, 11);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      this.roundRect(PIVOT_X - 104, 395, 208, 6, 3);
      ctx.fill();
      ctx.restore();
    }
    drawPost() {
      const ctx = this.ctx;
      const g = ctx.createLinearGradient(PIVOT_X - 9, 0, PIVOT_X + 9, 0);
      g.addColorStop(0, "#5f4124");
      g.addColorStop(0.5, "#9a7042");
      g.addColorStop(1, "#5f4124");
      ctx.fillStyle = g;
      this.roundRect(PIVOT_X - 9, PIVOT_Y + 6, 18, 392 - PIVOT_Y, 8);
      ctx.fill();
      ctx.fillStyle = "#c9973f";
      ctx.strokeStyle = "#8a6420";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PIVOT_X - 20, PIVOT_Y + 14);
      ctx.lineTo(PIVOT_X + 20, PIVOT_Y + 14);
      ctx.lineTo(PIVOT_X, PIVOT_Y - 8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#7a551c";
      ctx.beginPath();
      ctx.arc(PIVOT_X, PIVOT_Y + 4, 5, 0, Math.PI * 2);
      ctx.fill();
    }
    beamEndpoints() {
      const cos = Math.cos(this.angle);
      const sin = Math.sin(this.angle);
      return {
        lx: PIVOT_X - BEAM_HALF * cos,
        ly: PIVOT_Y - BEAM_HALF * sin,
        rx: PIVOT_X + BEAM_HALF * cos,
        ry: PIVOT_Y + BEAM_HALF * sin
      };
    }
    drawBeamAndPans() {
      const e = this.beamEndpoints();
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(PIVOT_X, PIVOT_Y);
      ctx.rotate(this.angle);
      const bg = ctx.createLinearGradient(0, -8, 0, 8);
      bg.addColorStop(0, "#a9794a");
      bg.addColorStop(0.5, "#7c5530");
      bg.addColorStop(1, "#5d3f22");
      ctx.fillStyle = bg;
      this.roundRect(-BEAM_HALF - 14, -7, BEAM_HALF * 2 + 28, 14, 7);
      ctx.fill();
      ctx.fillStyle = "#e3b45f";
      ctx.strokeStyle = "#8a6420";
      ctx.lineWidth = 2;
      for (const x of [-BEAM_HALF, BEAM_HALF]) {
        ctx.beginPath();
        ctx.arc(x, 0, 7, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
      this.drawPan(e.lx, e.ly, this.view.left, "left");
      this.drawPan(e.rx, e.ry, this.view.right, "right");
    }
    drawPan(endX, endY, pkgs, _which) {
      const ctx = this.ctx;
      const panY = endY + PAN_DROP;
      const rx = 90;
      const ry = 17;
      ctx.strokeStyle = "rgba(74, 55, 33, 0.75)";
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(endX, endY + 4);
      ctx.lineTo(endX - rx + 14, panY - 4);
      ctx.moveTo(endX, endY + 4);
      ctx.lineTo(endX + rx - 14, panY - 4);
      ctx.stroke();
      ctx.fillStyle = "rgba(60, 44, 28, 0.12)";
      ctx.beginPath();
      ctx.ellipse(endX, panY + 16, rx * 0.92, 10, 0, 0, Math.PI * 2);
      ctx.fill();
      const g = ctx.createLinearGradient(0, panY - ry, 0, panY + ry + 14);
      g.addColorStop(0, "#f0cd86");
      g.addColorStop(0.55, "#d39e4c");
      g.addColorStop(1, "#a9762c");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(endX, panY + 4, rx, ry + 6, 0, 0, Math.PI);
      ctx.moveTo(endX - rx, panY);
      ctx.quadraticCurveTo(endX, panY + 34, endX + rx, panY);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = "#8a6420";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = "#e8bd6b";
      ctx.beginPath();
      ctx.ellipse(endX, panY, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#8a6420";
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath();
      ctx.ellipse(endX - rx * 0.25, panY - 5, rx * 0.45, ry * 0.42, 0, 0, Math.PI * 2);
      ctx.fill();
      this.layoutPackagesOnPan(endX, panY, pkgs);
    }
    layoutPackagesOnPan(cx, panY, pkgs) {
      if (pkgs.length === 0) return;
      const baseSize = 50;
      const gap = 8;
      const maxRowWidth = 176;
      const size = Math.max(24, Math.min(baseSize, (maxRowWidth - (pkgs.length - 1) * gap) / pkgs.length));
      const rowW = pkgs.length * size + (pkgs.length - 1) * gap;
      const y = panY - 12 - size / 2;
      pkgs.forEach((pkg, ci) => {
        const x = cx - rowW / 2 + size / 2 + ci * (size + gap);
        this.drawPackage(x, y, size, pkg);
        this.hits.push({ pkg, x, y, size });
      });
    }
    drawPackage(x, y, size, pkg) {
      const ctx = this.ctx;
      const hovered = this.hoverPkg === pkg;
      const lift = hovered ? -4 : 0;
      y += lift;
      ctx.save();
      ctx.fillStyle = "rgba(50, 35, 18, 0.18)";
      this.roundRect(x - size / 2 + 2, y + size / 2 - 4, size, size * 0.28, 6);
      ctx.fill();
      const r = size * 0.16;
      const g = ctx.createLinearGradient(x, y - size / 2, x, y + size / 2);
      g.addColorStop(0, hovered ? "#e8b574" : "#ddab6b");
      g.addColorStop(1, hovered ? "#c98d45" : "#bd8240");
      ctx.fillStyle = g;
      ctx.strokeStyle = "#8a5a24";
      ctx.lineWidth = 2;
      this.roundRect(x - size / 2, y - size / 2, size, size, r);
      ctx.fill();
      ctx.stroke();
      ctx.strokeStyle = "rgba(122, 80, 32, 0.55)";
      ctx.lineWidth = Math.max(2, size * 0.09);
      ctx.beginPath();
      ctx.moveTo(x, y - size / 2 + 2);
      ctx.lineTo(x, y + size / 2 - 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x - size / 2 + 2, y - size * 0.18);
      ctx.lineTo(x + size / 2 - 2, y - size * 0.18);
      ctx.stroke();
      const br = size * 0.3;
      ctx.fillStyle = "#fff7e8";
      ctx.strokeStyle = "#7c4f1c";
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.arc(x, y + size * 0.12, br, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#43301a";
      ctx.font = `700 ${Math.round(size * 0.4)}px "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(pkg + 1), x, y + size * 0.14);
      if (hovered) {
        ctx.fillStyle = "rgba(67, 48, 26, 0.75)";
        ctx.font = `600 ${Math.max(11, Math.round(size * 0.24))}px system-ui, sans-serif`;
        ctx.fillText("点击取下", x, y - size / 2 - 10);
      }
      ctx.restore();
    }
    roundRect(x, y, w, h, r) {
      const ctx = this.ctx;
      const rr = Math.min(r, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.arcTo(x + w, y, x + w, y + h, rr);
      ctx.arcTo(x + w, y + h, x, y + h, rr);
      ctx.arcTo(x, y + h, x, y, rr);
      ctx.arcTo(x, y, x + w, y, rr);
      ctx.closePath();
    }
  };

  // src/main.ts
  var store = new GameStore(0);
  var $ = (sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`缺少元素 ${sel}`);
    return el;
  };
  var esc = (s) => String(s).replace(
    /[&<>"']/g,
    (c) => c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;"
  );
  var outcomeClass = (o) => o === 1 ? "o1" : o === 0 ? "o0" : "o_1";
  var outcomeLabel = (o) => OUTCOME_TEXT[o];
  var canvas = $("#scaleCanvas");
  var renderer = new ScaleRenderer(canvas);
  renderer.onPackageClick = (pkg) => {
    if (store.state.viewing === "draft") store.setTray(pkg, null);
  };
  function currentScaleView() {
    const s = store.state;
    if (s.viewing === "draft" || typeof s.viewing !== "number") {
      const d = store.draftSides();
      return { left: d.left, right: d.right, outcome: null };
    }
    const rec = s.records[s.viewing];
    if (!rec) {
      const d = store.draftSides();
      return { left: d.left, right: d.right, outcome: null };
    }
    return { left: rec.left, right: rec.right, outcome: rec.outcome };
  }
  function renderLevelTabs() {
    const wrap = $("#levelTabs");
    wrap.innerHTML = LEVELS.map((lv2, i) => `
    <button class="level-tab ${i === store.state.levelIndex ? "active" : ""}"
      data-act="select-level" data-i="${i}" data-testid="level-tab-${i}">
      <span class="lt-name">${esc(lv2.name)}
        <span class="badge-tag ${i === 1 ? "tag-combo" : i === 2 ? "tag-tight" : ""}">${esc(lv2.tag)}</span>
      </span>
      <span class="lt-desc">${esc(lv2.highlight)} · ${lv2.packageCount} 个包裹 · ${lv2.maxWeighings} 次称量机会 · 候选 ${lv2.candidates.join("/")} kg</span>
    </button>`).join("");
    const lv = store.level;
    $("#levelName").textContent = lv.name;
    const tag = $("#levelTag");
    tag.textContent = lv.tag;
    tag.className = `badge-tag ${store.state.levelIndex === 1 ? "tag-combo" : store.state.levelIndex === 2 ? "tag-tight" : ""}`;
    $("#levelBrief").textContent = lv.brief;
    $("#hintList").innerHTML = lv.hints.map((h) => `<li>${esc(h)}</li>`).join("");
  }
  function renderHud() {
    const s = store.state;
    const left = store.attemptsLeft();
    const max = store.level.maxWeighings;
    const bar = $("#attemptsBar");
    bar.classList.toggle("exhausted", left === 0);
    bar.innerHTML = `
    <span>称量次数</span>
    <span class="pips" data-testid="attempt-pips">
      ${Array.from({ length: max }, (_, i) => `<span class="pip ${i < s.records.length ? "used" : ""}"></span>`).join("")}
    </span>
    <span class="attempt-num" data-testid="attempts-left">剩余 ${left} / ${max} 次</span>`;
    const cap = $("#scaleCaption");
    if (s.viewing === "draft") {
      cap.textContent = "正在摆放：当前摆法（未确认）";
    } else {
      cap.textContent = `翻查：第 ${s.viewing + 1} 次确认称量（共 ${s.records.length} 条记录）`;
    }
    const line = $("#outcomeLine");
    const view = currentScaleView();
    if (view.outcome === null) {
      line.innerHTML = `<span class="outcome-draft">未确认摆法不产生结果 · 两盘放好后点击「确认称量」</span>`;
    } else {
      line.innerHTML = `<span class="result-badge ${outcomeClass(view.outcome)}" style="font-size:15.5px;padding:5px 20px">
      ${view.outcome === 1 ? "← 左盘更重" : view.outcome === -1 ? "右盘更重 →" : "天平平衡"}
    </span>`;
    }
    const check = store.canConfirm();
    const btn = $("#confirmBtn");
    btn.disabled = !check.ok;
    btn.textContent = s.won ? "已通关" : left === 0 ? "称量次数已用完" : `确认称量 · 消耗 1 次 · 当前余 ${left} 次`;
    $("#confirmReason").textContent = check.ok ? "" : check.reason ?? "";
  }
  function renderTrayRows() {
    const n = store.level.packageCount;
    const tray = store.state.tray;
    const wrap = $("#trayRows");
    wrap.innerHTML = Array.from({ length: n }, (_, p) => {
      const cur = tray[p];
      const btn = (slot, label, testid) => `
      <button data-act="set-tray" data-p="${p}" data-slot="${slot ?? "none"}"
        data-focus-key="tray-${p}-${slot ?? "none"}"
        data-testid="${testid}"
        aria-pressed="${cur === slot}">${label}</button>`;
      return `
      <div class="tray-row" data-testid="tray-row-${p}">
        <span class="pkg-badge">${p + 1}</span>
        <span class="tray-name">包裹 ${p + 1}</span>
        <span class="seg seg-tray">
          ${btn("left", "放左盘", `tray-${p}-left`)}
          ${btn("right", "放右盘", `tray-${p}-right`)}
          ${btn(null, "取下", `tray-${p}-none`)}
        </span>
        <span class="muted small">当前：${cur === "left" ? "左盘" : cur === "right" ? "右盘" : "未上秤"}</span>
      </div>`;
    }).join("");
  }
  function miniPkgs(ids) {
    return ids.map((i) => `<span class="mini-pkg">${i + 1}</span>`).join("");
  }
  function renderHistory() {
    const el = $("#historyList");
    const recs = store.state.records;
    if (recs.length === 0) {
      el.innerHTML = `<div class="history-empty" data-testid="history-empty">还没有确认过称量。摆好两盘后点「确认称量」，结果与摆法会永久保留在这里，可随时点击翻查。</div>`;
      return;
    }
    el.innerHTML = recs.map((r, i) => `
    <button class="history-item ${store.state.viewing === i ? "selected" : ""}"
      data-act="view" data-i="${i}" data-testid="history-${i}">
      <span class="hi-top">
        <span class="hi-index">第 ${i + 1} 次称量</span>
        <span class="result-badge ${outcomeClass(r.outcome)}">${esc(outcomeLabel(r.outcome))}</span>
      </span>
      <span class="hi-body">
        <span class="hi-side">${miniPkgs(r.left)}</span>
        <span class="hi-op">${r.outcome === 0 ? "=" : r.outcome === 1 ? "＞" : "＜"}</span>
        <span class="hi-side">${miniPkgs(r.right)}</span>
      </span>
    </button>`).join("") + `<button class="history-item ${store.state.viewing === "draft" ? "selected" : ""}"
        data-act="view" data-i="draft" data-testid="history-draft">
        <span class="hi-top"><span class="hi-index">＋ 当前摆法 / 新称量</span></span>
        <span class="hi-body"><span class="muted small">点击回到摆秤界面</span></span>
      </button>`;
  }
  function renderPossibilities() {
    const panel = $("#possibilityPanel");
    const lv = store.level;
    const survivors = store.survivors();
    const poss = store.possibilities();
    const exhausted = store.attemptsLeft() === 0;
    const summaryCls = survivors.length === 1 ? "poss-summary" : exhausted && survivors.length > 1 ? "poss-summary exhaust" : "poss-summary";
    const summaryText = survivors.length === 1 ? `✓ 全部 ${store.state.records.length} 条记录联合后，只剩 1 种完整重量组合——每个包裹的重量都已锁定。` : exhausted && survivors.length > 1 ? `⏱ 次数已用尽，但仍有 ${survivors.length} 种完整重量组合与全部 ${store.state.records.length} 条记录相容，局面尚未确定。可继续提交分组检验，或重新开始。` : `目前有 ${survivors.length} 种完整重量组合，能同时通过全部 ${store.state.records.length} 条称量记录。`;
    const rows = poss.map((pp) => `
    <div class="pkg-poss-row" data-testid="poss-row-${pp.packageId}">
      <span class="poss-label">包裹 ${pp.packageId + 1}</span>
      <span class="cand-chips">
        ${lv.candidates.map((w) => {
      const alive = pp.possible.includes(w);
      const support = pp.supportCount.get(w) ?? 0;
      return `<span class="cand ${alive ? "alive" : "dead"}" data-testid="cand-${pp.packageId}-${w}">
            ${w} kg${alive && survivors.length > 1 ? `<span class="support">${support} 种组合</span>` : ""}
          </span>`;
    }).join("")}
      </span>
    </div>`).join("");
    const listRows = survivors.map((a, idx) => `
    <div class="assign-row" data-testid="assign-row-${idx}">
      ${a.map((w, p) => `<span class="aw" title="包裹 ${p + 1}"><b>${p + 1}#</b>${w}</span>`).join("")}
    </div>`).join("");
    panel.innerHTML = `
    <div class="${summaryCls}" data-testid="survivor-count" data-count="${survivors.length}">${esc(summaryText)}</div>
    ${rows}
    <details class="assign-details" open>
      <summary>翻查所有仍成立的完整重量组合（${survivors.length}，可滚动）</summary>
      <div class="assign-list" data-testid="assign-list">${listRows}</div>
    </details>`;
  }
  function shelfRanges(survivors) {
    const { A, B } = store.shelfSides();
    const range = (ids) => {
      if (ids.length === 0 || survivors.length === 0) return [0, 0];
      let lo = Infinity;
      let hi = -Infinity;
      for (const a of survivors) {
        const v = sumOf(a, ids);
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      return [lo, hi];
    };
    return { A: range(A), B: range(B) };
  }
  function renderShelf() {
    const n = store.level.packageCount;
    const shelf = store.state.shelf;
    const { A, B } = store.shelfSides();
    const survivors = store.survivors();
    const ranges = shelfRanges(survivors);
    const complete = store.shelfComplete();
    const zone = (slot, ids, title, range) => `
    <div class="shelf-zone zone-${slot}" data-testid="zone-${slot}">
      <h4><span>${title}</span>
        <span class="shelf-total-range">${ids.length === 0 ? "空" : `可能总重 ${range[0]}–${range[1]} kg`}</span>
      </h4>
      <div class="shelf-chips">
        ${ids.length ? ids.map((p) => `<span class="mini-pkg" data-act="set-shelf" data-p="${p}" data-slot="${slot}"
            style="cursor:pointer" title="点击移回未分配">${p + 1}</span>`).join("") : '<span class="shelf-empty">点击下方包裹放入</span>'}
      </div>
    </div>`;
    const assigned = A.length + B.length;
    const unassigned = n - assigned;
    const rows = Array.from({ length: n }, (_, p) => {
      const cur = shelf[p];
      const locked = store.state.won ? "disabled" : "";
      const btn = (slot, label, testid) => `
      <button data-act="set-shelf" data-p="${p}" data-slot="${slot ?? "none"}" ${locked}
        data-focus-key="shelf-${p}-${slot ?? "none"}"
        data-testid="${testid}" aria-pressed="${cur === slot}">${label}</button>`;
      return `
      <div class="shelf-row" data-testid="shelf-row-${p}">
        <span class="pkg-badge">${p + 1}</span>
        <span class="tray-name">包裹 ${p + 1}</span>
        <span class="seg seg-shelf">
          ${btn("A", "→ 左架", `shelf-${p}-A`)}
          ${btn("B", "→ 右架", `shelf-${p}-B`)}
          ${btn(null, "未分", `shelf-${p}-none`)}
        </span>
      </div>`;
    }).join("");
    $("#shelfPanel").innerHTML = `
    <div class="shelf-zones">
      ${zone("A", A, "左货架", ranges.A)}
      ${zone("B", B, "右货架", ranges.B)}
    </div>
    <div class="unassigned" data-testid="shelf-progress">
      ${complete ? `✓ ${n} 个包裹已全部分配` : `还有 ${unassigned} 个包裹未分配（已分配 ${assigned}/${n}），全部放好后才能提交`}
    </div>
    <div class="shelf-rows">${rows}</div>`;
    const submit = $("#submitBtn");
    submit.disabled = !complete || store.state.won;
    submit.textContent = store.state.won ? "本组划分已证明必然等重 ✓" : complete ? "提交分组，检验必然性" : `还有 ${unassigned} 个包裹未分配`;
  }
  function witnessTable(w, shelf) {
    return `
    <table class="witness-table">
      <tr>${w.map((_, p) => `<th class="on-${shelf[p] ?? ""}">包裹${p + 1}</th>`).join("")}</tr>
      <tr>${w.map((weight) => `<td><span class="w">${weight}</span></td>`).join("")}</tr>
    </table>`;
  }
  function sumsLine(w) {
    const { A, B } = store.shelfSides();
    const ls = sumOf(w, A);
    const rs = sumOf(w, B);
    const expr = (ids) => ids.map((p) => w[p]).join("+") || "0";
    const dir = ls === rs ? "相等" : ls > rs ? "左架更重" : "右架更重";
    return `<div class="witness-sums">左架 ${expr(A)} = ${ls} kg　vs　右架 ${expr(B)} = ${rs} kg　→　${dir}</div>`;
  }
  function renderVerdict() {
    const el = $("#verdictPanel");
    const v = store.state.verdict;
    if (!v || store.state.verdictSignature !== store.shelfSignature()) {
      el.innerHTML = "";
      return;
    }
    const recordCount = store.state.records.length;
    if (v.kind === "necessary-equal") {
      const sumText = v.possibleEqualSums.length === 1 ? `两架总重都为 <b>${v.possibleEqualSums[0]} kg</b>` : `共同总重可能是 ${v.possibleEqualSums.join("、")} kg（随剩余可能变化），但在每一种可能下两架都相等`;
      const truth = store.level.trueWeights;
      el.innerHTML = `
      <div class="verdict-box verdict-ok" data-testid="verdict" data-kind="necessary-equal">
        <h4>🎉 必然等重，分组成立！</h4>
        <p>枚举全部 <b>${v.survivorCount}</b> 种剩余可能，没有任何一种能让两架不等——${sumText}。</p>
        <p class="truth-reveal">🔎 真相揭晓：各包裹真实重量为
          ${truth.map((w, p) => `<span class="mini-pkg" title="包裹${p + 1}">${p + 1}# ${w}kg</span>`).join("　")}
        </p>
        <div class="win-actions">
          <button class="btn btn-primary" data-act="restart" data-testid="restart-win">↻ 重玩本关（次数与记录还原）</button>
          <button class="btn" data-act="next-level" data-testid="next-level">下一关 →</button>
        </div>
      </div>`;
      return;
    }
    if (v.kind === "contingent-equal") {
      el.innerHTML = `
      <div class="verdict-box verdict-warn" data-testid="verdict" data-kind="contingent-equal">
        <h4>⚠ 还不能提交：只是「碰巧」会相等</h4>
        <p>你的分组在<b>某些</b>剩余可能下确实等重（见下），但并非在全部 ${v.survivorCount} 种可能下都成立。
           下面这组<b>反例</b>与全部 ${recordCount} 条称量记录同时相容，两架却不等重：</p>
        <div class="witness" data-testid="counterexample">
          <div class="witness-title">🔻 反例重量分配（必然检验未通过）</div>
          ${witnessTable(v.counterexample, store.state.shelf)}
          ${sumsLine(v.counterexample)}
        </div>
        <details class="assign-details">
          <summary>存在一组让它碰巧相等的可能（对照）</summary>
          <div class="witness">
            ${witnessTable(v.equalExample, store.state.shelf)}
            ${sumsLine(v.equalExample)}
          </div>
        </details>
        <p class="small" style="margin-bottom:0">提示：继续称量以排除反例，或点右上角「重新开始」还原次数与记录。</p>
      </div>`;
      return;
    }
    if (v.kind === "never-equal") {
      el.innerHTML = `
      <div class="verdict-box verdict-bad" data-testid="verdict" data-kind="never-equal">
        <h4>✗ 这组划分不可能公平</h4>
        <p>在当前全部 ${v.survivorCount} 种剩余可能下，两架都不会相等。例如下面这组与全部 ${recordCount} 条记录相容的重量：</p>
        <div class="witness" data-testid="counterexample">
          <div class="witness-title">🔻 反例重量分配</div>
          ${witnessTable(v.counterexample, store.state.shelf)}
          ${sumsLine(v.counterexample)}
        </div>
      </div>`;
      return;
    }
    el.innerHTML = `
    <div class="verdict-box verdict-bad" data-testid="verdict" data-kind="no-possibility">
      <h4>记录之间出现矛盾，已无可能重量</h4>
      <p>这在公正游戏中不应发生（真实重量始终满足记录）。请重新开始。</p>
    </div>`;
  }
  function renderAll() {
    renderLevelTabs();
    renderHud();
    renderTrayRows();
    renderHistory();
    renderPossibilities();
    renderShelf();
    renderVerdict();
    renderer.setView(currentScaleView());
  }
  store.subscribe(() => renderAll());
  document.addEventListener("click", (e) => {
    const target = e.target.closest("[data-act]");
    if (!target) return;
    const act = target.dataset.act;
    const focusKey = document.activeElement?.dataset.focusKey ?? null;
    switch (act) {
      case "select-level": {
        const i = Number(target.dataset.i);
        store.selectLevel(i);
        break;
      }
      case "restart":
        store.restart();
        break;
      case "next-level":
        store.selectLevel((store.state.levelIndex + 1) % LEVELS.length);
        break;
      case "set-tray": {
        const p = Number(target.dataset.p);
        const slot = target.dataset.slot === "left" ? "left" : target.dataset.slot === "right" ? "right" : null;
        store.setTray(p, slot);
        break;
      }
      case "clear-tray":
        store.clearTray();
        break;
      case "confirm":
        store.confirmWeighing();
        break;
      case "view": {
        const raw = target.dataset.i;
        store.viewRecord(raw === "draft" ? "draft" : Number(raw));
        break;
      }
      case "set-shelf": {
        const p = Number(target.dataset.p);
        const slot = target.dataset.slot === "A" ? "A" : target.dataset.slot === "B" ? "B" : null;
        if (target.classList.contains("mini-pkg") && store.state.shelf[p] === slot) {
          store.setShelf(p, null);
        } else {
          store.setShelf(p, slot);
        }
        break;
      }
      case "submit":
        store.submitPartition();
        requestAnimationFrame(() => {
          $("#verdictPanel").scrollIntoView({ behavior: "smooth", block: "nearest" });
        });
        break;
    }
    if (focusKey) {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-focus-key="${focusKey}"]`);
        el?.focus({ preventScroll: true });
      });
    }
  });
  renderAll();
  window.__game = { store };
})();
