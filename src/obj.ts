import { PipeData } from './pipe';

/**
 * 导出 OBJ：仅管道网格的顶点与三角形面（1 基索引），
 * 坐标与页面场景一致，不含中心线、控制点等辅助对象。
 */
export function toOBJ(data: PipeData): string {
  const lines: string[] = ['# pipe-along-curve export', 'o Pipe'];
  const p = data.positions;
  for (let i = 0; i < p.length; i += 3) {
    lines.push(`v ${fmt(p[i])} ${fmt(p[i + 1])} ${fmt(p[i + 2])}`);
  }
  const idx = data.indices;
  for (let i = 0; i < idx.length; i += 3) {
    lines.push(`f ${idx[i] + 1} ${idx[i + 1] + 1} ${idx[i + 2] + 1}`);
  }
  return lines.join('\n') + '\n';
}

function fmt(x: number): string {
  return Math.abs(x) < 1e-12 ? '0' : x.toFixed(6);
}

/** 统计 OBJ 文本中的顶点数与面数（供验证核对） */
export function countOBJ(obj: string): { vertices: number; faces: number } {
  let vertices = 0, faces = 0;
  for (const line of obj.split('\n')) {
    if (line.startsWith('v ')) vertices++;
    else if (line.startsWith('f ')) faces++;
  }
  return { vertices, faces };
}
