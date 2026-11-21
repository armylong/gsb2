/* eslint-disable */
// 浏览器内探针：仅在 ?selfcheck=1 时激活。
// 通过主程序挂出的 window.__LAB__ 句柄逐帧驱动固定路径，
// 核对真实 WebGL 渲染计数与剔除不变量，不修改任何产品逻辑。

interface SelfCheckFrame {
  frame: number;
  totalMeshes: number;
  perMeshDrawn: number;
  perGroupDrawn: number;
  nativeDrawn: number;
}

interface SelfCheckOutput {
  ok: boolean;
  errors: string[];
  totals?: {
    perMesh: number;
    perGroup: number;
    native: number;
    culledFrames: number;
  };
}

declare global {
  interface Window {
    __LAB__?: {
      TOTAL_FRAMES: number;
      gotoFrame(frame: number): void;
      tickOnce(): void;
      setMode(mode: 'per-mesh' | 'per-group' | 'native'): void;
      snapshot(): SelfCheckFrame;
    };
    __SELFCHECK__?: SelfCheckOutput;
  }
}

interface ModeTotals {
  perMesh: number;
  perGroup: number;
  native: number;
}

const search = new URLSearchParams(location.search);
if (search.get('selfcheck') === '1') {
  const start = performance.now();
  const tryRun = (): void => {
    const lab = window.__LAB__;
    if (!lab) {
      if (performance.now() - start < 10000) requestAnimationFrame(tryRun);
      return;
    }
    const out: SelfCheckOutput = { ok: false, errors: [] };
    try {
      const TOTAL = lab.TOTAL_FRAMES;
      const modeTotals: Record<string, ModeTotals> = {};
      // 三种策略各跑完整 180 帧，验证 layer 开关在真实 WebGL 下都成立。
      for (const mode of ['per-mesh', 'per-group', 'native'] as const) {
        lab.setMode(mode);
        let perMesh = 0;
        let perGroup = 0;
        let native = 0;
        for (let f = 0; f < TOTAL; f++) {
          lab.gotoFrame(f);
          lab.tickOnce();
          const snap = lab.snapshot();
          // 核心不变量 1：逐物件与按组的应绘制数必须逐帧相等（下钻不漏不重）。
          if (snap.perMeshDrawn !== snap.perGroupDrawn) {
            out.errors.push(
              `[${mode}] frame ${f}: perMesh ${snap.perMeshDrawn} != perGroup ${snap.perGroupDrawn}`,
            );
          }
          // 核心不变量 2：原生 Three.js 实际提交数不得超过逐物件应绘制数。
          if (snap.nativeDrawn > snap.perMeshDrawn) {
            out.errors.push(
              `[${mode}] frame ${f}: native ${snap.nativeDrawn} > expected ${snap.perMeshDrawn}`,
            );
          }
          perMesh += snap.perMeshDrawn;
          perGroup += snap.perGroupDrawn;
          native += snap.nativeDrawn;
        }
        modeTotals[mode] = { perMesh, perGroup, native };
      }
      out.totals = {
        perMesh: modeTotals['per-mesh'].perMesh,
        perGroup: modeTotals['per-group'].perGroup,
        native: modeTotals.native.native,
        culledFrames: 0,
      };
      out.ok = out.errors.length === 0;
    } catch (e) {
      out.ok = false;
      out.errors.push(e instanceof Error ? (e.stack ?? e.message) : String(e));
    }
    window.__SELFCHECK__ = out;
    const el = document.createElement('pre');
    el.id = 'selfcheck-result';
    el.textContent = JSON.stringify(
      out.ok ? { ok: true, totals: out.totals } : out,
    );
    document.body.appendChild(el);
  };
  tryRun();
}

export {};
