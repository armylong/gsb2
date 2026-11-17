// 方向光阴影诊断引擎（纯函数，零第三方依赖，可在 Node 与浏览器中运行）
//
// 输入：场景尺寸、阴影正交相机参数、偏移参数、主相机视角、物体包围球列表
// 输出：
//   - 每个物体相对阴影截锥的覆盖状态（inside / outside-h / outside-far / outside-near）
//   - 当前相机视野（地面多边形）与阴影覆盖区的交叠比例
//   - 带依据的诊断条目（覆盖不足、远平面裁剪、近平面、阴影条纹、阴影脱离、清晰度）
//   - 量化的参数调整建议
//
// 坐标约定：Y 轴向上，地面为 y=0 平面。

// ---------------------------------------------------------------- 小向量库

const v3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ],
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
  len: (a) => Math.hypot(a[0], a[1], a[2]),
};

// ------------------------------------------------------------- 光空间构造

/**
 * 由方向、目标点构造光空间正交基。
 * 光空间原点位于目标点：x 右、y 上、z 沿光传播方向（物体离光源越远 z 越大）。
 * three.js 阴影相机看向 -Z，其近/远平面映射到本坐标的 z=-near 与 z=far-near。
 */
export function buildLightFrame(lightDir, target) {
  const zAxis = v3.norm(lightDir);
  const upWorld = [0, 1, 0];
  let xAxis = v3.norm(v3.cross(upWorld, zAxis));
  if (v3.len(v3.cross(upWorld, zAxis)) < 1e-6) xAxis = [1, 0, 0];
  const yAxis = v3.cross(zAxis, xAxis);
  return { origin: [...target], xAxis, yAxis, zAxis };
}

/** 世界坐标 -> 光空间坐标（光空间 z 即沿光传播方向的深度，近平面处为 0） */
export function toLightSpace(worldPoint, frame) {
  const d = v3.sub(worldPoint, frame.origin);
  return [
    v3.dot(d, frame.xAxis),
    v3.dot(d, frame.yAxis),
    v3.dot(d, frame.zAxis),
  ];
}

// ------------------------------------------------------------- 主相机视野

/**
 * 主相机在地面上的视野多边形（凸多边形，3~8 点）。
 * 做法：取近/远平面构成的视锥盒，对 y=0 平面做 Sutherland-Hodgman 裁剪，
 * 交点即视野在地面的开口——相机上仰、部分射线朝天时依然成立。
 * 俯视（整个视锥都在地面上方、无交点）返回 null，由调用方退化为全覆盖。
 */
export function cameraGroundPolygon(camera, groundSize = 40) {
  const { position, target, fov, aspect } = camera;
  const forward = v3.norm(v3.sub(target, position));
  // 与 three.js lookAt 一致的右手基：right = cross(forward, worldUp)
  const right = v3.norm(v3.cross(forward, [0, 1, 0]));
  const up = v3.cross(right, forward);
  const halfV = Math.tan(((fov / 2) * Math.PI) / 180);
  const halfH = halfV * aspect;

  // 用足够远的远平面把视锥近似为盒，覆盖整个 40 单位地面
  const farD = 200;
  const nearD = 0.1;
  const corner = (d, sx, sy) =>
    v3.add(
      v3.add(position, v3.scale(forward, d)),
      v3.add(v3.scale(right, sx * halfH * d), v3.scale(up, sy * halfV * d)),
    );
  const poly = [
    corner(nearD, -1, 1), corner(nearD, 1, 1), corner(nearD, 1, -1), corner(nearD, -1, -1),
    corner(farD, -1, 1), corner(farD, 1, 1), corner(farD, 1, -1), corner(farD, -1, -1),
  ];

  // 半空间裁剪：inside(p) 为真时保留
  const clip = (points, inside, intersect) => {
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      const inA = inside(a);
      const inB = inside(b);
      if (inA && inB) out.push(b);
      else if (inA !== inB) {
        out.push(intersect(a, b));
        if (inB) out.push(b);
      }
    }
    return out;
  };
  const lerp3 = (a, b, t) => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];

  // 1) 保留 y <= 0 的半空间（地面及地下），交点压到 y=0
  let out = clip(
    poly,
    (p) => p[1] <= 1e-7,
    (a, b) => {
      const t = a[1] / (a[1] - b[1]);
      const p = lerp3(a, b, t);
      p[1] = 0;
      return p;
    },
  );
  if (out.length < 3) return null;

  // 2) 裁剪到地面矩形范围，避免视野多边形无限延伸
  const g = groundSize / 2;
  const planes = [
    [(p) => p[0] >= -g, (a, b) => lerp3(a, b, (-g - a[0]) / (b[0] - a[0]))],
    [(p) => p[0] <= g, (a, b) => lerp3(a, b, (g - a[0]) / (b[0] - a[0]))],
    [(p) => p[2] >= -g, (a, b) => lerp3(a, b, (-g - a[2]) / (b[2] - a[2]))],
    [(p) => p[2] <= g, (a, b) => lerp3(a, b, (g - a[2]) / (b[2] - a[2]))],
  ];
  for (const [inside, intersect] of planes) {
    out = clip(out, inside, intersect);
    if (out.length < 3) return null;
  }
  const hull = convexHullXZ(out);
  // 俯视等情形：裁剪结果退化为重合点，面积近似 0，视为无有效地面视野
  const area = polygonAreaXZ(hull);
  if (area < 1e-4) return null;
  return hull;
}

