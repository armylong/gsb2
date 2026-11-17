import * as THREE from 'three';

/** 文字标签精灵（门户标记、方位标记等） */
export function makeLabelSprite(text: string, color = '#ffffff'): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(8, 12, 16, 0.6)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 4;
  ctx.strokeRect(2, 2, c.width - 4, c.height - 4);
  ctx.fillStyle = color;
  ctx.font = 'bold 56px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, c.width / 2, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex }));
  sp.scale.set(2.0, 0.5, 1);
  return sp;
}

/** 门内再次出现的门户显示的“封闭面”纹理：斜纹 + 文字，明确表示不递归展开 */
export function makeClosedTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#232a33';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#4a5a6c';
  ctx.lineWidth = 10;
  for (let i = -c.height; i < c.width + c.height; i += 36) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + c.height, c.height);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(10, 14, 18, 0.78)';
  ctx.fillRect(14, c.height / 2 - 52, c.width - 28, 104);
  ctx.fillStyle = '#ffd27f';
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`门户${label}`, c.width / 2, c.height / 2 - 22);
  ctx.fillText('封闭·不递归', c.width / 2, c.height / 2 + 22);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** 门户背面纹理：实心封闭，不可通行 */
export function makeBackTexture(label: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 384;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#33393f';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.strokeStyle = '#22282d';
  ctx.lineWidth = 6;
  for (let y = 24; y < c.height; y += 48) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(c.width, y);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(10, 14, 18, 0.8)';
  ctx.fillRect(14, c.height / 2 - 52, c.width - 28, 104);
  ctx.fillStyle = '#ff9a9a';
  ctx.font = 'bold 30px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`门户${label} 背面`, c.width / 2, c.height / 2 - 22);
  ctx.fillText('不可通行', c.width / 2, c.height / 2 + 22);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
