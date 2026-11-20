import * as THREE from 'three';
import { DebugScene } from './scene/DebugScene';
import { BONE_COLORS, boneName } from './scene/heatmap';
import { PRESETS } from './weights/presets';
import {
  assertStateMatches,
  decodeState,
  encodeState,
  loadFromLocalStorage,
  saveToLocalStorage,
  STORAGE_KEY,
  BonePose,
} from './weights/storage';
import { BONE_COUNT } from './weights/WeightModel';

const container = document.getElementById('viewport')!;
const statusEl = document.getElementById('status')!;
const boneControlsEl = document.getElementById('bone-controls')!;
const vertexInfoEl = document.getElementById('vertex-info')!;
const storageStateEl = document.getElementById('storage-state')!;

function setStatus(message: string): void {
  statusEl.textContent = message;
}

// DebugScene 内部按默认预设、基于几何绑定坐标生成初始权重
const scene = new DebugScene(container, undefined, {
  onWeightsMutated: () => {
    setStatus('权重已更新(归一约束保持)');
  },
  onSelect: (bone, vertex) => {
    highlightBoneCard(bone);
    if (vertex === null) {
      vertexInfoEl.textContent = '未选中顶点（选择模式下点击网格顶点）';
    }
  },
  onVertexPick: (vertex, weights) => {
    renderVertexInfo(vertex, weights);
  },
  onBrushStamp: (changed) => {
    setStatus(`笔刷作用于 ${changed} 个顶点`);
  },
});

let currentPresetId: string = PRESETS.default.id;

// ---------------- 骨骼卡片(选择 / 锁定 / 姿态滑杆) ----------------

interface BoneCardRefs {
  card: HTMLDivElement;
  lockBtn: HTMLButtonElement;
  sliderY: HTMLInputElement;
  sliderZ: HTMLInputElement;
  valY: HTMLSpanElement;
  valZ: HTMLSpanElement;
}

const boneCards: BoneCardRefs[] = [];
const hex = (c: THREE.Color) => `#${c.getHexString()}`;

for (let b = 0; b < BONE_COUNT; b++) {
  const card = document.createElement('div');
  card.className = 'bone-card';
  card.innerHTML = `
    <div class="bone-head">
      <span class="bone-dot" style="background:${hex(BONE_COLORS[b])}"></span>
      <span class="bone-name">${boneName(b)}</span>
      <button class="lock-btn" title="锁定后该骨骼权重不被笔刷与归一化修改">未锁定</button>
    </div>
    <div class="bone-rot">
      <label>平面内旋转 Y <span class="rot-y-val">0°</span></label>
      <input type="range" class="rot-y" min="-90" max="90" step="1" value="0" />
      <label>平面外旋转 Z <span class="rot-z-val">0°</span></label>
      <input type="range" class="rot-z" min="-90" max="90" step="1" value="0" />
    </div>
  `;
  boneControlsEl.appendChild(card);

  const refs: BoneCardRefs = {
    card,
    lockBtn: card.querySelector('.lock-btn')!,
    sliderY: card.querySelector('.rot-y')!,
    sliderZ: card.querySelector('.rot-z')!,
    valY: card.querySelector('.rot-y-val')!,
    valZ: card.querySelector('.rot-z-val')!,
  };
  boneCards.push(refs);

  card.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'BUTTON') return;
    scene.setSelectedBone(b);
  });

  refs.lockBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const locked = scene.getLocked();
    const next = !locked[b];
    scene.setBoneLocked(b, next);
    refs.lockBtn.textContent = next ? '已锁定' : '未锁定';
    refs.lockBtn.classList.toggle('on', next);
    card.classList.toggle('locked', next);
    setStatus(`${boneName(b)}已${next ? '锁定，权重保持不变' : '解锁'}`);
  });

  const onPose = () => {
    const poses: BonePose[] = boneCards.map((r) => ({
      rotY: Number(r.sliderY.value),
      rotZ: Number(r.sliderZ.value),
    }));
    scene.setPose(poses);
    refs.valY.textContent = `${refs.sliderY.value}°`;
    refs.valZ.textContent = `${refs.sliderZ.value}°`;
  };
  refs.sliderY.addEventListener('input', onPose);
  refs.sliderZ.addEventListener('input', onPose);
}

function highlightBoneCard(bone: number): void {
  boneCards.forEach((r, i) => r.card.classList.toggle('selected', i === bone));
}
highlightBoneCard(0);

function syncPoseSliders(poses: BonePose[]): void {
  poses.forEach((p, b) => {
    boneCards[b].sliderY.value = String(p.rotY);
    boneCards[b].sliderZ.value = String(p.rotZ);
    boneCards[b].valY.textContent = `${Math.round(p.rotY)}°`;
    boneCards[b].valZ.textContent = `${Math.round(p.rotZ)}°`;
  });
}

// ---------------- 视图开关 ----------------

document.getElementById('show-heatmap')!.addEventListener('change', (e) => {
  scene.setHeatmapVisible((e.target as HTMLInputElement).checked);
});
document.getElementById('show-skeleton')!.addEventListener('change', (e) => {
  scene.setSkeletonVisible((e.target as HTMLInputElement).checked);
});
document.getElementById('wireframe')!.addEventListener('change', (e) => {
  scene.setWireframe((e.target as HTMLInputElement).checked);
});

