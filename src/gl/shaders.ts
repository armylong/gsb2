export const fullscreenVertexShader = `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

export function sceneFragmentShader(dataPass: boolean): string {
  return `#version 300 es
precision highp float;
precision highp int;

#define DATA_PASS ${dataPass ? 1 : 0}

#if DATA_PASS
layout(location = 0) out vec4 outTotal;
layout(location = 1) out vec4 outRayleigh;
layout(location = 2) out vec4 outMie;
layout(location = 3) out vec4 outSurface;
layout(location = 4) out vec4 outTransmittance;
layout(location = 5) out vec4 outDirect;
#else
out vec4 fragColor;
#endif

const int VIEW_STEPS = 44;
const int SUN_STEPS = 9;
const int RIDGE_COUNT = 2;

const float PI = 3.141592653589793;
const float PLANET_R = 6371.0;
const float ATMOSPHERE_R = 6431.0;
const float RAYLEIGH_H = 7.994;

uniform vec2 uResolution;
uniform vec3 uSunDir;
uniform vec3 uProbeDir;
uniform int uProbeEnabled;
uniform float uYaw;
uniform float uPitch;
uniform float uCameraHeight;
uniform float uTurbidity;
uniform float uRayleighOn;
uniform float uMieOn;
uniform float uExposure;
uniform int uViewMode;
uniform vec3 uMountainAlbedo;

uniform float uRidgeRadius[2];
uniform float uRidgeBase[2];
uniform float uRidgeAmp[2];
uniform float uRidgeSeed[2];

struct SceneHit {
  float t;
  int id; // 0 sky, 1 near ridge, 2 far ridge, 3 ground
  vec3 position;
  vec3 normal;
  vec3 albedo;
};

vec3 planetCenter() {
  return vec3(0.0, -PLANET_R, 0.0);
}

bool raySphere(
  vec3 ro,
  vec3 rd,
  vec3 center,
  float radius,
  out float t0,
  out float t1
) {
  vec3 oc = ro - center;
  float b = dot(oc, rd);
  float c = dot(oc, oc) - radius * radius;
  float discriminant = b * b - c;
  if (discriminant < 0.0) {
    t0 = 0.0;
    t1 = -1.0;
    return false;
  }
  float root = sqrt(max(discriminant, 0.0));
  t0 = -b - root;
  t1 = -b + root;
  return true;
}

float ridgeProfile(
  float theta,
  float baseHeight,
  float amplitude,
  float seed
) {
  float wave =
    0.50 * sin(3.0 * theta + seed) +
    0.27 * sin(7.0 * theta - seed * 1.7) +
    0.15 * sin(13.0 * theta + seed * 0.71) +
    0.08 * sin(23.0 * theta + seed * 2.13);
  return max(0.12, baseHeight + amplitude * wave);
}

SceneHit intersectScene(vec3 ro, vec3 rd) {
  SceneHit hit;
  hit.t = 1.0e30;
  hit.id = 0;
  hit.position = ro;
  hit.normal = vec3(0.0, 1.0, 0.0);
  hit.albedo = uMountainAlbedo;

  if (rd.y < -1.0e-7) {
    float tGround = -ro.y / rd.y;
    if (tGround > 0.0) {
      hit.t = tGround;
      hit.id = 3;
      hit.position = ro + rd * tGround;
      hit.normal = vec3(0.0, 1.0, 0.0);
      hit.albedo = vec3(0.135, 0.145, 0.118);
    }
  }

  float horizontalLength = length(rd.xz);
  if (horizontalLength > 1.0e-5) {
    for (int i = 0; i < RIDGE_COUNT; ++i) {
      float tRidge = uRidgeRadius[i] / horizontalLength;
      if (tRidge <= 0.0 || tRidge >= hit.t) continue;

      vec3 p = ro + rd * tRidge;
      float theta = atan(p.x, p.z);
      float topHeight = ridgeProfile(
        theta,
        uRidgeBase[i],
        uRidgeAmp[i],
        uRidgeSeed[i]
      );

      if (p.y <= topHeight) {
        float eps = 0.0035;
        float derivative =
          (ridgeProfile(theta + eps, uRidgeBase[i], uRidgeAmp[i], uRidgeSeed[i]) -
           ridgeProfile(theta - eps, uRidgeBase[i], uRidgeAmp[i], uRidgeSeed[i])) /
          (2.0 * eps);

        vec3 radial = normalize(vec3(p.x, 0.0, p.z));
        vec3 tangent = vec3(radial.z, 0.0, -radial.x);
        float tangentCoefficient = -0.55 * derivative / uRidgeRadius[i];
        vec3 normal = normalize(
          -radial * 0.90 +
          vec3(0.0, 0.55, 0.0) +
          tangent * tangentCoefficient
        );

        hit.t = tRidge;
        hit.id = i + 1;
        hit.position = p;
        hit.normal = normal;
        hit.albedo = uMountainAlbedo;
      }
    }
  }

  return hit;
}

