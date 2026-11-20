import {
  Conflict,
  Pt,
  Ring,
  expectedArea,
  findConflicts,
  signedArea,
  triangulate,
} from './geometry.js';
import { Sample, comboSample, doubleHoleSample, grooveSample } from './samples.js';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const panel = document.getElementById('panel')!;

let outer: Ring = [];
let holes: Ring[] = [];
let sampleName = '';

function load(s: Sample): void {
  outer = s.outer.map((p) => ({ ...p }));
  holes = s.holes.map((h) => h.map((p) => ({ ...p })));
  sampleName = s.name;
  render();
}

// ---------------------------------------------------------------- 拖拽

interface DragTarget {
  ring: number; // 0 = 外环, 1.. = 内环
  idx: number;
}
let drag: DragTarget | null = null;
let hover: DragTarget | null = null;

function ringOf(r: number): Ring {
  return r === 0 ? outer : holes[r - 1];
}

function vertexAt(x: number, y: number): DragTarget | null {
  const rings = [outer, ...holes];
  for (let r = 0; r < rings.length; r++) {
    for (let i = 0; i < rings[r].length; i++) {
      const p = rings[r][i];
      if ((p.x - x) ** 2 + (p.y - y) ** 2 <= 12 * 12) return { ring: r, idx: i };
    }
  }
  return null;
}

function canvasPos(e: PointerEvent): Pt {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

canvas.addEventListener('pointerdown', (e) => {
  const p = canvasPos(e);
  drag = vertexAt(p.x, p.y);
  if (drag) canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  const p = canvasPos(e);
  if (drag) {
    const pt = ringOf(drag.ring)[drag.idx];
    pt.x = Math.round(p.x);
    pt.y = Math.round(p.y);
    render();
  } else {
    const h = vertexAt(p.x, p.y);
    if (h !== hover) {
      hover = h;
      canvas.style.cursor = h ? 'grab' : 'default';
      render();
    }
  }
});
canvas.addEventListener('pointerup', () => {
  drag = null;
  render();
});

// ---------------------------------------------------------------- 渲染

function ringLabel(r: number): string {
  return r === 0 ? '外环' : `内环${r}`;
}

function conflictText(c: Conflict): string {
  if (c.kind === 'hole-outside') return `${ringLabel(c.ringA)} 跑到外环之外`;
  if (c.kind === 'hole-overlap')
    return `${ringLabel(c.ringA)} 与 ${ringLabel(c.ringB)} 互相嵌套`;
  return `${ringLabel(c.ringA)}边${c.edgeA} × ${ringLabel(c.ringB)}边${c.edgeB}`;
}

function drawRing(r: Ring, color: string, ringIdx: number, conflicts: Conflict[]): void {
  const conflictEdges = new Set(
    conflicts.filter((c) => c.kind === 'cross').flatMap((c) =>
      [c.ringA === ringIdx ? `e${c.edgeA}` : '', c.ringB === ringIdx ? `e${c.edgeB}` : ''],
    ),
  );
  for (let i = 0; i < r.length; i++) {
    const a = r[i];
    const b = r[(i + 1) % r.length];
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    if (conflictEdges.has(`e${i}`)) {
      ctx.strokeStyle = '#e02424';
      ctx.lineWidth = 5;
    } else {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2.5;
    }
    ctx.stroke();
  }
  // 顶点
  for (let i = 0; i < r.length; i++) {
    const p = r[i];
    const active =
      (drag && drag.ring === ringIdx && drag.idx === i) ||
      (hover && hover.ring === ringIdx && hover.idx === i);
    ctx.beginPath();
    ctx.arc(p.x, p.y, active ? 8 : 6, 0, Math.PI * 2);
    ctx.fillStyle = active ? '#ffbf00' : color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.font = '10px monospace';
    ctx.fillText(`${ringIdx === 0 ? 'O' : 'H' + ringIdx}${i}`, p.x + 9, p.y - 7);
  }
}

function render(): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const conflicts = findConflicts(outer, holes);
  let panelHTML = `<h3>样例:${sampleName}</h3>`;

  if (conflicts.length === 0) {
    const tris = triangulate(outer, holes);
    const total = tris.reduce((s, t) => s + t.area, 0);
    const exp = expectedArea(outer, holes);

    tris.forEach((t, i) => {
      ctx.beginPath();
      ctx.moveTo(t.a.x, t.a.y);
      ctx.lineTo(t.b.x, t.b.y);
      ctx.lineTo(t.c.x, t.c.y);
      ctx.closePath();
      ctx.fillStyle = `hsla(${(i * 47) % 360}, 70%, 60%, 0.22)`;
      ctx.fill();
      ctx.strokeStyle = 'rgba(60,60,60,0.55)';
      ctx.lineWidth = 1;
      ctx.stroke();
      const cx = (t.a.x + t.b.x + t.c.x) / 3;
      const cy = (t.a.y + t.b.y + t.c.y) / 3;
      ctx.fillStyle = '#222';
      ctx.font = '11px monospace';
      ctx.fillText(`#${i}`, cx - 8, cy - 2);
      ctx.fillText(t.area.toFixed(0), cx - 14, cy + 11);
    });

    const ok = Math.abs(total - exp) < Math.max(1e-6 * exp, 1e-6);
    panelHTML += `
      <p>三角形数量:<b>${tris.length}</b>(理论 ${outer.length + holes.reduce((s, h) => s + h.length, 0) + 2 * holes.length - 2})</p>
      <p>网格总面积:<b>${total.toFixed(2)}</b></p>
      <p>期望面积(|外环|−Σ|洞|):<b>${exp.toFixed(2)}</b></p>
      <p style="color:${ok ? '#0a0' : '#e02424'}">${ok ? '✓ 面积一致,凹角与洞边均为网格边界' : '✗ 面积不一致!'}</p>`;
  } else {
    // 有冲突:清除旧网格,只画环和冲突边
    panelHTML += `<p style="color:#e02424"><b>检测到 ${conflicts.length} 处冲突,网格已清除:</b></p><ul>`;
    for (const c of conflicts) panelHTML += `<li>${conflictText(c)}</li>`;
    panelHTML += `</ul><p>拖动顶点解除冲突后自动重建网格。</p>`;
  }

  drawRing(outer, '#1d4ed8', 0, conflicts);
  holes.forEach((h, i) => drawRing(h, '#c2410c', i + 1, conflicts));

  panelHTML += `<p class="dim">外环有符号面积:${signedArea(outer).toFixed(0)}(绕向由程序自动规范化,交换点序不影响结果)</p>`;
  panel.innerHTML = panelHTML;
}

// ---------------------------------------------------------------- 按钮

document.getElementById('btn-groove')!.addEventListener('click', () => load(grooveSample()));
document.getElementById('btn-holes')!.addEventListener('click', () => load(doubleHoleSample()));
document.getElementById('btn-combo')!.addEventListener('click', () => load(comboSample()));
document.getElementById('btn-rev-outer')!.addEventListener('click', () => {
  outer.reverse();
  outer.push(outer.shift()!); // 再旋转一位,充分打乱点序
  render();
});
document.getElementById('btn-rev-hole')!.addEventListener('click', () => {
  if (holes.length === 0) return;
  const h = holes[0];
  h.reverse();
  h.push(h.shift()!);
  render();
});

load(grooveSample());
