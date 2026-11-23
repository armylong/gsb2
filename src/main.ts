// 九宫格切片预览:源图拖分割线,成品拖宽高,边/中间可拉伸或平铺,导出透明 PNG。

type SliceMode = 'stretch' | 'tile';

interface Slices { l: number; t: number; r: number; b: number; } // r/b 为右/下分割线坐标

interface Layout {
  fx: number; fy: number;          // 四角压缩系数(<1 表示空间不足被压缩)
  lw: number; rw: number;          // 左/右角在成品中的宽
  th: number; bh: number;          // 上/下角在成品中的高
  midW: number; midH: number;      // 中间区域尺寸
}

const state = {
  src: null as HTMLCanvasElement | null,
  srcLabel: '',
  slices: { l: 0, t: 0, r: 0, b: 0 } as Slices,
  outW: 260,
  outH: 140,
  modeH: 'stretch' as SliceMode, // 上下边(水平方向填充)
  modeV: 'stretch' as SliceMode, // 左右边(垂直方向填充)
  modeC: 'stretch' as SliceMode, // 中间
  showRegions: true,
  checker: true,
  smooth: true,
  srcZoom: 3,
  dstZoom: 3,
};

// ---------- DOM ----------
function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error('missing #' + id);
  return e as T;
}
function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const g = c.getContext('2d');
  if (!g) throw new Error('no 2d context');
  return g;
}

const srcView = el<HTMLCanvasElement>('srcView');
const dstView = el<HTMLCanvasElement>('dstView');
const magCanvas = el<HTMLCanvasElement>('mag');
const srcInfo = el<HTMLDivElement>('srcInfo');
const dstInfo = el<HTMLDivElement>('dstInfo');
const magInfo = el<HTMLDivElement>('magInfo');

// 1:1 渲染结果的离屏画布(导出与预览共用同一渲染路径)
const dstOff = document.createElement('canvas');
let srcData: ImageData | null = null; // 源图像素缓存(像素查看用)
let dstData: ImageData | null = null; // 成品像素缓存

// ---------- 内置贴图:程序绘制 ----------

