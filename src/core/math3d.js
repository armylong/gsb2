// 最小三维向量工具：全部使用普通 [x, y, z] 数组，零依赖，Node 与浏览器共用。

export function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function add(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function scale(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize(a) {
  const len = length(a);
  if (len < 1e-12) return [0, 0, 0];
  return [a[0] / len, a[1] / len, a[2] / len];
}

// 三角形面积（向量标量面积的一半），退化三角形返回 0
export function triangleArea(p0, p1, p2) {
  return length(cross(sub(p1, p0), sub(p2, p0))) * 0.5;
}

// 夹角（弧度），输入应已归一化
export function angleBetweenUnit(a, b) {
  const c = Math.max(-1, Math.min(1, dot(a, b)));
  return Math.acos(c);
}

export function degToRad(d) {
  return (d * Math.PI) / 180;
}

export function radToDeg(r) {
  return (r * 180) / Math.PI;
}

// 带符号四面体体积的 6 倍：v0 · (v1 × v2)
export function triDot(p0, p1, p2) {
  return dot(p0, cross(p1, p2));
}
