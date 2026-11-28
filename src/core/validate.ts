import type { LevelDef } from './types';

function fail(level: LevelDef, message: string): never {
  throw new Error(`关卡「${level.id}」数据无效：${message}`);
}

/** 载入关卡前做一次完整校验，避免数据错误悄悄变成玩法错误。 */
export function validateLevel(level: LevelDef): void {
  if (level.width < 1 || level.height < 1) fail(level, '棋盘尺寸必须为正');
  if (level.plan.length !== level.height) fail(level, '样图行数与高不符');
  for (const row of level.plan) {
    if (row.length !== level.width) fail(level, '样图列数与宽不符');
  }
  if (level.inks.length === 0) fail(level, '至少需要一种墨');
  if (level.stencils.length === 0) fail(level, '至少需要一片模板');

  const paletteIds = new Set<string>();
  for (const entry of level.palette) {
    if (paletteIds.has(entry.id)) fail(level, `调色板颜色 id 重复：${entry.id}`);
    if (!/^#[0-9a-fA-F]{6}$/.test(entry.css)) fail(level, `颜色 ${entry.id} 的色值必须是 #rrggbb`);
    paletteIds.add(entry.id);
  }
  if (!paletteIds.has(level.paperColor)) fail(level, '调色板缺少纸白颜色');

  const inkIds = new Set<string>();
  for (const ink of level.inks) {
    if (inkIds.has(ink.id)) fail(level, `墨色 id 重复：${ink.id}`);
    inkIds.add(ink.id);
    if (!paletteIds.has(ink.color)) fail(level, `墨色 ${ink.id} 引用了不存在的颜色 ${ink.color}`);
    const budget = level.budget[ink.id];
    if (typeof budget !== 'number' || !Number.isInteger(budget) || budget < 0) {
      fail(level, `墨色 ${ink.id} 的墨量必须是非负整数`);
    }
  }

  for (const ink of level.inks) {
    const paperKey = `${level.paperColor}|${ink.color}`;
    if (level.mix[paperKey] !== ink.color) fail(level, `叠色表缺少 ${paperKey} → ${ink.color}`);
    const sameKey = `${ink.color}|${ink.color}`;
    if (level.mix[sameKey] !== ink.color) fail(level, `叠色表缺少 ${sameKey} → ${ink.color}`);
    for (const above of level.inks) {
      if (above.id === ink.id) continue;
      const key = `${ink.color}|${above.color}`;
      const result = level.mix[key];
      if (!result || !paletteIds.has(result)) fail(level, `叠色表缺少 ${key}`);
    }
  }

  // 叠色表必须闭合：任何能叠出来的颜色，再叠任何一种墨都要有定义。
  const reachable = new Set<string>([level.paperColor, ...level.inks.map((ink) => ink.color)]);
  const queue = [...reachable];
  while (queue.length > 0) {
    const color = queue.shift()!;
    for (const ink of level.inks) {
      const key = `${color}|${ink.color}`;
      const result = level.mix[key];
      if (!result) fail(level, `叠色表不闭合：缺少 ${key}`);
      if (!paletteIds.has(result)) fail(level, `叠色表 ${key} 指向不存在的颜色 ${result}`);
      if (!reachable.has(result)) {
        reachable.add(result);
        queue.push(result);
      }
    }
  }
  for (const color of reachable) {
    if (!paletteIds.has(color)) fail(level, `叠色表会产生调色板之外的颜色 ${color}`);
  }

  for (let y = 0; y < level.height; y += 1) {
    for (let x = 0; x < level.width; x += 1) {
      const token = level.plan[y]![x]!;
      if (token !== 'free' && token !== 'clean' && !paletteIds.has(token)) {
        fail(level, `样图 (${x},${y}) 引用了不存在的颜色 ${token}`);
      }
    }
  }

  const stencilIds = new Set<string>();
  for (const s of level.stencils) {
    if (stencilIds.has(s.id)) fail(level, `模板 id 重复：${s.id}`);
    stencilIds.add(s.id);
    if (s.holes.length === 0) fail(level, `模板 ${s.id} 没有孔`);
    const seen = new Set<string>();
    for (const h of s.holes) {
      if (!Number.isInteger(h.x) || !Number.isInteger(h.y)) fail(level, `模板 ${s.id} 的孔位必须是整数`);
      const key = `${h.x},${h.y}`;
      if (seen.has(key)) fail(level, `模板 ${s.id} 有重复孔位 ${key}`);
      seen.add(key);
    }
    if (!s.holes.some((h) => h.x === 0 && h.y === 0)) {
      fail(level, `模板 ${s.id} 的定位点 (0,0) 必须是一个孔`);
    }
  }

  for (const key of Object.keys(level.budget)) {
    if (!inkIds.has(key)) fail(level, `墨量预算引用了不存在的墨色 ${key}`);
  }

  const exact = level.plan.flat().filter((t) => t !== 'free' && t !== 'clean');
  if (exact.length === 0) fail(level, '样图没有要求颜色的格');
}