const legend = document.getElementById('heatmap-legend')!;
legend.innerHTML = `<span>0</span><div class="legend-bar"></div><span>1</span>`;

// ---------------- 笔刷 ----------------

document.querySelectorAll<HTMLButtonElement>('#brush-mode button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#brush-mode button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const mode = btn.dataset.mode as 'select' | 'add' | 'subtract';
    scene.setBrush({ mode });
    setStatus(mode === 'select' ? '选择/查看模式' : mode === 'add' ? '加权重笔刷：拖动修改' : '减权重笔刷：拖动修改');
  });
});

const radiusInput = document.getElementById('brush-radius') as HTMLInputElement;
const strengthInput = document.getElementById('brush-strength') as HTMLInputElement;
radiusInput.addEventListener('input', () => {
  document.getElementById('radius-val')!.textContent = Number(radiusInput.value).toFixed(2);
  scene.setBrush({ radius: Number(radiusInput.value) });
});
strengthInput.addEventListener('input', () => {
  document.getElementById('strength-val')!.textContent = Number(strengthInput.value).toFixed(2);
  scene.setBrush({ strength: Number(strengthInput.value) });
});

// ---------------- 预设与姿态 ----------------

document.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.preset as keyof typeof PRESETS;
    currentPresetId = id;
    scene.applyPreset(id);
    setStatus(`已套用预设：${PRESETS[id].label}（锁定骨骼权重保留）`);
  });
});

document.getElementById('demo-pose')!.addEventListener('click', () => {
  // 典型弯曲:肘部在平面内弯折,根部轻微带动,尾部平面外摆动
  const demo: BonePose[] = [
    { rotY: 12, rotZ: 0 },
    { rotY: 48, rotZ: 0 },
    { rotY: 8, rotZ: 26 },
  ];
  scene.setPose(demo);
  syncPoseSliders(demo);
  setStatus('已载入弯曲演示姿态');
});

document.getElementById('reset-pose')!.addEventListener('click', () => {
  scene.resetPose();
  syncPoseSliders(scene.getPoses());
  setStatus('回到绑定姿态：网格复位，权重编辑仍在');
});

document.getElementById('reset-weights')!.addEventListener('click', () => {
  currentPresetId = PRESETS.default.id;
  scene.resetWeights();
  setStatus('已恢复默认权重（锁定骨骼权重保留）');
});

// ---------------- 存档 ----------------

function refreshStorageState(): void {
  const raw = loadFromLocalStorage();
  if (!raw) {
    storageStateEl.textContent = '尚无本地存档';
    storageStateEl.classList.remove('ok');
    return;
  }
  try {
    const s = decodeState(raw);
    storageStateEl.textContent = `存档时间：${new Date(s.savedAt).toLocaleString()}（${s.vertexCount} 顶点）`;
    storageStateEl.classList.add('ok');
  } catch {
    storageStateEl.textContent = '本地存档损坏';
    storageStateEl.classList.remove('ok');
  }
}
refreshStorageState();

document.getElementById('save')!.addEventListener('click', () => {
  const json = encodeState(scene.getWeightsData(), scene.getPoses(), scene.getLocked(), currentPresetId);
  saveToLocalStorage(json);
  refreshStorageState();
  setStatus(`已保存到 localStorage（key=${STORAGE_KEY}）`);
});

document.getElementById('restore')!.addEventListener('click', () => {
  const raw = loadFromLocalStorage();
  if (!raw) {
    setStatus('没有可恢复的存档');
    return;
  }
  try {
    const state = decodeState(raw);
    assertStateMatches(state, scene.vertexCount);
    scene.restoreState(state);
    currentPresetId = state.presetId;
    syncPoseSliders(state.poses);
    state.locked.forEach((isLocked, b) => {
      boneCards[b].lockBtn.textContent = isLocked ? '已锁定' : '未锁定';
      boneCards[b].lockBtn.classList.toggle('on', isLocked);
      boneCards[b].card.classList.toggle('locked', isLocked);
    });
    setStatus('存档已恢复：权重、姿态、锁定状态全部还原');
  } catch (err) {
    setStatus(`恢复失败：${(err as Error).message}`);
  }
});

// 暴露给控制台做手工探查(非必需,方便调试)
(window as unknown as { __debugScene: DebugScene }).__debugScene = scene;

// ---------------- 顶点权重详情 ----------------

function renderVertexInfo(vertex: number, weights: number[]): void {
  const sum = weights.reduce((a, w) => a + w, 0);
  vertexInfoEl.innerHTML = `
    <div class="vmeta">顶点 #${vertex} · 权重和 ${sum.toFixed(4)}</div>
    ${weights
      .map((w, b) => {
        const pct = (w * 100).toFixed(1);
        return `
          <div class="vrow">
            <span class="bone-dot" style="background:${hex(BONE_COLORS[b])}"></span>
            <span class="vlabel">${boneName(b)}</span>
            <span class="bar"><i style="width:${pct}%;background:${hex(BONE_COLORS[b])}"></i></span>
            <span class="vnum">${w.toFixed(4)}</span>
          </div>`;
      })
      .join('')}
  `;
}

setStatus('就绪：点击关节选骨骼，选择模式下点击顶点查看各骨骼贡献');
