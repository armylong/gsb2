/**
 * 透明面排序。
 *
 * three.js 只按对象排序，不会对同一 mesh 内的三角形排序；
 * 透明材质关闭深度写入后，三角形先后顺序直接影响混合结果。
 * 这里对每个三角形按到相机的距离从远到近重排索引，
 * 保证透明面之间是标准的 back-to-front 混合顺序。
 *
 * 纯函数，便于单元测试。
 */

export function sortIndicesBackToFront(positions, indices, camera, out) {
  const triangleCount = indices.length / 3;
  const order = out && out.length === triangleCount ? out : new Float64Array(triangleCount);
  const sorted = new Uint32Array(indices.length);

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = indices[t * 3];
    const i1 = indices[t * 3 + 1];
    const i2 = indices[t * 3 + 2];

    const cx = (positions[i0 * 3] + positions[i1 * 3] + positions[i2 * 3]) / 3;
    const cy =
      (positions[i0 * 3 + 1] + positions[i1 * 3 + 1] + positions[i2 * 3 + 1]) / 3;
    const cz =
      (positions[i0 * 3 + 2] + positions[i1 * 3 + 2] + positions[i2 * 3 + 2]) / 3;

    const dx = cx - camera.x;
    const dy = cy - camera.y;
    const dz = cz - camera.z;
    // 用负距离做升序排序 = 远者优先。
    order[t] = -(dx * dx + dy * dy + dz * dz);
  }

  const triOrder = Array.from({ length: triangleCount }, (_, i) => i);
  triOrder.sort((a, b) => order[a] - order[b]);

  for (let t = 0; t < triangleCount; t += 1) {
    const src = triOrder[t] * 3;
    const dst = t * 3;
    sorted[dst] = indices[src];
    sorted[dst + 1] = indices[src + 1];
    sorted[dst + 2] = indices[src + 2];
  }

  return sorted;
}
