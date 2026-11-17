/* 竖屏取景工具前端逻辑 */
(function () {
  "use strict";
  const Core = window.FramerCore;

  const $ = (id) => document.getElementById(id);
  const els = {
    videoPath: $("videoPath"), btnOpen: $("btnOpen"),
    btnSample: $("btnSample"), sampleKind: $("sampleKind"),
    projectPath: $("projectPath"),
    btnSaveProject: $("btnSaveProject"), btnLoadProject: $("btnLoadProject"),
    mainCanvas: $("mainCanvas"), previewCanvas: $("previewCanvas"),
    mainMeta: $("mainMeta"), previewMeta: $("previewMeta"),
    dimBadge: $("dimBadge"), rotBadge: $("rotBadge"),
    btnPlay: $("btnPlay"), btnPause: $("btnPause"), btnStop: $("btnStop"),
    seekTime: $("seekTime"), btnSeek: $("btnSeek"), timeLabel: $("timeLabel"),
    timeline: $("timeline"), playedBar: $("playedBar"), playhead: $("playhead"),
    btnAddKf: $("btnAddKf"), btnDelKf: $("btnDelKf"), btnReset: $("btnReset"),
    easing: $("easing"), kfTable: $("kfTable"),
    outputPath: $("outputPath"), btnExport: $("btnExport"),
    btnVerify: $("btnVerify"), verifyBox: $("verifyBox"),
    exportProgress: $("exportProgress"), exportProgressBar: $("exportProgressBar"),
    statusBox: $("statusBox"),
  };

  const state = {
    src: null,           // 源视频路径
    playUrl: null,       // 实际播放地址（旋转视频为烤正代理）
    info: null,          // ffprobe 信息
    cropW: 0, cropH: 0,  // 9:16 取景尺寸（显示坐标系）
    keyframes: [],
    selectedKf: -1,
    video: null,         // 隐藏的 video 元素
    rafId: null,
    dragging: false,
    dragOffset: 0,
    pollTimer: null,
  };

  // ---------- 通用 ----------
  function status(msg, kind) {
    els.statusBox.textContent = msg;
    els.statusBox.className = "status" + (kind ? " " + kind : "");
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  function currentX() {
    if (!state.info) return 0;
    return Core.interpolate(
      state.keyframes, state.video.currentTime,
      state.info.display_width, state.cropW, els.easing.value);
  }

  function project() {
    return {
      src: state.src,
      keyframes: state.keyframes.map((k) => ({ t: k.t, x: k.x })),
      easing: els.easing.value,
    };
  }

  // ---------- 打开视频 ----------
  async function openVideo(path) {
    stopLoop();
    state.src = null; state.info = null; state.keyframes = [];
    const info = await fetch("/api/info?path=" + encodeURIComponent(path))
      .then((r) => r.json()).then((d) => {
        if (!d.ok) throw new Error(d.error);
        return d.info;
      });
    const [cropW, cropH] = Core.cropSize(info.display_width, info.display_height);
    state.src = path;
    state.info = info;
    state.cropW = cropW; state.cropH = cropH;

    let playPath = path;
    if (info.rotation) {
      status("检测到旋转元数据 " + info.rotation + "°，正在生成烤正代理以保证预览/导出方向一致…");
      const r = await api("/api/proxy", { path });
      playPath = r.proxy;
    }
    state.playUrl = "/api/media?path=" + encodeURIComponent(playPath);

    await loadVideoElement(state.playUrl);
    state.keyframes = Core.defaultKeyframes(info.display_width, cropW);
    state.selectedKf = 0;
    els.dimBadge.textContent =
      "存储 " + info.width + "×" + info.height +
      " · 显示 " + info.display_width + "×" + info.display_height +
      " · " + (info.has_audio ? "含音频" : "无音频") +
      " · " + info.duration.toFixed(2) + "s";
    if (info.rotation) {
      els.rotBadge.style.display = "inline-block";
      els.rotBadge.textContent = "旋转 " + info.rotation + "°（已烤正处理）";
      els.rotBadge.className = "badge rot";
    } else {
      els.rotBadge.style.display = "none";
    }
    els.videoPath.value = path;
    els.seekTime.max = String(info.duration);
    if (!els.outputPath.value) {
      els.outputPath.value = path.replace(/\.[^.]+$/, "") + "_vertical.mp4";
    }
    layoutCanvas();
    renderAll();
    status("视频已加载。拖动取景框或在时间线上添加关键点开始取景。", "ok");
  }

  function loadVideoElement(url) {
    return new Promise((resolve, reject) => {
      const v = document.createElement("video");
      v.src = url; v.muted = false; v.preload = "auto";
      v.playsInline = true;
      v.onloadedmetadata = () => resolve();
      v.onerror = () => reject(new Error("浏览器无法解码该视频"));
      state.video = v;
    });
  }

  // ---------- 画布 ----------
  function layoutCanvas() {
    const info = state.info;
    // 主画布按显示方向的 16:9 缩放，最大宽 960
    const maxW = 960;
    const scale = Math.min(1, maxW / info.display_width);
    els.mainCanvas.width = Math.round(info.display_width * scale);
    els.mainCanvas.height = Math.round(info.display_height * scale);
    // 竖屏预览与主画布等高
    els.previewCanvas.height = els.mainCanvas.height;
    els.previewCanvas.width = Math.round(els.mainCanvas.height * 9 / 16);
  }

  function renderAll() {
    drawMain();
    drawPreview();
    renderTimeline();
    renderTable();
    renderMeta();
  }

  function drawMain() {
    if (!state.info) return;
    const cv = els.mainCanvas, ctx = cv.getContext("2d");
    const v = state.video;
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (v.readyState >= 2) {
      ctx.drawImage(v, 0, 0, cv.width, cv.height);
    } else {
      ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
    }
    const sx = cv.width / state.info.display_width;
    const x = currentX() * sx;
    const w = state.cropW * sx, h = cv.height;
    // 遮罩
    ctx.fillStyle = "rgba(0,0,0,.55)";
    ctx.fillRect(0, 0, x, h);
    ctx.fillRect(x + w, 0, cv.width - x - w, h);
    // 边框与把手
    ctx.strokeStyle = "#4c8dff"; ctx.lineWidth = 2;
    ctx.strokeRect(x + 1, 1, w - 2, h - 2);
    ctx.fillStyle = "rgba(76,141,255,.9)";
    ctx.fillRect(x + w / 2 - 18, 6, 36, 5);
  }

  function drawPreview() {
    if (!state.info) return;
    const cv = els.previewCanvas, ctx = cv.getContext("2d");
    const v = state.video;
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, cv.width, cv.height);
    if (v.readyState < 2) return;
    const x = currentX();
    // 源（烤正代理）显示尺寸 = display_width × display_height
    const sx = cv.height / state.info.display_height;
    const sw = state.cropW, sh = state.cropH;
    ctx.drawImage(v, x, 0, sw, sh, 0, 0, cv.width, cv.height);
    void sx;
  }

  function renderMeta() {
    if (!state.info) return;
    const x = currentX();
    els.mainMeta.textContent =
      "取景框 " + state.cropW + "×" + state.cropH +
      "  左边缘 x=" + x +
      "（允许范围 0~" + (state.info.display_width - state.cropW) + "）";
    els.previewMeta.textContent =
      "竖屏输出 " + state.cropW + "×" + state.cropH +
      "  当前 t=" + state.video.currentTime.toFixed(3) + "s";
    els.timeLabel.textContent =
      state.video.currentTime.toFixed(3) + " / " + state.info.duration.toFixed(3) + " s";
  }

  // ---------- 时间线 ----------
  function renderTimeline() {
    if (!state.info) return;
    const dur = state.info.duration || 1;
    const pct = (t) => (t / dur) * 100;
    els.playedBar.style.width = pct(state.video.currentTime) + "%";
    els.playhead.style.left = pct(state.video.currentTime) + "%";
    els.timeline.querySelectorAll(".kf").forEach((n) => n.remove());
    state.keyframes.forEach((kf, i) => {
      const dot = document.createElement("div");
      dot.className = "kf" + (i === state.selectedKf ? " selected" : "");
      dot.style.left = pct(kf.t) + "%";
      dot.title = "t=" + kf.t.toFixed(3) + "s, x=" + kf.x;
      els.timeline.appendChild(dot);
    });
  }

  function renderTable() {
    els.kfTable.innerHTML = "";
    state.keyframes.forEach((kf, i) => {
      const tr = document.createElement("tr");
      if (i === state.selectedKf) tr.className = "selected";
      tr.innerHTML =
        "<td>" + (i + 1) + "</td>" +
        "<td>" + kf.t.toFixed(3) + "</td>" +
        "<td>" + kf.x + "</td>" +
        "<td><button data-jump='" + i + "'>跳转</button> " +
        "<button data-del='" + i + "' class='danger'>删除</button></td>";
      els.kfTable.appendChild(tr);
    });
    els.kfTable.querySelectorAll("[data-jump]").forEach((b) =>
      b.onclick = () => selectAndSeek(Number(b.dataset.jump)));
    els.kfTable.querySelectorAll("[data-del]").forEach((b) =>
      b.onclick = () => deleteKeyframe(Number(b.dataset.del)));
  }

  // ---------- 关键点操作 ----------
  function upsertKeyframe() {
    if (!state.info) return status("请先打开视频");
    const t = state.video.currentTime;
    const x = currentX();
    const idx = state.keyframes.findIndex((k) => Math.abs(k.t - t) < 0.05);
    if (idx >= 0) {
      state.keyframes[idx].x = x;
      state.selectedKf = idx;
      status("已更新关键点 t=" + t.toFixed(3) + "s");
    } else {
      state.keyframes.push({ t: Number(t.toFixed(3)), x });
      state.keyframes.sort((a, b) => a.t - b.t);
      state.selectedKf = state.keyframes.findIndex(
        (k) => Math.abs(k.t - t) < 0.05);
      status("已添加关键点 t=" + t.toFixed(3) + "s, x=" + x, "ok");
    }
    renderAll();
  }

  function deleteKeyframe(i) {
    if (!state.info) return;
    if (state.keyframes.length <= 1) {
      return status("至少保留一个关键点；如需还原初始位置请点击“恢复默认取景”。", "err");
    }
    const removed = state.keyframes.splice(i, 1)[0];
    state.selectedKf = Math.max(0, Math.min(i, state.keyframes.length - 1));
    status("已删除关键点 t=" + removed.t.toFixed(3) + "s");
    renderAll();
  }

  function resetFraming() {
    if (!state.info) return;
    state.keyframes = Core.defaultKeyframes(state.info.display_width, state.cropW);
    state.selectedKf = 0;
    status("已恢复默认取景：t=0 处单个居中关键点。", "ok");
    renderAll();
  }

  function selectAndSeek(i) {
    state.selectedKf = i;
    state.video.currentTime = state.keyframes[i].t;
    renderAll();
  }

  // ---------- 播放循环 ----------
  function startLoop() {
    if (state.rafId != null) return;
    const tick = () => {
      if (state.video.ended) {
        stopLoop(); status("播放结束。");
      }
      renderAll();
      state.rafId = requestAnimationFrame(tick);
    };
    state.rafId = requestAnimationFrame(tick);
  }
  function stopLoop() {
    if (state.rafId != null) cancelAnimationFrame(state.rafId);
    state.rafId = null;
  }

  // ---------- 取景框拖动 ----------
  function pointerToDisplayX(e) {
    const rect = els.mainCanvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (els.mainCanvas.width / rect.width);
    return px / (els.mainCanvas.width / state.info.display_width);
  }

  els.mainCanvas.addEventListener("pointerdown", (e) => {
    if (!state.info) return;
    els.mainCanvas.setPointerCapture(e.pointerId);
    const dx = pointerToDisplayX(e);
    const x = currentX();
    state.dragging = true;
    els.mainCanvas.classList.add("dragging");
    if (dx >= x && dx <= x + state.cropW) {
      state.dragOffset = dx - x;
    } else {
      state.dragOffset = state.cropW / 2;
    }
    moveFrame(dx);
  });
  els.mainCanvas.addEventListener("pointermove", (e) => {
    if (!state.dragging) return;
    moveFrame(pointerToDisplayX(e));
  });
  els.mainCanvas.addEventListener("pointerup", () => {
    state.dragging = false;
    els.mainCanvas.classList.remove("dragging");
  });

  function moveFrame(displayX) {
    // 拖动修改的是“当前时刻”的取景：若当前时刻有关键点则更新它，
    // 否则在当前时刻插入一个关键点，保证看到的位置可被保留
    const rawLeft = displayX - state.dragOffset;
    const x = Core.clampX(rawLeft, state.info.display_width, state.cropW);
    const t = state.video.currentTime;
    const idx = state.keyframes.findIndex((k) => Math.abs(k.t - t) < 0.05);
    if (idx >= 0) {
      state.keyframes[idx].x = x;
      state.selectedKf = idx;
    } else {
      state.keyframes.push({ t: Number(t.toFixed(3)), x });
      state.keyframes.sort((a, b) => a.t - b.t);
      state.selectedKf = state.keyframes.findIndex(
        (k) => Math.abs(k.t - t) < 0.05);
    }
    renderAll();
  }

  // ---------- 控件绑定 ----------
  els.btnOpen.onclick = () => {
    const p = els.videoPath.value.trim();
    if (!p) return status("请先填写视频路径");
    openVideo(p).catch((e) => status("打开失败：" + e.message + "（原有设置未改动）", "err"));
  };

  els.btnSample.onclick = async () => {
    try {
      status("正在本机生成样例视频…");
      const r = await api("/api/sample", { kind: els.sampleKind.value });
      els.videoPath.value = r.path;
      await openVideo(r.path);
      status("样例已生成并打开：" + r.path, "ok");
    } catch (e) {
      status("样例生成失败：" + e.message, "err");
    }
  };

  els.btnPlay.onclick = () => {
    if (!state.video) return;
    state.video.play().then(() => startLoop())
      .catch((e) => status("播放失败：" + e.message, "err"));
  };
  els.btnPause.onclick = () => { state.video && state.video.pause(); };
  els.btnStop.onclick = () => {
    if (!state.video) return;
    state.video.pause(); state.video.currentTime = 0; renderAll();
  };
  els.btnSeek.onclick = () => {
    if (!state.video) return;
    const t = Number(els.seekTime.value);
    if (Number.isNaN(t)) return status("请输入有效的秒数", "err");
    state.video.currentTime = Math.min(Math.max(t, 0), state.info.duration);
    renderAll();
  };
  els.timeline.addEventListener("click", (e) => {
    if (!state.info) return;
    const rect = els.timeline.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * state.info.duration;
    state.video.currentTime = Math.min(Math.max(t, 0), state.info.duration);
    renderAll();
  });

  els.btnAddKf.onclick = upsertKeyframe;
  els.btnDelKf.onclick = () => {
    if (state.selectedKf < 0) return status("请先在列表或时间线上选择一个关键点");
    deleteKeyframe(state.selectedKf);
  };
  els.btnReset.onclick = resetFraming;
  els.easing.onchange = () => renderAll();

  els.btnSaveProject.onclick = async () => {
    if (!state.info) return status("请先打开视频");
    const p = els.projectPath.value.trim();
    if (!p) return status("请填写工程文件保存路径（.json）", "err");
    try {
      await api("/api/project/save", { path: p, project: project() });
      status("工程已保存：" + p, "ok");
    } catch (e) { status("保存失败：" + e.message, "err"); }
  };
  els.btnLoadProject.onclick = async () => {
    const p = els.projectPath.value.trim();
    if (!p) return status("请填写工程文件路径", "err");
    try {
      const r = await api("/api/project/load", { path: p });
      const proj = r.project;
      await openVideo(proj.src);
      // openVideo 已建默认关键点，这里替换为工程数据并校验
      state.keyframes = Core.normalizeKeyframes(
        proj.keyframes, state.info.duration,
        state.info.display_width, state.cropW);
      els.easing.value = proj.easing;
      state.selectedKf = 0;
      renderAll();
      status("工程已加载：" + p, "ok");
    } catch (e) { status("加载失败：" + e.message + "（当前设置未改动）", "err"); }
  };

  // ---------- 导出 ----------
  els.btnExport.onclick = async () => {
    if (!state.info) return status("请先打开视频");
    const output = els.outputPath.value.trim();
    if (!output) return status("请填写导出路径", "err");
    els.btnExport.disabled = true;
    els.exportProgress.style.display = "block";
    els.exportProgressBar.style.width = "0%";
    els.verifyBox.textContent = "";
    try {
      // 先在前端做一次校验，非法直接返回，不改动任何现有设置
      Core.normalizeKeyframes(
        state.keyframes, state.info.duration,
        state.info.display_width, state.cropW);
      const r = await api("/api/export", { project: project(), output });
      status("导出已开始，任务 " + r.jobId);
      pollJob(r.jobId);
    } catch (e) {
      els.btnExport.disabled = false;
      els.exportProgress.style.display = "none";
      status("导出未开始：" + e.message + "（关键点设置保持不变）", "err");
    }
  };

  function pollJob(jobId) {
    clearInterval(state.pollTimer);
    state.pollTimer = setInterval(async () => {
      try {
        const d = await fetch("/api/job?id=" + jobId).then((r) => r.json());
        if (!d.ok) throw new Error(d.error);
        els.exportProgressBar.style.width = Math.round(d.progress * 100) + "%";
        if (d.status === "running") return;
        clearInterval(state.pollTimer);
        els.btnExport.disabled = false;
        if (d.status === "done") {
          status("导出完成：" + d.dst, "ok");
          verifyOutput(d.dst);
        } else {
          els.exportProgress.style.display = "none";
          status("导出失败，已保留当前关键点设置。原因：" + d.error, "err");
        }
      } catch (e) {
        clearInterval(state.pollTimer);
        els.btnExport.disabled = false;
        status("任务查询失败：" + e.message, "err");
      }
    }, 500);
  }

  els.btnVerify.onclick = () => {
    const p = els.outputPath.value.trim();
    if (!p) return status("请填写导出文件路径", "err");
    verifyOutput(p).catch((e) =>
      status("核对失败：" + e.message, "err"));
  };

  async function verifyOutput(path) {
    const d = await fetch("/api/verify?path=" + encodeURIComponent(path))
      .then((r) => r.json());
    if (!d.ok) throw new Error(d.error);
    const o = d.info, src = state.info;
    const durDelta = src ? Math.abs(o.duration - src.duration) : null;
    const ratioOk = Math.abs(o.width / o.height - 9 / 16) < 0.01;
    els.verifyBox.innerHTML =
      "尺寸：<b>" + o.width + "×" + o.height + "</b>" +
      (ratioOk ? "（9:16 ✓）" : "（比例异常 ✗）") + "<br>" +
      "时长：<b>" + o.duration.toFixed(3) + " s</b>" +
      (durDelta != null ? "（源 " + src.duration.toFixed(3) +
        "s，差 " + durDelta.toFixed(3) + "s）" : "") + "<br>" +
      "帧率：<b>" + o.fps.toFixed(2) + " fps</b><br>" +
      "音频：<b>" + (o.has_audio ? "有" : "无") + "</b>" +
      (src && src.has_audio && !o.has_audio ? "（源有音频，导出丢失！）" : "") + "<br>" +
      "旋转：<b>" + o.rotation + "°</b>（应为 0）";
    status("核对完成。可在下方查看尺寸/时长/音频；取景运动请用播放器对照时间线检查。", "ok");
  }
})();
