import * as THREE from 'three';
import { facePoint3, FaceId, SceneSpec } from './geom';
import { ImageSpec } from './project';

export interface VerifyReport {
  face: FaceId;
  vertexCount: number;
  maxErr: number; // 米
  meanErr: number; // 米
}

/**
 * 核对导出的 SVG:只解析 SVG 文本本身,
 * 把每个顶点从面内二维坐标折回三维,再从 eye 投影回目标图平面,
 * 与导出时记录在 data-src 里的来源坐标对比。
 */
export function verifySVG(svgText: string, spec: SceneSpec, eye: THREE.Vector3, img: ImageSpec): VerifyReport {
  const face = /data-face="(\w+)"/.exec(svgText)?.[1] as FaceId | undefined;
  const minX = Number(/data-minx="([\d.-]+)"/.exec(svgText)?.[1]);
  const maxY = Number(/data-maxy="([\d.-]+)"/.exec(svgText)?.[1]);
  const scale = Number(/data-scale="([\d.]+)"/.exec(svgText)?.[1]);
  const pad = Number(/data-pad="([\d.]+)"/.exec(svgText)?.[1]);
  if (!face || ![minX, maxY, scale, pad].every(Number.isFinite)) {
    throw new Error('SVG 缺少必要的 data-* 元信息');
  }

  let count = 0;
  let maxErr = 0;
  let sumErr = 0;

  const pathRe = /<path d="([^"]+)"[^>]*data-src="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = pathRe.exec(svgText)) !== null) {
    const nums = m[1].match(/-?[\d.]+/g)!.map(Number);
    const svgPts: [number, number][] = [];
    for (let k = 0; k + 1 < nums.length; k += 2) svgPts.push([nums[k], nums[k + 1]]);
    const srcPts = m[2].trim().split(/\s+/).map((s) => s.split(',').map(Number) as [number, number]);
    if (svgPts.length !== srcPts.length) throw new Error('顶点数与 data-src 不一致');

    for (let k = 0; k < svgPts.length; k++) {
      // SVG 坐标 → 面内二维(米),注意导出时第二坐标做了翻转
      const x2 = (svgPts[k][0] - pad) / scale + minX;
      const y2 = maxY - (svgPts[k][1] - pad) / scale;
      // 折回三维
      const p3 = facePoint3(face, spec, x2, y2);
      // 从 eye 重新投影到目标图平面 (z = img.cz)
      const t = (img.cz - eye.z) / (p3.z - eye.z);
      const u = eye.x + t * (p3.x - eye.x) - img.cx;
      const v = eye.y + t * (p3.y - eye.y) - img.cy;
      const err = Math.hypot(u - srcPts[k][0], v - srcPts[k][1]);
      count++;
      sumErr += err;
      if (err > maxErr) maxErr = err;
    }
  }
  return { face, vertexCount: count, maxErr, meanErr: count ? sumErr / count : 0 };
}
