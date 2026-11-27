// 导出：1) 带场景坐标的路径 JSON；2) 当前画布 PNG（检查场叠加解析参考曲线）
import { TraceResult, Seed, Vec2, REASON_TEXT } from '../core/types.js';
import { VelocityField } from '../core/types.js';
import { Camera } from './camera.js';
import { runChecks } from '../core/check.js';

export interface ExportBundle {
  format: 'streamline-export/v1';
  generatedAt: string;
  field: {
    id: string;
    label: string;
    domain: VelocityField['domain'];
    speedFloor: number;
    zones: VelocityField['zones'];
  };
  camera: { scale: number; center: Vec2 };
  coordinateSystem: {
    origin: '场景中心为 (0,0)，y 轴向下，单位与场景坐标一致';
    domain: VelocityField['domain'];
  };
  seeds: Array<{ id: number; x: number; y: number; manual: boolean; locked: boolean; blocked: boolean }>;
  streamlines: Array<{
    seedId: number;
    seed: Vec2;
    closed: boolean;
    length: number;
    pointCount: number;
    points: Vec2[];
    forwardEnd: { point: Vec2; reason: string; reasonText: string };
    backwardEnd: { point: Vec2; reason: string; reasonText: string };
  }>;
  validation: ReturnType<typeof runChecks> | null;
}

export function buildExportBundle(
  field: VelocityField,
  camera: Camera,
  seeds: Seed[],
  traces: TraceResult[]
): ExportBundle {
  const blockedSet = new Set(traces.filter((t) => t.blocked).map((t) => seedKey(t.seed)));
  const isValidation = field.id === 'uniform' || field.id === 'rigid';

  return {
    format: 'streamline-export/v1',
    generatedAt: new Date().toISOString(),
    field: {
      id: field.id,
      label: field.label,
      domain: field.domain,
      speedFloor: field.speedFloor,
      zones: field.zones
    },
    camera: camera.toJSON(),
    coordinateSystem: {
      origin: '场景中心为 (0,0)，y 轴向下，单位与场景坐标一致',
      domain: field.domain
    },
    seeds: seeds.map((s) => ({
      id: s.id,
      x: s.p.x,
      y: s.p.y,
      manual: s.manual,
      locked: s.locked,
      blocked: blockedSet.has(seedKey(s.p))
    })),
    streamlines: seeds.map((s, i) => {
      const t = traces[i];
      return {
        seedId: s.id,
        seed: s.p,
        closed: t.closed,
        length: t.length,
        pointCount: t.points.length,
        points: t.points.map((p) => ({ x: p.x, y: p.y })),
        forwardEnd: {
          point: t.forward.point,
          reason: t.forward.reason,
          reasonText: REASON_TEXT[t.forward.reason]
        },
        backwardEnd: {
          point: t.backward.point,
          reason: t.backward.reason,
          reasonText: REASON_TEXT[t.backward.reason]
        }
      };
    }),
    validation: isValidation ? runChecks() : null
  };
}

function seedKey(p: Vec2): string {
  return `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
}

export function downloadJSON(bundle: ExportBundle, filename: string): void {
  const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
  triggerDownload(URL.createObjectURL(blob), filename);
}

export function downloadPNG(canvas: HTMLCanvasElement, filename: string): void {
  canvas.toBlob((blob) => {
    if (blob) triggerDownload(URL.createObjectURL(blob), filename);
  }, 'image/png');
}

function triggerDownload(url: string, filename: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
