/* 本地视频取帧前端逻辑（原生 JS，无构建依赖）。 */

const state = {
  job: null,
  pollTimer: null,
  lastGeneration: 0,
};

const $ = (id) => document.getElementById(id);

function fmtTime(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s - h * 3600 - m * 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${sec.toFixed(3).padStart(6, "0")}`;
}

async function api(url, options = {}) {
  const resp = await fetch(url, options);
  let data = null;
  try {
    data = await resp.json();
  } catch {
    /* 非 JSON 响应（如下载） */
  }
  if (!resp.ok) {
    throw new Error(data?.error || `请求失败 (${resp.status})`);
  }
  return data;
}

function showError(boxId, message) {
  const box = $(boxId);
  if (!message) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.textContent = message;
  box.classList.remove("hidden");
}

// --------------------------------------------------------------- 样例列表

async function loadSamples() {
  try {
    const data = await api("/api/samples");
    const select = $("sampleSelect");
    select.innerHTML = '<option value="">加载样例视频…</option>';
    for (const sample of data.samples) {
      const opt = document.createElement("option");
      opt.value = sample.path;
      opt.textContent = `${sample.name} — ${sample.description}`;
      select.appendChild(opt);
    }
  } catch {
    /* 样例目录不存在时忽略，用户仍可手动上传 */
  }
}

// --------------------------------------------------------------- 导入

async function importJob(formData) {
  showError("importError", "");
  try {
    const job = await api("/api/jobs", { method: "POST", body: formData });
    state.job = job;
    state.lastGeneration = job.analysis_generation;
    renderJob(job);
  } catch (err) {
    showError("importError", err.message);
  }
}

$("fileInput").addEventListener("change", (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const form = new FormData();
  form.append("video", file);
  importJob(form);
});

$("sampleSelect").addEventListener("change", (event) => {
  const path = event.target.value;
  if (!path) return;
  const form = new FormData();
  form.append("sample_path", path);
  importJob(form);
});

// --------------------------------------------------------------- 渲染媒体信息

function renderJob(job) {
  $("mediaInfo").classList.remove("hidden");
  $("analysisPanel").classList.remove("hidden");

  $("infoName").textContent = job.original_name;
  $("infoDuration").textContent = `${fmtTime(job.duration)} (${job.duration.toFixed(3)} s)`;
  $("infoFormat").textContent = job.probe.format.long_name || job.probe.format.name || "—";
  $("infoVfr").innerHTML = job.is_vfr
    ? '可变帧率 (VFR)<span class="tag vfr">VFR</span>'
    : "恒定帧率 (CFR)";

  // 视频流选择
  const streamSelect = $("streamSelect");
  streamSelect.innerHTML = "";
  job.probe.video_streams.forEach((s, pos) => {
    const opt = document.createElement("option");
    opt.value = s.index;
    opt.selected = s.index === job.stream_index;
    opt.textContent = `流 #${s.index}：${s.codec} ${s.width}x${s.height}` +
      (s.rotation ? `，旋转 ${s.rotation}°` : "") +
      (s.vfr_hint ? "，VFR" : "");
    streamSelect.appendChild(opt);
  });

  const stream = job.probe.video_streams.find((s) => s.index === job.stream_index) || {};
  const rotText = stream.rotation
    ? `<span class="tag rot">旋转 ${stream.rotation}°（顺时针，导出时自动校正）</span>`
    : "无旋转";
  $("streamDetail").innerHTML =
    `编码：${stream.codec}　原始尺寸：${stream.width}×${stream.height}<br>` +
    `avg_frame_rate：${stream.avg_frame_rate ?? "—"}　r_frame_rate：${stream.r_frame_rate ?? "—"}<br>` +
    `方向：${rotText}`;

  // 时间范围默认值
  const endInput = $("endInput");
  if (endInput.value === "" || Number(endInput.dataset.bound) !== Math.floor(job.duration)) {
    endInput.value = job.duration.toFixed(3);
    endInput.dataset.bound = Math.floor(job.duration);
  }
  $("startInput").max = job.duration;
  endInput.max = job.duration;

  // 预览
  const player = $("player");
  player.src = `/api/jobs/${job.id}/preview?t=${Date.now()}`;
  player.load();

  renderStatus(job);
  renderCandidates(job);
}

