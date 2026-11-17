/* 本地视频拼接工具前端：纯原生 JS，无外部依赖 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const state = { data: null, pollTimer: null };

async function api(path, options = {}) {
  const resp = await fetch(path, options);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(payload.error || `请求失败：${resp.status}`);
  return payload;
}

function jsonOptions(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  };
}

// ---------------- 片段列表 ----------------

function renderClips() {
  const { clips } = state.data;
  $("#clip-count").textContent = `${clips.length} / ${state.data.max_clips}`;
  const ul = $("#clip-list");
  ul.innerHTML = "";

  clips.forEach((clip, i) => {
    const li = document.createElement("li");
    li.className = "clip-item" + (clip.ok ? "" : " invalid");

    const idx = document.createElement("span");
    idx.className = "index";
    idx.textContent = String(i + 1);
    li.appendChild(idx);

    if (clip.ok) {
      const img = document.createElement("img");
      img.src = clip.thumbnail + "?t=" + Date.now();
      img.alt = clip.name;
      li.appendChild(img);
    }

    const meta = document.createElement("div");
    meta.className = "clip-meta";
    if (clip.ok) {
      meta.innerHTML = `
        <div class="name" title="${clip.path}">${clip.name}</div>
        <div class="props">
          ${clip.duration.toFixed(3)}s · ${clip.width}x${clip.height} ·
          ${clip.fps}fps
          <span class="tag ${clip.has_audio ? "audio" : "silent"}">
            ${clip.has_audio ? "有声音" : "无声音 → 补静音"}
          </span>
        </div>`;
    } else {
      meta.innerHTML = `
        <div class="name" title="${clip.path}">${clip.name}</div>
        <div class="err">无法处理：${clip.error || "未知原因"}</div>`;
    }
    li.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "clip-actions";
    actions.append(
      miniBtn("↑", "上移", () => moveClip(clip.clip_id, -1), i === 0),
      miniBtn("↓", "下移", () => moveClip(clip.clip_id, 1), i === clips.length - 1),
    );
    const replace = miniBtn("替换", "只替换该片段", () => replaceClip(clip.clip_id));
    const remove = miniBtn("移除", "移除该片段", () => removeClip(clip.clip_id));
    remove.classList.add("danger");
    actions.append(replace, remove);
    li.appendChild(actions);

    ul.appendChild(li);
  });
}

function miniBtn(text, title, onClick, disabled = false) {
  const btn = document.createElement("button");
  btn.className = "btn tiny";
  btn.textContent = text;
  btn.title = title;
  btn.disabled = disabled;
  btn.addEventListener("click", onClick);
  return btn;
}

async function moveClip(clipId, direction) {
  state.data = (await api(`/api/clips/${clipId}/move`, jsonOptions("PUT", { direction })));
  renderAll();
}

async function removeClip(clipId) {
  state.data = await api(`/api/clips/${clipId}`, { method: "DELETE" });
  renderAll();
}

function pickReplaceFile(clipId) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "video/*";
  input.onchange = async () => {
    if (!input.files[0]) return;
    const fd = new FormData();
    fd.append("files", input.files[0]);
    try {
      state.data = await api(`/api/clips/${clipId}/replace`, { method: "PUT", body: fd });
      renderAll();
    } catch (err) {
      alert(err.message);
    }
  };
  input.click();
}

function replaceClip(clipId) {
  const choice = prompt(
    "替换片段：输入本机绝对路径，或留空点确定后选择文件。", "");
  if (choice === null) return;
  if (choice.trim() === "") return pickReplaceFile(clipId);
  const fd = new FormData();
  fd.append("path", new Blob([choice.trim()], { type: "text/plain" }));
  api(`/api/clips/${clipId}/replace`, { method: "PUT", body: fd })
    .then((snap) => { state.data = snap; renderAll(); })
    .catch((err) => alert(err.message));
}

// ---------------- 设置与预览 ----------------

function fillSettings() {
  const s = state.data.settings;
  if (document.activeElement !== $("#set-width")) $("#set-width").value = s.width || "";
  if (document.activeElement !== $("#set-height")) $("#set-height").value = s.height || "";
  if (document.activeElement !== $("#set-fps")) $("#set-fps").value = s.fps || "";
  $("#set-fit").value = s.fit;
}

async function pushSettings() {
  try {
    state.data = await api("/api/settings", jsonOptions("PUT", {
      width: Number($("#set-width").value) || 0,
      height: Number($("#set-height").value) || 0,
      fps: Number($("#set-fps").value) || 0,
      fit: $("#set-fit").value,
    }));
    renderAll();
  } catch (err) {
    alert(err.message);
  }
}

/**
 * 在 canvas 上按当前 fit 方式绘制每段画面的适配示意。
 * 只用等比缩放，浏览器层面同样不允许拉伸：drawImage 的目标矩形保持源宽高比。
 */
