import './style.css';
import * as THREE from 'three';
import { buildAll } from './meshBuilder';
import { MorphEngine } from './morphEngine';
import { KeyframeStore } from './keyframe';
import { LabScene, type PickedVertex } from './scene';
import { ControlPanel } from './ui';
import { downloadConfig, parseConfig, saveConfig } from './configIO';
import {
  DEFAULT_MESH_PARAMS,
  TARGETS,
  cloneWeights,
  zeroWeights,
  type PartId,
  type PinSpec,
  type SavedConfig,
  type TargetId,
  type Weights,
} from './types';

class LabApp {
  private params = { ...DEFAULT_MESH_PARAMS };
  private built = buildAll(this.params);
  private engine: MorphEngine;
  private scene: LabScene;
  private panel: ControlPanel;
  private kf = new KeyframeStore();
  /** 手动编辑权重(非播放时这就是当前权重) */
  private editing: Weights = zeroWeights();
  private pins: PickedVertex[] = [];
  private seamVisible = false;

  constructor() {
    const seamRadius = this.params.radius + 0.035;
    this.engine = new MorphEngine(
      this.built.wall,
      this.built.lid,
      this.params.wallHeight,
      seamRadius,
      this.params.radialSeg,
    );
    this.scene = new LabScene(document.getElementById('viewport')!, this.built);
    this.panel = new ControlPanel(document.getElementById('controls')!, {
      onWeightChange: (part, target, v) => this.changeWeight(part, target, v),
      onHingeChange: (deg) => this.changeHinge(deg),
      onFlexChange: (v) => this.changeFlex(v),
      onCapture: (slot) => this.capture(slot),
      onPlay: () => this.play(),
      onPause: () => this.pause(),
      onScrub: (t) => this.scrub(t),
      onSpeed: (v) => (this.kf.speed = v),
      onToggleInfluence: (on) => this.scene.setInfluenceMode(on, this.kf.current),
      onToggleSeam: (on) => {
        this.seamVisible = on;
      },
      onToggleLightHelper: (on) => this.scene.setLightHelperVisible(on),
      onLightChange: (az, el) => this.scene.setLightAzimuthElevation(az, el),
      onSave: () => this.save(),
      onLoad: (file) => this.load(file),
      onReset: () => this.reset(),
    });

    this.scene.onPick = (p) => this.addPin(p);
    document.getElementById('config-file')!.addEventListener('change', (e) => {
      const input = e.target as HTMLInputElement;
      if (input.files?.[0]) this.panel && this.loadFile(input.files[0]);
      input.value = '';
    });

    this.refresh();
    this.startLoop();
  }

  // ---------- 权重编辑 ----------

  private changeWeight(part: PartId, target: TargetId, v: number) {
    this.pause();
    this.editing[part][target] = v;
    this.kf.setManual(cloneWeights(this.editing));
    this.refresh();
  }

  private changeHinge(deg: number) {
    this.pause();
    this.editing.hingeDeg = deg;
    this.kf.setManual(cloneWeights(this.editing));
    this.refresh();
  }

  private changeFlex(v: number) {
    this.pause();
    this.editing.flex = v;
    this.kf.setManual(cloneWeights(this.editing));
    this.refresh();
  }

  // ---------- 关键帧 ----------

  private capture(slot: 0 | 1) {
    this.kf.capture(slot, this.kf.current);
    this.flashHud(`已录入 ${slot === 0 ? 'A' : 'B'} 帧`);
  }

  private play() {
    this.kf.play();
    this.panel.setPlaying(true);
  }

  private pause() {
    if (this.kf.mode === 'playing') {
      this.kf.pause();
      this.panel.setPlaying(false);
      // 停下时把当前插值结果交还给编辑态, 后续调节从当前画面连续出发
      this.editing = this.kf.snapshot();
      this.panel.syncWeights(this.editing);
    }
  }

  private scrub(t: number) {
    this.kf.scrub(t);
    this.editing = this.kf.snapshot();
    this.panel.syncWeights(this.editing);
    this.refresh();
  }

  // ---------- 测点 ----------

  private addPin(p: PickedVertex) {
    if (this.pins.some((x) => x.part === p.part && x.vertex === p.vertex)) return;
    if (this.pins.length >= 8) this.pins.shift();
    this.pins.push(p);
    this.scene.syncPins(this.pins);
    this.renderInspector();
  }

  private removePin(index: number) {
    this.pins.splice(index, 1);
    this.scene.syncPins(this.pins);
    this.renderInspector();
  }