$("streamSelect").addEventListener("change", async (event) => {
  if (!state.job) return;
  try {
    const job = await api(`/api/jobs/${state.job.id}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stream_index: Number(event.target.value) }),
    });
    state.job = job;
    renderJob(job);
  } catch (err) {
    alert(err.message);
    event.target.value = state.job.stream_index;
  }
});

// --------------------------------------------------------------- 模式切换

document.querySelectorAll('input[name="mode"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const scene = document.querySelector('input[name="mode"]:checked').value === "scene";
    $("intervalOptions").classList.toggle("hidden", scene);
    $("sceneOptions").classList.toggle("hidden", !scene);
  });
});

$("sensitivityInput").addEventListener("input", (e) => {
  $("sensitivityValue").textContent = e.target.value;
});

// --------------------------------------------------------------- 分析 / 取消

function collectParams() {
  const job = state.job;
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const params = {
    mode,
    start: Number($("startInput").value),
    end: Number($("endInput").value),
    max_frames: Number($("maxFramesInput").value),
    min_gap: Number($("minGapInput").value),
  };
  if (mode === "interval") {
    params.interval = Number($("intervalInput").value);
  } else {
    params.sensitivity = Number($("sensitivityInput").value);
  }
  return params;
}

$("analyzeBtn").addEventListener("click", async () => {
  if (!state.job) return;
  try {
    const data = await api(`/api/jobs/${state.job.id}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(collectParams()),
    });
    state.lastGeneration = data.analysis_generation;
    setAnalyzingUI(true);
    startPolling();
  } catch (err) {
    showMessage(err.message, "error");
  }
});

$("cancelBtn").addEventListener("click", async () => {
  if (!state.job) return;
  try {
    await api(`/api/jobs/${state.job.id}/cancel`, { method: "POST" });
  } catch (err) {
    showMessage(err.message, "error");
  }
});

function setAnalyzingUI(analyzing) {
  $("analyzeBtn").classList.toggle("hidden", analyzing);
  $("cancelBtn").classList.toggle("hidden", !analyzing);
  $("progressBox").classList.toggle("hidden", !analyzing);
  if (analyzing) {
    $("progressBar").style.width = "2%";
    $("progressText").textContent = "准备中…";
  }
}

// --------------------------------------------------------------- 轮询状态

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(pollJob, 500);
  pollJob();
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollJob() {
  if (!state.job) return;
  try {
    const job = await api(`/api/jobs/${state.job.id}`);
    // 代次防护：忽略比已发起分析更旧的迟到响应，防止瞬时状态回退
    if (job.analysis_generation < state.lastGeneration) return;
    state.job = job;
    renderStatus(job);
    renderCandidates(job);
    if (job.status !== "analyzing") {
      stopPolling();
      setAnalyzingUI(false);
    }
  } catch (err) {
    stopPolling();
    setAnalyzingUI(false);
    showMessage(err.message, "error");
  }
}

function renderStatus(job) {
  if (job.status === "analyzing") {
    $("progressBox").classList.remove("hidden");
    $("analyzeBtn").classList.add("hidden");
    $("cancelBtn").classList.remove("hidden");
    $("progressBar").style.width = `${Math.round(job.progress * 100)}%`;
    $("progressText").textContent = `${job.progress_stage} — ${Math.round(job.progress * 100)}%`;
  } else {
    $("analyzeBtn").classList.remove("hidden");
    $("cancelBtn").classList.add("hidden");
    if (job.status !== "analyzing") {
      $("progressBox").classList.toggle("hidden", job.analysis_generation === 0);
      if (job.analysis_generation > 0) {
        $("progressBar").style.width = job.status === "error" ? "0%" : "100%";
        $("progressText").textContent = job.progress_stage || "完成";
      }
    }
  }

  let level = "info";
  let text = "";
  if (job.status === "error") {
    level = "error";
    text = job.message || "分析失败。";
  } else if (job.status === "canceled") {
    level = "warn";
    text = job.message || "本轮分析已取消。";
  } else if (job.warnings?.length) {
    level = "warn";
    text = [job.message, ...job.warnings].filter(Boolean).join("\n");
  } else if (job.message) {
    level = "info";
    text = job.message;
  }
  showMessage(text, level);
}

function showMessage(text, level) {
  const box = $("analysisMessage");
  if (!text) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  box.className = `message-box ${level}`;
  box.textContent = text;
  box.classList.remove("hidden");
}

// --------------------------------------------------------------- 候选帧渲染

