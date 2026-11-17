/* 局部隐私遮挡工具前端 */
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const timeline = document.getElementById('timeline');
const tctx = timeline.getContext('2d');
const $ = id => document.getElementById(id);

const LEVEL_COLOR = { high: '#39d353', medium: '#ffd75e', low: '#ff5555' };

let info = null;          // 视频信息
let cur = 0;              // 当前帧
let playing = false;
let playTimer = null;
let boxesData = null;     // /api/boxes 返回
let draft = null;         // 正在拖出的矩形(视频坐标)
let pendingBox = null;    // 尚未设置区域的框选
let dragStart = null;
const imgCache = new Map();

function videoScale() { return info ? cv.width / info.width : 1; }
function toVideo(e) {
  const r = cv.getBoundingClientRect();
  const sx = info.width / r.width, sy = info.height / r.height;
  return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
}

function getImage(idx) {
  let im = imgCache.get(idx);
  if (!im) {
    im = new Image();
    im.onload = () => { if (idx === cur) draw(); };
    im.src = `/api/frame/${idx}`;
    imgCache.set(idx, im);
  }
  return im;
}

function curBox() {
  if (!boxesData) return null;
  return boxesData.boxes[String(cur)] || null;
}

function draw() {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!info) return;
  const im = getImage(cur);
  if (im.complete && im.naturalWidth) ctx.drawImage(im, 0, 0, cv.width, cv.height);
  const s = videoScale();
  const b = curBox();
  const masked = $('chkMask').checked;
  if (b) {
    const col = LEVEL_COLOR[b.level] || '#fff';
    if (masked) {
      ctx.fillStyle = '#000';
      ctx.fillRect(b.x * s, b.y * s, b.w * s, b.h * s);
    }
    ctx.strokeStyle = col;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x * s, b.y * s, b.w * s, b.h * s);
    ctx.fillStyle = col;
    ctx.font = '13px sans-serif';
    const tag = `${b.level} ${b.score.toFixed(2)}${b.keyframe ? ' ✦关键帧' : ''}`;
    ctx.fillText(tag, b.x * s, Math.max(12, b.y * s - 5));
  }
  const d = draft || pendingBox;
  if (d && !masked) {
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#fff';
    ctx.strokeRect(d.x * s, d.y * s, d.w * s, d.h * s);
    ctx.setLineDash([]);
  }
  $('pos').textContent = `帧 ${cur} / ${info.frames - 1}` +
    (b ? `  置信: ${b.level} (${b.score.toFixed(2)})` : '');
  $('slider').value = cur;
  drawTimeline();
}

function drawTimeline() {
  if (!info) return;
  const w = timeline.width = timeline.clientWidth;
  const h = timeline.height;
  tctx.fillStyle = '#14151a';
  tctx.fillRect(0, 0, w, h);
  if (boxesData) {
    for (let f = boxesData.start; f <= boxesData.end; f++) {
      const b = boxesData.boxes[String(f)];
      if (!b) continue;
      tctx.fillStyle = LEVEL_COLOR[b.level];
      tctx.fillRect(f / info.frames * w, 4, Math.max(1, w / info.frames), h - 8);
    }
    tctx.fillStyle = '#fff';
    for (const kf of boxesData.keyframes) {
      tctx.fillRect(kf / info.frames * w - 1, 0, 2, h);
    }
  }
  tctx.fillStyle = '#4a9eff';
  tctx.fillRect(cur / info.frames * w - 1, 0, 2, h);
}

function setFrame(f) {
  if (!info) return;
  cur = Math.max(0, Math.min(info.frames - 1, f));
  draw();
}

function stopPlay() {
  playing = false;
  $('btnPlay').textContent = '▶ 播放';
  if (playTimer) clearInterval(playTimer);
  playTimer = null;
}

async function api(url, opts) {
  const r = await fetch(url, opts);
  return r.json();
}
const post = (url, body) => api(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {})
});

async function waitCompute() {
  for (;;) {
    const st = await api('/api/status');
    if (st.state === 'done') break;
    if (st.state === 'error') { $('hint').textContent = '计算出错: ' + st.error; return false; }
    await new Promise(r => setTimeout(r, 300));
  }
  return true;
}

async function refreshBoxes() {
  boxesData = await api('/api/boxes');
  const lows = boxesData.low_intervals;
  $('lowlist').textContent = lows.length
    ? '⚠ 低置信待检查区间(帧):\n' + lows.map(([a, b]) => `  ${a} - ${b}`).join('\n')
    : '';
  $('kfinfo').textContent = '人工关键帧: ' + boxesData.keyframes.join(', ');
  draw();
}

async function afterChange() {
  $('hint').textContent = '跟踪计算中…';
  if (await waitCompute()) {
    $('hint').textContent = '';
    await refreshBoxes();
  }
}

