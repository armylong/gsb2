const $ = id => document.getElementById(id);
let nch = 0;

async function api(url, opts) {
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!r.ok) {
    const e = new Error(data.error || r.statusText);
    e.status = r.status; e.data = data;
    throw e;
  }
  return data;
}
const jsonPost = body => ({
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify(body),
});

async function refreshLists() {
  const t = await api('/api/testfiles');
  $('testFiles').innerHTML = t.files.map(f => `<option>${f}</option>`).join('')
    || '<option value="">(先运行 make_test_tones.py)</option>';
  const p = await api('/api/presets');
  $('presets').innerHTML = p.files.map(f => `<option>${f}</option>`).join('');
}

async function loadTest() {
  const name = $('testFiles').value;
  if (!name) return;
  try { onLoaded(await api('/api/load', jsonPost({name}))); }
  catch (e) { $('fileInfo').textContent = '加载失败: ' + e.message; }
}

async function upload() {
  const f = $('upload').files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('file', f);
  try { onLoaded(await api('/api/load', {method: 'POST', body: fd})); }
  catch (e) { $('fileInfo').textContent = '加载失败: ' + e.message; }
}

function onLoaded(d) {
  nch = d.channels;
  $('fileInfo').textContent =
    `文件 ${d.name}: ${d.channels} 声道 · ${d.sampleRate} Hz · 共 ${d.samples} 采样 (${d.seconds.toFixed(3)} 秒)`;
  drawWaves(d.channelData);
  buildMatrix(d.channels);
  $('stats').textContent = '尚未处理';
}

function drawWaves(chans) {
  const box = $('waves');
  box.innerHTML = '';
  for (const ch of chans) {
    const label = document.createElement('div');
    label.className = 'wlabel';
    label.textContent = `声道 ${ch.index}(按文件顺序)· 峰值 ${ch.peak.toFixed(4)}`;
    const cv = document.createElement('canvas');
    cv.width = 960; cv.height = 70;
    box.appendChild(label); box.appendChild(cv);
    const ctx = cv.getContext('2d');
    ctx.strokeStyle = '#6bd88a';
    ctx.beginPath();
    const n = ch.min.length, mid = cv.height / 2, amp = cv.height / 2 - 2;
    for (let i = 0; i < n; i++) {
      const x = i * cv.width / n;
      ctx.moveTo(x, mid - ch.max[i] * amp);
      ctx.lineTo(x, mid - ch.min[i] * amp);
    }
    ctx.stroke();
    ctx.strokeStyle = '#333a45';
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(cv.width, mid); ctx.stroke();
  }
}