function renderCandidates(job) {
  const grid = $("candidateGrid");
  $("candidateCount").textContent = job.candidates.length;
  if (!job.candidates.length) {
    grid.innerHTML = '<div class="empty-hint">暂无候选帧。开始分析，或在下方手动补加时间点。</div>';
    return;
  }

  grid.innerHTML = "";
  for (const cand of job.candidates) {
    const card = document.createElement("div");
    card.className = "candidate-card" + (cand.selected ? "" : " dimmed");

    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (cand.has_image && cand.image_ready) {
      const img = document.createElement("img");
      img.src = `/api/jobs/${job.id}/frames/${cand.id}/image`;
      img.alt = `t=${cand.actual_time}s`;
      img.loading = "lazy";
      thumb.appendChild(img);
      thumb.title = "点击跳到该时间";
      thumb.addEventListener("click", () => seekTo(cand.actual_time));
    } else {
      const pending = document.createElement("div");
      pending.className = "pending";
      pending.textContent = cand.error ? "提取失败" : "生成中…";
      thumb.appendChild(pending);
    }
    card.appendChild(thumb);

    const meta = document.createElement("div");
    meta.className = "meta";
    const sourceLabel = { interval: "间隔", scene: "切换", manual: "手动", start: "起点" }[cand.source] || cand.source;
    meta.innerHTML = `
      <div class="time-row">
        <span class="actual">${fmtTime(cand.actual_time)}</span>
        <span class="source-tag ${cand.source}">${sourceLabel}</span>
      </div>
      <div class="requested">请求 ${cand.requested_time.toFixed(3)}s</div>
    `;
    card.appendChild(meta);

    if (cand.merged_requests?.length) {
      const dup = document.createElement("div");
      dup.className = "dup-text";
      dup.textContent = `合并了 ${cand.merged_requests.length} 个指向同一真实帧的请求`;
      card.appendChild(dup);
    }
    if (cand.error) {
      const warn = document.createElement("div");
      warn.className = "warn-text";
      warn.textContent = cand.error;
      card.appendChild(warn);
    }

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const selectBtn = document.createElement("button");
    selectBtn.textContent = cand.selected ? "取消选择" : "选择";
    selectBtn.addEventListener("click", () => toggleSelect(cand, !cand.selected));
    const jumpBtn = document.createElement("button");
    jumpBtn.textContent = "跳转";
    jumpBtn.addEventListener("click", () => seekTo(cand.actual_time));
    const delBtn = document.createElement("button");
    delBtn.textContent = "删除";
    delBtn.addEventListener("click", () => removeCandidate(cand.id));
    actions.append(selectBtn, jumpBtn, delBtn);
    card.appendChild(actions);

    grid.appendChild(card);
  }
}

function seekTo(seconds) {
  const player = $("player");
  player.currentTime = Math.min(seconds, (state.job?.duration || seconds) - 0.001);
  player.play().catch(() => {});
}

async function toggleSelect(cand, selected) {
  try {
    await api(`/api/jobs/${state.job.id}/frames/${cand.id}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selected }),
    });
    await pollJob();
  } catch (err) {
    alert(err.message);
  }
}

async function removeCandidate(id) {
  try {
    await api(`/api/jobs/${state.job.id}/frames/${id}`, { method: "DELETE" });
    await pollJob();
  } catch (err) {
    alert(err.message);
  }
}

$("selectAllBtn").addEventListener("click", async () => {
  for (const c of state.job?.candidates || []) {
    if (!c.selected) await toggleSelect(c, true);
  }
});

$("selectNoneBtn").addEventListener("click", async () => {
  for (const c of state.job?.candidates || []) {
    if (c.selected) await toggleSelect(c, false);
  }
});

// --------------------------------------------------------------- 手动补加

$("addFrameBtn").addEventListener("click", async () => {
  if (!state.job) return;
  const value = Number($("manualTime").value);
  if (Number.isNaN(value)) {
    alert("请输入有效的时间（秒）。");
    return;
  }
  try {
    const data = await api(`/api/jobs/${state.job.id}/frames`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ time: value }),
    });
    state.job = data.job;
    const actual = data.candidate.actual_time;
    if (Math.abs(actual - value) > 0.002) {
      showMessage(
        `请求 ${value.toFixed(3)}s 落在两帧之间，已选中最接近的真实帧 ${fmtTime(actual)}（偏差 ${(actual - value).toFixed(3)}s）。`,
        "info",
      );
    }
    renderCandidates(state.job);
  } catch (err) {
    alert(err.message);
  }
});

// --------------------------------------------------------------- 导出

$("exportBtn").addEventListener("click", () => {
  if (!state.job) return;
  window.location.href = `/api/jobs/${state.job.id}/export`;
});

$("sheetBtn").addEventListener("click", () => {
  if (!state.job) return;
  window.open(`/api/jobs/${state.job.id}/contact-sheet`, "_blank");
});

// --------------------------------------------------------------- 初始化

loadSamples();