// ---- 事件 ----
$('btnLoad').onclick = async () => {
  const r = await post('/api/load', { path: $('vpath').value });
  if (r.ok === false) { alert('加载失败:\n' + (r.errors || [r.error]).join('\n')); return; }
  info = r; cur = 0; boxesData = null; pendingBox = null; draft = null;
  imgCache.clear();
  cv.width = 960; cv.height = Math.round(960 * info.height / info.width);
  $('vinfo').textContent = `${info.width}x${info.height}  ${info.fps.toFixed(2)}fps  ` +
    `${info.frames}帧  ${info.duration.toFixed(2)}s  音频:${info.has_audio ? '有' : '无'}`;
  $('inStart').value = 0; $('inEnd').value = info.frames - 1;
  $('slider').max = info.frames - 1;
  $('hint').textContent = '在画面上拖出要遮挡的区域';
  setFrame(0);
};

$('btnSample').onclick = async () => {
  $('hint').textContent = '正在生成样例…';
  const r = await fetch('/api/sample', { method: 'POST' }).then(x => x.json()).catch(() => null);
  if (r && r.video) { $('vpath').value = r.video; $('btnLoad').onclick(); }
  else $('hint').textContent = '样例生成失败';
};

$('btnPlay').onclick = () => {
  if (!info) return;
  if (playing) { stopPlay(); return; }
  playing = true;
  $('btnPlay').textContent = '⏸ 暂停';
  playTimer = setInterval(() => {
    if (cur >= info.frames - 1) { stopPlay(); return; }
    setFrame(cur + 1);
  }, 1000 / info.fps);
};
$('btnPrev').onclick = () => setFrame(cur - 1);
$('btnNext').onclick = () => setFrame(cur + 1);
$('slider').oninput = e => setFrame(+e.target.value);
$('chkMask').onchange = draw;
timeline.onclick = e => {
  const r = timeline.getBoundingClientRect();
  setFrame(Math.round((e.clientX - r.left) / r.width * info.frames));
};

document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') setFrame(cur - 1);
  if (e.key === 'ArrowRight') setFrame(cur + 1);
  if (e.key === ' ') { e.preventDefault(); $('btnPlay').onclick(); }
});

cv.addEventListener('mousedown', e => {
  if (!info) return;
  dragStart = toVideo(e);
  draft = null;
});
cv.addEventListener('mousemove', e => {
  if (!dragStart) return;
  const [x, y] = toVideo(e);
  draft = {
    x: Math.min(dragStart[0], x), y: Math.min(dragStart[1], y),
    w: Math.abs(x - dragStart[0]), h: Math.abs(y - dragStart[1])
  };
  draw();
});
cv.addEventListener('mouseup', async () => {
  if (!dragStart) return;
  dragStart = null;
  if (!draft || draft.w < 8 || draft.h < 8) { draft = null; draw(); return; }
  if (!boxesData) {
    pendingBox = draft;          // 等待“设置遮挡区域”
    $('hint').textContent = '已框选,确认起止帧后点击“以当前框设置遮挡区域”';
  } else {
    // 已有区域:拖框 = 在当前帧添加人工修正关键帧
    const b = draft; draft = null;
    await post('/api/keyframe', { frame: cur, x: b.x, y: b.y, w: b.w, h: b.h });
    $('hint').textContent = `已在第 ${cur} 帧添加修正,重新计算中…`;
    await afterChange();
  }
  draft = null;
  draw();
});

$('btnSetRegion').onclick = async () => {
  if (!pendingBox) { alert('请先在画面上拖出一个区域'); return; }
  const r = await post('/api/region', {
    start: +$('inStart').value, end: +$('inEnd').value, frame: cur,
    x: pendingBox.x, y: pendingBox.y, w: pendingBox.w, h: pendingBox.h
  });
  if (r.error) { alert(r.error); return; }
  pendingBox = null;
  await afterChange();
};

$('btnReset').onclick = async () => {
  await post('/api/reset');
  boxesData = null; pendingBox = null;
  $('lowlist').textContent = ''; $('kfinfo').textContent = '';
  $('hint').textContent = '在画面上拖出要遮挡的区域';
  draw();
};

$('btnDelKf').onclick = async () => {
  const r = await api(`/api/keyframe/${cur}`, { method: 'DELETE' });
  if (r.error) { alert(r.error); return; }
  await afterChange();
};

$('btnExport').onclick = async () => {
  let r = await post('/api/export', {});
  if (r.need_confirm) {
    const txt = r.low_intervals.map(([a, b]) => `  帧 ${a} - ${b}`).join('\n');
    if (!confirm(`仍有低置信待检查区间:\n${txt}\n\n确定继续导出?`)) return;
    r = await post('/api/export', { confirm_low: true });
  }
  if (r.error) { alert(r.error); return; }
  $('exportinfo').textContent = `已导出 ${r.frames} 帧 → ${r.out}`;
};

setInterval(() => { if (info && !playing) { /* 预加载后续帧 */
  for (let i = 1; i <= 3 && cur + i < info.frames; i++) getImage(cur + i);
} }, 400);

draw();
