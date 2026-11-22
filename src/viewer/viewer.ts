/**
 * three.js 双视口查看器
 *
 * 左：原始几何（中性灰）  右：还原几何（误差热图）
 * 同一相机、同一 OrbitControls，保证同镜头对照；
 * 支持误差放大（沿误差向量外推）、接缝连线、重复顶点标记与顶点拾取。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { AnalysisResult, DuplicateInfo, MeshModel, SeamPair } from '../core/types';
import { AXES } from '../core/types';
import { buildHeatColors } from './heat';
import type { HeatScale } from './heat';

export interface PickedVertex {
  chunkId: number;
  chunkName: string;
  vertex: number;
  original: [number, number, number];
  restored: [number, number, number];
  error: number;
}

export interface ViewerOptions {
  onPick: (picked: PickedVertex | null) => void;
}

interface ChunkMeshes {
  original: THREE.Mesh;
  restored: THREE.Mesh;
}

export class MeshViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private groupOrig = new THREE.Group();
  private groupRest = new THREE.Group();
  private seamGroup = new THREE.Group();
  private dupGroup = new THREE.Group();
  private highlight: THREE.Mesh;
  private meshes: ChunkMeshes[] = [];
  private model: MeshModel | null = null;
  private analysis: AnalysisResult | null = null;
  private heatScale: HeatScale = 'log';
  private exaggeration = 1;
  private showWireframe = false;
  private showSeams = true;
  private showDups = true;
  private splitRatio = 0.5;
  private resizeObserver: ResizeObserver;

  constructor(private container: HTMLElement, private opts: ViewerOptions) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setScissorTest(true);
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.display = 'block';

    this.scene.background = new THREE.Color(0x14171f);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1e5);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.85));
    const dir = new THREE.DirectionalLight(0xffffff, 1.4);
    dir.position.set(5, 10, 7);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0x88aaff, 0.5);
    dir2.position.set(-6, -4, -5);
    this.scene.add(dir2);

    this.scene.add(this.groupOrig, this.groupRest, this.seamGroup, this.dupGroup);

    this.highlight = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    this.highlight.visible = false;
    this.highlight.renderOrder = 999;
    this.scene.add(this.highlight);

    const grid = new THREE.GridHelper(20, 20, 0x3a4152, 0x232838);
    grid.name = 'grid';
    this.scene.add(grid);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.renderer.domElement.addEventListener('pointerdown', this.onPointerDown);
    this.controls.addEventListener('change', this.render);
    this.renderer.setAnimationLoop(() => {
      this.controls.update();
      this.render();
    });
  }

  /** 装载模型 + 分析结果，重建全部几何体 */
  setModel(model: MeshModel, analysis: AnalysisResult) {
    this.clearGroup(this.groupOrig);
    this.clearGroup(this.groupRest);
    this.clearGroup(this.seamGroup);
    this.clearGroup(this.dupGroup);
    this.meshes = [];
    this.model = model;
    this.analysis = analysis;
    this.highlight.visible = false;

    const maxError = analysis.stats.maxError;

    model.chunks.forEach((chunk) => {
      const qr = analysis.quant.chunks.find((c) => c.chunkId === chunk.id)!;

      // 原始
      const geoO = new THREE.BufferGeometry();
      geoO.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(chunk.positions), 3));
      geoO.setIndex(new THREE.BufferAttribute(Uint32Array.from(chunk.indices), 1));
      const matO = new THREE.MeshStandardMaterial({
        color: 0xb9c0cf,
        side: THREE.DoubleSide,
        flatShading: true,
        wireframe: this.showWireframe,
      });
      const meshO = new THREE.Mesh(geoO, matO);
      meshO.userData = { chunkId: chunk.id, kind: 'original' };
      this.groupOrig.add(meshO);

      // 还原（带热图顶点色）
      const geoR = new THREE.BufferGeometry();
      const restPositions = this.computeExaggerated(chunk.positions, qr.quant.restored);
      geoR.setAttribute('position', new THREE.BufferAttribute(restPositions, 3));
      geoR.setAttribute(
        'color',
        new THREE.BufferAttribute(buildHeatColors(qr.quant.errors, maxError, this.heatScale), 3),
      );
      geoR.setIndex(new THREE.BufferAttribute(Uint32Array.from(chunk.indices), 1));
      const matR = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide,
        flatShading: true,
        wireframe: this.showWireframe,
      });
      const meshR = new THREE.Mesh(geoR, matR);
      meshR.userData = { chunkId: chunk.id, kind: 'restored' };
      this.groupRest.add(meshR);

      this.meshes.push({ original: meshO, restored: meshR });
    });

    this.buildSeamLines(analysis.seamPairs, analysis.separatedSeams);
    this.buildDupMarkers(analysis.duplicates);
    this.fitCamera(model);
    this.render();
  }

  /** 仅热图配色/缩放变化时刷新顶点色（不重建几何） */
  setHeatScale(scale: HeatScale) {
    this.heatScale = scale;
    if (!this.model || !this.analysis) return;
    const maxError = this.analysis.stats.maxError;
    this.model.chunks.forEach((chunk) => {
      const qr = this.analysis!.quant.chunks.find((c) => c.chunkId === chunk.id)!;
      const entry = this.meshes.find((m) => m.restored.userData.chunkId === chunk.id)!;
      const attr = entry.restored.geometry.getAttribute('color') as THREE.BufferAttribute;
      attr.array.set(buildHeatColors(qr.quant.errors, maxError, scale));
      attr.needsUpdate = true;
    });
    this.render();
  }

  /** 误差放大倍数：p' = original + (restored - original) * k */
  setExaggeration(k: number) {
    this.exaggeration = k;
    if (!this.model || !this.analysis) return;
    this.model.chunks.forEach((chunk) => {
      const qr = this.analysis!.quant.chunks.find((c) => c.chunkId === chunk.id)!;
      const entry = this.meshes.find((m) => m.restored.userData.chunkId === chunk.id)!;
      const attr = entry.restored.geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.array.set(this.computeExaggerated(chunk.positions, qr.quant.restored));
      attr.needsUpdate = true;
      entry.restored.geometry.computeBoundingSphere();
    });
    this.refreshSeamGeometry();
    this.render();
  }

  setWireframe(on: boolean) {
    this.showWireframe = on;
    for (const m of this.meshes) {
      (m.original.material as THREE.MeshStandardMaterial).wireframe = on;
      (m.restored.material as THREE.MeshStandardMaterial).wireframe = on;
    }
    this.render();
  }

  setSeamsVisible(on: boolean) {
    this.showSeams = on;
    this.seamGroup.visible = on;
    this.render();
  }

  setDupsVisible(on: boolean) {
    this.showDups = on;
    this.dupGroup.visible = on;
    this.render();
  }

  private computeExaggerated(original: Float64Array, restored: Float64Array): Float32Array {
    const out = new Float32Array(original.length);
    const k = this.exaggeration;
    for (let i = 0; i < original.length; i++) {
      out[i] = original[i] + (restored[i] - original[i]) * k;
    }
    return out;
  }

  private buildSeamLines(seams: SeamPair[], separated: SeamPair[]) {
    this.clearGroup(this.seamGroup);
    if (seams.length === 0 || !this.model || !this.analysis) return;
    const separatedSet = new Set(separated.map((s) => `${s.chunkA}:${s.vertexA}|${s.chunkB}:${s.vertexB}`));
    const positions: number[] = [];
    const colors: number[] = [];
    const push = (p: number[], color: [number, number, number]) => {
      positions.push(...p);
      colors.push(color[0], color[1], color[2]);
    };
    for (const s of seams) {
      const pa = this.restoredWorld(s.chunkA, s.vertexA);
      const pb = this.restoredWorld(s.chunkB, s.vertexB);
      const isSep = separatedSet.has(`${s.chunkA}:${s.vertexA}|${s.chunkB}:${s.vertexB}`);
      const color: [number, number, number] = isSep ? [1, 0.25, 0.2] : [1, 0.75, 0.25];
      push(pa, color);
      push(pb, color);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, linewidth: 2 });
    const lines = new THREE.LineSegments(geo, mat);
    lines.renderOrder = 10;
    this.seamGroup.add(lines);
  }

  private refreshSeamGeometry() {
    if (!this.analysis) return;
    this.buildSeamLines(this.analysis.seamPairs, this.analysis.separatedSeams);
  }

  private restoredWorld(chunkId: number, vertex: number): number[] {
    const qr = this.analysis!.quant.chunks.find((c) => c.chunkId === chunkId)!;
    const chunk = this.model!.chunks.find((c) => c.id === chunkId)!;
    const i = vertex * 3;
    const k = this.exaggeration;
    return AXES.map((a) => chunk.positions[i + a] + (qr.quant.restored[i + a] - chunk.positions[i + a]) * k);
  }

  private buildDupMarkers(dups: DuplicateInfo[]) {
    this.clearGroup(this.dupGroup);
    if (dups.length === 0 || !this.analysis) return;
    const positions: number[] = [];
    for (const d of dups) positions.push(...d.position);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xff5cf0,
      size: 6,
      sizeAttenuation: false,
      depthTest: false,
    });
    const pts = new THREE.Points(geo, mat);
    pts.renderOrder = 20;
    this.dupGroup.add(pts);
  }

  private fitCamera(model: MeshModel) {
    const box = new THREE.Box3(
      new THREE.Vector3(...model.bbox.min),
      new THREE.Vector3(...model.bbox.max),
    );
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z, 1e-6);
    const grid = this.scene.getObjectByName('grid');
    if (grid) {
      grid.position.y = model.bbox.min[1] - maxDim * 0.02;
      grid.scale.setScalar(Math.max(1, maxDim / 10));
    }
    this.camera.near = Math.max(maxDim / 1e4, 1e-6);
    this.camera.far = maxDim * 1000;
    const fov = (this.camera.fov * Math.PI) / 180;
    const dist = (maxDim * 0.8) / Math.tan(fov / 2);
    this.camera.position.set(center.x + dist * 0.7, center.y + dist * 0.55, center.z + dist * 0.9);
    this.camera.zoom = 1;
    this.controls.target.copy(center);
    this.controls.minDistance = maxDim * 0.05;
    this.controls.maxDistance = maxDim * 50;
    this.camera.updateProjectionMatrix();
    this.controls.update();

    // 高亮球尺寸按模型尺度
    this.highlight.scale.setScalar(maxDim * 0.012);
  }

  private onPointerDown = (e: PointerEvent) => {
    // 拖拽（旋转）不触发拾取：只在按下与抬起几乎同位置时拾取
    const startX = e.clientX;
    const startY = e.clientY;
    const up = (ev: PointerEvent) => {
      this.renderer.domElement.removeEventListener('pointerup', up);
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > 4) return;
      this.pick(ev);
    };
    this.renderer.domElement.addEventListener('pointerup', up);
  };

  private pick(ev: PointerEvent) {
    if (!this.model || !this.analysis) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;

    // 判断点击落在哪一侧视口
    const localX = ev.clientX - rect.left;
    const side = localX < rect.width * this.splitRatio ? 'original' : 'restored';
    const targets = this.meshes.map((m) => (side === 'original' ? m.original : m.restored));

    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(targets, false);
    if (hits.length === 0) {
      this.highlight.visible = false;
      this.opts.onPick(null);
      this.render();
      return;
    }
    const hit = hits[0];
    const mesh = hit.object as THREE.Mesh;
    const chunkId = mesh.userData.chunkId as number;
    const chunk = this.model.chunks.find((c) => c.id === chunkId)!;
    const qr = this.analysis.quant.chunks.find((c) => c.chunkId === chunkId)!;

    // 在命中三角形的三个顶点中取距射线最近者
    const face = hit.face!;
    const candidates = [face.a, face.b, face.c];
    let best = candidates[0];
    let bestD = Infinity;
    const wp = new THREE.Vector3();
    for (const vi of candidates) {
      wp.fromArray(mesh.geometry.getAttribute('position').array, vi * 3);
      const d = this.raycaster.ray.distanceToPoint(wp);
      if (d < bestD) {
        bestD = d;
        best = vi;
      }
    }

    const i = best * 3;
    const picked: PickedVertex = {
      chunkId,
      chunkName: chunk.name,
      vertex: best,
      original: [chunk.positions[i], chunk.positions[i + 1], chunk.positions[i + 2]],
      restored: [qr.quant.restored[i], qr.quant.restored[i + 1], qr.quant.restored[i + 2]],
      error: qr.quant.errors[best],
    };
    this.highlight.position.set(
      chunk.positions[i] + (qr.quant.restored[i] - chunk.positions[i]) * this.exaggeration,
      chunk.positions[i + 1] + (qr.quant.restored[i + 1] - chunk.positions[i + 1]) * this.exaggeration,
      chunk.positions[i + 2] + (qr.quant.restored[i + 2] - chunk.positions[i + 2]) * this.exaggeration,
    );
    this.highlight.visible = true;
    this.opts.onPick(picked);
    this.render();
  }

  private resize = () => {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.render();
  };

  private render = () => {
    const w = this.renderer.domElement.width;
    const h = this.renderer.domElement.height;
    const split = Math.floor(w * this.splitRatio);

    this.groupOrig.visible = true;
    this.groupRest.visible = false;
    this.seamGroup.visible = false;
    this.dupGroup.visible = false;
    // 高亮球挂在场景根节点，两个视口都会渲染，保持其 visible 状态即可
    this.renderer.setViewport(0, 0, split, h);
    this.renderer.setScissor(0, 0, split, h);
    this.renderer.render(this.scene, this.camera);

    this.groupOrig.visible = false;
    this.groupRest.visible = true;
    this.seamGroup.visible = this.showSeams;
    this.dupGroup.visible = this.showDups;
    this.renderer.setViewport(split, 0, w - split, h);
    this.renderer.setScissor(split, 0, w - split, h);
    this.renderer.render(this.scene, this.camera);

    this.groupOrig.visible = true;
    this.groupRest.visible = true;
  };

  private clearGroup(group: THREE.Group) {
    for (const obj of [...group.children]) {
      group.remove(obj);
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Points || obj instanceof THREE.LineSegments) {
        obj.geometry.dispose();
        const m = obj.material;
        if (Array.isArray(m)) m.forEach((x) => x.dispose());
        else m.dispose();
      }
    }
  }

  dispose() {
    this.resizeObserver.disconnect();
    this.renderer.domElement.removeEventListener('pointerdown', this.onPointerDown);
    this.controls.dispose();
    this.renderer.setAnimationLoop(null);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