function polygonAreaXZ(polygon) {
  let a = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    a += p[0] * q[2] - q[0] * p[2];
  }
  return Math.abs(a) / 2;
}

/** Andrew 单调链凸包（在 xz 平面上，y 统一视为 0） */
export function convexHullXZ(points) {
  const pts = points
    .map((p) => [p[0], p[2]])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length <= 2) return pts.map(([x, z]) => [x, 0, z]);
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower.at(-1), p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (const p of pts.slice().reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper.at(-1), p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper).map(([x, z]) => [x, 0, z]);
}

export function pointInConvexXZ(point, polygon) {
  if (!polygon || polygon.length < 3) return true;
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const c =
      (b[0] - a[0]) * (point[2] - a[2]) - (b[2] - a[2]) * (point[0] - a[0]);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

// ------------------------------------------------------------- 常量阈值

export const LIMITS = {
  // 偏置（世界单位，场景默认 1 单位 ≈ 1 米）
  biasAcne: 8e-4, // |bias| 低于此值且 texel 偏大时，自阴影条纹风险高
  biasPeter: 3e-3, // |bias| 超过此值，且物体较小时出现阴影脱离
  normalBiasPeter: 0.08,
  // 清晰度：世界 texel 尺寸
  texelSoft: 0.06, // 大于此值阴影边缘发虚
  texelCoarse: 0.15, // 大于此值明显锯齿/块状
  // 覆盖裕量：包围球与截锥边缘的距离
  marginTight: 1.0,
  marginWaste: 0.6, // 覆盖范围是实际需求的倍数阈值（越大越浪费清晰度预算）
};

// ------------------------------------------------------------- 核心诊断

/**
 * @param {object} desc
 *   scene:  { groundSize }
 *   params: { orthoSize, near, far, mapSize, bias, normalBias, lightDir, lightTarget }
 *   camera: { position:[x,y,z], target:[x,y,z], fov, aspect }
 *   objects: [{ id, label, position:[x,y,z], radius, height }]
 * @returns {object} 完整诊断报告
 */
export function diagnose(desc) {
  const { scene, params, camera, objects } = desc;
  const frame = buildLightFrame(params.lightDir, params.lightTarget);
  const half = params.orthoSize / 2;
  // z 沿光传播方向：光源侧 z 为负、背光侧为正。
  // three.js 阴影相机看向 -Z，其近平面映射到本坐标 z=-near，远平面映射到 z=far-near。
  const nearPlane = -params.near; // 光源侧
  const farPlane = params.far - params.near; // 背光侧
  const depth = params.far - params.near;
  const texel = params.orthoSize / params.mapSize;

  const viewPoly = cameraGroundPolygon(camera, scene.groundSize);

  const objectReports = objects.map((obj) => {
    const center = toLightSpace(obj.position, frame);
    // 水平（正交相机 x/y 平面）越界距离：正值=还在框内的裕量，负值=越界多远
    const mx = half - Math.abs(center[0]) - obj.radius;
    const my = half - Math.abs(center[1]) - obj.radius;
    const marginH = Math.min(mx, my);
    // 近平面裁掉 z 过小（光源侧）的物体，远平面裁掉 z 过大的物体
    const marginDepthNear = center[2] - obj.radius - nearPlane;
    const marginDepthFar = farPlane - (center[2] + obj.radius);

    let state = 'inside';
    if (marginH < 0) state = 'outside-h';
    else if (marginDepthFar < 0) state = 'outside-far';
    else if (marginDepthNear < 0) state = 'outside-near';

    const inView = viewPoly ? pointInConvexXZ(obj.position, viewPoly) : true;
    return {
      id: obj.id,
      label: obj.label,
      state,
      inView,
      marginH,
      depth: center[2],
      marginDepthNear,
      marginDepthFar,
      texel,
    };
  });

  const inside = objectReports.filter((o) => o.state === 'inside');
  const visible = objectReports.filter((o) => o.inView);
  const visibleUncovered = visible.filter((o) => o.state !== 'inside');
  const coveredInView = visible.filter((o) => o.state === 'inside');

  // 视野覆盖比例：视野内物体按包围球计数（兼顾大小差异）；
  // 无有效视野多边形（垂直俯视等）时退化为全覆盖
  const viewCoverage =
    !viewPoly || visible.length === 0
      ? 1
      : coveredInView.length / visible.length;

  // 覆盖区实际需求（内含物体包围球在光空间 x/y 上的最大外接范围），用于判断范围浪费
  let neededHalf = 0;
  const insideIds = new Set(inside.map((o) => o.id));
  for (const obj of objects) {
    if (!insideIds.has(obj.id)) continue;
    const c = toLightSpace(obj.position, frame);
    neededHalf = Math.max(
      neededHalf,
      Math.abs(c[0]) + obj.radius,
      Math.abs(c[1]) + obj.radius,
    );
  }
  const wasteRatio = neededHalf > 0 ? half / neededHalf : null;

  const findings = [];
  const push = (f) => findings.push(f);

  // ---- 1. 水平覆盖不足（阴影突然消失：覆盖范围类） ----
  const outsideH = objectReports.filter((o) => o.state === 'outside-h');
  if (outsideH.length > 0) {
    const inViewList = outsideH.filter((o) => o.inView);
    const names = (list) => list.map((o) => o.label).join('、');
    push({
      id: 'coverage-horizontal',
      kind: 'coverage',
      severity: inViewList.length ? 'error' : 'warn',
      title: '阴影正交相机覆盖范围不足',
      detail:
        (inViewList.length
          ? `当前视野内 ${names(inViewList)} 的包围球超出光空间 ±${half.toFixed(1)} 的正交范围，`
          : `视野外还有 ${names(outsideH)} 超出正交范围，转动视角后其阴影会消失，`) +
        `超出部分不写入阴影贴图，表现为阴影突然消失（与偏移无关）。`,
      basis: outsideH
        .map(
          (o) =>
            `${o.label}：边缘越过截锥 ${Math.abs(o.marginH).toFixed(2)} 单位${o.inView ? '（在相机视野内）' : ''}`,
        )
        .join('；'),
      suggestion: `把「覆盖范围」从 ${params.orthoSize.toFixed(1)} 增大到至少 ${suggestOrthoSize(frame, objects).toFixed(1)}（含 1 单位裕量），或把光目标移向物体分布中心。`,
    });
  }

  // ---- 2. 远平面裁剪（远处阴影消失：覆盖范围-深度类） ----
  const outsideFar = objectReports.filter((o) => o.state === 'outside-far');
  if (outsideFar.length > 0) {
    const inViewList = outsideFar.filter((o) => o.inView);
    push({
      id: 'coverage-far',
      kind: 'coverage',
      severity: inViewList.length ? 'error' : 'warn',
      title: '阴影远平面过近，远处物体被裁掉',
      detail: `物体沿光方向深度超过 far=${params.far.toFixed(1)}，位于阴影相机后方，阴影贴图中没有该区域——这是“远处阴影消失”，缩小正交范围无法解决。`,
      basis: outsideFar
        .map(
          (o) =>
            `${o.label}：光空间深度 ${o.depth.toFixed(2)}，远平面边界在 ${farPlane.toFixed(2)}（far-near），超出 ${Math.abs(o.marginDepthFar).toFixed(2)} 单位`,
        )
        .join('；'),
      suggestion: `把 far 增大到至少 ${suggestFar(frame, objects, params.near).toFixed(1)}（当前 ${params.far.toFixed(1)}），同时保持 near 尽量贴近物体。`,
    });
  }

  // ---- 3. 近平面穿过物体 ----
  const outsideNear = objectReports.filter((o) => o.state === 'outside-near');
  if (outsideNear.length > 0) {
    push({
      id: 'coverage-near',
      kind: 'coverage',
      severity: 'error',
      title: '阴影近平面穿过物体',
      detail: '物体比阴影相机的 near 更靠近光源，会被近平面裁掉，阴影整体或局部消失。',
      basis: outsideNear
        .map((o) => `${o.label}：近平面裕量 ${o.marginDepthNear.toFixed(2)} 单位`)
        .join('；'),
      suggestion: `把 near 从 ${params.near.toFixed(1)} 减小到约 ${suggestNear(frame, objects).toFixed(1)}。`,
    });
  }

  // ---- 4. 视野覆盖比例 ----
  if (viewPoly && visible.length > 0 && viewCoverage < 0.999) {
    push({
      id: 'view-coverage',
      kind: 'coverage',
      severity: viewCoverage < 0.5 ? 'error' : 'warn',
      title: `当前相机视野内仅 ${(viewCoverage * 100).toFixed(0)}% 的物体落在阴影覆盖区`,
      detail: '视野地面区域与阴影正交框交叠不足，转动/拉远视角后会看到无阴影的地面。',
      basis: `视野内 ${visible.length} 个物体中 ${coveredInView.length} 个被覆盖；未覆盖：${visibleUncovered.map((o) => o.label).join('、') || '无'}`,
      suggestion: `把「覆盖范围」从 ${params.orthoSize.toFixed(1)} 增大到至少 ${suggestOrthoSize(frame, objects).toFixed(1)}，或将光目标对准当前视野中心；切换视角后该比例会重新计算。`,
    });
  }

  // ---- 5. 阴影条纹（阴影痤疮：bias 不足） ----
  const acneObjects = objectReports.filter(
    (o) => o.state === 'inside' && Math.abs(params.bias) < LIMITS.biasAcne && texel > LIMITS.texelSoft * 0.5,
  );
  if (Math.abs(params.bias) < LIMITS.biasAcne && texel > 0.05) {
    push({
      id: 'bias-acne',
      kind: 'bias',
      severity: 'warn',
      title: '阴影偏移过小，可能出现阴影条纹（痤疮）',
      detail: `bias=${fmt(params.bias)} 接近零，而当前 texel=${texel.toFixed(3)} 单位：斜面和曲面在阴影贴图中的深度量化误差无法被吸收，地面与物体表面会出现规则条纹/噪点。`,
      basis: acneObjects.length
        ? `其中 ${acneObjects.length} 个物体处于覆盖区内且 texel 偏大，条纹会出现在它们的接地处与表面`
        : '当前覆盖区内物体较少，但条纹风险随覆盖范围增大而升高',
      suggestion: `把「深度偏移」向负方向调到 -${LIMITS.biasAcne.toFixed(4)} ~ -0.002；若仍有条纹再配合「法向偏移」0.02~0.05。`,
    });
  }

  // ---- 6. 阴影脱离（peter-panning：bias / normalBias 过大） ----
  const peterObjects = inside.filter((o) => {
    const obj = objects.find((x) => x.id === o.id);
    return (
      Math.abs(params.bias) > LIMITS.biasPeter ||
      params.normalBias > LIMITS.normalBiasPeter ||
      params.normalBias > obj.radius * 0.25
    );
  });
  if (peterObjects.length) {
    const causes = [];
    if (Math.abs(params.bias) > LIMITS.biasPeter)
      causes.push(`depth bias=${fmt(params.bias)} 超过 ${LIMITS.biasPeter}`);
    if (params.normalBias > LIMITS.normalBiasPeter)
      causes.push(`normalBias=${params.normalBias.toFixed(3)} 超过 ${LIMITS.normalBiasPeter}`);
    const small = inside
      .map((o) => objects.find((x) => x.id === o.id))
      .filter((obj) => params.normalBias > obj.radius * 0.25);
    if (small.length)
      causes.push(`normalBias 已超过 ${small.map((o) => o.label).join('、')} 半径的 25%`);
    push({
      id: 'bias-peter',
      kind: 'bias',
      severity: 'warn',
      title: '阴影偏移过大，接触阴影悬空（阴影脱离）',
      detail: '偏移把接收点沿光方向推得太远，物体根部与阴影之间出现缝隙，像物体浮在地面上；物体越小越明显。',
      basis: causes.join('；'),
      suggestion: `先把「法向偏移」降到 0.02~0.05，再把「深度偏移」回调到约 -0.001；这是与条纹相反的调节方向，需要在两者间取平衡。`,
    });
  }

  // ---- 7. 清晰度 ----
  if (texel > LIMITS.texelSoft) {
    push({
      id: 'resolution-low',
      kind: 'resolution',
      severity: texel > LIMITS.texelCoarse ? 'error' : 'warn',
      title:
        texel > LIMITS.texelCoarse
          ? '阴影清晰度严重不足（块状锯齿）'
          : '阴影清晰度偏低，边缘发虚',
      detail: `覆盖范围 ${params.orthoSize.toFixed(1)} 单位分摊到 ${params.mapSize}px 阴影贴图上，每 texel=${texel.toFixed(3)} 单位；同样的贴图尺寸下，覆盖范围越大清晰度越差。`,
      basis: `texel 参考阈值：< ${LIMITS.texelSoft} 较好，> ${LIMITS.texelCoarse} 出现明显块状（当前 ${texel.toFixed(3)}）`,
      suggestion:
        wasteRatio && wasteRatio > LIMITS.marginWaste
          ? `当前覆盖范围是实际需求的 ${wasteRatio.toFixed(1)} 倍，优先把「覆盖范围」收缩到约 ${(neededHalf * 2 * 1.15).toFixed(1)}，可直接把 texel 降到 ${((neededHalf * 2 * 1.15) / params.mapSize).toFixed(3)}`
          : `把「阴影贴图」提高到 ${nextMapSize(params.mapSize)}（texel 降为 ${(params.orthoSize / nextMapSize(params.mapSize)).toFixed(3)}），注意显存占用随平方增长。`,
    });
  }

  // ---- 8. 覆盖裕量过紧（相机或物体轻微移动就会出界） ----
  const tight = inside.filter((o) => o.marginH >= 0 && o.marginH < LIMITS.marginTight);
  if (tight.length && !outsideH.length) {
    push({
      id: 'coverage-tight',
      kind: 'coverage',
      severity: 'info',
      title: '覆盖裕量不足 1 单位，物体或相机轻微变化就可能出界',
      detail: '物体包围球已贴近阴影正交框边缘，拖动物体或切换视角后容易触发覆盖不足。',
      basis: tight
        .map((o) => `${o.label}：裕量仅 ${o.marginH.toFixed(2)} 单位`)
        .join('；'),
      suggestion: '预留至少 1 单位裕量，或跟随物体移动光目标。',
    });
  }

  // ---- 9. 一切正常 ----
  if (!findings.some((f) => f.severity !== 'info')) {
    push({
      id: 'all-ok',
      kind: 'ok',
      severity: 'info',
      title: '覆盖、偏移与清晰度均在合理区间',
      detail: `视野内物体全部在阴影覆盖区内（texel=${texel.toFixed(3)}，bias=${fmt(params.bias)}）。`,
      basis: `覆盖 ${coveredInView.length}/${visible.length} 个视野内物体；正交范围 ${params.orthoSize.toFixed(1)}，near/far=${params.near.toFixed(1)}/${params.far.toFixed(1)}`,
      suggestion: '可切换视角预设或拖动物体，观察诊断如何随分布变化。',
    });
  }

  return {
    frame,
    texel,
    half,
    depth,
    viewPoly,
    viewCoverage,
    neededHalf,
    wasteRatio,
    objectReports,
    findings,
    stats: {
      total: objects.length,
      inside: inside.length,
      outsideH: outsideH.length,
      outsideFar: outsideFar.length,
      outsideNear: outsideNear.length,
      visible: visible.length,
      visibleUncovered: visibleUncovered.length,
    },
  };
}

// ------------------------------------------------------------- 建议计算

function suggestOrthoSize(frame, objects) {
  let m = 0;
  for (const o of objects) {
    const c = toLightSpace(o.position, frame);
    m = Math.max(m, Math.abs(c[0]) + o.radius, Math.abs(c[1]) + o.radius);
  }
  return Math.ceil((m * 2 + 2) * 2) / 2; // 含 1 单位裕量，0.5 取整
}

// 建议的 far：z 沿光传播方向，最远物体 z 最大，需 far-near >= z_max + 裕量
function suggestFar(frame, objects, near = 0.5) {
  let zMax = -Infinity;
  for (const o of objects) {
    const c = toLightSpace(o.position, frame);
    zMax = Math.max(zMax, c[2] + o.radius);
  }
  return Math.ceil(near + zMax + 2);
}

// 建议的 near：最近光源物体 z 最小，近平面在 -near，需 near >= -(z_min) + 裕量
function suggestNear(frame, objects) {
  let zMin = Infinity;
  for (const o of objects) {
    const c = toLightSpace(o.position, frame);
    zMin = Math.min(zMin, c[2] - o.radius);
  }
  return Math.max(0.5, Math.ceil((-zMin + 1) * 2) / 2);
}

function nextMapSize(current) {
  return Math.min(4096, Math.max(2048, current * 2));
}

function fmt(n) {
  return n.toFixed(5).replace(/0+$/, '').replace(/\.$/, '');
}

// ------------------------------------------------------------- 双组对比

/**
 * 对比两组诊断报告（A 为当前/基准，B 为对照）。
 * 按稳定 finding id 匹配，输出新增、消失、严重度变化，以及覆盖/清晰度指标差异。
 */
export function diffReports(reportA, reportB) {
  const mapA = new Map(reportA.findings.map((f) => [f.id, f]));
  const mapB = new Map(reportB.findings.map((f) => [f.id, f]));
  const rank = { info: 0, warn: 1, error: 2 };
  const entries = [];

  for (const [id, fb] of mapB) {
    const fa = mapA.get(id);
    if (!fa) {
      entries.push({ id, change: 'introduced', severity: fb.severity, title: fb.title, b: fb });
    } else if (rank[fb.severity] !== rank[fa.severity]) {
      entries.push({
        id,
        change: rank[fb.severity] > rank[fa.severity] ? 'worsened' : 'improved',
        severity: fb.severity,
        title: fb.title,
        a: fa,
        b: fb,
      });
    }
  }
  for (const [id, fa] of mapA) {
    if (!mapB.has(id)) {
      entries.push({ id, change: 'resolved', severity: fa.severity, title: fa.title, a: fa });
    }
  }

  const metrics = [
    {
      key: 'viewCoverage',
      label: '视野覆盖率',
      a: reportA.viewCoverage,
      b: reportB.viewCoverage,
      format: (v) => `${(v * 100).toFixed(0)}%`,
      higherBetter: true,
    },
    {
      key: 'texel',
      label: 'Texel 尺寸（越小越清晰）',
      a: reportA.texel,
      b: reportB.texel,
      format: (v) => v.toFixed(3),
      higherBetter: false,
    },
    {
      key: 'visibleUncovered',
      label: '视野内未覆盖物体',
      a: reportA.stats.visibleUncovered,
      b: reportB.stats.visibleUncovered,
      format: (v) => `${v} 个`,
      higherBetter: false,
    },
    {
      key: 'outsideFar',
      label: '远平面裁剪物体',
      a: reportA.stats.outsideFar,
      b: reportB.stats.outsideFar,
      format: (v) => `${v} 个`,
      higherBetter: false,
    },
  ];

  // 物体级状态差异
  const objDiffs = [];
  for (const ob of reportB.objectReports) {
    const oa = reportA.objectReports.find((x) => x.id === ob.id);
    if (oa && oa.state !== ob.state) {
      objDiffs.push({ id: ob.id, label: ob.label, from: oa.state, to: ob.state });
    }
  }
  return { entries, metrics, objDiffs };
}

export const STATE_LABELS = {
  inside: '覆盖区内',
  'outside-h': '超出正交范围',
  'outside-far': '超出远平面',
  'outside-near': '近平面裁剪',
};
