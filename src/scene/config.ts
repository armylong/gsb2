export type Vec3 = [number, number, number];

export interface RidgeSpec {
  id: 1 | 2;
  name: string;
  /** Cylindrical radius in kilometres around the observer. */
  radiusKm: number;
  baseKm: number;
  amplitudeKm: number;
  seed: number;
}

export interface SceneParams {
  /** Sun centre elevation above the astronomical horizon, degrees. */
  sunElevationDeg: number;
  /** Camera/eye altitude above ground, metres in the UI. */
  cameraHeightKm: number;
  /** Camera pitch, degrees. Positive looks upward. */
  viewPitchDeg: number;
  /** Camera yaw, degrees. Zero looks toward +Z/sun azimuth. */
  yawDeg: number;
  /** Linear turbidity/haze multiplier. 1 = exceptionally clear. */
  turbidity: number;
  rayleighEnabled: boolean;
  mieEnabled: boolean;
  autoExposure: boolean;
  /** Exposure value in stops; linear scale = 2**ev. */
  exposureEv: number;
}

export interface CpuHit {
  id: 0 | 1 | 2 | 3;
  label: string;
  distanceKm: number;
  point: Vec3;
}

export interface GpuReadout {
  total: Vec3;
  rayleigh: Vec3;
  mie: Vec3;
  surface: Vec3;
  transmittance: Vec3;
  direct: Vec3;
  hitId: number;
  distanceKm: number;
}

export const RIDGES: readonly RidgeSpec[] = [
  {
    id: 1,
    name: '近山脊',
    radiusKm: 8,
    baseKm: 0.34,
    amplitudeKm: 0.3,
    seed: 1.7,
  },
  {
    id: 2,
    name: '远山脊',
    radiusKm: 22,
    baseKm: 1.45,
    amplitudeKm: 0.66,
    seed: 4.4,
  },
] as const;

/** Sun is fixed at this world azimuth relative to the initial camera. */
export const SUN_AZIMUTH_RAD = 0.18;
export const VERTICAL_FOV_DEG = 38;
export const MOUNTAIN_ALBEDO: Vec3 = [0.235, 0.205, 0.178];

export const PRESETS = {
  noon: {
    label: '正午',
    sunElevationDeg: 61,
    cameraHeightKm: 0.01,
    viewPitchDeg: 4.2,
    yawDeg: 0,
    turbidity: 2.1,
  },
  lowSun: {
    label: '低太阳',
    sunElevationDeg: 3.6,
    cameraHeightKm: 0.01,
    viewPitchDeg: 2.8,
    yawDeg: 0,
    turbidity: 3.2,
  },
  extreme: {
    label: '极端浑浊自检',
    sunElevationDeg: -2.5,
    cameraHeightKm: 0.002,
    viewPitchDeg: -1.5,
    yawDeg: 0,
    turbidity: 30,
  },
} as const;

export const DEFAULT_PARAMS: SceneParams = {
  ...PRESETS.lowSun,
  rayleighEnabled: true,
  mieEnabled: true,
  autoExposure: false,
  exposureEv: -0.9,
};
