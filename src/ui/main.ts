import { Vector3 } from 'three';
import { Skeleton } from '../core/skeleton';
import type { PoseFrame } from '../core/skeleton';
import { JOINT_LABELS, ROOT_NAME, createSourceDef, createTargetDef } from '../core/skeletons';
import { ClipSampler, createClips } from '../core/clips';
import type { MotionClip } from '../core/clips';
import {
  buildRetargetedMotion,
  defaultMapping,
  parseMapping,
  parseMotion,
  retargetFrame,
  serializeMapping,
  serializeMotion,
  validateMapping,
} from '../core/retarget';
import type { JointMapping, RetargetedMotion, RootMotionMode } from '../core/retarget';
import { inspectPair, formatVec3 } from '../core/inspect';
import { PuppetView, SOURCE_PALETTE, TARGET_PALETTE } from '../three/puppet';
import { ViewerScene } from '../three/scene';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const source = new Skeleton(createSourceDef());
const target = new Skeleton(createTargetDef());
const clips = createClips();
const samplers = new Map<string, ClipSampler>(clips.map((c) => [c.id, new ClipSampler(c)]));

let mapping: JointMapping = defaultMapping(source, target);
let activeClip: MotionClip = clips[0];
let importedMotion: RetargetedMotion | null = null;
let time = 0;
let playing = false;
let rootMode: RootMotionMode = 'height';
let showTrail = true;
let sourceRestOnly = false;
let targetRestOnly = false;
let selectedJoint: string | null = 'lknee';
let lastFrameStamp: number | null = null;

const viewer = new ViewerScene($('viewer'));
const sourceView = new PuppetView(source, SOURCE_PALETTE);
const targetView = new PuppetView(target, TARGET_PALETTE);
viewer.addPuppet(sourceView, viewer.sourceOffset);
viewer.addPuppet(targetView, viewer.targetOffset);
viewer.attachPickMeshes([
  { view: sourceView, prefix: 'src' },
  { view: targetView, prefix: 'tgt' },
]);

