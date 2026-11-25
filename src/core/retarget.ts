import { Quaternion, Vector3 } from 'three';
import type { PoseFrame } from './skeleton';
import type { Skeleton } from './skeleton';
import { qToArray, vFromArray, vToArray } from './math';
import type { Quat, Vec3 } from './math';

/** 关节对应：源关节名 -> 目标关节名。root 也走同一张表 */
export type JointMapping = Record<string, string>;

export interface MappingIssue {
  kind: 'missing' | 'duplicate' | 'unknown-source' | 'unknown-target';
  source?: string;
  target?: string;
  sources?: string[];
  message: string;
}

export interface MappingValidation {
  /** 过滤掉问题项之后、仍可用于预览的对应 */
  usable: JointMapping;
  issues: MappingIssue[];
}

export function defaultMapping(source: Skeleton, target: Skeleton): JointMapping {
  const m: JointMapping = {};
  for (const name of source.jointNames) {
    if (target.has(name)) m[name] = name;
  }
  return m;
}

/** 校验：指出缺失目标、一个目标被配两次等具体关节；其余对应仍可用 */
export function validateMapping(
  source: Skeleton,
  target: Skeleton,
  mapping: JointMapping,
): MappingValidation {
  const issues: MappingIssue[] = [];
  const targetToSources = new Map<string, string[]>();
  const usable: JointMapping = {};

  for (const src of source.jointNames) {
    const tgt = mapping[src];
    if (tgt === undefined || tgt === '') {
      issues.push({
        kind: 'missing',
        source: src,
        message: `源关节「${src}」没有配置目标对应，预览时该关节保持静止`,
      });
      continue;
    }
    if (!source.has(src)) {
      issues.push({ kind: 'unknown-source', source: src, message: `未知源关节「${src}」` });
      continue;
    }
    if (!target.has(tgt)) {
      issues.push({
        kind: 'unknown-target',
        source: src,
        target: tgt,
        message: `源关节「${src}」配置的目标「${tgt}」在目标骨架中不存在`,
      });
      continue;
    }
    const list = targetToSources.get(tgt) ?? [];
    list.push(src);
    targetToSources.set(tgt, list);
  }

  for (const [tgt, sources] of targetToSources) {
    if (sources.length > 1) {
      issues.push({
        kind: 'duplicate',
        target: tgt,
        sources,
        message: `目标关节「${tgt}」被 ${sources.length} 个源关节同时配置：${sources.join('、')}，这些对应将被忽略`,
      });
    }
  }

  const duplicatedTargets = new Set(
    [...targetToSources.entries()].filter(([, v]) => v.length > 1).map(([k]) => k),
  );
  for (const [src, tgt] of Object.entries(mapping)) {
    if (target.has(tgt) && !duplicatedTargets.has(tgt)) usable[src] = tgt;
  }
  return { usable, issues };
}

export type RootMotionMode = 'height' | 'keep';

/**
 * 把源骨架的一帧重定向到目标骨架。
 *
 * 静止局部系增量共轭（每个关节独立，不依赖父关节当前姿势）：
 *   δ  = Rs_local_rest^-1 * Rs_local           源相对自身静止局部系的旋转增量
 *   M  = Rt_local_rest^-1 * Rs_local_rest      源静止局部帧 -> 目标静止局部帧
 *   δt = M * δ * M^-1                          把增量的旋转轴/角映射进目标静止局部帧
 *   Rt_local = Rt_local_rest * δt
 *
 * 静止帧 δ=I 时 δt=I，目标严格回到自身静止姿势（首帧/末帧复现的保证）。
 * 目标关节绕骨头拧 180°（左右骨局部轴相反）时，M 是绕骨头轴的 180° 旋转，
 * 共轭只翻转垂直于骨头的轴、不翻骨头轴，于是铰链弯曲角保持、世界弯曲方向一致。
 * 源 T-pose、目标 A-pose 等静止肘/膝朝向差异由静止帧吸收，不影响动作映射。
 *
 * 根平移：height 模式按身高比换算；keep 模式保持在目标静止原点。
 * 全部使用绝对量，无运行期状态，拖时间条不会累计位移。
 */
