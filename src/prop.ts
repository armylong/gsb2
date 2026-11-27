import * as THREE from 'three'

/**
 * 用几何体搭的道具: 箱体身体 + 球头 + 前置红臂(突出) + 后置蓝鳍(突出) + 底座。
 * 红色臂朝 +Z(正面), 蓝色鳍朝 -Z(背面), 正面/背面一眼可分。
 */
export function buildProp(): THREE.Group {
  const g = new THREE.Group()
  const mat = (c: number) => new THREE.MeshLambertMaterial({ color: c })

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, 0.8), mat(0xd98f3a))
  body.position.y = 0.9

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.42, 24, 16), mat(0xe8d06a))
  head.position.set(0, 1.95, 0.1)

  // 前置突出的红臂 — 制造自遮挡与视差缺失的主要来源
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 16), mat(0xc23b2e))
  arm.rotation.x = Math.PI / 2
  arm.position.set(0.45, 1.2, 0.75)

  // 后置突出的蓝鳍
  const fin = new THREE.Mesh(new THREE.ConeGeometry(0.35, 0.9, 4), mat(0x2e6fc2))
  fin.rotation.x = -Math.PI / 2
  fin.position.set(0, 1.1, -0.8)

  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.65, 0.25, 24), mat(0x777777))
  base.position.y = 0.125

  g.add(body, head, arm, fin, base)
  return g
}
