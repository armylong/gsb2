import {
  Box3,
  Box3Helper,
  Camera,
  CameraHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Sphere,
  BufferGeometry,
  Float32BufferAttribute,
} from 'three';
import { CullFrame } from '../culling/cullController';
import { CullStatus } from '../culling/frustum';
import { SampleScene } from '../scene/sampleScene';

const COLORS: Record<CullStatus, number> = {
  in: 0x35d07f,
  intersect: 0xf2b134,
  out: 0xe5484d,
};

/** 可调线宽无关的球线框（三个正交平面上的圆环），用 position + scale 更新。 */
class WireSphereHelper extends LineSegments {
  constructor(color: number) {
    const geometry = WireSphereHelper.buildGeometry();
    const material = new LineBasicMaterial({ color, transparent: true, opacity: 0.95 });
    super(geometry, material);
    this.frustumCulled = false;
  }

  private static buildGeometry(): BufferGeometry {
    const segments = 32;
    const positions: number[] = [];
    const ringPlanes: ('xy' | 'xz' | 'yz')[] = ['xy', 'xz', 'yz'];
    for (const plane of ringPlanes) {
      for (let i = 0; i < segments; i++) {
        const a = (i / segments) * Math.PI * 2;
        const b = ((i + 1) / segments) * Math.PI * 2;
        const points: [number, number][] = [
          [Math.cos(a), Math.sin(a)],
          [Math.cos(b), Math.sin(b)],
        ];
        for (const [c, s] of points) {
          if (plane === 'xy') positions.push(c, s, 0);
          else if (plane === 'xz') positions.push(c, 0, s);
          else positions.push(0, c, s);
        }
      }
    }
    return new BufferGeometry().setAttribute('position', new Float32BufferAttribute(positions, 3));
  }

  updateSphere(sphere: Sphere): void {
    this.position.copy(sphere.center);
    this.scale.setScalar(Math.max(sphere.radius, 1e-6));
  }

  setColor(color: number): void {
    (this.material as LineBasicMaterial).color.set(color);
  }
}

export interface DebugHandles {
  group: Group;
  setVisible(visible: boolean): void;
  update(frame: CullFrame, showBoxes: boolean): void;
  dispose(): void;
}

interface MeshDebug {
  sphere: WireSphereHelper;
  box: Box3Helper;
}

interface GroupDebug {
  sphere: WireSphereHelper;
  box: Box3Helper;
}

export function createDebugView(scene: SampleScene, observeCamera: Camera): DebugHandles {
  const root = new Group();
  root.name = 'debug-view';

  const frustumHelper = new CameraHelper(observeCamera);
  frustumHelper.frustumCulled = false;
  root.add(frustumHelper);

  const meshDebug = new Map<string, MeshDebug>();
  const groupDebug = new Map<string, GroupDebug>();

  for (const entity of scene.meshes) {
    const sphere = new WireSphereHelper(COLORS.out);
    const box = new Box3Helper(new Box3(), COLORS.out);
    (box.material as LineBasicMaterial).transparent = true;
    box.frustumCulled = false;
    sphere.layers.set(1);
    box.layers.set(1);
    root.add(sphere);
    root.add(box);
    meshDebug.set(entity.id, { sphere, box });
  }

  for (const groupEntity of scene.groups) {
    const sphere = new WireSphereHelper(0xffffff);
    const box = new Box3Helper(new Box3(), 0xffffff);
    const mat = sphere.material as LineBasicMaterial;
    mat.transparent = true;
    mat.opacity = 0.8;
    (box.material as LineBasicMaterial).transparent = true;
    box.frustumCulled = false;
    sphere.layers.set(1);
    box.layers.set(1);
    root.add(sphere);
    root.add(box);
    groupDebug.set(groupEntity.id, { sphere, box });
  }

  return {
    group: root,
    setVisible(visible: boolean) {
      root.visible = visible;
    },
    update(frame: CullFrame, showBoxes: boolean) {
      frustumHelper.update();
      frustumHelper.layers.set(1);

      for (const groupInfo of frame.groups) {
        const gd = groupDebug.get(groupInfo.groupEntity.id);
        if (!gd) continue;
        gd.sphere.updateSphere(groupInfo.groupEntity.worldSphere);
        gd.sphere.setColor(COLORS[groupInfo.result.status]);
        gd.box.box.copy(groupInfo.groupEntity.worldBox);
        (gd.box.material as LineBasicMaterial).color.set(COLORS[groupInfo.result.status]);
        gd.box.visible = showBoxes;
        gd.sphere.visible = true;

        for (const memberInfo of groupInfo.members) {
          const md = meshDebug.get(memberInfo.entity.id);
          if (!md) continue;
          const status: CullStatus = memberInfo.drawn ? memberInfo.result.status : 'out';
          md.sphere.updateSphere(memberInfo.entity.worldSphere);
          md.sphere.setColor(COLORS[status]);
          md.box.box.copy(memberInfo.entity.worldBox);
          (md.box.material as LineBasicMaterial).color.set(COLORS[status]);
          md.box.visible = showBoxes;
          md.sphere.visible = true;
        }
      }
    },
    dispose() {
      root.traverse((obj) => {
        if (obj instanceof LineSegments) {
          obj.geometry.dispose();
          (obj.material as LineBasicMaterial).dispose();
        }
      });
    },
  };
}

export function meshStatusOf(info: { drawn: boolean; result: { status: CullStatus } }): CullStatus {
  return info.drawn ? info.result.status : 'out';
}
