/**
 * 用简单几何体拼出的示意机构：底座 + 泵体 + 检查盖 + 轴系 + 可摆动的摆臂，
 * 以及一个刻意堆满零件的「角落工位」用于验收拥挤排布。
 *
 * 层次结构（摆臂组内的零件会随摆臂一起转动，锚点用局部坐标定义）：
 *
 *   root
 *   ├─ base_plate
 *   ├─ housing
 *   ├─ cover
 *   ├─ cover_bolts (4 颗)
 *   ├─ shaft
 *   ├─ bearing
 *   ├─ pivot_group (Y 轴摆动)
 *   │   ├─ pivot_arm
 *   │   ├─ clamp
 *   │   ├─ clamp_bolt
 *   │   └─ link_rod
 *   └─ corner_* (故意挤在右前角的一组小零件)
 */

import * as THREE from 'three';

export interface AnchorDefinition {
  id: string;
  /** 标注角标，例如 ①。 */
  code: string;
  partId: string;
  /** 相对零件 group 的局部坐标；必须落在该零件表面上。 */
  local: [number, number, number];
  title: string;
  detail: string;
  priority: number;
  locked: boolean;
}

export interface PartHandle {
  id: string;
  name: string;
  group: THREE.Group;
  meshes: THREE.Mesh[];
  /** 用于选中高亮。 */
  materials: THREE.MeshStandardMaterial[];
  baseEmissive: THREE.Color[];
  visible: boolean;
}

export interface Assembly {
  root: THREE.Group;
  parts: Map<string, PartHandle>;
  anchors: AnchorDefinition[];
  pivotGroup: THREE.Group;
  /** 摆臂绕 Y 轴的角度（弧度）。 */
  setArmAngle(radians: number): void;
  setPartVisible(id: string, visible: boolean): void;
  setSelectedPart(id: string | null): void;
  /** 供选择框使用。 */
  selectionHelper: THREE.BoxHelper;
}

interface PartOptions {
  id: string;
  name: string;
  color: number;
  metalness?: number;
  roughness?: number;
}

const PART_PALETTE: Record<string, { color: number; metalness: number; roughness: number }> = {};