  private renderInspector() {
    const host = document.getElementById('pins')!;
    host.innerHTML = '';
    if (this.pins.length === 0) {
      host.innerHTML = '<p class="hint">还没有测点。</p>';
      return;
    }
    this.pins.forEach((pin, i) => {
      const mesh = pin.part === 'wall' ? this.built.wall : this.built.lid;
      const world = this.engine.getWorldPosition(pin.part, pin.vertex, new THREE.Vector3());
      // rest 位置用同一世界坐标系(盖子含当前铰链刚体姿态), 位移才是纯软变形
      const base = this.engine.getRestWorldPosition(
        pin.part,
        pin.vertex,
        this.kf.current.hingeDeg,
        new THREE.Vector3(),
      );
      const w = this.kf.current;
      const card = document.createElement('div');
      card.className = 'pin-card';
      const u = mesh.params[pin.vertex * 2].toFixed(3);
      const v = mesh.params[pin.vertex * 2 + 1].toFixed(3);
      const hard = mesh.hardEdge[pin.vertex] ? '硬边' : '软区';
      card.innerHTML = `
        <header><b>#${i + 1} ${pin.part === 'wall' ? '容器壁' : '盖子'} v${pin.vertex}</b>
        <button data-rm="${i}">移除</button></header>
        <table>
          <tr><td>参数 (u,v)</td><td>${u}, ${v}（${hard}）</td></tr>
          <tr><td>变形前(世界/rest姿态)</td><td>${fmt(base)}</td></tr>
          <tr><td>变形后(世界)</td><td>${fmt(world)}</td></tr>
          <tr><td>软变形位移</td><td>${fmt(world.clone().sub(base))}（模 ${world.distanceTo(base).toFixed(4)}）</td></tr>
        </table>
        <div class="targets"></div>`;
      const tagHost = card.querySelector('.targets')!;
      for (const t of TARGETS) {
        const weight = w[pin.part][t.id];
        const contrib = this.engine.getTargetContribution(pin.part, pin.vertex, t.id, weight);
        const tag = document.createElement('span');
        const active = Math.abs(weight) > 1e-6 && contrib.length() > 1e-7;
        tag.className = `tag ${active ? t.id : 'zero'}`;
        tag.textContent = `${t.label.split(' ')[0]} w=${weight.toFixed(2)} → 局部位移 ${contrib.length().toFixed(3)}`;
        tagHost.appendChild(tag);
      }
      card.querySelector('[data-rm]')!.addEventListener('click', () => this.removePin(i));
      host.appendChild(card);
    });
  }

  // ---------- 存取档 ----------

  /** 导出当前配置 JSON 文本(也供自动化测试调用) */
  exportJSON(): string {
    return saveConfig(this.kf.current, this.pins as PinSpec[], this.params);
  }

  /** 从 JSON 文本复现配置, 返回错误信息或 null */
  importJSON(text: string): string | null {
    try {
      const config = parseConfig(text) as SavedConfig;
      if (JSON.stringify(config.meshParams) !== JSON.stringify(this.params)) {
        throw new Error('网格参数与当前实验页不一致, 无法保证复现同一画面');
      }
      this.pause();
      this.editing = cloneWeights(config.weights);
      this.kf.setManual(cloneWeights(this.editing));
      this.kf.t = 0;
      this.pins = config.pins.map((p) => ({ ...p }));
      this.panel.syncWeights(this.editing);
      this.panel.setTimeline(0);
      this.scene.syncPins(this.pins);
      this.refresh();
      return null;
    } catch (err) {
      return (err as Error).message;
    }
  }

  private save() {
    const text = this.exportJSON();
    downloadConfig(text);
    this.flashHud('配置已导出 JSON');
  }

  private load(file: File) {
    this.loadFile(file);
  }