float altitudeKm(vec3 p) {
  return max(length(p - planetCenter()) - PLANET_R, 0.0);
}

vec3 sunTransmittance(
  vec3 p,
  vec3 sunDir,
  vec3 betaR,
  vec3 betaM,
  float mieScaleHeight
) {
  float atmosphereNear, atmosphereFar;
  if (!raySphere(p, sunDir, planetCenter(), ATMOSPHERE_R, atmosphereNear, atmosphereFar)) {
    return vec3(1.0);
  }
  float marchEnd = max(atmosphereFar, 0.0);

  float planetNear, planetFar;
  if (raySphere(p, sunDir, planetCenter(), PLANET_R, planetNear, planetFar)) {
    // A positive entry root means the sun ray enters the planet.
    if (planetNear > 0.001 && planetNear < marchEnd) {
      return vec3(0.0);
    }
  }

  float opticalR = 0.0;
  float opticalM = 0.0;
  for (int i = 0; i < SUN_STEPS; ++i) {
    float u0 = float(i) / float(SUN_STEPS);
    float u1 = float(i + 1) / float(SUN_STEPS);
    // Quadratic spacing puts samples near the lit point, where haze is dense.
    float s0 = marchEnd * u0 * u0;
    float s1 = marchEnd * u1 * u1;
    float ds = max(s1 - s0, 1.0e-6);
    float sm = 0.5 * (s0 + s1);
    vec3 samplePoint = p + sunDir * sm;
    float h = altitudeKm(samplePoint);
    opticalR += exp(-h / RAYLEIGH_H) * ds;
    opticalM += exp(-h / mieScaleHeight) * ds;
  }

  return exp(-betaR * opticalR - betaM * opticalM);
}

vec3 sanitizeRadiance(vec3 value) {
  if (any(isnan(value)) || any(isinf(value))) {
    return vec3(0.0);
  }
  return clamp(value, vec3(0.0), vec3(50000.0));
}

vec3 acesFilm(vec3 x) {
  const float a = 2.51;
  const float b = 0.03;
  const float c = 2.43;
  const float d = 0.59;
  const float e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 linear = 12.92 * c;
  vec3 gamma = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(linear, gamma, step(vec3(0.0031308), c));
}

