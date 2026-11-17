import * as THREE from 'three';
import { EyeId, PairRead, StereoRig, ViewMode, VISIBILITY_TEXT } from './stereo';
import { GROUP_COLORS, MarkerDef } from './markers';

export interface ViewportRect {
  x: number; y: number; w: number; h: number;
}

/** 单帧需要的标记读数包 */
export interface MarkerFrame {
  def: MarkerDef;
  read: PairRead;
  selected: boolean;
}

interface DotEl {
  el: HTMLDivElement;
  label: HTMLDivElement;
}

/**
 * HTML 覆盖层：
 *  - 视口标签与中心十字；
 *  - 每个标记在每个可见眼中的投影点（DOM 圆点，随读数每帧重定位，绝不参与拉伸）；
 *  - 右下角 2D 俯视示意图（Canvas 2D）。
 */
export class Overlay {
  private dots = new Map<string, DotEl[]>(); // markerId -> [left,right] 两个圆点
  private mm: CanvasRenderingContext2D;

  constructor(
    private readonly root: HTMLElement,
    private readonly labelL: HTMLElement,
    private readonly labelR: HTMLElement,
    private readonly crossL: HTMLElement,
    private readonly crossR: HTMLElement,
    private readonly minimap: HTMLCanvasElement,
  ) {
    this.mm = minimap.getContext('2d')!;
  }

  private ensureDots(id: string, colorHex: number): DotEl[] {
    let arr = this.dots.get(id);
    if (arr) return arr;
    arr = [0, 1].map(() => {
      const el = document.createElement('div');
      el.className = 'm-dot';
      Object.assign(el.style, {
        position: 'absolute', width: '12px', height: '12px', borderRadius: '50%',
        border: '2px solid rgba(255,255,255,0.85)', transform: 'translate(-50%,-50%)',
        pointerEvents: 'none', display: 'none', zIndex: '5',
      });
      const label = document.createElement('div');
      Object.assign(label.style, {
        position: 'absolute', left: '10px', top: '-10px', whiteSpace: 'nowrap',
        fontSize: '11px', color: '#d7dde7', textShadow: '0 1px 3px #000',
      });
      el.appendChild(label);
      this.root.appendChild(el);
      return { el, label };
    });
    const c = `#${colorHex.toString(16).padStart(6, '0')}`;
    arr.forEach((d) => { d.el.style.background = c; });
    this.dots.set(id, arr);
    return arr;
  }

  /** 调整视口标签与十字位置；返回每个活动眼的视口矩形（CSS 像素） */
  layout(mode: ViewMode, totalW: number, totalH: number): Record<EyeId, ViewportRect | null> {
    const halfW = Math.floor(totalW / 2);
    const left: ViewportRect = { x: 0, y: 0, w: mode === 'sbs' ? halfW : totalW, h: totalH };
    const right: ViewportRect = { x: mode === 'sbs' ? halfW : 0, y: 0, w: totalW - halfW, h: totalH };
    const active: Record<EyeId, ViewportRect | null> = {
      left: mode === 'right' ? null : left,
      right: mode === 'left' ? null : right,
    };

    this.labelL.style.display = active.left ? 'flex' : 'none';
    this.labelR.style.display = active.right ? 'flex' : 'none';
    if (active.left) {
      this.labelL.style.left = `${active.left.x + 12}px`;
      this.labelL.querySelector<HTMLElement>('.vp-size')!.textContent =
        `${Math.round(active.left.w)}×${Math.round(active.left.h)}px`;
      this.crossL.style.display = 'block';
      this.crossL.style.left = `${active.left.x + active.left.w / 2}px`;
      this.crossL.style.top = `${active.left.h / 2}px`;
    } else this.crossL.style.display = 'none';
    if (active.right) {
      this.labelR.style.right = 'auto';
      this.labelR.style.left = `${active.right.x + active.right.w - 12}px`;
      this.labelR.style.transform = 'translateX(-100%)';
      this.labelR.querySelector<HTMLElement>('.vp-size')!.textContent =
        `${Math.round(active.right.w)}×${Math.round(active.right.h)}px`;
      this.crossR.style.display = 'block';
      this.crossR.style.left = `${active.right.x + active.right.w / 2}px`;
      this.crossR.style.top = `${active.right.h / 2}px`;
    } else this.crossR.style.display = 'none';
    return active;
  }

  /** 每帧刷新所有标记投影点 */
  updateDots(frames: MarkerFrame[], viewports: Record<EyeId, ViewportRect | null>): void {
    const eyes: EyeId[] = ['left', 'right'];
    for (const f of frames) {
      const dots = this.ensureDots(f.def.id, f.def.color);
      for (const [i, eye] of eyes.entries()) {
        const vp = viewports[eye];
        const er = f.read[eye];
        const dot = dots[i];
        if (!vp || !er.visible || er.u === null || er.v === null) {
          dot.el.style.display = 'none';
          continue;
        }
        dot.el.style.display = 'block';
        dot.el.style.left = `${vp.x + er.u * vp.w}px`;
        dot.el.style.top = `${er.v * vp.h}px`;
        const unsafe = f.read.unsafe;
        dot.el.style.outline = unsafe ? '3px solid #d29922' : 'none';
        dot.el.style.boxShadow = f.selected
          ? '0 0 0 3px rgba(74,168,255,.95), 0 0 14px rgba(74,168,255,.9)'
          : 'none';
        if (f.selected) {
          const dTxt = f.read.disparity === null
            ? VISIBILITY_TEXT[f.read.visibility]
            : `d=${(f.read.disparity * 100).toFixed(3)}%`;
          dot.label.textContent = `${f.def.label} · ${eye === 'left' ? 'L' : 'R'} · ${dTxt}`;
          dot.label.style.display = 'block';
        } else {
          dot.label.style.display = 'none';
        }
      }
    }
  }