  private loadFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      const err = this.importJSON(String(reader.result));
      if (err) this.flashHud(`载入失败: ${err}`, true);
      else this.flashHud(`已载入 ${file.name}，画面已复现`);
    };
    reader.readAsText(file);
  }

  private reset() {
    this.pause();
    this.editing = zeroWeights();
    this.kf.setManual(zeroWeights());
    this.kf.t = 0;
    this.pins = [];
    this.panel.syncWeights(this.editing);
    this.panel.setTimeline(0);
    this.scene.syncPins(this.pins);
    this.refresh();
  }

  /** 测试用: 施加合成极端权重强制触发翻面检测 */
  applyExtremeWeights() {
    const w = zeroWeights();
    w.wall.bulge = 6;
    w.wall.dent = -5;
    w.lid.dent = 5;
    this.pause();
    this.editing = w;
    this.kf.setManual(cloneWeights(w));
    this.panel.syncWeights(w);
    this.refresh();
  }

  /** 测试/调试快照: 纯数据, 供自动化断言 */
  debugAddPin(part: PartId, vertex: number) {
    this.addPin({ part, vertex });
  }

  debugSnapshot() {
    const wallPos = this.built.wall.geometry.attributes.position as THREE.BufferAttribute;
    const N = this.params.radialSeg;
    const bottomStart = 0;
    let bottomDrift = 0;
    for (let i = 0; i < N; i++) {
      const cur = new THREE.Vector3().fromBufferAttribute(wallPos, bottomStart + i);
      const base = new THREE.Vector3(
        this.built.wall.base[i * 3],
        this.built.wall.base[i * 3 + 1],
        this.built.wall.base[i * 3 + 2],
      );
      bottomDrift = Math.max(bottomDrift, cur.distanceTo(base));
    }
    return {
      invertedCount: this.lastMorph.invertedFaces.wall.length + this.lastMorph.invertedFaces.lid.length,
      strainedCount: this.lastMorph.strainedFaces.wall.length + this.lastMorph.strainedFaces.lid.length,
      seamMaxGap: this.lastMorph.seamMaxGap,
      bottomDrift,
      pinCount: this.pins.length,
      weights: cloneWeights(this.kf.current),
      timelineT: this.kf.t,
    };
  }

  private lastMorph: {
    invertedFaces: { wall: number[]; lid: number[] };
    strainedFaces: { wall: number[]; lid: number[] };
    seamMaxGap: number;
  } = {
    invertedFaces: { wall: [], lid: [] },
    strainedFaces: { wall: [], lid: [] },
    seamMaxGap: 0,
  };

  // ---------- 每帧刷新 ----------

  private refresh() {
    const result = this.engine.apply(this.kf.current);
    this.lastMorph = result;
    this.scene.updateFlipOverlay(result);
    this.scene.updateInfluenceColors(this.kf.current);
    this.scene.updateSeamMarkers(this.seamVisible, result.seamMaxGap);
    this.scene.updatePinPositions(this.pins);
    this.updateHud(result);
    this.renderInspector();
  }

  private updateHud(r: {
    invertedFaces: { wall: number[]; lid: number[] };
    strainedFaces: { wall: number[]; lid: number[] };
    seamMaxGap: number;
  }) {
    const hud = document.getElementById('hud')!;
    const invCount = r.invertedFaces.wall.length + r.invertedFaces.lid.length;
    const strainedCount = r.strainedFaces.wall.length + r.strainedFaces.lid.length;
    const flipCls = invCount > 0 ? 'bad' : strainedCount > 0 ? 'warn' : 'ok';
    const seam =
      r.seamMaxGap < 0
        ? '<span class="hint">盖子打开中, 接缝分离属预期</span>'
        : `接缝最大间距 <span class="${r.seamMaxGap < 1e-6 ? 'ok' : 'warn'}">${r.seamMaxGap.toExponential(2)}</span>`;
    hud.innerHTML = `
      <div>翻面三角形 <span class="${flipCls}">${invCount}</span>
       ｜ 濒临翻转 <span class="${strainedCount ? 'warn' : 'ok'}">${strainedCount}</span></div>
      <div>${seam}</div>
      <div class="hint">红=已翻转面覆盖层, 橙=濒临翻转; 点击网格钉选测点</div>`;
  }

  private flashTimer: number | undefined;
  private flashHud(msg: string, bad = false) {
    const hud = document.getElementById('hud')!;
    const line = document.createElement('div');
    line.style.color = bad ? 'var(--danger)' : 'var(--accent)';
    line.textContent = msg;
    hud.appendChild(line);
    window.clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => line.remove(), 2500);
  }

  private startLoop() {
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (this.kf.mode === 'playing') {
        this.kf.advance(dt);
        this.panel.setTimeline(this.kf.t);
        this.panel.syncWeights(this.kf.current);
        this.refresh();
        if (this.kf.mode !== 'playing') this.panel.setPlaying(false);
      }
      this.scene.render();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function fmt(v: THREE.Vector3): string {
  return `(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})`;
}

const app = new LabApp();

// 测试钩子: 仅用于本地自动化冒烟验证, 不参与 UI 交互
(window as unknown as Record<string, unknown>).__lab = { app };
