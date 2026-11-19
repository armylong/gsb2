import type {
  AnimationSpec,
  BuildResult,
  ImportResult,
  PackSettings,
  SourceFrameInfo,
  VerificationReport,
} from '../../shared/types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return body as T;
}

export function getFrames(): Promise<{ frames: SourceFrameInfo[] }> {
  return request('/api/frames');
}

export function importFiles(files: { name: string; sourceKey: string; dataBase64: string }[]): Promise<ImportResult> {
  return request('/api/import', { method: 'POST', body: JSON.stringify({ files }) });
}

export function loadSamples(): Promise<ImportResult> {
  return request('/api/frames/samples', { method: 'POST', body: '{}' });
}

export function removeFrames(ids: string[]): Promise<{ frames: SourceFrameInfo[] }> {
  return request('/api/frames/remove', { method: 'POST', body: JSON.stringify({ ids }) });
}

export function pack(settings: PackSettings, frameIds?: string[]): Promise<BuildResult> {
  return request('/api/pack', { method: 'POST', body: JSON.stringify({ settings, frameIds }) });
}

export interface ExportResponse {
  exportId: string;
  verification: VerificationReport;
  warnings: string[];
  files: string[];
}

export function exportBuild(buildId: string, animation: AnimationSpec): Promise<ExportResponse> {
  return request('/api/export', { method: 'POST', body: JSON.stringify({ buildId, animation }) });
}

export function exportFileUrl(exportId: string, path: string): string {
  return `/api/export/${encodeURIComponent(exportId)}/file/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

export function exportZipUrl(exportId: string): string {
  return `/api/export/${encodeURIComponent(exportId)}/zip`;
}

export function sourceUrl(frame: SourceFrameInfo): string {
  return frame.previewUrl;
}

/** Read files from an <input type="file"> as base64 payloads. */
export async function filesToPayload(
  fileList: FileList | File[],
): Promise<{ name: string; sourceKey: string; dataBase64: string }[]> {
  const files = Array.from(fileList);
  const out: { name: string; sourceKey: string; dataBase64: string }[] = [];
  for (const file of files) {
    const relative = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const buffer = await file.arrayBuffer();
    out.push({ name: file.name, sourceKey: relative, dataBase64: base64FromBuffer(buffer) });
  }
  return out;
}

export function base64FromBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