export function createAssembly(): Assembly {
  const root = new THREE.Group();
  root.name = 'assembly';
  const parts = new Map<string, PartHandle>();
  const pivotGroup = new THREE.Group();
  pivotGroup.name = 'pivot_group';
  pivotGroup.position.set(2.2, 2.4, -0.4);
  root.add(pivotGroup);

  function makePart(
    options: PartOptions,
    parent: THREE.Object3D = root,
    position = new THREE.Vector3(),
  ): PartHandle {
    const group = new THREE.Group();
    group.name = options.id;
    group.userData.partId = options.id;
    group.userData.partName = options.name;
    group.position.copy(position);
    parent.add(group);

    const handle: PartHandle = {
      id: options.id,
      name: options.name,
      group,
      meshes: [],
      materials: [],
      baseEmissive: [],
      visible: true,
    };
    parts.set(options.id, handle);
    PART_PALETTE[options.id] = {
      color: options.color,
      metalness: options.metalness ?? 0.55,
      roughness: options.roughness ?? 0.42,
    };
    return handle;
  }

  function materialFor(part: PartHandle, color?: number): THREE.MeshStandardMaterial {
    const preset = PART_PALETTE[part.id] ?? { color: 0x8899aa, metalness: 0.5, roughness: 0.5 };
    const material = new THREE.MeshStandardMaterial({
      color: color ?? preset.color,
      metalness: preset.metalness,
      roughness: preset.roughness,
    });
    part.materials.push(material);
    part.baseEmissive.push(material.emissive.clone());
    return material;
  }

  function addMesh(
    part: PartHandle,
    geometry: THREE.BufferGeometry,
    position: THREE.Vector3Like,
    rotation?: { x: number; y: number; z: number },
    material?: THREE.MeshStandardMaterial,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geometry, material ?? materialFor(part));
    mesh.position.set(position.x, position.y, position.z);
    if (rotation) mesh.rotation.set(rotation.x, rotation.y, rotation.z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.partId = part.id;
    part.group.add(mesh);
    part.meshes.push(mesh);
    return mesh;
  }

  function addEdges(mesh: THREE.Mesh, color = 0x0b1220, opacity = 0.35) {
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 28),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity }),
    );
    edges.position.copy(mesh.position);
    edges.rotation.copy(mesh.rotation);
    mesh.parent?.add(edges);
  }

  // ---------------------------------------------------------------- 底座
  const base = makePart({ id: 'base_plate', name: '底座 / 安装板', color: 0x54657b });
  const baseMesh = addMesh(
    base,
    new THREE.BoxGeometry(14, 0.7, 9),
    new THREE.Vector3(0, 0.35, 0),
  );
  addEdges(baseMesh);
  // 底座倒角装饰
  const plinth = makePart({ id: 'base_plinth', name: '底座支脚', color: 0x3f4b5c });
  for (const [x, z] of [
    [-6.2, -3.7],
    [6.2, -3.7],
    [-6.2, 3.7],
    [6.2, 3.7],
  ]) {
    addMesh(plinth, new THREE.BoxGeometry(1.2, 0.35, 1.2), new THREE.Vector3(x, 0.175, z));
  }

  // ---------------------------------------------------------------- 泵体
  const housing = makePart({ id: 'housing', name: '泵体 / 机座', color: 0x7c8ea5 });
  const housingMesh = addMesh(
    housing,
    new THREE.BoxGeometry(4.2, 3.4, 4.2),
    new THREE.Vector3(-3.6, 2.4, -1.2),
  );
  addEdges(housingMesh);
  // 散热筋
  for (let i = 0; i < 3; i += 1) {
    addMesh(
      housing,
      new THREE.BoxGeometry(4.0, 0.16, 0.22),
      new THREE.Vector3(-3.6, 1.35 + i * 0.42, 0.95),
    );
  }

  // 检查盖
  const cover = makePart({ id: 'cover', name: '检查盖', color: 0xd08b4f });
  const coverMesh = addMesh(
    cover,
    new THREE.BoxGeometry(3.4, 0.3, 3.4),
    new THREE.Vector3(-3.6, 4.25, -1.2),
  );
  addEdges(coverMesh, 0x2b1608, 0.45);

  // 检查盖四角螺钉
  const coverBolts = makePart({ id: 'cover_bolts', name: '检查盖螺钉 ×4', color: 0xc8ad72 });
  for (const [x, z] of [
    [-1.2, -1.2],
    [1.2, -1.2],
    [-1.2, 1.2],
    [1.2, 1.2],
  ]) {
    addMesh(
      coverBolts,
      new THREE.CylinderGeometry(0.16, 0.16, 0.28, 6),
      new THREE.Vector3(-3.6 + x, 4.54, -1.2 + z),
    );
  }

  // ---------------------------------------------------------------- 轴系
  const shaft = makePart({ id: 'shaft', name: '主轴', color: 0xb9c4d0, metalness: 0.85, roughness: 0.22 });
  addMesh(
    shaft,
    new THREE.CylinderGeometry(0.3, 0.3, 3.6, 24),
    new THREE.Vector3(0, 2.4, -1.2),
    new THREE.Euler(0, 0, Math.PI / 2),
  );
  addMesh(
    shaft,
    new THREE.CylinderGeometry(0.38, 0.38, 0.18, 18),
    new THREE.Vector3(1.4, 2.4, -1.2),
    new THREE.Euler(0, 0, Math.PI / 2),
  );

  const bearing = makePart({ id: 'bearing', name: '轴承座', color: 0x6d7f95 });
  const bearingMesh = addMesh(
    bearing,
    new THREE.BoxGeometry(1.0, 1.0, 1.0),
    new THREE.Vector3(1.8, 2.4, -1.2),
  );
  addEdges(bearingMesh);

  // ---------------------------------------------------------------- 摆臂（可动）
  const arm = makePart({ id: 'pivot_arm', name: '摆臂', color: 0x4f7fa6 }, pivotGroup);
  // 摆臂分两段，避免端部穿过夹头，同时保证加强筋表面可作标注基准。
  const armMesh = addMesh(
    arm,
    new THREE.BoxGeometry(3.4, 0.5, 0.8),
    new THREE.Vector3(1.7, 0, 0),
  );
  addEdges(armMesh);
  // 加强筋
  addMesh(arm, new THREE.BoxGeometry(2.0, 0.18, 0.5), new THREE.Vector3(1.4, 0.34, 0));

  const clamp = makePart({ id: 'clamp', name: '端部夹头', color: 0xcf6a4c }, pivotGroup);
  addMesh(
    clamp,
    new THREE.CylinderGeometry(0.72, 0.72, 0.9, 28),
    new THREE.Vector3(4.4, 0, 0),
  );
  addMesh(
    clamp,
    new THREE.CylinderGeometry(0.5, 0.5, 0.94, 24, 1, true),
    new THREE.Vector3(4.4, 0, 0),
    undefined,
    materialFor(clamp, 0x3b2a24),
  );

  const clampBolt = makePart({ id: 'clamp_bolt', name: '夹紧螺栓', color: 0xc8ad72 }, pivotGroup);
  addMesh(
    clampBolt,
    new THREE.CylinderGeometry(0.16, 0.16, 0.3, 6),
    new THREE.Vector3(4.4, 0.6, 0),
  );

  const linkRod = makePart({ id: 'link_rod', name: '连杆', color: 0x9aa9b8, metalness: 0.8, roughness: 0.3 }, pivotGroup);
  addMesh(
    linkRod,
    new THREE.CylinderGeometry(0.16, 0.16, 1.6, 18),
    new THREE.Vector3(4.4, 0, 0.8),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );
  addMesh(
    linkRod,
    new THREE.SphereGeometry(0.24, 18, 14),
    new THREE.Vector3(4.4, 0, 1.6),
  );

  // ---------------------------------------------------------------- 拥挤角落
  const cornerBlock = makePart({ id: 'corner_block', name: '角座', color: 0x8c9aa8 });
  const cornerBlockMesh = addMesh(
    cornerBlock,
    new THREE.BoxGeometry(1.8, 0.5, 1.6),
    new THREE.Vector3(5.4, 0.95, 3.0),
  );
  addEdges(cornerBlockMesh);

  const cornerBolts: PartHandle[] = [];
  const boltPositions: Array<[number, number, number, string]> = [
    [4.85, 1.35, 2.55, 'A'],
    [5.95, 1.35, 2.55, 'B'],
    [4.85, 1.35, 3.45, 'C'],
    [5.35, 1.35, 2.95, 'D'],
    [5.95, 1.35, 3.45, 'E'],
  ];
  for (const [x, y, z, letter] of boltPositions) {
    const bolt = makePart(
      { id: `corner_bolt_${letter.toLowerCase()}`, name: `角座螺栓 ${letter}`, color: 0xc8ad72 },
      root,
      new THREE.Vector3(x, y, z),
    );
    addMesh(bolt, new THREE.CylinderGeometry(0.19, 0.19, 0.3, 6), new THREE.Vector3(0, 0, 0));
    addMesh(
      bolt,
      new THREE.CylinderGeometry(0.27, 0.27, 0.06, 18),
      new THREE.Vector3(0, -0.17, 0),
    );
    cornerBolts.push(bolt);
  }

  const cornerNut = makePart({ id: 'corner_nut', name: '锁紧螺母', color: 0xb9a06a });
  addMesh(
    cornerNut,
    new THREE.CylinderGeometry(0.24, 0.24, 0.2, 6),
    new THREE.Vector3(5.35, 1.55, 3.45),
  );

  const cornerPinB = makePart({ id: 'corner_pin_b', name: '圆柱销 φ4', color: 0xa6b2c0, metalness: 0.8, roughness: 0.25 });
  addMesh(
    cornerPinB,
    new THREE.CylinderGeometry(0.09, 0.09, 0.5, 14),
    new THREE.Vector3(4.85, 1.45, 2.15),
  );

  const cornerPin = makePart({ id: 'corner_pin', name: '定位销', color: 0xa6b2c0, metalness: 0.8, roughness: 0.25 });
  addMesh(
    cornerPin,
    new THREE.CylinderGeometry(0.11, 0.11, 0.6, 16),
    new THREE.Vector3(5.95, 1.5, 3.45),
  );

  const cornerShim = makePart({ id: 'corner_shim', name: '调整垫片', color: 0xb7a06a, metalness: 0.65, roughness: 0.35 });
  addMesh(
    cornerShim,
    new THREE.BoxGeometry(1.1, 0.08, 0.8),
    new THREE.Vector3(4.4, 0.74, 4.05),
  );

  const cornerWasher = makePart({ id: 'corner_washer', name: '弹簧垫圈组', color: 0xcbb37b });
  addMesh(
    cornerWasher,
    new THREE.TorusGeometry(0.22, 0.05, 10, 20),
    new THREE.Vector3(5.35, 1.47, 2.95),
    new THREE.Euler(Math.PI / 2, 0, 0),
  );

  // 检查窗（背面视角的遮挡体）
  const inspectionWindow = makePart({ id: 'inspection_window', name: '观察窗盖板', color: 0x46607a, metalness: 0.35, roughness: 0.25 });
  addMesh(
    inspectionWindow,
    new THREE.BoxGeometry(2.8, 2.2, 0.18),
    new THREE.Vector3(-3.6, 2.5, -3.39),
  );

  // ---------------------------------------------------------------- 标注点
  const anchors: AnchorDefinition[] = [
    {
      id: 'base_mount',
      code: '①',
      partId: 'base_plate',
      local: [3.8, 0.7, -3.3],
      title: '底座安装面',
      detail: '水平度 0.05 mm',
      priority: 1,
      locked: false,
    },
    {
      id: 'base_corner',
      code: '②',
      partId: 'base_plate',
      local: [5.9, 0.7, 0.9],
      title: '底座定位边',
      detail: '与角座基准面贴合',
      priority: 2,
      locked: false,
    },
    {
      id: 'housing_oil',
      code: '③',
      partId: 'housing',
      local: [-1.8, 2.6, 0.9],
      title: '油位观察窗',
      detail: '油面不低于上限刻线',
      priority: 2,
      locked: false,
    },
    {
      id: 'cover_seal',
      code: '④',
      partId: 'cover',
      local: [-2.4, 4.4, -1.2],
      title: '检查盖密封圈',
      detail: '装配前涂润滑脂',
      priority: 3,
      locked: false,
    },
    {
      id: 'cover_bolts_fix',
      code: '⑤',
      partId: 'cover_bolts',
      local: [-2.4, 4.68, 0.0],
      title: '检查盖螺钉 ×4',
      detail: '对角拧紧 · 8 N·m',
      priority: 4,
      locked: true,
    },
    {
      id: 'shaft_clip',
      code: '⑥',
      partId: 'shaft',
      local: [0.2, 2.7, -1.2],
      title: '轴端挡圈',
      detail: 'φ22 · 装后转动自如',
      priority: 3,
      locked: false,
    },
    {
      id: 'bearing_grease',
      code: '⑦',
      partId: 'bearing',
      local: [2.0, 2.9, -1.2],
      title: '轴承座润滑',
      detail: '锂基脂 2 号 · 加至 2/3',
      priority: 2,
      locked: false,
    },
    {
      id: 'arm_material',
      code: '⑧',
      partId: 'pivot_arm',
      local: [1.4, 0.43, 0],
      title: '摆臂材质',
      detail: '45# 钢 · 磁粉探伤',
      priority: 3,
      locked: false,
    },
    {
      id: 'clamp_torque',
      code: '⑨',
      partId: 'clamp_bolt',
      local: [4.4, 0.75, 0],
      title: '夹紧螺栓',
      detail: '25 N·m · 涂防松胶',
      priority: 5,
      locked: true,
    },
    {
      id: 'link_clearance',
      code: '⑩',
      partId: 'link_rod',
      local: [4.4, 0.24, 1.6],
      title: '连杆销旷量',
      detail: '径向 ≤ 0.15 mm',
      priority: 3,
      locked: false,
    },
    {
      id: 'corner_face',
      code: '⑪',
      partId: 'corner_block',
      local: [5.4, 0.95, 3.8],
      title: '角座基准面',
      detail: '与底座定位边贴合',
      priority: 4,
      locked: false,
    },
    {
      id: 'corner_torque',
      code: '⑫',
      partId: 'corner_block',
      local: [5.05, 1.2, 2.7],
      title: '角座紧固',
      detail: '12 N·m · 螺纹涂胶',
      priority: 3,
      locked: false,
    },
    {
      id: 'corner_bolt_a',
      code: '⑬',
      partId: 'corner_bolt_a',
      local: [0, 0.15, 0],
      title: 'M8×25 螺栓 A',
      detail: '先预紧至 6 N·m',
      priority: 4,
      locked: false,
    },
    {
      id: 'corner_bolt_b',
      code: '⑭',
      partId: 'corner_bolt_b',
      local: [0, 0.15, 0],
      title: '弹簧垫圈 B',
      detail: '缺口朝下',
      priority: 2,
      locked: false,
    },
    {
      id: 'corner_bolt_c',
      code: '⑮',
      partId: 'corner_bolt_c',
      local: [0, 0.15, 0],
      title: '平垫圈 C',
      detail: '不得漏装',
      priority: 1,
      locked: false,
    },
    {
      id: 'corner_pin_fit',
      code: '⑯',
      partId: 'corner_pin',
      local: [5.95, 1.8, 3.45],
      title: '定位销 φ6',
      detail: '过盈 0.01–0.02 mm',
      priority: 5,
      locked: true,
    },
    {
      id: 'corner_shim_gap',
      code: '⑰',
      partId: 'corner_shim',
      local: [4.4, 0.78, 4.05],
      title: '调整垫片',
      detail: '间隙 0.20 mm',
      priority: 2,
      locked: false,
    },
    {
      id: 'corner_bolt_d',
      code: '⑲',
      partId: 'corner_bolt_d',
      local: [0, 0.15, 0],
      title: 'M8×30 螺栓 D',
      detail: '先手拧到位再加扭',
      priority: 2,
      locked: false,
    },
    {
      id: 'corner_bolt_e',
      code: '⑳',
      partId: 'corner_bolt_e',
      local: [0, 0.15, 0],
      title: 'M8×30 螺栓 E',
      detail: '与 C 交替拧紧',
      priority: 2,
      locked: false,
    },
    {
      id: 'corner_nut_fix',
      code: '㉑',
      partId: 'corner_nut',
      local: [5.35, 1.65, 3.45],
      title: '锁紧螺母',
      detail: '薄型 · 8 N·m',
      priority: 3,
      locked: false,
    },
    {
      id: 'corner_pin_b_fit',
      code: '㉒',
      partId: 'corner_pin_b',
      local: [4.85, 1.7, 2.15],
      title: '圆柱销 φ4',
      detail: '与销孔 H7 配合',
      priority: 1,
      locked: false,
    },
    {
      id: 'window_check',
      code: '⑱',
      partId: 'inspection_window',
      local: [-3.6, 2.5, -3.48],
      title: '观察窗盖板',
      detail: '背面 · 密封胶均匀',
      priority: 2,
      locked: false,
    },
  ];

  const selectionHelper = new THREE.BoxHelper(new THREE.Object3D(), 0xffc36b);
  selectionHelper.visible = false;
  root.add(selectionHelper);

  function setArmAngle(radians: number): void {
    pivotGroup.rotation.y = radians;
  }

  function setPartVisible(id: string, visible: boolean): void {
    const part = parts.get(id);
    if (!part) return;
    part.visible = visible;
    part.group.visible = visible;
  }

  function setSelectedPart(id: string | null): void {
    for (const part of parts.values()) {
      const selected = part.id === id;
      part.materials.forEach((material, index) => {
        const base = part.baseEmissive[index] ?? new THREE.Color(0x000000);
        material.emissive.copy(base);
        if (selected) {
          material.emissive.lerp(new THREE.Color(0xffb057), 0.65);
          material.emissiveIntensity = 1.4;
        } else {
          material.emissiveIntensity = 1;
        }
      });
    }
    if (id) {
      const part = parts.get(id);
      if (part) {
        selectionHelper.setFromObject(part.group);
        selectionHelper.visible = true;
        return;
      }
    }
    selectionHelper.visible = false;
  }

  return {
    root,
    parts,
    anchors,
    pivotGroup,
    setArmAngle,
    setPartVisible,
    setSelectedPart,
    selectionHelper,
  };
}
