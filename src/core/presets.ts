import { PRESETS, getModel, type ModelPreset } from './generators';
import { buildThickenedSolid } from './thickening';
import type { ValidationReport } from './types';

export interface PresetResult {
  preset: ModelPreset;
  valid: boolean;
  matchesExpectation: boolean;
  closed: boolean;
  manifold: boolean;
  foldedTriangles: number;
  intersectionTotal: number;
  problemWalls: number;
  summary: string;
}

export interface PresetCheckReport {
  pass: boolean;
  results: PresetResult[];
  messages: string[];
}

/**
 * 内置验证参数自检: 逐个跑 PRESETS, 核对"有效/无效"与预期一致。
 * 这组参数既用作 UI 快捷按钮, 也用作回归门槛。
 */
export function runPresetCheck(): PresetCheckReport {
  const results: PresetResult[] = [];
  for (const preset of PRESETS) {
    const model = getModel(preset.modelId);
    const solid = buildThickenedSolid(model, { thickness: preset.thickness, side: preset.side });
    const validation: ValidationReport = solid.validation;
    const problemWalls = solid.sideWalls.filter((wall) => wall.problem).length;
    results.push({
      preset,
      valid: validation.valid,
      matchesExpectation: validation.valid === preset.expectValid,
      closed: validation.topology.closed,
      manifold: validation.topology.manifold,
      foldedTriangles: validation.foldedOffsetTriangles.length,
      intersectionTotal: validation.intersectionTotal,
      problemWalls,
      summary: validation.valid
        ? '闭合、流形、无自相交'
        : validation.messages[0] ?? '存在几何问题',
    });
  }
  const failed = results.filter((result) => !result.matchesExpectation);
  const messages: string[] = [];
  if (failed.length === 0) {
    messages.push(`全部 ${results.length} 组预设符合预期。`);
  } else {
    for (const result of failed) {
      messages.push(
        `${result.preset.label}: 预期${result.preset.expectValid ? '有效' : '无效'}, 实际${result.valid ? '有效' : '无效'}`,
      );
    }
  }
  return { pass: failed.length === 0, results, messages };
}
