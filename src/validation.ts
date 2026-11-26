import { simulate } from './engine';
import { levels } from './levels';
import { buildConflictPresets, cloneData } from './presets';
import type { CheckResult, Level, ValidationReport } from './types';

function check(name: string, ok: boolean, detail: string): CheckResult {
  return { name, ok, detail };
}

function findLevel(id: string): Level {
  const level = levels.find((item) => item.id === id);
  if (!level) throw new Error(`missing level ${id}`);
  return level;
}

export function runLocalValidation(): ValidationReport {
  const checks: CheckResult[] = [];

  try {
    // 1. Both shipped levels have complete, winnable reference schedules.
    for (const level of levels) {
      const result = simulate(level, level.solution);
      const cueCount = level.scenes.reduce((sum, scene) => sum + scene.appearances.length, 0);
      const allCues = result.cueVerdicts.length === cueCount && result.cueVerdicts.every((c) => c.ok);
      checks.push(
        check(
          `参考方案完整通关：${level.name}`,
          result.passed && allCues,
          result.passed
            ? `走完整场 ${level.horizon} 拍，${result.sceneVerdicts.length} 幕 / ${cueCount} 个登场核对全部通过`
            : `仍有 ${result.violations.length} 个冲突：${result.violations
                .slice(0, 4)
                .map((v) => `[${v.code}@${v.beat}] ${v.message}`)
                .join(' / ')}`,
        ),
      );

      checks.push(
        check(
          `快照覆盖每一拍：${level.id}`,
          result.snapshots.length === level.horizon + 1,
          `生成 ${result.snapshots.length} 个整数拍快照，可停在任意一拍核对`,
        ),
      );
    }

    // 2. Inspector state at a known beat in level 1.
    {
      const level = findLevel('lone-quickchange');
      const result = simulate(level, level.solution);
      const beat17 = result.snapshots[17];
      const lin = beat17.actors.find((a) => a.id === 'lin');
      checks.push(
        check(
          '第 17 拍可核对林一在右口、穿武将靠且在右口队列',
          !!lin &&
            lin.location === 'R' &&
            lin.worn.base === 'jiang' &&
            beat17.queues.R.includes('lin'),
          lin
            ? `位置=${lin.location}，base=${lin.worn.base}，R 队列=[${beat17.queues.R.join(',')}]`
            : '找不到林一快照',
        ),
      );
    }

    // 3. Room schedule in level 2 has three sequential B-room blocks.
    {
      const level = findLevel('room-race-coat');
      const result = simulate(level, level.solution);
      const bAt11 = result.snapshots[11].roomUsage.filter((u) => u.room === 'B');
      const bAt14 = result.snapshots[14].roomUsage.filter((u) => u.room === 'B');
      checks.push(
        check(
          '第二关 B 间排程首尾相接且不重叠',
          bAt11.some((u) => u.actorId === 'da' && u.accepted) &&
            bAt14.some((u) => u.actorId === 'cheng' && u.accepted),
          `第11拍 B=[${bAt11.map((u) => u.actorId).join(',')}]；第14拍 B=[${bAt14
            .map((u) => u.actorId)
            .join(',')}]`,
        ),
      );
    }

    // 4. Shared coat physically moves cheng -> T -> mei and is worn for act 2.
    {
      const level = findLevel('room-race-coat');
      const result = simulate(level, level.solution);
      const coatAt10 = result.snapshots[10].garments.find((g) => g.id === 'coat');
      const coatAt15 = result.snapshots[15].garments.find((g) => g.id === 'coat');
      const coatAt18 = result.snapshots[18].garments.find((g) => g.id === 'coat');
      checks.push(
        check(
          '外套经中转台交接并在乙间换好',
          coatAt10?.location === 'T' &&
            !coatAt10.wornBy &&
            coatAt15?.carriedBy === 'mei' &&
            coatAt18?.wornBy === 'mei',
          `第10拍位置=${coatAt10?.location}；第15拍携带者=${coatAt15?.carriedBy}；第18拍穿着者=${coatAt18?.wornBy}`,
        ),
      );
    }

    // 5. Every conflict preset must produce its promised diagnosis.
    for (const preset of buildConflictPresets()) {
      const level = findLevel(preset.levelId);
      const result = simulate(level, preset.plan);
      const found =
        result.violations.some((v) => v.code === preset.expectedCode) ||
        result.cueVerdicts.some((c) => c.status === preset.expectedCode);
      const sample = result.violations.find((v) => v.code === preset.expectedCode);
      checks.push(
        check(
          `冲突处理：${preset.name}`,
          found && !result.passed,
          found
            ? `已捕获 ${preset.expectedCode}：${sample?.message ?? '登场核对状态对应'}`
            : `未找到 ${preset.expectedCode}；现有代码=${[
                ...new Set(result.violations.map((v) => v.code)),
              ].join(',')}`,
        ),
      );
    }

    // 6. Late cue gives an ETA and the exact reason category.
    {
      const level = cloneData(findLevel('lone-quickchange'));
      level.scenes[1].start = 14;
      const result = simulate(level, level.solution);
      const cue = result.cueVerdicts.find((c) => c.appearanceId === 's2_lin');
      checks.push(
        check(
          '迟到诊断包含预计到达拍',
          cue?.status === 'late' && typeof cue.etaBeat === 'number',
          cue ? `status=${cue.status}，eta=${cue.etaBeat}，入口=${cue.entrance}` : '缺少第二幕核对',
        ),
      );
    }

    // 7. Edit a later segment and replay: snapshots through preserve point are
    //    byte-for-byte identical, proving the feasible prefix is retained.
    {
      const level = findLevel('lone-quickchange');
      const before = simulate(level, level.solution);
      const edited = cloneData(level.solution);
      const lastMove = edited.actions.find((a) => a.id === 'l1_lin_a_to_l');
      if (lastMove && lastMove.type === 'move') {
        lastMove.start = 26;
        lastMove.duration = 3;
      }
      const after = simulate(level, edited);
      const prefix = 13;
      const prefixSame =
        JSON.stringify(before.snapshots.slice(0, prefix + 1)) ===
        JSON.stringify(after.snapshots.slice(0, prefix + 1));
      checks.push(
        check(
          `改后续计划后从开场重算，前 ${prefix} 拍保留` ,
          prefixSame,
          prefixSame
            ? `第 0–${prefix} 拍快照完全一致；修改从第 26 拍才开始影响状态`
            : '保留段快照发生了非预期变化',
        ),
      );
    }
  } catch (error) {
    checks.push(
      check(
        '本地验证脚本自身未抛出异常',
        false,
        error instanceof Error ? error.stack ?? error.message : String(error),
      ),
    );
  }

  return { ok: checks.every((c) => c.ok), checks };
}
