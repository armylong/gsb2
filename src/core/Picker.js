/**
 * Picker —— 拾取 / 框选几何层
 *
 * 所有屏幕坐标统一使用相对画布左上角的 CSS 像素（clientX/Y 减去画布边界）。
 * 拖框开始与结束都记录同一坐标系下的点，窗口缩放或相机移动后：
 *   - NDC 在拾取/投影当下按最新画布尺寸换算；
 *   - 框选命中在松手当下用最新相机重新投影每个物件。
 * 因此选择区域始终以“当前场景画面”为准，不会因分辨率或视角变化而错位。
 */

import { Raycaster, Vector3, Matrix4, Vector2 } from 'three';

const _raycaster = new Raycaster();
const _origin = new Vector3();
const _dir = new Vector3();
const _mat = new Matrix4();
const _v = new Vector3();

/** 画布 CSS 像素坐标 -> NDC（-1..1，y 向上） */
export function localToNDC(localX, localY, width, height) {
  return new Vector2((localX / width) * 2 - 1, -(localY / height) * 2 + 1);
}

/** 鼠标 client 坐标 -> 画布本地 CSS 像素坐标 */
export function toLocal(event, rect) {
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

/**
 * 点选：返回屏幕位置处最近的“可见”实例 id，无命中返回 null。
 *
 * InstancedMesh 对 scale=0（隐藏）的实例不产生相交，
 * 这里再显式跳过 hiddenIds 做双保险，保证永远选不到隐藏物件。
 */
export function pickPointId(mesh, camera, localX, localY, width, height, hiddenLookup) {
  const ndc = localToNDC(localX, localY, width, height);
  _raycaster.setFromCamera(ndc, camera);
  const hits = _raycaster.intersectObject(mesh, false);
  for (const hit of hits) {
    if (hit.instanceId == null) continue;
    if (hiddenLookup && hiddenLookup(hit.instanceId)) continue;
    return hit.instanceId; // intersectObject 已按距离排序，首个即最近
  }
  return null;
}

/**
 * 把某个实例的世界坐标投影到屏幕。
 * @returns {{x:number, y:number, inFront:boolean}|null} CSS 像素坐标；相机背后返回 inFront=false
 */
export function projectInstance(mesh, instanceId, camera, width, height) {
  mesh.getMatrixAt(instanceId, _mat);
  _v.setFromMatrixPosition(_mat); // 实例中心（世界坐标，mesh 本身位于原点）
  _v.project(camera);
  return {
    x: ((_v.x + 1) / 2) * width,
    y: ((-_v.y + 1) / 2) * height,
    inFront: _v.z < 1, // 在近平面之前；相机正后方的点 z≈-1 但会落到屏幕中央，必须排除
  };
}

/**
 * 框选：返回投影中心落在矩形内、且位于相机前方的可见实例 id 列表。
 *
 * 密集遮挡区域的可理解规则（README 中同步说明）：
 *   以“物件中心投影是否在框内”为唯一判定，与遮挡无关——
 *   被挡住的物件同样被选中，结果确定、可解释，重复执行结果幂等。
 *
 * @param {object} rect 画布本地 CSS 像素矩形 {x0,y0,x1,y1}（端点顺序无所谓）
 */
export function pickBoxIds(mesh, camera, width, height, rect, hiddenLookup) {
  const minX = Math.min(rect.x0, rect.x1);
  const maxX = Math.max(rect.x0, rect.x1);
  const minY = Math.min(rect.y0, rect.y1);
  const maxY = Math.max(rect.y0, rect.y1);
  const count = mesh.count;
  const ids = [];

  for (let id = 0; id < count; id++) {
    if (hiddenLookup && hiddenLookup(id)) continue;
    const p = projectInstance(mesh, id, camera, width, height);
    if (
      p.inFront &&
      p.x >= minX &&
      p.x <= maxX &&
      p.y >= minY &&
      p.y <= maxY
    ) {
      ids.push(id);
    }
  }
  return ids;
}

export { _raycaster, _origin, _dir };