void main() {
  vec3 ro = vec3(0.0, max(uCameraHeight, 0.0005), 0.0);
  vec3 rd;

  if (uProbeEnabled == 1) {
    rd = normalize(uProbeDir);
  } else {
    vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
    float aspect = max(uResolution.x / max(uResolution.y, 1.0), 0.05);
    float pitch = uPitch;
    float yaw = uYaw;
    float cp = cos(pitch);
    float sp = sin(pitch);
    float cy = cos(yaw);
    float sy = sin(yaw);

    vec3 forward = vec3(sy * cp, sp, cy * cp);
    vec3 right = vec3(cy, 0.0, -sy);
    vec3 up = vec3(-sp * sy, cp, -sp * cy);
    float tanHalfFov = tan(19.0 * PI / 180.0);

    rd = normalize(
      forward +
      right * (ndc.x * tanHalfFov * aspect) +
      up * (ndc.y * tanHalfFov)
    );
  }

  vec3 sunDir = normalize(uSunDir);

  // Turbidity primarily increases aerosol density and the moist/hazy scale height.
  float mieMultiplier = 0.28 + 0.72 * clamp(uTurbidity, 0.0, 40.0);
  float mieScaleHeight = mix(
    1.2,
    3.8,
    clamp((uTurbidity - 1.0) / 29.0, 0.0, 1.0)
  );

  vec3 betaR = vec3(0.0058, 0.0135, 0.0331) * uRayleighOn;
  vec3 betaM = vec3(0.0048, 0.0048, 0.0048) * mieMultiplier * uMieOn;

  SceneHit sceneHit = intersectScene(ro, rd);

  float atmosphereNear, atmosphereFar;
  raySphere(ro, rd, planetCenter(), ATMOSPHERE_R, atmosphereNear, atmosphereFar);
  float endT = max(atmosphereFar, 0.0);

  if (sceneHit.id != 0) {
    endT = min(endT, sceneHit.t);
  } else {
    float planetNear, planetFar;
    if (raySphere(ro, rd, planetCenter(), PLANET_R, planetNear, planetFar)) {
      if (planetNear > 0.001 && planetNear < endT) {
        endT = planetNear;
      }
    }
  }
  endT = max(endT, 0.0005);

  float opticalR = 0.0;
  float opticalM = 0.0;
  vec3 integratedR = vec3(0.0);
  vec3 integratedM = vec3(0.0);

  for (int i = 0; i < VIEW_STEPS; ++i) {
    float u0 = float(i) / float(VIEW_STEPS);
    float u1 = float(i + 1) / float(VIEW_STEPS);
    float s0 = endT * u0 * u0;
    float s1 = endT * u1 * u1;
    float ds = max(s1 - s0, 1.0e-6);
    float sampleT = 0.5 * (s0 + s1);

    vec3 p = ro + rd * sampleT;
    float h = altitudeKm(p);
    float densityR = exp(-h / RAYLEIGH_H);
    float densityM = exp(-h / mieScaleHeight);

    float halfOpticalR = opticalR + densityR * ds * 0.5;
    float halfOpticalM = opticalM + densityM * ds * 0.5;
    vec3 viewTransmittance = exp(
      -betaR * halfOpticalR - betaM * halfOpticalM
    );
    vec3 sunT = sunTransmittance(
      p, sunDir, betaR, betaM, mieScaleHeight
    );

    integratedR += viewTransmittance * sunT * densityR * ds;
    integratedM += viewTransmittance * sunT * densityM * ds;

    opticalR += densityR * ds;
    opticalM += densityM * ds;
  }

  vec3 viewTransmittanceEnd = exp(-betaR * opticalR - betaM * opticalM);

  float mu = clamp(dot(rd, sunDir), -1.0, 1.0);
  float mu2 = mu * mu;

  // Normalized Rayleigh phase function.
  float phaseRayleigh = 3.0 / (16.0 * PI) * (1.0 + mu2);

  // Cornette-Shanks phase: retains the Rayleigh-like polarization term while
  // adding a strong forward lobe controlled by g.
  float g = 0.78;
  float g2 = g * g;
  float phaseMie =
    (3.0 / (8.0 * PI)) *
    ((1.0 - g2) * (1.0 + mu2)) /
    ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * mu, 1.0e-5), 1.5));

  const vec3 sunTint = vec3(1.0, 0.955, 0.86);
  const float sunIntensity = 18.0;

  vec3 rayleighRadiance =
    sunIntensity * sunTint * betaR * phaseRayleigh * integratedR;
  vec3 mieRadiance =
    sunIntensity * sunTint * betaM * phaseMie * integratedM;

  vec3 sunCameraT = sunTransmittance(
    ro, sunDir, betaR, betaM, mieScaleHeight
  );

  // Angular radius is about 0.27 degrees. Smooth between 0.37 and 0.25 degrees.
  float sunDisk = smoothstep(cos(0.0065), cos(0.00435), mu);
  vec3 directSkyRadiance =
    sunTint * sunIntensity * 24.0 * sunDisk * sunCameraT;

  vec3 surfaceRadiance = vec3(0.0);
  vec3 directSurfaceRadiance = vec3(0.0);

  if (sceneHit.id != 0) {
    vec3 sunSurfaceT = sunTransmittance(
      sceneHit.position, sunDir, betaR, betaM, mieScaleHeight
    );
    float nDotL = max(dot(sceneHit.normal, sunDir), 0.0);
    float dayFactor = smoothstep(-0.12, 0.55, sunDir.y);
    vec3 ambientColor = mix(
      vec3(0.045, 0.055, 0.078),
      vec3(0.155, 0.205, 0.295),
      dayFactor
    );
    float hazeAmbient = 1.0 + 0.10 * clamp(uTurbidity - 1.0, 0.0, 29.0);

    vec3 directIrradiance =
      sunTint * sunIntensity * 0.115 * sunSurfaceT * nDotL;
    directSurfaceRadiance = sceneHit.albedo * directIrradiance;
    surfaceRadiance =
      sceneHit.albedo *
      (directIrradiance + ambientColor * hazeAmbient);
  }

  vec3 totalRadiance = rayleighRadiance + mieRadiance;
  vec3 directOutput = vec3(0.0);

  if (sceneHit.id != 0) {
    totalRadiance += surfaceRadiance * viewTransmittanceEnd;
    directOutput = directSurfaceRadiance;
  } else {
    totalRadiance += directSkyRadiance;
    directOutput = directSkyRadiance;
  }

  totalRadiance = sanitizeRadiance(totalRadiance);
  rayleighRadiance = sanitizeRadiance(rayleighRadiance);
  mieRadiance = sanitizeRadiance(mieRadiance);
  surfaceRadiance = sanitizeRadiance(surfaceRadiance);
  directOutput = sanitizeRadiance(directOutput);
  viewTransmittanceEnd = clamp(viewTransmittanceEnd, vec3(0.0), vec3(1.0));

