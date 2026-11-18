import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { POLYHEDRONS } from '../src/presets';
import {
  buildModel,
  evaluateFold,
  newellNormal,
  rootAlignmentTransform,
  worldPoints,
} from '../src/geometry';
import { TOLERANCE, validateModel } from '../src/validate';

describe('预设纸模几何', () => {
  for (const def of POLYHEDRONS) {
    describe(def.name, () => {
      const model = buildModel(def);

      it('展开树覆盖所有面且根面唯一', () => {
        expect(model.hingeEdges.length).toBe(def.faces.length - 1);
        const roots = def.faces.filter((f) => f.id === def.rootFaceId);
        expect(roots).toHaveLength(1);
      });

      it('所有展开面共面于 z=0 且外法线为 +Z', () => {
        for (const face of model.faces) {
          const netWorld = face.flatLocalPoints.map((p) => p.clone().add(face.pivotFlat));
          for (const p of netWorld) expect(Math.abs(p.z)).toBeLessThan(TOLERANCE.position);
          const n = newellNormal(netWorld);
          expect(n.z).toBeGreaterThan(0.999999);
        }
      });

      it('目标实体面法线全部朝外', () => {
        const c = new THREE.Vector3();
        model.faces.forEach((f) => f.targetPoints.forEach((p) => c.add(p)));
        c.multiplyScalar(1 / model.faces.reduce((n, f) => n + f.targetPoints.length, 0));
        for (const face of model.faces) {
          const n = newellNormal(face.targetPoints);
          const fc = face.targetPoints
            .reduce((a, b) => a.clone().add(b), new THREE.Vector3())
            .multiplyScalar(1 / face.targetPoints.length);
          expect(n.dot(c.clone().sub(fc))).toBeLessThan(-1e-6);
        }
      });

      it('全部验证项通过', () => {
        const report = validateModel(model);
        for (const e of report.entries) {
          expect(e.pass, `${e.name}: ${e.detail}, actual=${e.actual}`).toBe(true);
        }
        expect(report.pass).toBe(true);
      });

      it('完全折叠顶点恰好收敛到目标实体顶点', () => {
        const poses = evaluateFold(model, 1);
        const align = rootAlignmentTransform(model);
        for (const face of model.faces) {
          const wp = worldPoints(face, poses.get(face.id)!).map((p) => p.clone().applyMatrix4(align));
          face.targetPoints.forEach((tp, i) => {
            expect(wp[i].distanceTo(tp)).toBeLessThan(TOLERANCE.position);
          });
        }
      });

      it('完全折叠所有共享边（含裁切边）端点重合', () => {
        const poses = evaluateFold(model, 1);
        const align = rootAlignmentTransform(model);
        const byVid = new Map<number, THREE.Vector3>();
        for (const face of model.faces) {
          const wp = worldPoints(face, poses.get(face.id)!).map((p) => p.clone().applyMatrix4(align));
          const fdef = def.faces.find((f) => f.id === face.id)!;
          fdef.targetVertexIds.forEach((vid, i) => {
            const existing = byVid.get(vid);
            if (existing) expect(existing.distanceTo(wp[i])).toBeLessThan(TOLERANCE.position);
            else byVid.set(vid, wp[i]);
          });
        }
      });

      it('手动角度不被重复累加', () => {
        const child = model.faces.find((f) => f.parentId !== null)!;
        const angle = child.targetAngle * 0.4;
        const p1 = evaluateFold(model, 0.5, new Map([[child.id, angle]]));
        const p2 = evaluateFold(model, 0.5, new Map([[child.id, angle]]));
        const a = worldPoints(child, p1.get(child.id)!);
        const b = worldPoints(child, p2.get(child.id)!);
        a.forEach((p, i) => expect(p.distanceTo(b[i])).toBeLessThan(TOLERANCE.position));
      });
    });
  }
});
