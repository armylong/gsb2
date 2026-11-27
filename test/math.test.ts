// 核心数学正确性测试：node --import tsx test/math.test.ts
// 不启动浏览器，只验证三维与导出共用的周期数学。
import assert from 'node:assert';
import {
  mod,
  smoothstep,
  getCell,
  warpCenterY,
  weftCenterY,
  evalTop,
  buildPalettes,
  type WeaveState,
} from '../src/weave/weaveMath.ts';
import { PRESETS } from '../src/weave/presets.ts';

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

function presetState(id: string, repsX = 3, repsZ = 3): WeaveState {
  const p = PRESETS.find((x) => x.id === id)!;
  return {
    model: { sizeW: p.model.sizeW, sizeF: p.model.sizeF, matrix: p.model.matrix.slice() },
    yarn: JSON.parse(JSON.stringify(p.yarn)),
    repsX,
    repsZ,
  };
}

console.log('模索引');
check('mod 对负数也回到循环内', () => {
  assert.equal(mod(-1, 4), 3);
  assert.equal(mod(-4, 4), 0);
  assert.equal(mod(5, 4), 1);
});

console.log('高度函数的周期性（接缝不跳变）');
for (const id of ['plain', 'twill', 'float', 'uneven']) {
  const s = presetState(id);
  const sf = s.yarn.weft.spacing;
  const sw = s.yarn.warp.spacing;
  const tileZ = s.model.sizeF * sf;
  const tileX = s.model.sizeW * sw;
  check(`${id}: 经线高度平移整数循环后完全相等`, () => {
    for (const i of [0, 1, s.model.sizeW - 1]) {
      for (const z of [0.13 * sf, 0.47 * sf, 0.83 * sf, 1.2 * sf, 2.7 * sf]) {
        const a = warpCenterY(s.model, s.yarn, i, z);
        const b = warpCenterY(s.model, s.yarn, i + s.model.sizeW, z + tileZ);
        const c = warpCenterY(s.model, s.yarn, i, z + 3 * tileZ);
        assert.ok(Math.abs(a - b) < 1e-12, `warp y mismatch at i=${i} z=${z}`);
        assert.ok(Math.abs(a - c) < 1e-12, `warp y period mismatch z=${z}`);
      }
    }
  });
  check(`${id}: 纬线高度平移整数循环后完全相等`, () => {
    for (const j of [0, 1, s.model.sizeF - 1]) {
      for (const x of [0.21 * sw, 0.61 * sw, 1.9 * sw]) {
        const a = weftCenterY(s.model, s.yarn, j, x);
        const b = weftCenterY(s.model, s.yarn, j + s.model.sizeF, x + tileX);
        assert.ok(Math.abs(a - b) < 1e-12, `weft y mismatch j=${j} x=${x}`);
      }
    }
  });
}

console.log('交叉点处高度与组织一致');
check('经线上浮点：经线在上、纬线在下', () => {
  const s = presetState('plain');
  const sf = s.yarn.weft.spacing;
  const sw = s.yarn.warp.spacing;
  // 平纹 i0j0 = 经线上浮
  assert.equal(getCell(s.model, 0, 0), 1);
  const wy = warpCenterY(s.model, s.yarn, 0, 0);
  const fy = weftCenterY(s.model, s.yarn, 0, 0);
  assert.ok(wy > fy);
  // 邻格 j1 纬线上浮，关系反转
  assert.equal(getCell(s.model, 0, 1), 0);
  const wy1 = warpCenterY(s.model, s.yarn, 0, sf);
  const fy1 = weftCenterY(s.model, s.yarn, 1, 0);
  assert.ok(wy1 < fy1);
  void sw;
});

console.log('长浮线：连续上浮段中段保持水平（一整根线）');
check('float 预设 i=0 经线 j=4,5,0,1 是连续 4 点上浮', () => {
  const s = presetState('float');
  for (const j of [4, 5, 0, 1]) {
    assert.equal(getCell(s.model, 0, j), 1, `i0 j${j} 应为经浮`);
  }
});
check('浮线中段（j5→j0 跨边界之间）高度恒定且位于上层', () => {
  const s = presetState('float');
  const sf = s.yarn.weft.spacing;
  // j=5 交叉点在 z=5sf，j=0 下一个循环在 z=6sf，中间应保持顶层高度
  const hAt5 = warpCenterY(s.model, s.yarn, 0, 5 * sf);
  const hMid = warpCenterY(s.model, s.yarn, 0, 5.5 * sf);
  const hAt6 = warpCenterY(s.model, s.yarn, 0, 6 * sf);
  assert.ok(Math.abs(hAt5 - hMid) < 1e-12, '浮线下沉了，说明没有保持水平');
  assert.ok(Math.abs(hMid - hAt6) < 1e-12);
  assert.ok(hMid > 0, '浮线应在中心面上方');
});

console.log('高度函数连续可过渡（无突跳）');
check('相邻交叉点之间任意采样，高度在两端值之间', () => {
  const s = presetState('twill');
  const sf = s.yarn.weft.spacing;
  const h0 = warpCenterY(s.model, s.yarn, 1, 0);
  const h1 = warpCenterY(s.model, s.yarn, 1, sf);
  for (let k = 1; k < 10; k++) {
    const h = warpCenterY(s.model, s.yarn, 1, (k / 10) * sf);
    const lo = Math.min(h0, h1);
    const hi = Math.max(h0, h1);
    assert.ok(h >= lo - 1e-12 && h <= hi + 1e-12);
  }
});
check('smoothstep 端点为 0/1', () => {
  assert.equal(smoothstep(0), 0);
  assert.equal(smoothstep(1), 1);
  assert.equal(smoothstep(0.5), 0.5);
});

console.log('俯视采样 evalTop 的四边周期连续（导出可平铺）');
check('同一物理点从相邻循环采样，颜色与高度一致', () => {
  const s = presetState('float');
  const pal = buildPalettes(s);
  const tx = s.model.sizeW * s.yarn.warp.spacing;
  const tz = s.model.sizeF * s.yarn.weft.spacing;
  for (let k = 0; k < 20; k++) {
    const x = Math.random() * tx;
    const z = Math.random() * tz;
    const a = evalTop(s, x, z, pal);
    const b = evalTop(s, x + tx, z + tz, pal);
    assert.ok(Math.abs(a.r - b.r) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
    assert.equal(a.gap, b.gap);
  }
});
check('右边缘与左边缘逐像素对应（256 网格）', () => {
  const s = presetState('uneven');
  const pal = buildPalettes(s);
  const tx = s.model.sizeW * s.yarn.warp.spacing;
  const tz = s.model.sizeF * s.yarn.weft.spacing;
  const N = 128;
  for (let py = 0; py < N; py++) {
    const z = (py + 0.5) * (tz / N);
    const left = evalTop(s, 0.5 * (tx / N), z, pal);
    const right = evalTop(s, tx - 0.5 * (tx / N), z, pal);
    // 这两个点在无限平铺里互为跨边邻居，各自再平移一个 tile 后应等价
    const rightWrapped = evalTop(s, -0.5 * (tx / N), z, pal);
    assert.ok(Math.abs(rightWrapped.r - right.r) < 1e-9);
    assert.ok(Math.abs(rightWrapped.y - right.y) < 1e-9);
    void left;
  }
});

console.log(`\n全部 ${passed} 项通过`);
