/**
 * 法线贴图 shader。切线/手性由 CPU 预计算为顶点属性传入，
 * 与 src/core/tangentSpace.ts 的数学一一对应。
 */

export const vertexShader = /* glsl */ `
  attribute vec3 tangent;
  attribute float handedness;
  attribute float degenerate;
  attribute float region;

  varying vec3 vTangent;
  varying vec3 vNormal;
  varying float vW;
  varying float vDegenerate;
  varying float vRegion;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  void main() {
    vUv = uv;
    vTangent = tangent;
    vNormal = normal;
    vW = handedness;
    vDegenerate = degenerate;
    vRegion = region;
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D normalMap;
  uniform vec3 lightPos;
  uniform float bumpScale;
  uniform float texRotDeg;   // 纹理旋转（度）
  uniform float greenFlip;   // 1 = DirectX 纵向约定（翻绿通道）
  uniform int fixMode;       // 0=全部正确 1=全部错误 2=左错右对
  uniform float showDegenerate;
  uniform float showGrid;

  varying vec3 vTangent;
  varying vec3 vNormal;
  varying float vW;
  varying float vDegenerate;
  varying float vRegion;
  varying vec2 vUv;
  varying vec3 vWorldPos;

  vec2 rotateUV(vec2 uv, float deg) {
    float r = radians(deg);
    float c = cos(r), s = sin(r);
    vec2 p = uv - 0.5;
    return vec2(0.5 + p.x * c - p.y * s, 0.5 + p.x * s + p.y * c);
  }

  void main() {
    // 1. 采样切线空间法线（程序纹理，可旋转）
    vec2 uv = rotateUV(vUv, texRotDeg);
    vec3 ts = texture2D(normalMap, fract(uv)).rgb * 2.0 - 1.0;
    ts.y = mix(ts.y, -ts.y, greenFlip); // 纵向编码约定切换
    ts.xy *= bumpScale;

    // 2. 手性处理：正确=w，错误=强制 1
    float w = vW;
    if (fixMode == 1) w = 1.0;
    else if (fixMode == 2) w = (vRegion < 0.5) ? 1.0 : vW;

    // 3. 切线空间 → 世界空间
    vec3 T = normalize(vTangent);
    vec3 N = normalize(vNormal);
    vec3 B = cross(N, T) * w;
    vec3 n = normalize(T * ts.x + B * ts.y + N * ts.z);

    // 4. 光照
    vec3 L = normalize(lightPos - vWorldPos);
    vec3 V = vec3(0.0, 0.0, 1.0);
    float diff = max(dot(n, L), 0.0);
    vec3 H = normalize(L + V);
    float spec = pow(max(dot(n, H), 0.0), 32.0) * 0.35;
    vec3 base = (vRegion < 0.5) ? vec3(0.86, 0.80, 0.70) : vec3(0.70, 0.78, 0.88);
    vec3 col = base * (0.18 + 0.82 * diff) + vec3(spec);

    // 5. 叠加：UV 网格 / 退化坐标区域标红
    if (showGrid > 0.5) {
      vec2 g = abs(fract(vUv * 8.0) - 0.5);
      float line = smoothstep(0.46, 0.5, max(g.x, g.y));
      col = mix(col, vec3(0.2, 0.9, 0.9), line * 0.35);
    }
    if (showDegenerate > 0.5 && vDegenerate > 0.5) {
      col = mix(col, vec3(1.0, 0.1, 0.1), 0.65);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;
