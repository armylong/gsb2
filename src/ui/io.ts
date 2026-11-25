/**
 * 导入/导出:
 *  - 导出一个 JSON 定位设置 + 两台输出 PNG(可分别下载)
 *  - 导入时读取 JSON, 若同批选择了 PNG 则解码为位图, 用于"导出图反演核对"
 */
import { bakeOutput, bitmapSampler, computeOverlap, type ProjectorView } from '../core/blend.ts';
import { buildView } from '../core/view.ts';
import { applySettings, toSettingsFile, type AppState } from './state.ts';
import type { SettingsFile } from '../core/types.ts';

export interface ImportResult {
  warnings: string[];
  /** 投影 id -> 位图视图(仅当提供了 PNG 时) */
  bitmapViews: Map<number, ProjectorView>;
  imageNames: Map<number, string>;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 导出设置 JSON 与两台烘焙 PNG, 触发三次下载 */
export async function exportBundle(state: AppState, stamp: string): Promise<void> {
  const imageFiles: Record<number, string> = {};
  const blobs = new Map<number, Blob>();

  for (let i = 0; i < state.projectors.length; i++) {
    const st = state.projectors[i];
    const other = state.projectors[1 - i];
    const view = buildView(st);
    const overlap = computeOverlap(st.quad, other.quad);
    // 导出 PNG 烘焙几何权重但不烘焙亮度(亮度在 JSON 里, 重导入再应用)
    const rgba = bakeOutput(
      { ...view, brightness: 1 },
      view.forwardH,
      other.quad,
      st.outputWidth,
      st.outputHeight,
      state.blendRatio,
      overlap,
    );
    const canvas = document.createElement('canvas');
    canvas.width = st.outputWidth;
    canvas.height = st.outputHeight;
    canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), st.outputWidth, st.outputHeight), 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG 编码失败');
    const name = `${stamp}-projector-${st.id}.png`;
    imageFiles[st.id] = name;
    blobs.set(st.id, blob);
  }

  const settings = toSettingsFile(state, imageFiles);
  const jsonBlob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
  download(jsonBlob, `${stamp}-settings.json`);
  for (const [id, blob] of blobs) download(blob, imageFiles[id]);
}

async function decodeImageBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

/** 读取用户选择的一个 JSON + 可选 PNG 集合 */
export async function importBundle(files: File[], state: AppState): Promise<ImportResult> {
  const result: ImportResult = {
    warnings: [],
    bitmapViews: new Map(),
    imageNames: new Map(),
  };
  const jsonFile = files.find((f) => f.name.endsWith('.json'));
  if (!jsonFile) {
    result.warnings.push('未选择 .json 设置文件, 已忽略');
    return result;
  }
  let settings: SettingsFile;
  try {
    settings = JSON.parse(await jsonFile.text()) as SettingsFile;
  } catch {
    result.warnings.push('JSON 解析失败');
    return result;
  }
  if (settings.version !== 1) {
    result.warnings.push(`不支持的设置版本: ${settings.version}`);
    return result;
  }

  const warnings = applySettings(state, settings);
  result.warnings.push(...warnings);

  // 关联 PNG: 按 imageFile 文件名匹配
  const pngByName = new Map<string, File>();
  for (const f of files) {
    if (f.type === 'image/png' || f.name.endsWith('.png')) pngByName.set(f.name, f);
  }
  for (const sp of settings.projectors) {
    const file = pngByName.get(sp.imageFile);
    if (!file) {
      result.warnings.push(`投影${sp.id} 的位图 ${sp.imageFile} 未提供, 将使用实时图案`);
      continue;
    }
    const bmp = await decodeImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const st = state.projectors.find((p) => p.id === sp.id);
    if (!st) continue;
    const view = buildView(st, bitmapSampler(data, bmp.width, bmp.height));
    view.preBaked = true; // 位图含几何权重; 亮度仍取 st.brightness
    result.bitmapViews.set(sp.id, view);
    result.imageNames.set(sp.id, sp.imageFile);
    bmp.close();
  }
  return result;
}