  /** 俯视示意图：rig 局部 X-Z 平面 */
  drawMinimap(rig: StereoRig, frames: MarkerFrame[]): void {
    const ctx = this.mm;
    const W = this.minimap.width;
    const H = this.minimap.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(10,14,20,0.9)';
    ctx.fillRect(0, 0, W, H);

    const xMin = -10, xMax = 10;   // 米
    const dMin = 0, dMax = 34;     // 正深度（米）
    const pad = 18;
    const sx = (x: number) => pad + ((x - xMin) / (xMax - xMin)) * (W - pad * 2);
    // 深度 0（眼位）在顶部，深度增大向底部
    const sy = (d: number) => pad + ((d - dMin) / (dMax - dMin)) * (H - pad * 2);

    // 网格
    ctx.strokeStyle = 'rgba(110,141,180,.25)';
    ctx.lineWidth = 1;
    ctx.font = '10px monospace';
    ctx.fillStyle = '#8b96a7';
    for (let d = 0; d <= 30; d += 5) {
      ctx.beginPath(); ctx.moveTo(sx(xMin), sy(d)); ctx.lineTo(sx(xMax), sy(d)); ctx.stroke();
      ctx.fillText(`${d}m`, 2, sy(d) - 2);
    }
    ctx.beginPath(); ctx.moveTo(sx(0), sy(dMin)); ctx.lineTo(sx(0), sy(dMax)); ctx.stroke();

    const p = rig.params;

    // 视锥（两只眼，near/far），示意图深度坐标 = 正深度
    for (const eye of ['left', 'right'] as const) {
      const ex = eye === 'left' ? -p.baseline / 2 : p.baseline / 2;
      const tanH = Math.tan(THREE.MathUtils.degToRad(p.fov) / 2);
      ctx.strokeStyle = eye === 'left' ? 'rgba(255,123,114,.8)' : 'rgba(88,166,255,.8)';
      ctx.beginPath();
      for (const depth of [p.near, p.far]) {
        const half = depth * tanH;
        const shift = (eye === 'left' ? 1 : -1) * (p.baseline / 2) * (p.near / p.convergence) * (depth / p.near);
        const cx = ex + shift;
        ctx.moveTo(sx(ex), sy(0));
        ctx.lineTo(sx(cx - half), sy(depth));
        ctx.moveTo(sx(ex), sy(0));
        ctx.lineTo(sx(cx + half), sy(depth));
      }
      ctx.stroke();
      // 眼位
      ctx.fillStyle = eye === 'left' ? '#ff7b72' : '#58a6ff';
      ctx.beginPath(); ctx.arc(sx(ex), sy(0), 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#d7dde7';
      ctx.fillText(eye === 'left' ? 'L' : 'R', sx(ex) + (eye === 'left' ? -10 : 5), sy(0) + 12);
    }

    // 会聚面
    ctx.strokeStyle = '#3fb950';
    ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(sx(xMin), sy(p.convergence)); ctx.lineTo(sx(xMax), sy(p.convergence)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#3fb950';
    ctx.fillText(`zc=${p.convergence.toFixed(1)}m`, W - 78, sy(p.convergence) - 3);

    // near/far 边界
    ctx.strokeStyle = 'rgba(248,81,73,.55)';
    for (const depth of [p.near, p.far]) {
      ctx.beginPath(); ctx.moveTo(sx(xMin), sy(depth)); ctx.lineTo(sx(xMax), sy(depth)); ctx.stroke();
    }

    // 标记（rig 局部坐标：深度 = −localZ）
    for (const f of frames) {
      const local = rig.root.worldToLocal(f.def.position.clone());
      const depth = -local.z;
      if (depth < dMin || depth > dMax) continue;
      const c = `#${GROUP_COLORS[f.def.group].toString(16).padStart(6, '0')}`;
      ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(sx(local.x), sy(depth), f.selected ? 4.5 : 3, 0, Math.PI * 2); ctx.fill();
      if (f.read.visibility !== 'both') {
        ctx.strokeStyle = '#f85149';
        ctx.beginPath(); ctx.arc(sx(local.x), sy(depth), 6, 0, Math.PI * 2); ctx.stroke();
      }
      if (f.selected) {
        ctx.strokeStyle = '#fff';
        ctx.beginPath(); ctx.arc(sx(local.x), sy(depth), 7, 0, Math.PI * 2); ctx.stroke();
      }
    }

    // 标题
    ctx.fillStyle = '#8b96a7';
    ctx.font = '11px sans-serif';
    ctx.fillText('俯视（X-深度，米；下方为前方）', pad, 12);
  }
}