// 贴图 A:窄边花纹。边框只有几像素宽,角上有花纹,边上有小菱形装饰。
// 用来测窄边切片,以及"分割线切到花纹时花纹被拉长"的现象。
function makeNarrowEdgeTexture(): HTMLCanvasElement {
  const S = 128, CORNER = 26;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = ctx2d(c);

  // 底
  g.fillStyle = '#f6eeda';
  g.fillRect(0, 0, S, S);
  g.fillStyle = '#efe2c4';
  g.fillRect(6, 6, S - 12, S - 12);

  // 窄边框:2px 深线 + 1px 亮线 + 1px 深线,总共约 5px
  g.fillStyle = '#8a5a2b';
  g.fillRect(0, 0, S, 2); g.fillRect(0, S - 2, S, 2);
  g.fillRect(0, 0, 2, S); g.fillRect(S - 2, 0, 2, S);
  g.fillStyle = '#e8d9b0';
  g.fillRect(2, 2, S - 4, 1); g.fillRect(2, S - 3, S - 4, 1);
  g.fillRect(2, 2, 1, S - 4); g.fillRect(S - 3, 2, 1, S - 4);
  g.fillStyle = '#8a5a2b';
  g.fillRect(3, 3, S - 6, 1); g.fillRect(3, S - 4, S - 6, 1);
  g.fillRect(3, 3, 1, S - 6); g.fillRect(S - 4, 3, 1, S - 6);

  // 边上每隔 16px 一颗小菱形(位于窄边上,拉伸时会被拉长,平铺时会重复)
  g.fillStyle = '#b3702f';
  for (let x = CORNER + 8; x < S - CORNER - 4; x += 16) {
    diamond(g, x, 4, 3);
    diamond(g, x, S - 4, 3);
  }
  for (let y = CORNER + 8; y < S - CORNER - 4; y += 16) {
    diamond(g, 4, y, 3);
    diamond(g, S - 4, y, 3);
  }

  // 四角花纹:花瓣 + 圆点,占满角区,分割线放错就会被切进拉伸区
  for (const [cx, cy] of [[13, 13], [S - 13, 13], [13, S - 13], [S - 13, S - 13]] as const) {
    g.fillStyle = '#b3702f';
    for (let k = 0; k < 4; k++) {
      const a = k * Math.PI / 2 + Math.PI / 4;
      g.beginPath();
      g.ellipse(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6, 5, 2.5, a, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#8a3b1e';
    g.beginPath(); g.arc(cx, cy, 3, 0, Math.PI * 2); g.fill();
    // 伸向边的小藤条(故意伸到 26px 角区边缘,方便演示切错线)
    g.strokeStyle = '#b3702f';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(cx, cy);
    g.quadraticCurveTo(cx + (cx < S / 2 ? 10 : -10), cy, cx + (cx < S / 2 ? 13 : -13), cy);
    g.stroke();
  }

  // 中心淡淡的纹理,便于观察中间的拉伸/平铺
  g.fillStyle = 'rgba(179,112,47,0.12)';
  for (let y = CORNER; y < S - CORNER; y += 12) {
    for (let x = CORNER + ((y / 12) % 2) * 6; x < S - CORNER; x += 12) {
      g.fillRect(x, y, 2, 2);
    }
  }
  return c;
}

function diamond(g: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  g.beginPath();
  g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
  g.closePath(); g.fill();
}

// 贴图 B:半透明圆角面板。圆角 + 半透明渐变 + 外发光,专门测透明边缘与接缝。
function makeRoundedTexture(): HTMLCanvasElement {
  const S = 128, R = 30, PAD = 12;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = ctx2d(c);

  const rr = (x: number, y: number, w: number, h: number, r: number): void => {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  };

  // 外发光(半透明,逐层衰减)
  for (let i = 6; i >= 1; i--) {
    g.fillStyle = `rgba(70,110,220,${0.05 * (7 - i)})`;
    rr(PAD - i, PAD - i, S - 2 * PAD + 2 * i, S - 2 * PAD + 2 * i, R + i);
    g.fill();
  }
  // 主体:半透明竖向渐变
  const grad = g.createLinearGradient(0, PAD, 0, S - PAD);
  grad.addColorStop(0, 'rgba(255,255,255,0.65)');
  grad.addColorStop(0.5, 'rgba(170,200,255,0.45)');
  grad.addColorStop(1, 'rgba(90,130,230,0.55)');
  rr(PAD, PAD, S - 2 * PAD, S - 2 * PAD, R);
  g.fillStyle = grad;
  g.fill();
  // 半透明描边
  g.strokeStyle = 'rgba(255,255,255,0.8)';
  g.lineWidth = 2;
  rr(PAD + 1, PAD + 1, S - 2 * PAD - 2, S - 2 * PAD - 2, R - 1);
  g.stroke();
  g.strokeStyle = 'rgba(40,70,160,0.5)';
  g.lineWidth = 1.5;
  rr(PAD, PAD, S - 2 * PAD, S - 2 * PAD, R);
  g.stroke();
  // 角上高光点(检查角是否变形用)
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.beginPath(); g.arc(PAD + 12, PAD + 10, 3, 0, Math.PI * 2); g.fill();
  return c;
}

// ---------- 九宫格渲染核心(预览与导出共用) ----------

function computeLayout(sw: number, sh: number, sl: Slices, outW: number, outH: number): Layout {
  const clw = sl.l, crw = sw - sl.r;
  const cth = sl.t, cbh = sh - sl.b;
  // 宽/高放不下两侧角时,两侧角按同一系数压缩,保证不互相覆盖;放大后自动恢复
  const fx = clw + crw > 0 ? Math.min(1, outW / (clw + crw)) : 1;
  const fy = cth + cbh > 0 ? Math.min(1, outH / (cth + cbh)) : 1;
  const lw = clw * fx, rw = crw * fx;
  const th = cth * fy, bh = cbh * fy;
  return { fx, fy, lw, rw, th, bh, midW: outW - lw - rw, midH: outH - th - bh };
}

// 用一块源区域填充目标区域;每个轴独立选择拉伸或平铺。
// 平铺从目标区域左上角开始,末尾不足一块时按剩余比例裁切源图,能看清截到哪里。
function fillRegion(
  g: CanvasRenderingContext2D, src: HTMLCanvasElement,
  sx: number, sy: number, sw: number, sh: number,
  dx: number, dy: number, dw: number, dh: number,
  modeX: SliceMode, modeY: SliceMode
): void {
  if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
  g.save();
  g.beginPath();
  g.rect(dx, dy, dw, dh);
  g.clip();
  if (modeX === 'stretch' && modeY === 'stretch') {
    g.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
  } else {
    const tileW = modeX === 'tile' ? sw : dw;
    const tileH = modeY === 'tile' ? sh : dh;
    let guard = 0;
    for (let y = dy; y < dy + dh - 1e-9; y += tileH) {
      for (let x = dx; x < dx + dw - 1e-9; x += tileW) {
        if (++guard > 20000) { g.restore(); return; }
        const w = Math.min(tileW, dx + dw - x);
        const h = Math.min(tileH, dy + dh - y);
        const srcW = modeX === 'tile' ? sw * (w / tileW) : sw;
        const srcH = modeY === 'tile' ? sh * (h / tileH) : sh;
        g.drawImage(src, sx, sy, srcW, srcH, x, y, w, h);
      }
    }
  }
  g.restore();
}

function renderNineSlice(
  g: CanvasRenderingContext2D, src: HTMLCanvasElement, sl: Slices,
  outW: number, outH: number
): Layout {
  const sw = src.width, sh = src.height;
  const L = computeLayout(sw, sh, sl, outW, outH);
  const mw = sl.r - sl.l, mh = sl.b - sl.t; // 源中间块尺寸
  g.imageSmoothingEnabled = state.smooth;

  // 四角:保留尺寸;空间不足时按 fx/fy 一致压缩
  if (L.lw > 0 && L.th > 0) g.drawImage(src, 0, 0, sl.l, sl.t, 0, 0, L.lw, L.th);
  if (L.rw > 0 && L.th > 0) g.drawImage(src, sl.r, 0, sw - sl.r, sl.t, L.lw + L.midW, 0, L.rw, L.th);
  if (L.lw > 0 && L.bh > 0) g.drawImage(src, 0, sl.b, sl.l, sh - sl.b, 0, L.th + L.midH, L.lw, L.bh);
  if (L.rw > 0 && L.bh > 0) g.drawImage(src, sl.r, sl.b, sw - sl.r, sh - sl.b, L.lw + L.midW, L.th + L.midH, L.rw, L.bh);
  // 上下边:水平方向按 modeH,垂直方向跟随角高
  fillRegion(g, src, sl.l, 0, mw, sl.t, L.lw, 0, L.midW, L.th, state.modeH, 'stretch');
  fillRegion(g, src, sl.l, sl.b, mw, sh - sl.b, L.lw, L.th + L.midH, L.midW, L.bh, state.modeH, 'stretch');
  // 左右边:垂直方向按 modeV
  fillRegion(g, src, 0, sl.t, sl.l, mh, 0, L.th, L.lw, L.midH, 'stretch', state.modeV);
  fillRegion(g, src, sl.r, sl.t, sw - sl.r, mh, L.lw + L.midW, L.th, L.rw, L.midH, 'stretch', state.modeV);
  // 中间
  fillRegion(g, src, sl.l, sl.t, mw, mh, L.lw, L.th, L.midW, L.midH, state.modeC, state.modeC);
  return L;
}

// ---------- 视图绘制 ----------

const REGION_FILL = ['rgba(255,90,90,0.16)', 'rgba(80,150,255,0.16)', 'rgba(255,90,90,0.16)',
                     'rgba(80,150,255,0.16)', 'rgba(90,210,120,0.16)', 'rgba(80,150,255,0.16)',
                     'rgba(255,90,90,0.16)', 'rgba(80,150,255,0.16)', 'rgba(255,90,90,0.16)'];
const REGION_LINE = ['rgba(230,60,60,0.7)', 'rgba(50,120,230,0.7)', 'rgba(230,60,60,0.7)',
                     'rgba(50,120,230,0.7)', 'rgba(40,170,80,0.7)', 'rgba(50,120,230,0.7)',
                     'rgba(230,60,60,0.7)', 'rgba(50,120,230,0.7)', 'rgba(230,60,60,0.7)'];
const REGION_NAME = ['左上', '上边', '右上', '左边', '中间', '右边', '左下', '下边', '右下'];

function drawChecker(g: CanvasRenderingContext2D, w: number, h: number, size: number): void {
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#c8ccd4';
  for (let y = 0; y < h; y += size) {
    for (let x = ((y / size) % 2) * size; x < w; x += size * 2) {
      g.fillRect(x, y, size, size);
    }
  }
}

// 在指定缩放下的 9 个区域矩形(源图用分割线,成品用布局结果)
function regionRects(xs: number[], ys: number[]): { x: number; y: number; w: number; h: number }[] {
  const out: { x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out.push({ x: xs[c], y: ys[r], w: xs[c + 1] - xs[c], h: ys[r + 1] - ys[r] });
    }
  }
  return out;
}

function drawRegionOverlay(
  g: CanvasRenderingContext2D,
  rects: { x: number; y: number; w: number; h: number }[],
  zoom: number
): void {
  rects.forEach((rc, i) => {
    const x = rc.x * zoom, y = rc.y * zoom, w = rc.w * zoom, h = rc.h * zoom;
    g.fillStyle = REGION_FILL[i];
    g.fillRect(x, y, w, h);
    g.strokeStyle = REGION_LINE[i];
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    if (w >= 22 && h >= 14) {
      g.fillStyle = 'rgba(30,30,30,0.75)';
      g.font = '10px sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(`${i + 1} ${REGION_NAME[i]}`, x + w / 2, y + h / 2);
    }
  });
}

function drawSrcView(): void {
  const src = state.src;
  if (!src) return;
  const z = state.srcZoom;
  const sl = state.slices;
  const w = Math.max(1, Math.round(src.width * z));
  const h = Math.max(1, Math.round(src.height * z));
  srcView.width = w;
  srcView.height = h;
  const g = ctx2d(srcView);
  if (state.checker) drawChecker(g, w, h, 8);
  g.imageSmoothingEnabled = false;
  g.drawImage(src, 0, 0, w, h);

  if (state.showRegions) {
    drawRegionOverlay(g, regionRects([0, sl.l, sl.r, src.width], [0, sl.t, sl.b, src.height]), z);
  }
  // 四条分割线
  const lines: { v: boolean; p: number; color: string }[] = [
    { v: true, p: sl.l, color: '#e03e2d' },
    { v: true, p: sl.r, color: '#e03e2d' },
    { v: false, p: sl.t, color: '#7a3fd4' },
    { v: false, p: sl.b, color: '#7a3fd4' },
  ];
  for (const ln of lines) {
    g.strokeStyle = ln.color;
    g.lineWidth = 2;
    g.beginPath();
    if (ln.v) { g.moveTo(ln.p * z, 0); g.lineTo(ln.p * z, h); }
    else { g.moveTo(0, ln.p * z); g.lineTo(w, ln.p * z); }
    g.stroke();
  }
  srcInfo.textContent =
    `${state.srcLabel}  ${src.width}×${src.height}px\n` +
    `分割线: 左 ${sl.l}  右 ${sl.r}  上 ${sl.t}  下 ${sl.b}` +
    `  (角 ${sl.l}×${sl.t} / ${src.width - sl.r}×${src.height - sl.b},中间 ${sl.r - sl.l}×${sl.b - sl.t})`;
}

function drawDstView(): void {
  const src = state.src;
  if (!src) return;
  const z = state.dstZoom;
  // 1:1 渲染到离屏画布(与导出同一路径)
  dstOff.width = state.outW;
  dstOff.height = state.outH;
  const og = ctx2d(dstOff);
  og.clearRect(0, 0, state.outW, state.outH);
  const L = renderNineSlice(og, src, state.slices, state.outW, state.outH);
  dstData = og.getImageData(0, 0, state.outW, state.outH);

  // 无平滑放大显示
  const w = Math.max(1, Math.round(state.outW * z));
  const h = Math.max(1, Math.round(state.outH * z));
  dstView.width = w;
  dstView.height = h;
  const g = ctx2d(dstView);
  if (state.checker) drawChecker(g, w, h, 8);
  g.imageSmoothingEnabled = false;
  g.drawImage(dstOff, 0, 0, w, h);

  if (state.showRegions) {
    drawRegionOverlay(g, regionRects(
      [0, L.lw, L.lw + L.midW, state.outW],
      [0, L.th, L.th + L.midH, state.outH]
    ), z);
    drawTileMarkers(g, L, z);
  }
  // 缩放网格线(放大到 4 倍以上时画出像素格,便于看细缝)
  if (z >= 4) {
    g.strokeStyle = 'rgba(0,0,0,0.08)';
    g.lineWidth = 1;
    for (let x = 1; x < state.outW; x++) {
      g.beginPath(); g.moveTo(x * z + 0.5, 0); g.lineTo(x * z + 0.5, h); g.stroke();
    }
    for (let y = 1; y < state.outH; y++) {
      g.beginPath(); g.moveTo(0, y * z + 0.5); g.lineTo(w, y * z + 0.5); g.stroke();
    }
  }
  // 外框 + 右/下/角拖拽把手
  g.strokeStyle = '#333';
  g.lineWidth = 1;
  g.strokeRect(0.5, 0.5, w - 1, h - 1);
  g.fillStyle = '#333';
  g.fillRect(w - 3, h / 2 - 10, 6, 20);
  g.fillRect(w / 2 - 10, h - 3, 20, 6);
  g.fillRect(w - 5, h - 5, 10, 10);

  const compress: string[] = [];
  if (L.fx < 1) compress.push(`宽度不足,左右角压缩到 ${(L.fx * 100).toFixed(1)}%`);
  if (L.fy < 1) compress.push(`高度不足,上下角压缩到 ${(L.fy * 100).toFixed(1)}%`);
  dstInfo.textContent =
    `成品 ${state.outW}×${state.outH}px  (缩放 ${z}×)` +
    (compress.length ? `\n${compress.join(';')},四角互不覆盖,放大后恢复` : '\n四角保持原始尺寸');
}

// 平铺区域画出每块的分界虚线,便于看清平铺起点与末尾截断位置
function drawTileMarkers(g: CanvasRenderingContext2D, L: Layout, z: number): void {
  const src = state.src;
  if (!src) return;
  const sl = state.slices;
  const mw = sl.r - sl.l, mh = sl.b - sl.t;
  g.save();
  g.strokeStyle = 'rgba(230,0,140,0.75)';
  g.lineWidth = 1;
  g.setLineDash([4, 3]);
  const vline = (x: number, y0: number, y1: number): void => {
    g.beginPath(); g.moveTo(x * z, y0 * z); g.lineTo(x * z, y1 * z); g.stroke();
  };
  const hline = (y: number, x0: number, x1: number): void => {
    g.beginPath(); g.moveTo(x0 * z, y * z); g.lineTo(x1 * z, y * z); g.stroke();
  };
  if (state.modeH === 'tile' && mw > 0) {
    for (let x = L.lw + mw; x < L.lw + L.midW - 1e-9; x += mw) {
      vline(x, 0, L.th);
      vline(x, L.th + L.midH, state.outH);
    }
  }
  if (state.modeV === 'tile' && mh > 0) {
    for (let y = L.th + mh; y < L.th + L.midH - 1e-9; y += mh) {
      hline(y, 0, L.lw);
      hline(y, L.lw + L.midW, state.outW);
    }
  }
  if (state.modeC === 'tile') {
    if (mw > 0) for (let x = L.lw + mw; x < L.lw + L.midW - 1e-9; x += mw) vline(x, L.th, L.th + L.midH);
    if (mh > 0) for (let y = L.th + mh; y < L.th + L.midH - 1e-9; y += mh) hline(y, L.lw, L.lw + L.midW);
  }
  g.restore();
}

function renderAll(): void {
  const src = state.src;
  if (!src) return;
  srcData = ctx2d(src).getImageData(0, 0, src.width, src.height);
  drawSrcView();
  drawDstView();
}

// ---------- 像素查看 ----------

function updateMag(view: 'src' | 'dst', px: number, py: number): void {
  const data = view === 'src' ? srcData : dstData;
  const g = ctx2d(magCanvas);
  const N = 15, half = 7, cell = 15;
  g.fillStyle = '#20242a';
  g.fillRect(0, 0, magCanvas.width, magCanvas.height);
  if (!data || px < 0 || py < 0 || px >= data.width || py >= data.height) {
    magInfo.textContent = '把鼠标移到源图或成品上';
    return;
  }
  for (let dy = -half; dy <= half; dy++) {
    for (let dx = -half; dx <= half; dx++) {
      const x = px + dx, y = py + dy;
      if (x < 0 || y < 0 || x >= data.width || y >= data.height) continue;
      const i = (y * data.width + x) * 4;
      const d = data.data;
      g.fillStyle = `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3] / 255})`;
      // 透明像素画棋盘,避免和面板底色混淆
      if (d[i + 3] < 255) {
        g.fillStyle = ((x + y) % 2 === 0) ? '#c8ccd4' : '#ffffff';
        g.fillRect((dx + half) * cell, (dy + half) * cell, cell, cell);
        g.fillStyle = `rgba(${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3] / 255})`;
      }
      g.fillRect((dx + half) * cell, (dy + half) * cell, cell, cell);
    }
  }
  // 网格 + 中心十字
  g.strokeStyle = 'rgba(0,0,0,0.15)';
  g.lineWidth = 1;
  for (let k = 0; k <= N; k++) {
    g.beginPath(); g.moveTo(k * cell + 0.5, 0); g.lineTo(k * cell + 0.5, N * cell); g.stroke();
    g.beginPath(); g.moveTo(0, k * cell + 0.5); g.lineTo(N * cell, k * cell + 0.5); g.stroke();
  }
  g.strokeStyle = '#e03e2d';
  g.lineWidth = 2;
  g.strokeRect(half * cell + 1, half * cell + 1, cell - 2, cell - 2);

  const i = (py * data.width + px) * 4;
  const d = data.data;
  let region = '';
  if (view === 'dst' && state.src) {
    const L = computeLayout(state.src.width, state.src.height, state.slices, state.outW, state.outH);
    const col = px < L.lw ? 0 : px < L.lw + L.midW ? 1 : 2;
    const row = py < L.th ? 0 : py < L.th + L.midH ? 1 : 2;
    region = `  区域:${REGION_NAME[row * 3 + col]}`;
  }
  magInfo.textContent =
    `${view === 'src' ? '源图' : '成品'} (${px}, ${py})${region}\n` +
    `rgba(${d[i]}, ${d[i + 1]}, ${d[i + 2]}, ${d[i + 3]})  alpha ${(d[i + 3] / 255 * 100).toFixed(1)}%`;
}

// ---------- 交互:拖分割线 / 拖成品尺寸 ----------

type Drag =
  | { kind: 'slice'; line: 'l' | 'r' | 't' | 'b' }
  | { kind: 'resize'; horiz: boolean; vert: boolean }
  | null;

let drag: Drag = null;

function canvasPos(e: PointerEvent, c: HTMLCanvasElement): { x: number; y: number } {
  const r = c.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function clampSlices(): void {
  const src = state.src;
  if (!src) return;
  const sl = state.slices;
  sl.l = Math.max(0, Math.min(sl.l, src.width - 1));
  sl.r = Math.max(sl.l + 1, Math.min(sl.r, src.width));
  sl.t = Math.max(0, Math.min(sl.t, src.height - 1));
  sl.b = Math.max(sl.t + 1, Math.min(sl.b, src.height));
}

srcView.addEventListener('pointerdown', (e: PointerEvent) => {
  const src = state.src;
  if (!src) return;
  const p = canvasPos(e, srcView);
  const z = state.srcZoom;
  const sl = state.slices;
  const TOL = 6;
  const cand = ([
    { line: 'l', d: Math.abs(p.x - sl.l * z) },
    { line: 'r', d: Math.abs(p.x - sl.r * z) },
    { line: 't', d: Math.abs(p.y - sl.t * z) },
    { line: 'b', d: Math.abs(p.y - sl.b * z) },
  ] as { line: 'l' | 'r' | 't' | 'b'; d: number }[])
    .filter(c => c.d <= TOL).sort((a, b) => a.d - b.d);
  if (cand.length > 0) {
    drag = { kind: 'slice', line: cand[0].line };
    srcView.setPointerCapture(e.pointerId);
  }
});

srcView.addEventListener('pointermove', (e: PointerEvent) => {
  const src = state.src;
  if (!src) return;
  const p = canvasPos(e, srcView);
  const z = state.srcZoom;
  if (drag && drag.kind === 'slice') {
    const sl = state.slices;
    const v = drag.line === 'l' || drag.line === 'r'
      ? Math.round(p.x / z) : Math.round(p.y / z);
    sl[drag.line] = v;
    clampSlices();
    renderAll();
  } else {
    const sl = state.slices;
    const nearV = Math.min(Math.abs(p.x - sl.l * z), Math.abs(p.x - sl.r * z)) <= 6;
    const nearH = Math.min(Math.abs(p.y - sl.t * z), Math.abs(p.y - sl.b * z)) <= 6;
    srcView.style.cursor = nearV ? 'ew-resize' : nearH ? 'ns-resize' : 'crosshair';
  }
  updateMag('src', Math.floor(p.x / z), Math.floor(p.y / z));
});

srcView.addEventListener('pointerup', () => { drag = null; });

dstView.addEventListener('pointerdown', (e: PointerEvent) => {
  const p = canvasPos(e, dstView);
  const w = dstView.width, h = dstView.height;
  const nearR = Math.abs(p.x - w) <= 6;
  const nearB = Math.abs(p.y - h) <= 6;
  if (nearR || nearB) {
    drag = { kind: 'resize', horiz: nearR, vert: nearB };
    dstView.setPointerCapture(e.pointerId);
  }
});

dstView.addEventListener('pointermove', (e: PointerEvent) => {
  const p = canvasPos(e, dstView);
  const z = state.dstZoom;
  if (drag && drag.kind === 'resize') {
    if (drag.horiz) state.outW = Math.max(1, Math.min(8192, Math.round(p.x / z)));
    if (drag.vert) state.outH = Math.max(1, Math.min(8192, Math.round(p.y / z)));
    renderAll();
    syncExportInputs(false);
  } else {
    const w = dstView.width, h = dstView.height;
    const nearR = Math.abs(p.x - w) <= 6;
    const nearB = Math.abs(p.y - h) <= 6;
    dstView.style.cursor = nearR && nearB ? 'nwse-resize' : nearR ? 'ew-resize' : nearB ? 'ns-resize' : 'crosshair';
  }
  updateMag('dst', Math.floor(p.x / z), Math.floor(p.y / z));
});

dstView.addEventListener('pointerup', () => { drag = null; });

// ---------- 控件 ----------

function setTexture(c: HTMLCanvasElement, label: string, corner: number): void {
  state.src = c;
  state.srcLabel = label;
  state.slices = { l: corner, t: corner, r: c.width - corner, b: c.height - corner };
  renderAll();
}

el<HTMLSelectElement>('texSel').addEventListener('change', (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v === 'narrow') setTexture(makeNarrowEdgeTexture(), '内置:窄边花纹', 26);
  else setTexture(makeRoundedTexture(), '内置:半透明圆角', 40);
});

el<HTMLInputElement>('fileInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const file = input.files && input.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    ctx2d(c).drawImage(img, 0, 0);
    // 自定义图默认按三分之一切
    state.src = c;
    state.srcLabel = `文件:${file.name}`;
    state.slices = {
      l: Math.round(c.width / 3), r: Math.round(c.width * 2 / 3),
      t: Math.round(c.height / 3), b: Math.round(c.height * 2 / 3),
    };
    renderAll();
    URL.revokeObjectURL(img.src);
  };
  img.src = URL.createObjectURL(file);
});