export function retargetFrame(
  source: Skeleton,
  target: Skeleton,
  mapping: JointMapping,
  srcFrame: PoseFrame,
  mode: RootMotionMode,
): PoseFrame {
  const outLocals: Record<string, Quat> = {};

  for (const [srcName, tgtName] of Object.entries(mapping)) {
    if (srcName === 'root' || !target.has(tgtName)) continue;
    const si = source.jointIndex(srcName);
    const ti = target.jointIndex(tgtName);
    const frameMap = target.restLocalRot[ti]
      .clone()
      .invert()
      .multiply(source.restLocalRot[si]);

    const srcDelta = source.restLocalRot[si].clone().invert().multiply(source.localRot[si]);
    const tgtDelta = frameMap
      .clone()
      .multiply(srcDelta)
      .multiply(frameMap.clone().invert());
    outLocals[tgtName] = qToArray(tgtDelta);
  }

  // 未参与对应的目标关节输出单位增量：显式保持静止，不依赖数据缺省
  for (let i = 1; i < target.count; i++) {
    const name = target.jointNames[i];
    if (!outLocals[name]) outLocals[name] = qToArray(new Quaternion());
  }

  const rootSrc = mapping['root'];
  let rootRot: Quaternion;
  if (rootSrc && target.has(rootSrc)) {
    // 根：保留源根相对自身静止世界系的转向增量，左乘到目标的静止世界朝向上
    const si = source.jointIndex('root');
    const ti = target.jointIndex(rootSrc);
    const rootDelta = source.restWorldRot[si].clone().invert().multiply(source.worldRot[si]);
    rootRot = target.restWorldRot[ti].clone().multiply(rootDelta);
  } else {
    rootRot = target.restWorldRot[0].clone();
  }

  const targetRootRest = target.restWorldPos[0];
  let rootPos: Vector3;
  if (mode === 'height' && rootSrc && target.has(rootSrc)) {
    const srcRest = source.restWorldPos[0];
    const srcNow = vFromArray(srcFrame.rootPos);
    const scale = target.height / source.height;
    const delta = srcNow.clone().sub(srcRest).multiplyScalar(scale);
    rootPos = targetRootRest.clone().add(delta);
  } else {
    rootPos = targetRootRest.clone();
  }

  return {
    time: srcFrame.time,
    rootPos: vToArray(rootPos),
    rootRot: qToArray(rootRot),
    locals: outLocals,
  };
}

export interface RetargetedMotion {
  format: 'paper-puppet-retarget/1';
  clipId: string;
  clipName: string;
  sourceName: string;
  targetName: string;
  mode: RootMotionMode;
  heightScale: number;
  sampleRate: number;
  duration: number;
  mapping: JointMapping;
  frames: PoseFrame[];
}

/** 整段重定向并序列化为可导出的动作数据 */
export function buildRetargetedMotion(
  source: Skeleton,
  target: Skeleton,
  mapping: JointMapping,
  clipId: string,
  clipName: string,
  frames: PoseFrame[],
  mode: RootMotionMode,
  sampleRate: number,
): RetargetedMotion {
  const out: PoseFrame[] = [];
  for (const f of frames) {
    source.applyFrame(f);
    out.push(retargetFrame(source, target, mapping, f, mode));
  }
  return {
    format: 'paper-puppet-retarget/1',
    clipId,
    clipName,
    sourceName: source.name,
    targetName: target.name,
    mode,
    heightScale: target.height / source.height,
    sampleRate,
    duration: frames.length ? frames[frames.length - 1].time : 0,
    mapping: { ...mapping },
    frames: out,
  };
}

/** 从导出数据还原姿势帧（重新打开时复现起始/中段/末帧） */
export function framesFromMotion(data: RetargetedMotion): PoseFrame[] {
  return data.frames.map((f) => ({
    time: f.time,
    rootPos: [...f.rootPos] as Vec3,
    rootRot: [...f.rootRot] as Quat,
    locals: Object.fromEntries(Object.entries(f.locals).map(([k, v]) => [k, [...v] as Quat])),
  }));
}

export function serializeMotion(data: RetargetedMotion): string {
  return JSON.stringify(data, null, 2);
}

export function parseMotion(text: string): RetargetedMotion {
  const data = JSON.parse(text) as RetargetedMotion;
  if (data.format !== 'paper-puppet-retarget/1') {
    throw new Error(`不支持的动作数据格式: ${String(data.format)}`);
  }
  if (!Array.isArray(data.frames) || data.frames.length === 0) {
    throw new Error('动作数据没有任何帧');
  }
  return data;
}

export function serializeMapping(mapping: JointMapping): string {
  return JSON.stringify(
    { format: 'paper-puppet-mapping/1', mapping },
    null,
    2,
  );
}

export function parseMapping(text: string): JointMapping {
  const data = JSON.parse(text) as { format?: string; mapping?: JointMapping };
  if (data.format !== 'paper-puppet-mapping/1' || !data.mapping) {
    throw new Error('对应关系文件格式不正确');
  }
  return data.mapping;
}
