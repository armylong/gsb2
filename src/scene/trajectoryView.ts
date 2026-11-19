import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Contact, ShotResult, TrajectorySegment } from '../sim/types';

const SEGMENT_COLORS = {
  flight: 0x66e08a,
  inside: 0xff7b54,
  reflection: 0xffd23f,
};

const CONTACT_COLORS: Record<Contact['kind'], number> = {
  entry: 0x4ea1ff,
  exit: 0x9d7bff,
  'stop-inside': 0xff3b3b,
  reflect: 0xffd23f,
  'reflect-rejected': 0xff3b3b,
  blocked: 0xe63946,
  'target-hit': 0x00ff9d,
};

const CONTACT_LABELS: Record<Contact['kind'], string> = {
  entry: '入口',
  exit: '出口',
  'stop-inside': '内部停点',
  reflect: '反弹',
  'reflect-rejected': '反弹被拒',
  blocked: '阻挡',
  'target-hit': '命中靶面',
};

/**
 * 弹道可视化: 逐段折线 + 接触点小球 + 法线箭头 + 序号标签。
 * 每段单独建 mesh, 用户可点击选中查看详情。
 */
export class TrajectoryView {
  readonly group = new THREE.Group();
  private segmentMeshes = new Map<number, THREE.Line>();
  private result: ShotResult | null = null;
  private readonly picker: THREE.Raycaster;

  constructor() {
    this.picker = new THREE.Raycaster();
  }

  clear(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      if (child instanceof THREE.Line || child instanceof THREE.Mesh) {
        child.geometry.dispose();
        if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
        else child.material.dispose();
      } else if (child instanceof THREE.ArrowHelper) {
        child.dispose();
      } else if (child instanceof CSS2DObject) {
        child.element.remove();
      }
    }
    this.segmentMeshes.clear();
    this.result = null;
  }

  build(result: ShotResult): void {
    this.clear();
    this.result = result;

    result.segments.forEach((seg) => {
      const points = [seg.start.clone(), seg.end.clone()];
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({
        color: SEGMENT_COLORS[seg.type],
        linewidth: 2,
      });
      const line = new THREE.Line(geo, mat);
      line.userData.segmentIndex = seg.index;
      line.userData.segmentType = seg.type;
      line.renderOrder = 10;
      this.segmentMeshes.set(seg.index, line);
      this.group.add(line);

      if (seg.type === 'reflection') {
        // 零长度反射节点画一个小十字代替不可见的线段
        this.addReflectionMarker(seg);
      }
    });

    result.contacts.forEach((contact, i) => {
      this.addContactMarker(contact, i + 1);
    });

    // 终点标记
    const endBall = new THREE.Mesh(
      new THREE.SphereGeometry(0.11, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    endBall.position.copy(result.endPoint);
    this.group.add(endBall);
  }

  private addReflectionMarker(seg: TrajectorySegment): void {
    const s = 0.14;
    const pts = [
      new THREE.Vector3(-s, 0, 0),
      new THREE.Vector3(s, 0, 0),
      new THREE.Vector3(0, -s, 0),
      new THREE.Vector3(0, s, 0),
      new THREE.Vector3(0, 0, -s),
      new THREE.Vector3(0, 0, s),
    ].map((p) => p.add(seg.end));
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const line = new THREE.LineSegments(
      geo,
      new THREE.LineBasicMaterial({ color: SEGMENT_COLORS.reflection }),
    );
    this.group.add(line);
  }

  private addContactMarker(contact: Contact, seqNo: number): void {
    const color = CONTACT_COLORS[contact.kind];
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.09, 16, 16),
      new THREE.MeshBasicMaterial({ color }),
    );
    ball.position.copy(contact.point);
    this.group.add(ball);

    if (contact.normal && contact.normal.lengthSq() > 0) {
      const arrow = new THREE.ArrowHelper(
        contact.normal.clone().normalize(),
        contact.point.clone(),
        0.85,
        color,
        0.22,
        0.12,
      );
      this.group.add(arrow);
    }

    const div = document.createElement('div');
    div.textContent = `${seqNo}.${CONTACT_LABELS[contact.kind]}·${contact.objectName}`;
    div.style.cssText =
      'color:#fff;background:rgba(13,17,23,0.82);padding:1px 6px;border-radius:5px;' +
      'font-size:11px;white-space:nowrap;pointer-events:none;border:1px solid #2a3140;';
    const label = new CSS2DObject(div);
    label.position.copy(contact.point).add(new THREE.Vector3(0, 0.28, 0));
    this.group.add(label);
  }

  /** 屏幕点击拾取: 返回命中的弹道段序号。 */
  pickSegment(ndc: THREE.Vector2, camera: THREE.Camera): number | null {
    this.picker.setFromCamera(ndc, camera);
    const lines = [...this.segmentMeshes.values()];
    const hits = this.picker.intersectObjects(lines, false);
    if (hits.length === 0) return null;
    const idx = hits[0].object.userData.segmentIndex;
    return typeof idx === 'number' ? idx : null;
  }

  setSelected(index: number | null): void {
    for (const [i, line] of this.segmentMeshes) {
      const mat = line.material as THREE.LineBasicMaterial;
      if (i === index) {
        mat.color.setHex(0x00ff9d);
        continue;
      }
      const type = this.result?.segments.find((s) => s.index === i)?.type;
      mat.color.setHex(SEGMENT_COLORS[type ?? 'flight']);
    }
  }
}

/** 瞄准线: 从发射点沿当前方向画到最大射程的虚线, 发射前后均可见。 */
export class AimLine {
  readonly group = new THREE.Group();
  private readonly line: THREE.Line;
  private readonly originMarker: THREE.Mesh;

  constructor() {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ]);
    this.line = new THREE.Line(
      geo,
      new THREE.LineDashedMaterial({
        color: 0x8b95a7,
        dashSize: 0.35,
        gapSize: 0.22,
        transparent: true,
        opacity: 0.9,
      }),
    );
    this.originMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
    );
    this.group.add(this.line, this.originMarker);
  }

  update(origin: THREE.Vector3, direction: THREE.Vector3, maxRange: number): void {
    const end = origin.clone().addScaledVector(direction.clone().normalize(), maxRange);
    const pos = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    pos.setXYZ(0, origin.x, origin.y, origin.z);
    pos.setXYZ(1, end.x, end.y, end.z);
    pos.needsUpdate = true;
    this.line.computeLineDistances();
    this.originMarker.position.copy(origin);
  }

  setVisible(v: boolean): void {
    this.group.visible = v;
  }
}