el<HTMLInputElement>('chkRegions').addEventListener('change', (e) => {
  state.showRegions = (e.target as HTMLInputElement).checked; renderAll();
});
el<HTMLInputElement>('chkChecker').addEventListener('change', (e) => {
  state.checker = (e.target as HTMLInputElement).checked; renderAll();
});
el<HTMLInputElement>('chkSmooth').addEventListener('change', (e) => {
  state.smooth = (e.target as HTMLInputElement).checked; renderAll();
});
el<HTMLSelectElement>('modeH').addEventListener('change', (e) => {
  state.modeH = (e.target as HTMLSelectElement).value as SliceMode; renderAll();
});
el<HTMLSelectElement>('modeV').addEventListener('change', (e) => {
  state.modeV = (e.target as HTMLSelectElement).value as SliceMode; renderAll();
});
el<HTMLSelectElement>('modeC').addEventListener('change', (e) => {
  state.modeC = (e.target as HTMLSelectElement).value as SliceMode; renderAll();
});
el<HTMLInputElement>('srcZoom').addEventListener('input', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (v >= 0.5 && v <= 16) { state.srcZoom = v; renderAll(); }
});
el<HTMLInputElement>('dstZoom').addEventListener('input', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (v >= 0.5 && v <= 16) { state.dstZoom = v; renderAll(); }
});