function download(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function readJsonFile(input: HTMLInputElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const file = input.files?.[0];
    if (!file) {
      reject(new Error('未选择文件'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'));
    reader.readAsText(file);
    input.value = '';
  });
}

const IMPORTED_CLIP_ID = '__imported__';

/** 当前片段在给定时间的源帧；导入的动作数据是目标帧，不走这里 */
function sourceFrameAt(t: number): PoseFrame {
  const sampler = samplers.get(activeClip.id);
  if (!sampler) throw new Error(`找不到片段采样器: ${activeClip.id}`);
  return sampler.sample(t, source);
}

/** 导入动作的最近采样帧（已经是目标骨架的帧，直接应用、不再重定向） */
function importedFrameAt(t: number): PoseFrame {
  const frames = importedMotion!.frames;
  let best = frames[0];
  let bestDist = Infinity;
  for (const f of frames) {
    const d = Math.abs(f.time - t);
    if (d < bestDist) {
      bestDist = d;
      best = f;
    }
  }
  return best;
}

function currentTargetFrame(srcFrame: PoseFrame): PoseFrame {
  const { usable } = validateMapping(source, target, mapping);
  return retargetFrame(source, target, usable, srcFrame, rootMode);
}

function rebuildTrail(): void {
  if (!showTrail || rootMode === 'keep') {
    viewer.clearTrail();
    return;
  }
  const points: Vector3[] = [];
  const steps = 40;
  for (let k = 0; k <= steps; k++) {
    const t = (activeClip.duration * k) / steps;
    if (importedMotion) {
      points.push(new Vector3(...importedFrameAt(t).rootPos).add(viewer.targetOffset));
    } else {
      const f = sourceFrameAt(t);
      source.applyFrame(f);
      const out = currentTargetFrame(f);
      points.push(new Vector3(...out.rootPos).add(viewer.targetOffset));
    }
  }
  viewer.updateTrail(points);
}

function refresh(): void {
  if (importedMotion) {
    // 导入复现模式：源显示静止参考姿势，目标直接播放导入的帧
    source.applyRest();
    if (targetRestOnly) target.applyRest();
    else target.applyFrame(importedFrameAt(time));
  } else {
    const frame = sourceFrameAt(time);
    if (sourceRestOnly) source.applyRest();
    else source.applyFrame(frame);
    if (targetRestOnly) target.applyRest();
    else target.applyFrame(currentTargetFrame(frame));
  }

  sourceView.update();
  targetView.update();
  updateSelectionGizmo();
  updateInspection();
  viewer.render();
}

function updateSelectionGizmo(): void {
  if (selectedJoint && source.has(selectedJoint)) sourceView.setSelected(selectedJoint);
  else sourceView.setSelected(null);
  const tgtName = selectedJoint ? mapping[selectedJoint] : undefined;
  if (tgtName && target.has(tgtName)) targetView.setSelected(tgtName);
  else targetView.setSelected(null);
}

function updateInspection(): void {
  const box = $('inspect-content');
  if (!selectedJoint || !source.has(selectedJoint)) {
    box.textContent = '未选中关节';
    return;
  }
  const tgtName = mapping[selectedJoint];
  if (!tgtName || !target.has(tgtName)) {
    box.innerHTML = `源关节「${label(selectedJoint)}」没有可用的目标对应，无法检视`;
    return;
  }
  const r = inspectPair(source, target, selectedJoint, tgtName);
  const axisRow = (name: string, opp: boolean): string =>
    `<tr><td>${name} 轴</td><td class="${opp ? 'axis-opposite' : 'axis-same'}">${
      opp ? '朝向相反' : '朝向一致'
    }</td></tr>`;
  box.innerHTML = `
    <table>
      <tr><th></th><th>源：${label(r.sourceName)}</th><th>目标：${label(r.targetName)}</th></tr>
      <tr><td>局部 X 轴（世界）</td><td>${formatVec3(r.source.x)}</td><td>${formatVec3(r.target.x)}</td></tr>
      <tr><td>局部 Y 轴（世界）</td><td>${formatVec3(r.source.y)}</td><td>${formatVec3(r.target.y)}</td></tr>
      <tr><td>局部 Z 轴（世界）</td><td>${formatVec3(r.source.z)}</td><td>${formatVec3(r.target.z)}</td></tr>
      <tr><td>静止骨头指向</td><td>${formatVec3(r.sourceRestBoneDir)}</td><td>${formatVec3(r.targetRestBoneDir)}</td></tr>
      <tr><td>当前实际指向</td><td>${formatVec3(r.sourceCurrentBoneDir)}</td><td>${formatVec3(r.targetCurrentBoneDir)}</td></tr>
      <tr><td>弯曲角（度）</td><td>${r.sourceBendDeg.toFixed(1)}°</td><td>${r.targetBendDeg.toFixed(1)}°</td></tr>
      <tr><td>局部欧拉角（度）</td><td>${r.source.localEulerDeg.map((n) => n.toFixed(1)).join(', ')}</td><td>${r.target.localEulerDeg.map((n) => n.toFixed(1)).join(', ')}</td></tr>
      ${axisRow('X', r.oppositeAxes.x)}
      ${axisRow('Y', r.oppositeAxes.y)}
      ${axisRow('Z', r.oppositeAxes.z)}
    </table>`;
}

function label(name: string): string {
  return JOINT_LABELS[name] ?? name;
}

function buildClipSelect(): void {
  const sel = $<HTMLSelectElement>('clip-select');
  sel.innerHTML = '';
  for (const c of clips) {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  $('duration-label').textContent = `时长 ${activeClip.duration.toFixed(1)} s`;
}

function buildInspectSelect(): void {
  const sel = $<HTMLSelectElement>('inspect-select');
  sel.innerHTML = '';
  for (const name of source.jointNames) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = label(name);
    sel.appendChild(opt);
  }
  sel.value = selectedJoint ?? '';
}

function buildMappingList(): void {
  const list = $('mapping-list');
  list.innerHTML = '';
  const validation = validateMapping(source, target, mapping);
  const issueBox = $('mapping-issues');
  issueBox.innerHTML = validation.issues
    .map(
      (i) =>
        `<div class="issue ${i.kind}">${i.message}（${
          i.kind === 'missing'
            ? '缺失目标'
            : i.kind === 'duplicate'
              ? '重复配置'
              : '目标不存在'
        }）</div>`,
    )
    .join('');

  for (const srcName of source.jointNames) {
    const tgt = mapping[srcName] ?? '';
    const hasIssue = validation.issues.some(
      (i) =>
        i.source === srcName ||
        (i.kind === 'duplicate' && i.sources?.includes(srcName)),
    );
    const row = document.createElement('div');
    row.className =
      'mapping-row' + (hasIssue ? ' bad' : '') + (srcName === selectedJoint ? ' selected' : '');
    const srcLabel = document.createElement('span');
    srcLabel.textContent = label(srcName) + (srcName === ROOT_NAME ? '（根）' : '');
    const sel = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = '（无对应）';
    sel.appendChild(none);
    for (const tName of target.jointNames) {
      const opt = document.createElement('option');
      opt.value = tName;
      opt.textContent = label(tName);
      sel.appendChild(opt);
    }
    sel.value = tgt;
    sel.addEventListener('change', () => {
      if (sel.value === '') delete mapping[srcName];
      else mapping[srcName] = sel.value;
      buildMappingList();
      rebuildTrail();
      refresh();
    });
    row.append(srcLabel, sel);
    list.appendChild(row);
  }
}

function setTime(t: number): void {
  time = Math.min(Math.max(t, 0), activeClip.duration);
  const slider = $<HTMLInputElement>('time-slider');
  slider.max = String(activeClip.duration);
  slider.value = String(time);
  $('time-label').textContent = `t = ${time.toFixed(2)} s`;
  refresh();
}

function tick(now: number): void {
  if (playing) {
    if (lastFrameStamp === null) lastFrameStamp = now;
    const dt = (now - lastFrameStamp) / 1000;
    lastFrameStamp = now;
    let next = time + dt;
    if (next >= activeClip.duration) {
      next = activeClip.duration;
      playing = false;
      $('play-btn').textContent = '播放';
    }
    setTime(next);
  } else {
    lastFrameStamp = null;
  }
  requestAnimationFrame(tick);
}

function exportCurrentMotion(): void {
  if (importedMotion) {
    alert('当前是导入复现模式，请先在片段选择中切回自带片段再导出');
    return;
  }
  const sampleRate = 30;
  const frames: PoseFrame[] = [];
  const step = 1 / sampleRate;
  for (let t = 0; t < activeClip.duration - 1e-9; t += step) {
    frames.push(sourceFrameAt(t));
  }
  frames.push(sourceFrameAt(activeClip.duration));
  const { usable } = validateMapping(source, target, mapping);
  const data = buildRetargetedMotion(
    source,
    target,
    usable,
    activeClip.id,
    activeClip.name,
    frames,
    rootMode,
    sampleRate,
  );
  download(`target-motion-${activeClip.id}.json`, serializeMotion(data));
  $('motion-status').textContent =
    `已导出 ${frames.length} 帧（${data.sampleRate} fps，身高换算系数 ${data.heightScale.toFixed(2)}）`;
}

// ---------- 事件接线 ----------
$<HTMLSelectElement>('clip-select').addEventListener('change', (e) => {
  const id = (e.target as HTMLSelectElement).value;
  if (id === IMPORTED_CLIP_ID && importedMotion) return; // 导入模式保持当前状态
  const clip = clips.find((c) => c.id === id);
  if (!clip) return;
  activeClip = clip;
  importedMotion = null;
  playing = false;
  $('play-btn').textContent = '播放';
  $('duration-label').textContent = `时长 ${clip.duration.toFixed(1)} s`;
  setTime(0);
  rebuildTrail();
});

$('play-btn').addEventListener('click', () => {
  if (time >= activeClip.duration - 1e-6) setTime(0);
  playing = !playing;
  $('play-btn').textContent = playing ? '暂停' : '播放';
});

$('rest-btn').addEventListener('click', () => {
  playing = false;
  $('play-btn').textContent = '播放';
  setTime(0);
  source.applyRest();
  target.applyRest();
  sourceView.update();
  targetView.update();
  updateSelectionGizmo();
  updateInspection();
  viewer.render();
});

$<HTMLInputElement>('time-slider').addEventListener('input', (e) => {
  playing = false;
  $('play-btn').textContent = '播放';
  setTime(Number((e.target as HTMLInputElement).value));
});

document.querySelectorAll<HTMLInputElement>('input[name="root-mode"]').forEach((radio) => {
  radio.addEventListener('change', () => {
    rootMode = radio.value as RootMotionMode;
    rebuildTrail();
    refresh();
  });
});

$<HTMLInputElement>('trail-toggle').addEventListener('change', (e) => {
  showTrail = (e.target as HTMLInputElement).checked;
  rebuildTrail();
  refresh();
});

$<HTMLInputElement>('src-rest-toggle').addEventListener('change', (e) => {
  sourceRestOnly = (e.target as HTMLInputElement).checked;
  refresh();
});
$<HTMLInputElement>('tgt-rest-toggle').addEventListener('change', (e) => {
  targetRestOnly = (e.target as HTMLInputElement).checked;
  refresh();
});

$('mapping-reset-btn').addEventListener('click', () => {
  mapping = defaultMapping(source, target);
  buildMappingList();
  rebuildTrail();
  refresh();
});

$('mapping-save-btn').addEventListener('click', () => {
  download('joint-mapping.json', serializeMapping(mapping));
});

$('mapping-load-btn').addEventListener('click', () => $('mapping-file').click());
$<HTMLInputElement>('mapping-file').addEventListener('change', async (e) => {
  try {
    const text = await readJsonFile(e.target as HTMLInputElement);
    mapping = parseMapping(text);
    buildMappingList();
    rebuildTrail();
    refresh();
  } catch (err) {
    alert(`载入对应失败：${err instanceof Error ? err.message : String(err)}`);
  }
});

$<HTMLSelectElement>('inspect-select').addEventListener('change', (e) => {
  selectedJoint = (e.target as HTMLSelectElement).value;
  buildMappingList();
  refresh();
});

viewer.setPickHandler((picked) => {
  if (picked === null) return;
  const [side, name] = picked.split(':');
  if (side === 'src') {
    selectedJoint = name;
  } else {
    const srcEntry = Object.entries(mapping).find(([, t]) => t === name);
    if (srcEntry) selectedJoint = srcEntry[0];
    else {
      selectedJoint = name; // 同名默认对应存在时也能检视
    }
  }
  $<HTMLSelectElement>('inspect-select').value = selectedJoint ?? '';
  buildMappingList();
  refresh();
});

$('export-btn').addEventListener('click', exportCurrentMotion);

$('motion-load-btn').addEventListener('click', () => $('motion-file').click());
$<HTMLInputElement>('motion-file').addEventListener('change', async (e) => {
  try {
    const text = await readJsonFile(e.target as HTMLInputElement);
    importedMotion = parseMotion(text);
    activeClip = {
      id: IMPORTED_CLIP_ID,
      name: `${importedMotion.clipName}（导入复现）`,
      duration: importedMotion.duration,
      keyframes: [],
    };
    rootMode = importedMotion.mode;
    document
      .querySelectorAll<HTMLInputElement>('input[name="root-mode"]')
      .forEach((r) => (r.checked = r.value === rootMode));
    const clipSel = $<HTMLSelectElement>('clip-select');
    let opt = Array.from(clipSel.options).find((o) => o.value === IMPORTED_CLIP_ID);
    if (!opt) {
      opt = document.createElement('option');
      opt.value = IMPORTED_CLIP_ID;
      clipSel.appendChild(opt);
    }
    opt.textContent = activeClip.name;
    clipSel.value = IMPORTED_CLIP_ID;
    $('duration-label').textContent = `时长 ${activeClip.duration.toFixed(1)} s`;
    $('motion-status').textContent =
      `已载入 ${importedMotion.frames.length} 帧，可拖动时间条复现起始/中段/末帧`;
    setTime(0);
    rebuildTrail();
  } catch (err) {
    alert(`载入动作失败：${err instanceof Error ? err.message : String(err)}`);
  }
});

// ---------- 初始化 ----------
buildClipSelect();
buildInspectSelect();
buildMappingList();
setTime(0);
rebuildTrail();
requestAnimationFrame(tick);
