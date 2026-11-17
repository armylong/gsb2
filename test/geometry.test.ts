import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { PRESETS, BACKGROUND_COLOR, hexToRgb } from '../src/presets';
import { buildMeshes, evaluateRay, type SceneMeshes } from '../src/geometry';
import { compositeFragments } from '../src/blend';

function makeCamera(presetId: string): THREE.PerspectiveCamera {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  cam.position.set(...preset.camera.position);
  cam.lookAt(...preset.camera.target);
  cam.updateMatrixWorld(true);
  return cam;
}

function setup(presetId: string): {
  preset: (typeof PRESETS)[number];
  meshes: SceneMeshes;
  camera: THREE.PerspectiveCamera;
} {
  const preset = PRESETS.find((p) => p.id === presetId)!;
  const meshes = buildMeshes(preset);
  meshes.transparent.forEach((m) => m.updateMatrixWorld(true));
  meshes.occluder?.updateMatrixWorld(true);
  return { preset, meshes, camera: makeCamera(presetId) };
}

describe('几何验证:交叉面交线两侧深度顺序相反', () => {
  const { preset, meshes, camera } = setup('crossing');

  it('交线左侧(x<0):orange 在前、teal 在后', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-left')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    expect(frags.map((f) => f.id)).toEqual(['orange', 'teal']);
    expect(frags[0].depth).toBeLessThan(frags[1].depth);
  });

  it('交线右侧(x>0):深度次序翻转,teal 在前、orange 在后', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-right')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    expect(frags.map((f) => f.id)).toEqual(['teal', 'orange']);
    expect(frags[0].depth).toBeLessThan(frags[1].depth);
  });

  it('两侧合成颜色不同,且与各自深度次序一致', () => {
    const left = preset.checkpoints.find((c) => c.id === 'cp-left')!;
    const right = preset.checkpoints.find((c) => c.id === 'cp-right')!;
    const bg = hexToRgb(BACKGROUND_COLOR);
    const cl = compositeFragments(evaluateRay(camera, meshes, left.ndc[0], left.ndc[1]), bg);
    const cr = compositeFragments(evaluateRay(camera, meshes, right.ndc[0], right.ndc[1]), bg);
    expect(cl.color).not.toEqual(cr.color);
  });

  it('交线附近两面深度接近相等(允许微小数值误差)', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-line')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    expect(frags).toHaveLength(2);
    expect(Math.abs(frags[0].depth - frags[1].depth)).toBeLessThan(0.02);
  });
});

describe('几何验证:不透明挡板按深度遮挡透明面', () => {
  const { preset, meshes, camera } = setup('occluder');
  const bg = hexToRgb(BACKGROUND_COLOR);

  it('挡板中心:命中 黄面→挡板→紫面,紫面被判定为遮挡', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-board')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    expect(frags.map((f) => f.id)).toEqual(['yellow', 'board', 'violet']);
    const result = compositeFragments(frags, bg);
    expect(result.occluded.map((f) => f.id)).toEqual(['violet']);
    // 最终颜色不含紫面贡献:与"场景里没有紫面"时相同
    const withoutViolet = frags.filter((f) => f.id !== 'violet');
    expect(compositeFragments(withoutViolet, bg).color).toEqual(result.color);
  });

  it('挡板之外:上方视线没有挡板,看到黄叠紫', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-front')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    expect(frags.map((f) => f.id)).toEqual(['yellow', 'violet']);
    const result = compositeFragments(frags, bg);
    expect(result.occluded).toHaveLength(0);
  });

  it('挡板下缘:无黄面覆盖,直接看到挡板灰色本色,紫面仍被遮挡', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-side')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    expect(frags.map((f) => f.id)).toEqual(['board', 'violet']);
    const result = compositeFragments(frags, bg);
    expect(result.occluded.map((f) => f.id)).toEqual(['violet']);
    expect(result.color).toEqual(hexToRgb(preset.occluder!.color));
  });

  it('无论以什么输入顺序喂给合成器,挡板遮挡结论不变', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-board')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    const r1 = compositeFragments(frags, bg).color;
    const r2 = compositeFragments([...frags].reverse(), bg).color;
    const r3 = compositeFragments([frags[1], frags[2], frags[0]], bg).color;
    expect(r1).toEqual(r2);
    expect(r2).toEqual(r3);
  });
});

describe('几何验证:透明度两个端点', () => {
  const { preset, meshes, camera } = setup('separated');
  const bg = hexToRgb(BACKGROUND_COLOR);

  it('alpha=0:检查点颜色退化为后方(蓝面+背景),前面不产生贡献', () => {
    const red = preset.surfaces.find((s) => s.id === 'red')!;
    red.opacity = 0;
    const cp = preset.checkpoints.find((c) => c.id === 'cp-overlap')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    const result = compositeFragments(frags, bg);
    const onlyBlue = compositeFragments(frags.filter((f) => f.id !== 'red'), bg);
    expect(result.color).toEqual(onlyBlue.color);
  });

  it('alpha=1:前面完全遮住后面,结果只含红面颜色', () => {
    const red = preset.surfaces.find((s) => s.id === 'red')!;
    red.opacity = 1;
    const cp = preset.checkpoints.find((c) => c.id === 'cp-overlap')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    const result = compositeFragments(frags, bg);
    expect(result.color).toEqual(hexToRgb(red.color));
    expect(result.occluded.map((f) => f.id)).toEqual(['blue']);
  });

  it('背景检查点在任何透明度下都等于背景色', () => {
    const cp = preset.checkpoints.find((c) => c.id === 'cp-bg')!;
    const frags = evaluateRay(camera, meshes, cp.ndc[0], cp.ndc[1]);
    expect(frags).toHaveLength(0);
    expect(compositeFragments(frags, bg).color).toEqual(bg);
  });
});

describe('几何验证:交换添加顺序后正确模式结果一致', () => {
  it('三个预设的全部固定检查点,乱序输入合成器结果都相同', () => {
    const bg = hexToRgb(BACKGROUND_COLOR);
    for (const preset of PRESETS) {
      const meshes = buildMeshes(preset);
      meshes.transparent.forEach((m) => m.updateMatrixWorld(true));
      meshes.occluder?.updateMatrixWorld(true);
      const cam = makeCamera(preset.id);
      for (const cp of preset.checkpoints) {
        const frags = evaluateRay(cam, meshes, cp.ndc[0], cp.ndc[1]);
        const reference = compositeFragments(frags, bg).color;
        const shuffled = compositeFragments([...frags].reverse(), bg).color;
        expect(shuffled).toEqual(reference);
        const rotate = compositeFragments(
          [...frags.slice(1), frags[0]].filter(Boolean),
          bg,
        ).color;
        expect(rotate).toEqual(reference);
      }
    }
  });
});
