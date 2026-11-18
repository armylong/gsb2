/**
 * 有限的方块材质表。
 *
 * 透明规则只依赖 `transparent` 标记，渲染与网格化共用同一份定义，
 * 避免“逻辑上透明、网格上不透明”这类不一致。
 */
export const MATERIALS = Object.freeze({
  stone: {
    id: 'stone',
    label: '石头',
    color: 0x8b95a3,
    transparent: false,
    opacity: 1,
  },
  dirt: {
    id: 'dirt',
    label: '泥土',
    color: 0x8a5b3c,
    transparent: false,
    opacity: 1,
  },
  grass: {
    id: 'grass',
    label: '草地',
    color: 0x5c9e52,
    transparent: false,
    opacity: 1,
  },
  sand: {
    id: 'sand',
    label: '沙子',
    color: 0xd8c28d,
    transparent: false,
    opacity: 1,
  },
  wood: {
    id: 'wood',
    label: '木头',
    color: 0x9b6d43,
    transparent: false,
    opacity: 1,
  },
  leaves: {
    id: 'leaves',
    label: '树叶',
    color: 0x3e7f45,
    transparent: false,
    opacity: 1,
  },
  glass: {
    id: 'glass',
    label: '玻璃',
    color: 0xa8e6ee,
    transparent: true,
    opacity: 0.3,
  },
  water: {
    id: 'water',
    label: '水',
    color: 0x3f86c9,
    transparent: true,
    opacity: 0.6,
  },
});

export const MATERIAL_IDS = Object.freeze(Object.keys(MATERIALS));

export const OPAQUE_MATERIAL_IDS = Object.freeze(
  MATERIAL_IDS.filter((id) => !MATERIALS[id].transparent),
);

export const TRANSPARENT_MATERIAL_IDS = Object.freeze(
  MATERIAL_IDS.filter((id) => MATERIALS[id].transparent),
);

export function isKnownMaterial(id) {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(MATERIALS, id);
}

export function isTransparent(id) {
  return isKnownMaterial(id) && MATERIALS[id].transparent;
}

export function materialLabel(id) {
  return isKnownMaterial(id) ? MATERIALS[id].label : '空气';
}
