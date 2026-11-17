import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { App, type AppEnv } from '../ui/App';
import type {
  IOverviewViewport,
  ICameraPreview,
  OverviewCallbacks,
  ViewportFactory,
} from '../ui/viewportTypes';
import type { CameraSample } from '../core/types';
import { buildExport } from '../core/exporter';
import { createStubDocument, type StubDocument, type StubElement } from './dom-stub';

class FakeOverview implements IOverviewViewport {
  cb: OverviewCallbacks | null = null;
  gizmo = {
    update: vi.fn((s: CameraSample) => {
      this.lastSample = s;
    }),
    setHeld: vi.fn(),
  };
  updatePath = vi.fn();
  updateTarget = vi.fn();
  setTargetVisible = vi.fn();
  render = vi.fn();
  resize = vi.fn();
  dispose = vi.fn();
  lastSample: CameraSample | null = null;
}

class FakePreview implements ICameraPreview {
  applied: CameraSample[] = [];
  applySample = vi.fn((s: CameraSample) => {
    this.applied.push(s);
  });
  render = vi.fn();
  resize = vi.fn();
  dispose = vi.fn();
}

function mount(): {
  app: App;
  overview: FakeOverview;
  preview: FakePreview;
  doc: StubDocument;
} {
  const doc = createStubDocument();
  doc.register(doc.getElementById('app'));
  const overview = new FakeOverview();
  const preview = new FakePreview();
  const factory: ViewportFactory = {
    createOverview: (_host, cb) => {
      overview.cb = cb;
      return overview;
    },
    createPreview: () => preview,
  };
  const env: AppEnv = {
    document: doc as unknown as Document,
    requestAnimationFrame: () => 1, // never auto-loop in tests
    cancelAnimationFrame: () => undefined,
    now: () => 0,
  };
  const app = new App(factory, env);
  app.start();
  return { app, overview, preview, doc };
}

function el(doc: StubDocument, id: string): StubElement {
  return doc.getElementById(id);
}

/** Reach into the app's private rig/state for assertions (test-only). */
function rigOf(app: App) {
  return (app as unknown as { rig: import('../core/CameraRig').CameraRig }).rig;
}
function stateOf(app: App) {
  return (app as unknown as { state: import('../ui/state').AppState }).state;
}