// ---------- 导出 ----------

const expW = el<HTMLInputElement>('expW');
const expH = el<HTMLInputElement>('expH');

function syncExportInputs(fromOutput: boolean): void {
  if (fromOutput) {
    expW.value = String(state.outW);
    expH.value = String(state.outH);
  }
}

el<HTMLButtonElement>('btnReadSize').addEventListener('click', () => syncExportInputs(true));
el<HTMLButtonElement>('btnApplySize').addEventListener('click', () => {
  const w = parseInt(expW.value, 10), h = parseInt(expH.value, 10);
  if (w >= 1 && h >= 1 && w <= 8192 && h <= 8192) {
    state.outW = w;
    state.outH = h;
    renderAll();
  }
});
el<HTMLButtonElement>('btnExport').addEventListener('click', () => {
  const src = state.src;
  if (!src) return;
  const w = parseInt(expW.value, 10), h = parseInt(expH.value, 10);
  if (!(w >= 1 && h >= 1 && w <= 8192 && h <= 8192)) return;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  renderNineSlice(ctx2d(c), src, state.slices, w, h);
  c.toBlob((blob) => {
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `nineslice_${w}x${h}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
});

// ---------- 初始化 ----------

setTexture(makeNarrowEdgeTexture(), '内置:窄边花纹', 26);
syncExportInputs(true);
