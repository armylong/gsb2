/**
 * 与 src/physics.ts 同构的 GLSL 实现。
 * 片元着色器按 21 个波长采样积分（380–780nm，步长 20nm），
 * 读数面板用 TS 侧按 10nm 步长积分，两者公式一致、仅采样密度不同。
 */
export const THIN_FILM_GLSL = /* glsl */ `
  const float N1 = 1.0;    // 空气
  const float N2 = 1.45;   // 薄膜
  const float N3 = 2.6;    // 深色基底

  float airyR(float r12, float r23, float delta) {
    float c = cos(2.0 * delta);
    float s = sin(2.0 * delta);
    float numRe = r12 + r23 * c;
    float numIm = r23 * s;
    float denRe = 1.0 + r12 * r23 * c;
    float denIm = r12 * r23 * s;
    return (numRe * numRe + numIm * numIm) / (denRe * denRe + denIm * denIm);
  }

  // 单波长反射率；d = 0 时退化为空气-基底界面的菲涅尔反射
  float filmReflectance(float lambdaNm, float cosTheta, float d) {
    float cos1 = clamp(cosTheta, 0.02, 1.0);
    float sin1 = sqrt(1.0 - cos1 * cos1);
    float sin2 = (N1 / N2) * sin1;
    float cos2 = sqrt(max(0.0, 1.0 - sin2 * sin2));
    float sin3 = (N1 / N3) * sin1;
    float cos3 = sqrt(max(0.0, 1.0 - sin3 * sin3));

    float r12s = (N1 * cos1 - N2 * cos2) / (N1 * cos1 + N2 * cos2);
    float r12p = (N2 * cos1 - N1 * cos2) / (N2 * cos1 + N1 * cos2);
    float r23s = (N2 * cos2 - N3 * cos3) / (N2 * cos2 + N3 * cos3);
    float r23p = (N3 * cos2 - N2 * cos3) / (N3 * cos2 + N2 * cos3);

    float delta = 2.0 * 3.14159265 * N2 * d * cos2 / lambdaNm;
    return clamp(0.5 * (airyR(r12s, r23s, delta) + airyR(r12p, r23p, delta)), 0.0, 1.0);
  }

  float gfit(float l, float mu, float s1, float s2) {
    float t = (l - mu) * (l < mu ? s1 : s2);
    return exp(-0.5 * t * t);
  }

  vec3 cie1931(float l) {
    float x = 1.056 * gfit(l, 599.8, 0.0264, 0.0323)
            + 0.362 * gfit(l, 442.0, 0.0624, 0.0374)
            - 0.065 * gfit(l, 501.1, 0.0490, 0.0382);
    float y = 0.821 * gfit(l, 568.8, 0.0213, 0.0247)
            + 0.286 * gfit(l, 530.9, 0.0613, 0.0322);
    float z = 1.217 * gfit(l, 437.0, 0.0845, 0.0278)
            + 0.681 * gfit(l, 459.0, 0.0385, 0.0725);
    return vec3(x, y, z);
  }

  vec3 xyzToLinearSrgb(vec3 xyz) {
    return vec3(
       3.2406 * xyz.x - 1.5372 * xyz.y - 0.4986 * xyz.z,
      -0.9689 * xyz.x + 1.8758 * xyz.y + 0.0415 * xyz.z,
       0.0557 * xyz.x - 0.2040 * xyz.y + 1.0570 * xyz.z
    );
  }

  float linearToSrgb(float c) {
    c = clamp(c, 0.0, 1.0);
    return c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
  }

  // 视角 + 膜厚 → 显示 sRGB（已 gamma）
  vec3 filmColorSrgb(float cosTheta, float d) {
    vec3 xyz = vec3(0.0);
    float norm = 0.0;
    for (int i = 0; i < 21; i++) {
      float l = 380.0 + 20.0 * float(i);
      float r = filmReflectance(l, cosTheta, d);
      vec3 c = cie1931(l);
      xyz += r * c;
      norm += c.y;
    }
    xyz /= norm;
    vec3 rgb = xyzToLinearSrgb(xyz);
    return vec3(linearToSrgb(rgb.r), linearToSrgb(rgb.g), linearToSrgb(rgb.b));
  }
`;
