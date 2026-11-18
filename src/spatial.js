// 空间数学：听者坐标系下的相对方位/距离计算。
// 纯函数、无 DOM / Web Audio 依赖，便于 Node 自动化测试。
// 坐标约定（与 Three.js / Web Audio PannerNode 一致，右手系）：
//   x 向右，y 向上，z 朝向屏幕外；听者朝向 yaw=0 时面向 -z 方向。

export const MAX_SOURCES = 3;

export const BOUNDS = {
  x: 12,
  y: 6,
  z: 12,
};

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function wrapAngle(deg) {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a < -180) a += 360;
  return a;
}

// 听者位置 -> 声源位置的相对向量（世界系）
export function relativeVector(source, listener) {
  return {
    x: source.x - listener.x,
    y: source.y - listener.y,
    z: source.z - listener.z,
  };
}

export function distance(source, listener) {
  const d = relativeVector(source, listener);
  return Math.hypot(d.x, d.y, d.z);
}

// 水平方位角（度）：以听者朝向为 0°，正值 = 右侧，负值 = 左侧，范围 (-180, 180]
export function azimuth(source, listener) {
  const d = relativeVector(source, listener);
  const yaw = (listener.yaw * Math.PI) / 180;
  // 听者“前方”单位向量（yaw=0 时为 -z）
  const fwdX = -Math.sin(yaw);
  const fwdZ = -Math.cos(yaw);
  // 听者“右方”单位向量
  const rightX = Math.cos(yaw);
  const rightZ = -Math.sin(yaw);
  const forward = d.x * fwdX + d.z * fwdZ;
  const right = d.x * rightX + d.z * rightZ;
  return wrapAngle((Math.atan2(right, forward) * 180) / Math.PI);
}

// 仰角（度）：相对水平面向上为正
export function elevation(source, listener) {
  const d = relativeVector(source, listener);
  const horizontal = Math.hypot(d.x, d.z);
  return (Math.atan2(d.y, horizontal) * 180) / Math.PI;
}

// 供 UI / 测试使用的八方位文字描述
export function azimuthLabel(angleDeg) {
  const a = wrapAngle(angleDeg);
  const bands = [
    [-157.5, '左后方'], [-112.5, '左侧偏后'], [-67.5, '左侧'],
    [-22.5, '左前方'], [22.5, '正前方'], [67.5, '右前方'],
    [112.5, '右侧'], [157.5, '右侧偏后'], [180.1, '右后方'],
  ];
  for (const [limit, label] of bands) {
    if (a < limit) return label;
  }
  return '右后方';
}

// 综合空间关系描述
export function describeSpatial(source, listener) {
  const dist = distance(source, listener);
  const az = azimuth(source, listener);
  const el = elevation(source, listener);
  return {
    distance: dist,
    azimuth: az,
    elevation: el,
    label: azimuthLabel(az),
  };
}
