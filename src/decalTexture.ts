import * as THREE from 'three';

/**
 * 程序生成的非对称贴花图案:白色绘制 + alpha,着色时由 uDecalColor 着色。
 * 包含:边框、刻度尺(下/左)、方向文字(UP / FRONT→)、编号、斜向标记,
 * 任何旋转/镜像都能从画面上直接看出来。
 */
export function createDecalTexture(): THREE.CanvasTexture {
  const S = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, S, S);
  ctx.strokeStyle = '#ffffff';
  ctx.fillStyle = '#ffffff';
  ctx.lineCap = 'butt';

  // 外边框
  ctx.lineWidth = 10;
  ctx.strokeRect(18, 18, S - 36, S - 36);

  // 内边框(仅左/下,制造不对称)
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(40, 40);
  ctx.lineTo(40, S - 40);
  ctx.lineTo(S - 40, S - 40);
  ctx.stroke();

  // 下边缘刻度尺:每 1/10 一格,每 5 格加长,标注数字
  ctx.lineWidth = 4;
  ctx.font = 'bold 20px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (let i = 0; i <= 10; i++) {
    const x = 40 + ((S - 80) * i) / 10;
    const len = i % 5 === 0 ? 34 : 18;
    ctx.beginPath();
    ctx.moveTo(x, S - 40);
    ctx.lineTo(x, S - 40 - len);
    ctx.stroke();
    if (i % 2 === 0) ctx.fillText(String(i), x, S - 48);
  }
  // 左边缘刻度尺(无数字,与下边区分)
  for (let i = 0; i <= 10; i++) {
    const y = 40 + ((S - 80) * i) / 10;
    const len = i % 5 === 0 ? 30 : 14;
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(40 + len, y);
    ctx.stroke();
  }

  // 方向文字:顶部 "UP ↑"
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('UP ↑', S / 2, 92);

  // 非对称标记:左上大箭头指向右上
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(90, 200);
  ctx.lineTo(300, 130);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(300, 130);
  ctx.lineTo(258, 128);
  ctx.lineTo(288, 162);
  ctx.closePath();
  ctx.fill();

  // 文字 "FRONT →"(竖排,右侧)
  ctx.save();
  ctx.translate(S - 70, S / 2 + 40);
  ctx.rotate(-Math.PI / 2);
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('FRONT →', 0, 0);
  ctx.restore();

  // 左下斜向标记线
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.moveTo(60, S - 120);
  ctx.lineTo(180, S - 60);
  ctx.stroke();

  // 贯穿纹理边界的元素:让视锥侧边界的裁切直接可见
  // 粗斜纹从左边贯穿到顶边(穿过左上角)
  ctx.lineWidth = 16;
  ctx.beginPath();
  ctx.moveTo(0, 150);
  ctx.lineTo(150, 0);
  ctx.stroke();
  // 右侧水平短纹,贯穿右边
  ctx.lineWidth = 12;
  ctx.beginPath();
  ctx.moveTo(S - 90, 240);
  ctx.lineTo(S, 240);
  ctx.stroke();
  // 底部竖直短纹,贯穿底边
  ctx.beginPath();
  ctx.moveTo(300, S - 70);
  ctx.lineTo(300, S);
  ctx.stroke();

  // 右下编号
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'right';
  ctx.fillText('No.07', S - 60, S - 100);

  // 中心十字(小,便于观察投射中心)
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(S / 2 - 22, S / 2);
  ctx.lineTo(S / 2 + 22, S / 2);
  ctx.moveTo(S / 2, S / 2 - 22);
  ctx.lineTo(S / 2, S / 2 + 22);
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