function drawPreview() {
  const canvas = $("#preview");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  const eff = state.data.effective_settings;
  const okClips = state.data.clips.filter((c) => c.ok);
  if (!eff || okClips.length === 0) {
    ctx.fillStyle = "#5a6783";
    ctx.font = "15px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("添加有效片段后在此预览适配效果", W / 2, H / 2);
    $("#preview-caption").textContent = "";
    return;
  }

  const fit = eff.fit;
  const frameW = 300, frameH = Math.round(frameW * eff.height / eff.width);
  const originX = (W - frameW) / 2, originY = (H - frameH) / 2;

  // 输出画框
  ctx.strokeStyle = "#4f8cff";
  ctx.lineWidth = 2;
  ctx.strokeRect(originX, originY, frameW, frameH);

  const palette = ["#ff5c5c", "#38c172", "#4f8cff", "#f5a623", "#b07cff", "#35d0d8"];
  const gap = 8;
  const thumbW = (frameW - gap * (okClips.length - 1)) / okClips.length;

  okClips.forEach((clip, i) => {
    const x = originX + i * (thumbW + gap);
    const srcRatio = clip.width / clip.height;
    const dstRatio = eff.width / eff.height;
    let dw, dh, dx, dy;
    if (fit === "cover") {
      if (srcRatio > dstRatio) {
        dh = frameH; dw = frameH * srcRatio;
      } else {
        dw = frameW; dh = frameW / srcRatio;
      }
      dx = x + (thumbW - dw) / 2; dy = originY + (frameH - dh) / 2;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, originY, thumbW, frameH);
      ctx.clip();
    } else {
      if (srcRatio > dstRatio) {
        dw = thumbW; dh = thumbW / srcRatio;
      } else {
        dh = frameH; dw = frameH * srcRatio;
      }
      dx = x + (thumbW - dw) / 2; dy = originY + (frameH - dh) / 2;
    }
    ctx.fillStyle = palette[i % palette.length];
    ctx.globalAlpha = 0.85;
    ctx.fillRect(dx, dy, dw, dh);
    ctx.globalAlpha = 1;
    if (fit === "cover") ctx.restore();
    ctx.fillStyle = "#fff";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${i + 1}`, x + thumbW / 2, originY + frameH + 18);
    ctx.fillStyle = "#93a0b8";
    ctx.font = "10px sans-serif";
    ctx.fillText(`${clip.width}x${clip.height}`, x + thumbW / 2, originY + frameH + 33);
  });

  $("#preview-caption").textContent =
    `输出画框 ${eff.width}x${eff.height} @ ${eff.fps}fps，适配方式 ${fit}：` +
    (fit === "contain"
      ? "画面等比缩放到完整可见，不足区域填黑边，不裁切不变形"
      : "画面等比放大填满画框，超出部分居中裁掉，不变形");
}

function renderJunctions() {
  const box = $("#junction-box");
  box.innerHTML = "";
  const junctions = state.data.junctions;
  if (junctions.length === 0) {
    box.innerHTML = `<div class="junction"><span class="ok-text">单片段或暂无交界需要检查。</span></div>`;
    return;
  }
  junctions.forEach((j) => {
    const div = document.createElement("div");
    div.className = "junction";
    const issues = j.issues.length
      ? `<ul>${j.issues.map((t) => `<li>${t}</li>`).join("")}</ul>`
      : `<span class="ok-text">规格一致，交界无需特殊处理</span>`;
    div.innerHTML = `<strong>${j.names[0]} → ${j.names[1]}</strong>${issues}`;
    box.appendChild(div);
  });
}

// ---------------- 导出摘要与进度 ----------------

function renderSummary() {
  const d = state.data;
  const eff = d.effective_settings;
  const box = $("#export-summary");
  const valid = d.clips.filter((c) => c.ok);
  if (valid.length === 0) {
    box.textContent = "尚未添加有效片段。";
    $("#btn-export").disabled = true;
    $("#btn-verify").disabled = true;
    return;
  }
  const lines = [
    `有效片段：${valid.length} 段`,
    `预计总时长：${d.estimated_duration.toFixed(3)} 秒`,
    eff ? `输出设置：${eff.width}x${eff.height}，${eff.fps}fps，适配=${eff.fit}，像素=yuv420p，音频=AAC 48kHz 立体声` : "",
    `无声片段规则：统一补与画面等长的静音轨（不占压后续声音）`,
  ];
  box.textContent = lines.filter(Boolean).join("\n");
  $("#btn-export").disabled = d.export_running;
  $("#btn-verify").disabled = !(d.last_result && d.last_result.ok);
  renderExportMsg();
}

function renderExportMsg() {
  const d = state.data;
  const box = $("#export-msg");
  box.innerHTML = "";
  const r = d.last_result;
  if (!r) return;
  const div = document.createElement("div");
  if (r.ok) {
    div.className = "msg-ok";
    div.textContent =
      `导出成功：${r.output_path}（预计 ${r.expected_duration.toFixed(3)}s），可点击「导出后回读校验」核对成品。`;
  } else {
    div.className = "msg-err";
    const where = r.failed_clip_id
      ? `出错片段 ID：${r.failed_clip_id}，阶段：${r.failed_stage}`
      : `阶段：${r.failed_stage}`;
    div.textContent = `导出失败：${r.error}\n${where}\n请在上方列表替换出错片段后重新导出，已完成片段的中间片会复用。`;
  }
  box.appendChild(div);
}

function renderProgress() {
  const d = state.data;
  const box = $("#progress-box");
  if (d.export_running) {
    box.classList.remove("hidden");
    $("#progress-fill").style.width = `${Math.round(d.export_progress.ratio * 100)}%`;
    $("#progress-text").textContent = d.export_progress.text || "";
  } else {
    box.classList.add("hidden");
  }
}

// ---------------- 校验结果 ----------------

function renderVerify(report) {
  const card = $("#verify-card");
  card.classList.remove("hidden");
  const verdict = $("#verify-verdict");
  verdict.textContent = report.passed ? "全部通过" : "存在未通过项";
  verdict.style.color = report.passed ? "var(--ok)" : "var(--err)";

  $("#verify-checks").innerHTML = report.checks.map((c) =>
    `<li class="${c.passed ? "pass" : "fail"}">${c.passed ? "✓" : "✗"} ${c.name}：${c.detail}</li>`
  ).join("");

  $("#verify-order").innerHTML = report.order_samples.map((s) => {
    if (s.error) return `<li class="fail">第 ${s.index + 1} 段：${s.error}</li>`;
    const status = s.matched === null ? "（非内置样例，仅记录）"
      : s.matched ? "✓ 与预期片段特征色一致" : "✗ 特征色不符，顺序可能错乱";
    return `<li class="${s.matched === false ? "fail" : "pass"}">第 ${s.index + 1} 段 @${s.at}s：RGB(${s.actual_rgb.join(",")}) 主导通道[${(s.actual_signature || []).join(",")}] ${status}</li>`;
  }).join("");

  $("#verify-junctions").innerHTML = report.junction_frames.map((j) => {
    if (j.error) return `<li class="fail">${j.boundary}s：${j.error}</li>`;
    const bad = j.black_frame || j.duplicate_frame;
    const note = j.black_frame ? "发现黑帧" : j.duplicate_frame ? "发现重复帧" : "两侧画面不同且无黑帧";
    return `<li class="${bad ? "fail" : "pass"}">交界 ${j.boundary}s：亮度 ${j.luma_before}→${j.luma_after}，${note}</li>`;
  }).join("") || `<li>无交界（单片段）</li>`;

  $("#verify-audio").innerHTML = report.audio_segments.map((a) => {
    if (a.error) return `<li class="fail">第 ${a.index + 1} 段：${a.error}</li>`;
    return `<li class="${a.passed ? "pass" : "fail"}">第 ${a.index + 1} 段：RMS ${a.rms_db}dBFS，${a.expectation}</li>`;
  }).join("") || `<li>成品无音轨</li>`;

  card.scrollIntoView({ behavior: "smooth" });
}

// ---------------- 总渲染与事件 ----------------

function renderAll() {
  renderClips();
  fillSettings();
  drawPreview();
  renderJunctions();
  renderSummary();
  renderProgress();
}

async function refresh() {
  state.data = await api("/api/state");
  renderAll();
  if (state.data.export_running) schedulePoll();
}

function schedulePoll() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    try {
      state.data = await api("/api/state");
      renderAll();
      if (!state.data.export_running) {
        clearInterval(state.pollTimer);
        state.pollTimer = null;
      }
    } catch { /* 下一轮重试 */ }
  }, 700);
}

function bindEvents() {
  $("#file-input").addEventListener("change", async (e) => {
    const files = [...e.target.files];
    if (!files.length) return;
    const fd = new FormData();
    files.forEach((f) => fd.append("files", f));
    try {
      const snap = await api("/api/clips", { method: "POST", body: fd });
      state.data = snap.state;
      renderAll();
    } catch (err) {
      alert(err.message);
    }
    e.target.value = "";
  });

  $("#path-input").addEventListener("keydown", async (e) => {
    if (e.key !== "Enter" || !e.target.value.trim()) return;
    const fd = new FormData();
    fd.append("path", new Blob([e.target.value.trim()], { type: "text/plain" }));
    try {
      const snap = await api("/api/clips", { method: "POST", body: fd });
      state.data = snap.state;
      renderAll();
      e.target.value = "";
    } catch (err) {
      alert(err.message);
    }
  });

  $("#btn-samples").addEventListener("click", async () => {
    try {
      await api("/api/samples", jsonOptions("POST", {}));
      schedulePoll();
      setTimeout(refresh, 1200);
    } catch (err) {
      alert(err.message);
    }
  });

  ["#set-width", "#set-height", "#set-fps", "#set-fit"].forEach((sel) => {
    const el = $(sel);
    el.addEventListener("change", pushSettings);
  });

  $("#btn-export").addEventListener("click", async () => {
    try {
      await api("/api/export", jsonOptions("POST", { output: $("#output-name").value }));
      schedulePoll();
    } catch (err) {
      alert(err.message);
    }
  });

  $("#btn-verify").addEventListener("click", async () => {
    try {
      const report = await api("/api/verify", jsonOptions("POST", {}));
      renderVerify(report);
    } catch (err) {
      alert(err.message);
    }
  });
}

bindEvents();
refresh();
