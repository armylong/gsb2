/* app.js — 界面控制器：导入、波形渲染、区间选择、试听、导出与结果核对 */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);

  const state = {
    fileName: null,
    audio: null,          // decodeWav 结果
    selection: null,      // { start, end } 帧（end 不含），左右声道共用
    fadeMs: 5,
    loop: null,           // buildLoop 结果缓存
    view: { start: 0, fpp: 1 },
    drag: null,
    peaks: null,          // 每声道峰值桶
    verifySidecar: null,
  };
  const player = new LoopPlayer();
  player.onEnded = () => { syncPlayState(); };

  /* ---------- 提示条 ---------- */
  let msgTimer = null;
  function showError(msg) {
    const bar = $('messageBar');
    bar.className = 'message';
    bar.textContent = '⚠ ' + msg;
    bar.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { bar.hidden = true; }, 4200);
  }
  function showInfo(msg) {
    const bar = $('messageBar');
    bar.className = 'message info';
    bar.textContent = msg;
    bar.hidden = false;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { bar.hidden = true; }, 2800);
  }

  /* ---------- 导入 ---------- */
  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    await loadWavFile(file);
  });

  async function loadWavFile(file) {
    try {
      const buf = await file.arrayBuffer();
      const audio = WavCodec.decodeWav(buf);
      player.stop();
      syncPlayState();
      state.fileName = file.name;
      state.audio = audio;
      state.selection = { start: 0, end: audio.frameCount };
      state.fadeMs = 5;
      state.loop = null;
      state.view = { start: 0, fpp: Math.max(0.25, audio.frameCount / canvasCssWidth()) };
      state.peaks = null;
      $('canvasHint').hidden = true;
      enableControls(true);
      $('metaText').textContent =
        `${file.name} · ${audio.sampleRate} Hz · ${audio.channels === 2 ? '双声道' : '单声道'} · ` +
        `${audio.bitDepth}-bit ${audio.encoding} · ${audio.frameCount} 帧 · ${audio.durationSec.toFixed(3)} 秒`;
      $('fadeMs').value = 5;
      rebuildLoop(true);
      resizeCanvas();
      showInfo('导入成功：' + file.name);
    } catch (err) {
      showError(err && err.message ? err.message : String(err));
    }
  }

  function enableControls(on) {
    for (const id of ['startFrame', 'endFrame', 'lenFrames', 'lenMs', 'fadeMs', 'fadeFrames',
      'exportLen', 'playOriginal', 'playLoop', 'exportBtn']) {
      $(id).disabled = !on;
    }
    document.querySelectorAll('button[data-fade]').forEach((b) => { b.disabled = !on; });
    $('stopBtn').disabled = true;
  }

  /* ---------- Canvas ---------- */
  const canvas = $('wave');
  const ctx2d = canvas.getContext('2d');

  function canvasCssWidth() { return Math.max(320, canvas.clientWidth || canvas.parentElement.clientWidth - 2); }

  function resizeCanvas() {
    const dpr = globalThis.devicePixelRatio || 1;
    const w = canvasCssWidth();
    const lanes = state.audio ? state.audio.channels : 1;
    const laneH = state.audio && state.audio.channels === 2 ? 118 : 240;
    canvas.style.height = (laneH * lanes + 12 * (lanes - 1) + 16) + 'px';
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round((laneH * lanes + 12 * (lanes - 1) + 16) * dpr);
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    state.peaks = null;
    draw();
  }
  globalThis.addEventListener('resize', resizeCanvas);

  function laneGeometry() {
    const lanes = state.audio ? state.audio.channels : 1;
    const laneH = state.audio && state.audio.channels === 2 ? 118 : 240;
    const gap = 12, pad = 8;
    const arr = [];
    for (let i = 0; i < lanes; i++) arr.push({ top: pad + i * (laneH + gap), h: laneH, mid: pad + i * (laneH + gap) + laneH / 2 });
    return arr;
  }

  function ensurePeaks() {
    if (!state.audio || state.peaks) return;
    const bucket = Math.max(1, Math.round(state.view.fpp));
    state.peaks = state.audio.data.map((ch) => Geometry.buildPeaks(ch, bucket));
  }

  function draw() {
    const w = canvasCssWidth();
    const h = parseFloat(canvas.style.height) || 260;
    ctx2d.clearRect(0, 0, w, h);
    ctx2d.fillStyle = '#20242e';
    ctx2d.fillRect(0, 0, w, h);
    if (!state.audio) return;

    ensurePeaks();
    const { start: vStart, fpp } = state.view;
    const lanes = laneGeometry();

    // 中线与零轴
    for (const lane of lanes) {
      ctx2d.strokeStyle = '#2c323e';
      ctx2d.beginPath(); ctx2d.moveTo(0, lane.mid); ctx2d.lineTo(w, lane.mid); ctx2d.stroke();
    }

    // 波形
    for (let c = 0; c < state.audio.channels; c++) {
      const lane = lanes[c];
      const peaks = state.peaks[c];
      ctx2d.fillStyle = c === 0 ? '#6ea3ff' : '#37c39b';
      const firstBucket = Math.max(0, Math.floor(vStart / peaks.bucketFrames));
      const lastBucket = Math.min(peaks.buckets - 1, Math.ceil((vStart + w * fpp) / peaks.bucketFrames));
      for (let b = firstBucket; b <= lastBucket; b++) {
        const frame = b * peaks.bucketFrames;
        const x = (frame - vStart) / fpp;
        if (x < -1 || x > w + 1) continue;
        const yMax = lane.mid - peaks.max[b] * (lane.h / 2 - 4);
        const yMin = lane.mid - peaks.min[b] * (lane.h / 2 - 4);
        const bw = Math.max(1, peaks.bucketFrames / fpp);
        ctx2d.fillRect(x, yMax, bw, Math.max(1, yMin - yMax));
      }
      // 声道标签
      ctx2d.fillStyle = '#8b93a3';
      ctx2d.font = '11px sans-serif';
      ctx2d.fillText(state.audio.channels === 2 ? (c === 0 ? 'L' : 'R') : 'MONO', 6, lane.top + 14);
    }

    // 选区（两声道共用同一组边界）
    if (state.selection) {
      const x1 = Geometry.xAtFrame(state.selection.start, vStart, fpp);
      const x2 = Geometry.xAtFrame(state.selection.end, vStart, fpp);
      ctx2d.fillStyle = 'rgba(79,140,255,0.22)';
      ctx2d.fillRect(x1, 0, x2 - x1, h);
      ctx2d.strokeStyle = '#7fb0ff';
      ctx2d.lineWidth = 1.5;
      for (const x of [x1, x2]) {
        ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, h); ctx2d.stroke();
      }
      ctx2d.lineWidth = 1;
    }

    // 播放头
    if (player.playing) {
      let frame;
      if (player.mode === 'loop' && state.loop) {
        frame = state.selection.start + Math.floor(player.currentTime() * state.audio.sampleRate);
      } else {
        frame = Math.floor(player.currentTime() * state.audio.sampleRate);
      }
      const x = Geometry.xAtFrame(frame, vStart, fpp);
      if (x >= 0 && x <= w) {
        ctx2d.strokeStyle = '#ffd166';
        ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, h); ctx2d.stroke();
      }
    }
  }

  /* ---------- 鼠标交互 ---------- */
  function eventFrame(ev) {
    const rect = canvas.getBoundingClientRect();
    return Geometry.frameAtX(ev.clientX - rect.left, state.view.start, state.view.fpp, rect.width, state.audio.frameCount);
  }
  function nearEdge(frame) {
    const s = state.selection;
    const tol = 8 / state.view.fpp;
    if (Math.abs(frame - s.start) <= tol) return 'start';
    if (Math.abs(frame - s.end) <= tol) return 'end';
    return null;
  }

  canvas.addEventListener('mousedown', (ev) => {
    if (!state.audio) return;
    const frame = eventFrame(ev);
    if (ev.shiftKey) {
      state.drag = { type: 'pan', x: ev.clientX, viewStart: state.view.start };
      canvas.style.cursor = 'grabbing';
      return;
    }
    const edge = nearEdge(frame);
    if (edge) state.drag = { type: 'edge', which: edge };
    else state.drag = { type: 'select', anchor: frame };
  });

  globalThis.addEventListener('mousemove', (ev) => {
    if (!state.audio || !state.drag) return;
    const d = state.drag;
    if (d.type === 'pan') {
      const dx = ev.clientX - d.x;
      const maxStart = Math.max(0, state.audio.frameCount - state.view.fpp * canvasCssWidth());
      state.view.start = Geometry.clamp(Math.round(d.viewStart - dx * state.view.fpp), 0, maxStart);
      state.peaks = null;
      draw();
      return;
    }
    const frame = eventFrame(ev);
    if (d.type === 'select') {
      state.selection = { start: Math.min(d.anchor, frame), end: Math.max(d.anchor, frame) };
    } else if (d.which === 'start') {
      state.selection.start = Geometry.clamp(frame, 0, state.selection.end - 2);
    } else {
      state.selection.end = Geometry.clamp(frame, state.selection.start + 2, state.audio.frameCount);
    }
    rebuildLoop(true);
  });

  globalThis.addEventListener('mouseup', () => {
    if (state.drag) {
      state.drag = null;
      canvas.style.cursor = 'crosshair';
    }
  });

  canvas.addEventListener('wheel', (ev) => {
    if (!state.audio) return;
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const anchor = state.view.start + (ev.clientX - rect.left) * state.view.fpp;
    const factor = ev.deltaY > 0 ? 1.25 : 0.8;
    const v = Geometry.zoomView(state.view.start, state.view.fpp, factor, anchor, rect.width, state.audio.frameCount);
    state.view = v;
    state.peaks = null;
    draw();
  }, { passive: false });

  canvas.addEventListener('dblclick', (ev) => {
    if (!state.audio) return;
    const edge = nearEdge(eventFrame(ev));
    if (edge === 'start') state.selection.start = Geometry.clamp(state.selection.start - 1, 0, state.selection.end - 2);
    else if (edge === 'end') state.selection.end = Geometry.clamp(state.selection.end + 1, state.selection.start + 2, state.audio.frameCount);
    else return;
    rebuildLoop(true);
  });

  globalThis.addEventListener('keydown', (ev) => {
    if (!state.audio || !state.selection) return;
    if (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
    const step = ev.shiftKey ? 10 : 1;
    let used = true;
    if (ev.key === 'ArrowLeft') state.selection.start = Geometry.clamp(state.selection.start - step, 0, state.selection.end - 2);
    else if (ev.key === 'ArrowRight') state.selection.end = Geometry.clamp(state.selection.end + step, state.selection.start + 2, state.audio.frameCount);
    else used = false;
    if (used) { ev.preventDefault(); rebuildLoop(true); }
  });

  /* ---------- 数字输入精确调整 ---------- */
  $('startFrame').addEventListener('change', () => {
    if (!state.audio) return;
    const v = parseInt($('startFrame').value, 10);
    if (!Number.isInteger(v)) return showError('起点必须是整数帧');
    if (v < 0 || v > state.audio.frameCount - 2) return showError('起点超出有效范围（0 ~ ' + (state.audio.frameCount - 2) + '）');
    if (v >= state.selection.end) return showError('起点必须早于终点至少 2 帧');
    state.selection.start = v;
    rebuildLoop(true);
  });
  $('endFrame').addEventListener('change', () => {
    if (!state.audio) return;
    const v = parseInt($('endFrame').value, 10);
    if (!Number.isInteger(v)) return showError('终点必须是整数帧');
    if (v <= state.selection.start + 1 || v > state.audio.frameCount) return showError('终点必须大于起点至少 2 帧，且不超过文件末尾 ' + state.audio.frameCount);
    state.selection.end = v;
    rebuildLoop(true);
  });
  $('fadeMs').addEventListener('change', () => {
    const v = parseFloat($('fadeMs').value);
    if (!(v >= 0)) return showError('淡化时长必须是非负数字（毫秒）');
    state.fadeMs = v;
    rebuildLoop(true);
  });
  document.querySelectorAll('button[data-fade]').forEach((b) => {
    b.addEventListener('click', () => {
      state.fadeMs = parseFloat(b.dataset.fade);
      $('fadeMs').value = state.fadeMs;
      rebuildLoop(true);
    });
  });

  /* ---------- 区间/淡化变化：重建循环并刷新所有显示，立即停止旧试听 ---------- */
  function rebuildLoop(stopPlayback) {
    if (!state.audio || !state.selection) return;
    const sr = state.audio.sampleRate;
    try {
      const fadeFrames = LoopCore.msToFrames(state.fadeMs, sr);
      const built = LoopCore.buildLoop(state.audio.data, state.selection.start, state.selection.end, fadeFrames);
      state.loop = built;
      if (stopPlayback && player.playing) {
        player.stop();
        syncPlayState();
        showInfo('区间已更新，旧的试听已停止');
      }
      refreshReadouts(built);
      draw();
    } catch (err) {
      showError(err.message || String(err));
    }
  }

  function fmt(x, digits) { return Number(x).toFixed(digits); }

  function refreshReadouts(built) {
    const sr = state.audio.sampleRate;
    const s = state.selection;
    $('startFrame').value = s.start;
    $('endFrame').value = s.end;
    $('lenFrames').value = built.config.lengthFrames;
    $('lenMs').value = fmt(LoopCore.framesToMs(built.config.lengthFrames, sr), 3);
    $('fadeFrames').value = built.config.fadeFrames +
      (built.config.fadeClamped ? '（已按区间一半上限收敛）' : '');
    $('exportLen').value = built.lengthFrames + ' 帧 / ' + fmt(LoopCore.framesToMs(built.lengthFrames, sr), 3) + ' ms';

    const raw = LoopCore.rawSeamJump(state.audio.data, s.start, s.end);
    const after = LoopCore.loopSeamJump(built.channels);
    renderSeam($('rawSeam'), raw);
    renderSeam($('loopSeam'), after);
  }

  function renderSeam(el, vals) {
    const labels = state.audio.channels === 2 ? ['L', 'R'] : ['M'];
    el.textContent = vals.map((v, i) => labels[i] + '=' + v.toExponential(2)).join('  ');
    const worst = Math.max.apply(null, vals);
    el.classList.toggle('bad', worst > 0.02);
    el.classList.toggle('good', worst <= 0.02);
    el.classList.toggle('muted', false);
  }

  /* ---------- 播放 ---------- */
  function syncPlayState() {
    const playing = player.playing;
    $('stopBtn').disabled = !playing;
    $('playState').textContent = playing
      ? (player.mode === 'loop' ? '循环试听中…' : '播放原始声音…')
      : '已停止';
  }

  $('playOriginal').addEventListener('click', () => {
    if (!state.audio) return;
    try {
      const buf = player.makeBuffer(state.audio.data, state.audio.sampleRate);
      player.play(buf, 'original', 1, 0);
      syncPlayState();
    } catch (err) { showError(err.message || String(err)); }
  });

  $('playLoop').addEventListener('click', () => {
    if (!state.audio || !state.loop) return;
    try {
      rebuildLoop(false); // 确保最新参数
      const buf = player.makeBuffer(state.loop.channels, state.audio.sampleRate);
      const rounds = Math.max(0, parseInt($('rounds').value, 10) || 0);
      player.play(buf, 'loop', rounds, 0);
      syncPlayState();
    } catch (err) { showError(err.message || String(err)); }
  });

  $('stopBtn').addEventListener('click', () => { player.stop(); syncPlayState(); });

  /* ---------- 导出 ---------- */
  $('exportBtn').addEventListener('click', () => {
    if (!state.audio || !state.loop) return showError('请先导入 WAV 并选择有效区间');
    try {
      const sr = state.audio.sampleRate;
      const s = state.selection;
      const built = state.loop;
      if (built.lengthFrames <= 0) throw new Error('循环长度为 0，已阻止导出');
      const wavBuf = WavCodec.encodeWav16(built.channels, sr);
      const base = (state.fileName || 'sound').replace(/\.wav$/i, '');
      const sidecar = {
        tool: 'local-sfx-loop-maker',
        exportedAt: new Date().toISOString(),
        sourceFile: state.fileName,
        sourceSampleRate: sr,
        sourceChannels: state.audio.channels,
        sourceBitDepth: state.audio.bitDepth,
        sourceEncoding: state.audio.encoding,
        sourceTotalFrames: state.audio.frameCount,
        loop: {
          startFrame: s.start,
          endFrame: s.end,
          endFrameRule: 'exclusive（终点帧不包含在区间内）',
          selectedLengthFrames: built.config.lengthFrames,
          crossfadeFrames: built.config.fadeFrames,
          crossfadeMs: Number(LoopCore.framesToMs(built.config.fadeFrames, sr).toFixed(4)),
          crossfadeAlgorithm: 'seam-centered linear equal-gain circular crossfade',
          exportedLengthFrames: built.lengthFrames,
          exportedDurationMs: Number(LoopCore.framesToMs(built.lengthFrames, sr).toFixed(4)),
          exportedSampleRate: sr,
          exportedChannels: state.audio.channels,
          exportedBitDepth: 16,
          exportedEncoding: 'PCM',
          rawSeamJumpPerChannel: LoopCore.rawSeamJump(state.audio.data, s.start, s.end),
          loopSeamJumpPerChannel: LoopCore.loopSeamJump(built.channels),
        },
      };
      downloadBlob(new Blob([wavBuf], { type: 'audio/wav' }), base + '.loop.wav');
      downloadBlob(new Blob([JSON.stringify(sidecar, null, 2)], { type: 'application/json' }), base + '.loop.json');
      showInfo('已导出 ' + base + '.loop.wav 与区间说明 ' + base + '.loop.json');
    } catch (err) { showError(err.message || String(err)); }
  });

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  /* ---------- 核对导出结果 ---------- */
  $('verifyInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    const wavFile = files.find((f) => /\.wav$/i.test(f.name));
    const jsonFile = files.find((f) => /\.json$/i.test(f.name));
    if (!wavFile) return showError('请同时选择导出的 .loop.wav（可附带 .loop.json）');
    try {
      const audio = WavCodec.decodeWav(await wavFile.arrayBuffer());
      let sc = null;
      if (jsonFile) {
        try {
          sc = JSON.parse(await jsonFile.text());
          if (!sc || typeof sc !== 'object' || !sc.loop) {
            showError('区间说明 JSON 结构不符，将仅回读 WAV');
            sc = null;
          }
        } catch (jsonErr) {
          showError('区间说明 JSON 无法解析（' + jsonErr.message + '），将仅回读 WAV');
        }
      }
      renderVerify(wavFile.name, audio, sc);
    } catch (err) { showError('核对失败：' + (err.message || String(err))); }
  });

  function renderVerify(name, audio, sc) {
    const rows = [];
    const add = (k, actual, expect, ok) => rows.push({ k, actual, expect, ok });
    const loop = sc && sc.loop ? sc.loop : null;
    add('文件', name, sc ? sc.sourceFile + ' 的循环导出' : '无说明文件（仅做 WAV 回读）', null);
    add('采样率', audio.sampleRate + ' Hz', loop ? loop.exportedSampleRate + ' Hz' : '—',
      loop ? audio.sampleRate === loop.exportedSampleRate : null);
    add('声道数', audio.channels + (audio.channels === 2 ? '（双声道）' : '（单声道）'),
      loop ? loop.exportedChannels + '' : '—', loop ? audio.channels === loop.exportedChannels : null);
    add('位深/编码', audio.bitDepth + '-bit ' + audio.encoding,
      loop ? loop.exportedBitDepth + '-bit ' + loop.exportedEncoding : '16-bit PCM',
      loop ? audio.bitDepth === loop.exportedBitDepth && audio.encoding === loop.exportedEncoding
        : audio.bitDepth === 16 && audio.encoding === 'PCM');
    add('帧数/循环时长', audio.frameCount + ' 帧 / ' + audio.durationSec.toFixed(4) + ' 秒',
      loop ? loop.exportedLengthFrames + ' 帧 / ' + (loop.exportedDurationMs / 1000).toFixed(4) + ' 秒' : '—',
      loop ? audio.frameCount === loop.exportedLengthFrames : null);
    if (loop) {
      add('循环起点 / 终点', loop.startFrame + ' / ' + loop.endFrame + '（不含）',
        '源文件共 ' + sc.sourceTotalFrames + ' 帧',
        loop.startFrame >= 0 && loop.endFrame <= sc.sourceTotalFrames && loop.endFrame - loop.startFrame >= 2);
      add('淡化', loop.crossfadeFrames + ' 帧 / ' + loop.crossfadeMs + ' ms',
        '长度关系 L-F=' + (loop.selectedLengthFrames - loop.crossfadeFrames),
        audio.frameCount === loop.selectedLengthFrames - loop.crossfadeFrames);
    }
    const seam = LoopCore.loopSeamJump(audio.data);
    const seamOk = Math.max.apply(null, seam) <= 0.02;
    add('回读接缝跳变', seam.map((v, i) => (audio.channels === 2 ? (i === 0 ? 'L' : 'R') : 'M') + '=' + v.toExponential(2)).join(' '),
      '阈值 2.0e-2', seamOk);

    const html = '<table><tr><th>项目</th><th>实际回读</th><th>说明文件/期望</th><th>结果</th></tr>' +
      rows.map((r) => '<tr><td>' + r.k + '</td><td>' + r.actual + '</td><td>' + r.expect + '</td><td>' +
        (r.ok === null ? '—' : r.ok ? '<span class="ok-text">✓ 一致</span>' : '<span class="bad-text">✗ 不一致</span>') +
        '</td></tr>').join('') + '</table>';
    $('verifyContent').innerHTML = html;
    $('verifyPanel').hidden = false;
    showInfo(seamOk ? '核对完成，接缝跳变在阈值内' : '核对完成，但接缝跳变偏大');
  }

  /* ---------- 播放头动画 ---------- */
  function tick() {
    if (player.playing) draw();
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
  resizeCanvas();
})();