describe('App headless integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('mounts both panels and drives both viewports with the same sample', () => {
    const { app, overview, preview, doc } = mount();
    expect(el(doc, 'left-panel').innerHTML).toContain('程序样例');
    expect(el(doc, 'right-panel').innerHTML).toContain('播放控制');
    expect(overview.updatePath).toHaveBeenCalled();
    expect(preview.applied.length).toBeGreaterThan(0);
    expect(overview.gizmo.update).toHaveBeenCalledTimes(preview.applied.length);
    expect(preview.applied[0].time).toBe(0);
    app.dispose();
  });

  it('seek is stateless: direct seek matches sequential playback to the same time', () => {
    const { app, preview } = mount();
    app.seek(3.5);
    const direct = preview.applied.at(-1)!;

    const second = mount();
    const times: number[] = [];
    for (let t = 0; t < 3.5; t += 0.137) times.push(t);
    times.push(3.5); // guarantee the final instant is exactly the seek target
    for (const t of times) second.app.seek(t);
    const sequential = second.preview.applied.at(-1)!;

    expect(direct.position.distanceTo(sequential.position)).toBeLessThan(1e-9);
    expect(direct.quaternion.angleTo(sequential.quaternion)).toBeLessThan(1e-9);
    expect(direct.progress).toBeCloseTo(sequential.progress, 12);
    app.dispose();
    second.app.dispose();
  });

  it('speed/look mode toggles rebuild the rig; target mode shows the marker', () => {
    const { app, overview, doc } = mount();
    doc.querySelectorAll('[data-speed]').find((b) => b.dataset.speed === 'timed')!.onclick!();
    expect(stateOf(app).playback.speedMode).toBe('timed');

    doc.querySelectorAll('[data-look]').find((b) => b.dataset.look === 'target')!.onclick!();
    expect(stateOf(app).playback.lookMode).toBe('target');
    expect(overview.setTargetVisible).toHaveBeenCalledWith(true);
    app.seek(2);
    const s = overview.lastSample!;
    expect(s.time).toBe(2);
    app.dispose();
  });

  it('closed toggle closes the path and gives a seamless loop (t=0 == t=duration)', () => {
    const { app, overview, doc } = mount();
    doc.querySelectorAll('[data-mode]').find((b) => b.dataset.mode === 'closed')!.onclick!();
    expect(overview.updatePath.mock.calls.some((c) => c[1] === true)).toBe(true);

    app.seek(0);
    const a = overview.lastSample!;
    app.seek(stateOf(app).playback.duration);
    const b = overview.lastSample!;
    expect(a.position.distanceTo(b.position)).toBeLessThan(1e-6);
    expect(a.quaternion.angleTo(b.quaternion)).toBeLessThan(1e-6);
    app.dispose();
  });

  it('time input clamps to [0, duration] and updates the playhead', () => {
    const { app, preview, doc } = mount();
    const duration = stateOf(app).playback.duration;
    const input = el(doc, 'time-input');

    input.value = '999';
    input.onchange!();
    expect(preview.applied.at(-1)!.time).toBe(duration);

    input.value = '-5';
    input.onchange!();
    expect(preview.applied.at(-1)!.time).toBe(0);
    app.dispose();
  });

  it('editing time-curve knots keeps time order and non-decreasing progress', () => {
    const { app, doc } = mount();
    el(doc, 'add-knot').onclick!();
    const pInputs = doc.querySelectorAll('[data-k]').filter((b) => b.dataset.k === 'p');
    // Force a backwards value on an interior row; sanitize must clamp it.
    const inner = pInputs[1];
    inner.value = '0.95';
    inner.onchange!();
    const next = pInputs[pInputs.length - 2];
    next.value = '0.01';
    next.onchange!();

    const knots = stateOf(app).playback.timeKnots;
    for (let i = 1; i < knots.length; i++) {
      expect(knots[i].p).toBeGreaterThanOrEqual(knots[i - 1].p);
      expect(knots[i].t).toBeGreaterThan(knots[i - 1].t);
    }
    expect(knots[0]).toEqual({ t: 0, p: 0 });
    app.seek(stateOf(app).playback.duration / 2); // still evaluates cleanly
    app.dispose();
  });

  it('verification panel shows per-check measurements and an overall pass', () => {
    const { app, doc } = mount();
    el(doc, 'verify').onclick!();
    const report = el(doc, 'verify-report').innerHTML;
    expect(report).toContain('全部通过');
    expect(report).toContain('PASS');
    expect(report).toMatch(/rad|m\)/); // real measurements, not only a badge
    app.dispose();
  });

  it('export is endpoint-inclusive and matches live evaluation, with axis conventions', () => {
    const { app } = mount();
    const rig = rigOf(app);
    const interval = stateOf(app).exportInterval;
    const docJson = buildExport(rig, { intervalSeconds: interval });

    expect(docJson.frames[0].time).toBe(0);
    expect(docJson.frames.at(-1)!.time).toBeCloseTo(rig.duration, 9);
    expect(docJson.sampling.includesEndpoints).toBe(true);

    const mid = docJson.frames[Math.floor(docJson.frames.length / 2)];
    const live = rig.sampleAt(mid.time);
    expect(mid.position.x).toBeCloseTo(live.position.x, 8);
    expect(mid.quaternion.w).toBeCloseTo(live.quaternion.w, 8);
    expect(docJson.conventions.quaternionOrder).toContain('[w, x, y, z]');
    expect(docJson.conventions.coordinateSystem).toContain('right-handed');
    app.dispose();
  });

  it('control-point and target drag callbacks mutate state and re-evaluate', () => {
    const { app, overview } = mount();
    overview.cb!.onControlPointDrag(0, new THREE.Vector3(5, 6, 7));
    overview.cb!.onControlPointDragEnd();
    expect(stateOf(app).path.controlPoints[0]).toMatchObject({ x: 5, y: 6, z: 7 });

    overview.cb!.onTargetDrag(new THREE.Vector3(1, 2, 3));
    expect(stateOf(app).playback.target).toMatchObject({ x: 1, y: 2, z: 3 });

    app.seek(1); // no throw; pose still finite
    const s = overview.lastSample!;
    expect(Number.isFinite(s.position.x)).toBe(true);
    app.dispose();
  });

  it('preset switching loads all three generated presets and they stay valid', () => {
    const { app, doc } = mount();
    for (const id of ['ordinary', 'vertical', 'closed']) {
      // Re-render to refresh preset buttons, then click the matching one.
      const btn = doc.querySelectorAll('[data-mode]'); // ensure doc populated
      expect(btn.length).toBeGreaterThan(0);
      app.applyPresetPublic(id);
      expect(stateOf(app).activePresetId).toBe(id);
      app.seek(0);
    }
    app.dispose();
  });
});
