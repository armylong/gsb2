/** 浏览器端：把 RGBA 字节编码为 PNG（走 OffscreenCanvas / canvas，零额外依赖） */
export async function encodePngBrowser(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<Blob> {
  const imageData = new ImageData(rgba, width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 2D canvas 上下文');
  ctx.putImageData(imageData, 0, 0);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败'));
    }, 'image/png');
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(new Blob([text], { type: 'application/json' }), filename);
}
