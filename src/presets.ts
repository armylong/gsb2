/** 透明面参数(可在面板上修改) */
export interface SurfaceParams {
  id: string;
  name: string;
  /** hex 颜色,如 0xff3344 */
  color: number;
  /** 不透明度 0..1 */
  opacity: number;
  /** 世界坐标位置 */
  position: [number, number, number];
  /** 欧拉角(弧度),顺序 XYZ */
  rotation: [number, number, number];
  /** 平面宽高(世界单位) */
  size: [number, number];
}

export interface OccluderParams {
  id: string;
  name: string;
  color: number;
  position: [number, number, number];
  rotation: [number, number, number];
  size: [number, number];
}

export interface CheckpointDef {
  id: string;
  name: string;
  /** 检查点取在屏幕上的位置,NDC 坐标(-1..1),与相机状态无关地表达"画面位置" */
  ndc: [number, number];
  /** 该点期望命中的表面 id 顺序(从近到远),仅用于说明文档 */
  expectSurfaces: string[];
  /** 该点验证的情形说明 */
  situation: string;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  surfaces: SurfaceParams[];
  occluder: OccluderParams | null;
  checkpoints: CheckpointDef[];
  camera: {
    position: [number, number, number];
    target: [number, number, number];
  };
}

export const BACKGROUND_COLOR = 0x202228;

/**
 * 三个固定预设。颜色、位置全部硬编码,保证演示可复现。
 * 相机统一沿 +Z 看向原点附近。
 */
export const PRESETS: Preset[] = [
  {
    id: 'separated',
    name: '场景 A · 前后分离的彩色透明面',
    description:
      '红色透明面在前(z=+0.6,离相机近)、蓝色透明面在后(z=-0.6),两平面平行、永不相交,蓝面整体向左错开。红面比蓝面大一圈,右侧出现只过红面的区域;任何像素上的前后次序一致,用于核对最基础的叠色与透明度端点。',
    surfaces: [
      {
        id: 'red',
        name: '红色透明面(前)',
        color: 0xff3344,
        opacity: 0.55,
        position: [0, 0, 0.6],
        rotation: [0, 0, 0],
        size: [3.8, 2.4],
      },
      {
        id: 'blue',
        name: '蓝色透明面(后)',
        color: 0x3377ff,
        opacity: 0.55,
        position: [-0.4, 0, -0.6],
        rotation: [0, 0, 0],
        size: [2.4, 2.0],
      },
    ],
    occluder: null,
    checkpoints: [
      {
        id: 'cp-overlap',
        name: 'A-1 两面重叠中心',
        ndc: [0, 0],
        expectSurfaces: ['red', 'blue'],
        situation: '分离:红在前、蓝在后,标准 back-to-front 叠色',
      },
      {
        id: 'cp-red-only',
        name: 'A-2 只过红面(右侧)',
        ndc: [0.55, 0],
        expectSurfaces: ['red'],
        situation: '分离:该视线超出蓝面范围,只有前面单层 alpha 覆盖背景',
      },
      {
        id: 'cp-bg',
        name: 'A-3 两面之外(背景)',
        ndc: [-0.85, 0.85],
        expectSurfaces: [],
        situation: '分离:无任何表面,应等于背景色',
      },
    ],
    camera: {
      position: [0, 0, 4.2],
      target: [0, 0, 0],
    },
  },
  {
    id: 'crossing',
    name: '场景 B · 两张互相穿过的透明面',
    description:
      '橙色面与青色面绕 Y 轴反向旋转并在 x=0 处相交。交线左侧橙在前、右侧青在前——同一时刻画面不同区域深度次序相反,物体级排序必然在一侧出错。',
    surfaces: [
      {
        id: 'orange',
        name: '橙色透明面',
        color: 0xff9922,
        opacity: 0.55,
        position: [0, 0, 0],
        rotation: [0, Math.PI / 4, 0],
        size: [4.2, 3.2],
      },
      {
        id: 'teal',
        name: '青色透明面',
        color: 0x22ccaa,
        opacity: 0.55,
        position: [0, 0, 0],
        rotation: [0, -Math.PI / 4, 0],
        size: [4.2, 3.2],
      },
    ],
    occluder: null,
    checkpoints: [
      {
        id: 'cp-left',
        name: 'B-1 交线左侧(x<0)',
        ndc: [-0.5, 0],
        expectSurfaces: ['orange', 'teal'],
        situation: '相交:该侧橙在前、青在后',
      },
      {
        id: 'cp-right',
        name: 'B-2 交线右侧(x>0)',
        ndc: [0.5, 0],
        expectSurfaces: ['teal', 'orange'],
        situation: '相交:深度次序翻转,青在前、橙在后',
      },
      {
        id: 'cp-line',
        name: 'B-3 交线附近(x≈0)',
        ndc: [0, 0],
        expectSurfaces: ['orange', 'teal'],
        situation: '相交:两面深度精确相等,该像素的平局归属由光栅化决定,叠色与解析口径可能不同(容差已放宽)',
      },
    ],
    camera: {
      position: [0, 0, 4.2],
      target: [0, 0, 0],
    },
  },
  {
    id: 'occluder',
    name: '场景 C · 透明面与不透明挡板交错',
    description:
      '黄色透明面在挡板之前(且比挡板小一圈、偏上),紫色透明面在挡板之后。挡板是不透明物体,始终按深度截断后方:被它挡住的紫面部分绝不能因绘制顺序透出,挡板下缘还能看到未被黄面覆盖的灰色本体。',
    surfaces: [
      {
        id: 'yellow',
        name: '黄色透明面(挡板前)',
        color: 0xffdd33,
        opacity: 0.5,
        position: [0, 0.45, 0.9],
        rotation: [0, 0, 0],
        size: [1.0, 1.8],
      },
      {
        id: 'violet',
        name: '紫色透明面(挡板后)',
        color: 0x9955ff,
        opacity: 0.6,
        position: [0, 0, -0.9],
        rotation: [0, 0, 0],
        size: [4.0, 3.2],
      },
    ],
    occluder: {
      id: 'board',
      name: '不透明挡板',
      color: 0x9aa0a8,
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      size: [1.6, 2.2],
    },
    checkpoints: [
      {
        id: 'cp-front',
        name: 'C-1 挡板上方(黄叠紫,无挡板)',
        ndc: [0, 0.64],
        expectSurfaces: ['yellow', 'violet'],
        situation: '挡板:该视线上没有挡板,黄叠紫',
      },
      {
        id: 'cp-board',
        name: 'C-2 挡板上半部(黄+挡板,紫被遮)',
        ndc: [0, 0.05],
        expectSurfaces: ['yellow', 'board', 'violet'],
        situation: '挡板:黄面叠在挡板上,紫面被挡板完全遮住',
      },
      {
        id: 'cp-side',
        name: 'C-3 挡板下缘灰色本体(无黄面)',
        ndc: [0, -0.32],
        expectSurfaces: ['board', 'violet'],
        situation: '挡板:视线只命中挡板,看到挡板灰色本色,紫面仍被遮住',
      },
    ],
    camera: {
      position: [0, 0, 4.6],
      target: [0, 0, 0],
    },
  },
];

/** 深拷贝预设,供"恢复预设"使用(面板会改状态,不能污染原定义) */
export function clonePreset(p: Preset): Preset {
  return JSON.parse(JSON.stringify(p)) as Preset;
}

export function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
