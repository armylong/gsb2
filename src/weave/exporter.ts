import { type WeaveState, buildPalettes, evalTop, heightRange, tileSizeX, tileSizeZ } from './weaveMath';

export interface ExportResult {
  colorCanvas: HTMLCanvasElement;
  heightCanvas: HTMLCanvasElement;
  /** 把色图做 2×2 平铺，直接核对四边是否连续 */
  tiledCanvas: HTMLCanvasElement;
  size: number;
}

function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * 导出一个循环的俯视色图与灰度高度图。
 * 两张图尺寸完全一致，逐像素来自 evalTop（与三维管线同一套周期公式），
 * 因此四边严格周期连续，可直接当贴图平铺；不使用任何透视截图。
 */
export function exportMaps(state: WeaveState, size: number): ExportResult {
  const { model, yarn } = state;
  const pal = buildPalettes(state);
  const tx = tileSizeX(yarn, model);
  const tz = tileSizeZ(yarn, model);
  const hr = heightRange(yarn);
  const hRange = hr.max - hr.min;

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = size;
  colorCanvas.height = size;
  const heightCanvas = document.createElement('canvas');
  heightCanvas.width = size;
  heightCanvas.height = size;

  const cImg = colorCanvas.getContext('2d')!.createImageData(size, size);
  const hImg = heightCanvas.getContext('2d')!.createImageData(size, size);

  for (let py = 0; py < size; py++) {
    const z = (py + 0.5) * (tz / size);
    for (let px = 0; px < size; px++) {
      const x = (px + 0.5) * (tx / size);
      const s = evalTop(state, x, z, pal);
      const off = (py * size + px) * 4;

      // 色图：把线性光照结果做 gamma 校正后写入 sRGB
      cImg.data[off] = toByte(Math.pow(Math.min(1, s.r), 1 / 2.2));
      cImg.data[off + 1] = toByte(Math.pow(Math.min(1, s.g), 1 / 2.2));
      cImg.data[off + 2] = toByte(Math.pow(Math.min(1, s.b), 1 / 2.2));
      cImg.data[off + 3] = 255;

      // 高度图：归一化到实际几何高度区间的线性灰度
      const hv = Math.max(0, Math.min(1, (s.y - hr.min) / hRange));
      const g = toByte(hv);
      hImg.data[off] = g;
      hImg.data[off + 1] = g;
      hImg.data[off + 2] = g;
      hImg.data[off + 3] = 255;
    }
  }

  colorCanvas.getContext('2d')!.putImageData(cImg, 0, 0);
  heightCanvas.getContext('2d')!.putImageData(hImg, 0, 0);

  const tiledCanvas = document.createElement('canvas');
  tiledCanvas.width = size * 2;
  tiledCanvas.height = size * 2;
  const tctx = tiledCanvas.getContext('2d')!;
  for (let a = 0; a < 2; a++) {
    for (let b = 0; b < 2; b++) {
      tctx.drawImage(colorCanvas, b * size, a * size);
    }
  }
  // 标出循环边界，方便核对
  tctx.strokeStyle = 'rgba(255,80,200,0.9)';
  tctx.lineWidth = 2;
  tctx.strokeRect(1, 1, size * 2 - 2, size * 2 - 2);
  tctx.beginPath();
  tctx.moveTo(size, 0);
  tctx.lineTo(size, size * 2);
  tctx.moveTo(0, size);
  tctx.lineTo(size * 2, size);
  tctx.stroke();

  return { colorCanvas, heightCanvas, tiledCanvas, size };
}

export function downloadCanvas(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}