function buildMatrix(n) {
  const tb = document.querySelector('#matrix tbody');
  tb.innerHTML = '';
  for (let i = 0; i < n; i++) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>声道 ${i + 1}</td>` +
      `<td><input type="checkbox" class="inv"></td>` +
      `<td><input type="number" class="dly" min="0" max="960" step="1" value="0" style="width:70px"></td>` +
      `<td><input type="checkbox" class="lon"></td>` +
      `<td><input type="number" class="lg" min="0" max="1" step="0.01" value="1.00" style="width:64px"></td>` +
      `<td><input type="checkbox" class="ron"></td>` +
      `<td><input type="number" class="rg" min="0" max="1" step="0.01" value="1.00" style="width:64px"></td>`;
    tb.appendChild(tr);
  }
}

function collectSettings() {
  const rows = document.querySelectorAll('#matrix tbody tr');
  const channels = [...rows].map(tr => ({
    invert: tr.querySelector('.inv').checked,
    delay: Math.max(0, Math.min(960, parseInt(tr.querySelector('.dly').value || '0', 10))),
    L: {on: tr.querySelector('.lon').checked,
        gain: Math.max(0, Math.min(1, parseFloat(tr.querySelector('.lg').value || '0')))},
    R: {on: tr.querySelector('.ron').checked,
        gain: Math.max(0, Math.min(1, parseFloat(tr.querySelector('.rg').value || '0')))},
  }));
  return {channels, protect: $('protect').checked};
}

async function applyPreset() {
  const name = $('presets').value;
  if (!name || !nch) return;
  const p = await api('/api/preset/' + encodeURIComponent(name));
  $('presetDesc').textContent = p.description || '';
  const rows = document.querySelectorAll('#matrix tbody tr');
  rows.forEach((tr, i) => {
    const c = p.channels[i];
    if (!c) return;
    tr.querySelector('.inv').checked = !!c.invert;
    tr.querySelector('.dly').value = c.delay || 0;
    tr.querySelector('.lon').checked = !!(c.L && c.L.on);
    tr.querySelector('.lg').value = (c.L && c.L.gain != null) ? c.L.gain : 0;
    tr.querySelector('.ron').checked = !!(c.R && c.R.on);
    tr.querySelector('.rg').value = (c.R && c.R.gain != null) ? c.R.gain : 0;
  });
}

const db = v => v > 0 ? (20 * Math.log10(v)).toFixed(2) + ' dBFS' : '-∞';

function showStats(s) {
  const corr = s.corr === null ? '无有效值(静音或直流)' : s.corr.toFixed(4);
  const clipLine = s.clipping
    ? (s.atten < 1
        ? `<span class="warn">保护前超满幅,已统一衰减 ×${s.atten.toFixed(6)} (${s.atten_db.toFixed(2)} dB)</span>`
        : `<span class="bad">警告:输出超出 16 位可表示范围且峰值保护已关闭,直接导出会削波!</span>`)
    : '<span class="good">峰值在可表示范围内</span>';
  $('stats').innerHTML =
    `保护前峰值  L ${s.peak_pre_l.toFixed(6)} (${db(s.peak_pre_l)})   R ${s.peak_pre_r.toFixed(6)} (${db(s.peak_pre_r)})\n` +
    `保护后峰值  L ${s.peak_post_l.toFixed(6)} (${db(s.peak_post_l)})   R ${s.peak_post_r.toFixed(6)} (${db(s.peak_post_r)})\n` +
    `统一衰减量  ×${s.atten.toFixed(6)} (${s.atten === 1 ? '0.00 dB,未衰减' : s.atten_db.toFixed(2) + ' dB'})\n` +
    `左右相关程度 ${corr}\n` +
    `单声道合听峰值 ${s.mono_peak.toFixed(6)} (${db(s.mono_peak)})\n` + clipLine;
}

async function apply() {
  if (!nch) return;
  try {
    const d = await api('/api/process', jsonPost(collectSettings()));
    showStats(d.stats);
    $('audProc').src = d.audition.processed;
    $('audSrc').src = d.audition.source;
    $('audMono').src = d.audition.mono;
  } catch (e) { $('stats').textContent = '处理失败: ' + e.message; }
}

async function doExport() {
  if (!nch) return;
  const s = collectSettings();
  s.allowClip = $('allowClip').checked;
  try {
    const d = await api('/api/export', jsonPost(s));
    $('allowClipWrap').hidden = true;
    const rb = d.readback;
    $('exportResult').innerHTML =
      `已导出 <a href="${d.file}">${d.name}</a> · 共 ${d.samples} 采样(与输入一致)\n` +
      `回读校验: ${rb.ok ? '<span class="good">通过</span>' : '<span class="bad">失败</span>'}` +
      `(与预期最大偏差 ${rb.maxDiffLsb} LSB,允许 ≤1)`;
  } catch (e) {
    if (e.status === 409) $('allowClipWrap').hidden = false;
    $('exportResult').innerHTML = `<span class="bad">${e.message}</span>`;
  }
}

$('btnLoadTest').onclick = loadTest;
$('upload').onchange = upload;
$('btnPreset').onclick = applyPreset;
$('btnApply').onclick = apply;
$('btnExport').onclick = doExport;
refreshLists();
