/**
 * 标记的 3D 表达：数字徽章精灵（含选中态）+ 接缝标记。
 * 每帧按 marker.s + phase 在当前 path 上重新采样定位，
 * 几何变更后直接重建——材料坐标不变，标记自然跟着带材料走。
 */
import * as THREE from 'three';
import { sampleAt, type BeltPath } from '../math/belt';
import { type MarkerSet } from '../math/markers';
import { makeBadgeTexture } from './textures';
import { BELT_WIDTH } from './beltMesh';

const wrap = (s: number, L: number) => ((s % L) + L) % L;

export interface MarkerObjects {
  group: THREE.Group;
  /** label -> sprite，用于射线拾取 */
  pickables: THREE.Sprite[];
  update: (phase: number) => void;
  dispose: () => void;
}

export function buildMarkerObjects(path: BeltPath, set: MarkerSet): MarkerObjects {
  const group = new THREE.Group();
  const pickables: THREE.Sprite[] = [];
  const entries: { sprite: THREE.Sprite; label: number; s: number }[] = [];

  for (const m of set.markers) {
    if (m.kind === 'arrow' || m.kind === 'tick') continue;
    const tex = makeBadgeTexture(String(m.label), !!m.selected);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: true });
    const sprite = new THREE.Sprite(mat);
    const scale = m.selected ? 0.62 : 0.44;
    sprite.scale.set(scale, scale, 1);
    sprite.userData.label = m.label;
    group.add(sprite);
    pickables.push(sprite);
    entries.push({ sprite, label: m.label!, s: m.s });
  }

  // 选中环
  const ringTex = makeRingTexture();
  const ring = new THREE.Mesh(
    new THREE.PlaneGeometry(0.78, 0.78),
    new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  group.add(ring);
  const selectedEntry = entries.find((e) => set.markers.find((m) => m.label === e.label)?.selected);

  const update = (phase: number) => {
    const L = path.length;
    for (const e of entries) {
      const smp = sampleAt(path, wrap(e.s + phase, L));
      e.sprite.position.set(smp.p.x + smp.normal.x * 0.3, smp.p.y + smp.normal.y * 0.3, BELT_WIDTH * 0.66);
    }
    if (selectedEntry) {
      const smp = sampleAt(path, wrap(selectedEntry.s + phase, L));
      ring.position.set(smp.p.x, smp.p.y, BELT_WIDTH * 0.6);
      ring.visible = true;
    } else {
      ring.visible = false;
    }
  };

  const dispose = () => {
    for (const e of entries) {
      e.sprite.material.map?.dispose();
      e.sprite.material.dispose();
    }
    ringTex.dispose();
    ring.material.dispose();
  };

  return { group, pickables, update, dispose };
}

/** 接缝 3D 标记：固定在 s=0 处的橙色小旗（走带时随材料绕圈） */
export function buildSeamObject(path: BeltPath): { mesh: THREE.Mesh; update: (phase: number) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ff7a59';
  ctx.beginPath();
  ctx.moveTo(18, 10);
  ctx.lineTo(110, 64);
  ctx.lineTo(18, 118);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff3d6';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('S', 52, 66);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.4, 0.4),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );

  const update = (phase: number) => {
    const smp = sampleAt(path, wrap(phase, path.length));
    mesh.position.set(smp.p.x + smp.normal.x * 0.12, smp.p.y + smp.normal.y * 0.12, BELT_WIDTH * 0.56);
  };
  return { mesh, update };
}

function makeRingTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 128, 128);
  ctx.strokeStyle = '#f5b942';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(64, 64, 54, 0, Math.PI * 2);
  ctx.stroke();
  const tex = new THREE.CanvasTexture(c);
  return tex;
}
