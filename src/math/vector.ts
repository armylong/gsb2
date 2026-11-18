/**
 * 最小三维向量实现 —— 碰撞数学层不依赖 three.js，方便单元测试与复用。
 * 全部使用可变临时对象风格，避免热路径上产生大量 GC。
 */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = {
  create(x = 0, y = 0, z = 0): Vec3 {
    return { x, y, z };
  },

  set(out: Vec3, x: number, y: number, z: number): Vec3 {
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  },

  copy(out: Vec3, a: Vec3): Vec3 {
    out.x = a.x;
    out.y = a.y;
    out.z = a.z;
    return out;
  },

  add(out: Vec3, a: Vec3, b: Vec3): Vec3 {
    out.x = a.x + b.x;
    out.y = a.y + b.y;
    out.z = a.z + b.z;
    return out;
  },

  sub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
    out.x = a.x - b.x;
    out.y = a.y - b.y;
    out.z = a.z - b.z;
    return out;
  },

  scale(out: Vec3, a: Vec3, s: number): Vec3 {
    out.x = a.x * s;
    out.y = a.y * s;
    out.z = a.z * s;
    return out;
  },

  dot(a: Vec3, b: Vec3): number {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  },

  cross(out: Vec3, a: Vec3, b: Vec3): Vec3 {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    out.x = ay * bz - az * by;
    out.y = az * bx - ax * bz;
    out.z = ax * by - ay * bx;
    return out;
  },

  length(a: Vec3): number {
    return Math.hypot(a.x, a.y, a.z);
  },

  normalize(out: Vec3, a: Vec3): Vec3 {
    const len = Math.hypot(a.x, a.y, a.z) || 1;
    out.x = a.x / len;
    out.y = a.y / len;
    out.z = a.z / len;
    return out;
  },

  distance(a: Vec3, b: Vec3): number {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  },
};
