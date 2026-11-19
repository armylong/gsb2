/**
 * 极简 OBJ 读写，只处理 v / f（三角形）与可选的 o 名称行。
 * 浏览器导出与 Node 验证脚本共用本模块，保证“导出再读取”的口径一致。
 */
import { MeshData } from './meshTypes';

export function writeOBJ(mesh: MeshData, objectName = 'simplified_mesh'): string {
  const lines: string[] = [`o ${objectName}`];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
  }
  // OBJ 索引从 1 开始
  const idx = mesh.indices;
  for (let i = 0; i < idx.length; i += 3) {
    lines.push(`f ${idx[i] + 1} ${idx[i + 1] + 1} ${idx[i + 2] + 1}`);
  }
  lines.push('');
  return lines.join('\n');
}

function fmt(x: number): string {
  // 10 位小数：保证归一化坐标（最长边约 4）往返后误差在 1e-10 量级，
  // 距离读数与边界判定保持稳定
  return Number.isFinite(x) ? x.toFixed(10) : '0';
}

export function parseOBJ(text: string): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];
  const polygon: number[] = [];

  const flushPolygon = () => {
    if (polygon.length < 3) {
      polygon.length = 0;
      return;
    }
    // 扇形三角化（本工具导出的都是三角形，这里只做防御性兼容）
    for (let i = 1; i < polygon.length - 1; i++) {
      indices.push(polygon[0], polygon[i], polygon[i + 1]);
    }
    polygon.length = 0;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'v': {
        positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
        break;
      }
      case 'f': {
        for (let i = 1; i < parts.length; i++) {
          // 支持 "1", "1/2", "1/2/3", "1//3" 等写法；负索引按 OBJ 规范回绕
          let token = parts[i];
          if (token.startsWith('-')) {
            const rel = Number(token.split('/')[0]);
            polygon.push(positions.length / 3 + rel);
          } else {
            polygon.push(Number(token.split('/')[0]) - 1);
          }
        }
        flushPolygon();
        break;
      }
      default:
        // vn / vt / o / g / s 等行忽略
        break;
    }
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
  };
}

export function downloadOBJ(mesh: MeshData, filename: string, objectName?: string): void {
  const text = writeOBJ(mesh, objectName);
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 释放放到下一帧，避免某些浏览器下载尚未开始
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