#if DATA_PASS
  outTotal = vec4(totalRadiance, sceneHit.id == 0 ? -1.0 : sceneHit.t);
  outRayleigh = vec4(rayleighRadiance, float(sceneHit.id));
  outMie = vec4(mieRadiance, 0.0);
  outSurface = vec4(surfaceRadiance, sceneHit.id == 0 ? -1.0 : sceneHit.t);
  outTransmittance = vec4(viewTransmittanceEnd, 1.0);
  outDirect = vec4(directOutput, 1.0);
#else
  vec3 selectedHdr;
  if (uViewMode == 1) {
    selectedHdr = rayleighRadiance;
  } else if (uViewMode == 2) {
    selectedHdr = mieRadiance;
  } else {
    selectedHdr = totalRadiance;
  }
  selectedHdr = sanitizeRadiance(selectedHdr);
  fragColor = vec4(linearToSrgb(acesFilm(selectedHdr * uExposure)), 1.0);
#endif
}
`;
}

export const tonemapFragmentShader = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTexture;
uniform float uExposure;
out vec4 fragColor;

vec3 acesFilm(vec3 x) {
  return clamp(
    (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14),
    0.0,
    1.0
  );
}

vec3 linearToSrgb(vec3 c) {
  c = max(c, vec3(0.0));
  vec3 linear = 12.92 * c;
  vec3 gamma = 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055;
  return mix(linear, gamma, step(vec3(0.0031308), c));
}

void main() {
  vec3 hdr = texture(uTexture, vUv).rgb;
  hdr = max(hdr, vec3(0.0));
  fragColor = vec4(linearToSrgb(acesFilm(hdr * uExposure)), 1.0);
}
`;
