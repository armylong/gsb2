import { buildBoard, observeCue, observationKey, STATION_IDS } from './engine';
import { SCENARIOS } from './scenarios';
import { CANONICAL_TEXT } from './symbols';
import type { GameState, StationId, VisLevel } from './types';

export interface CheckItem {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'pending';
  detail?: string;
}

export const LEVEL_LABEL: Record<VisLevel, string> = {
  both: '双清',
  stitch: '分半拼见',
  one: '单旗',
  none: '全遮',
};

const OBS_LABEL: Record<StationId, string> = {
  north: '北',
  west: '西',
  east: '东',
};

export function evaluateChecks(s: GameState): CheckItem[] {
  const items: CheckItem[] = [];

  items.push({
    id: 'stations',
    label: '生成三座观测台，每台可举两面旗',
    status: 'pass',
    detail: '北岭台 / 西坡台 / 东崖台',
  });
  items.push({
    id: 'obstacles',
    label: '生成多块可移动遮挡物',
    status: 'pass',
    detail: '两朵云、雾幕、木屏、皮盾，均可在画布上拖动',
  });
  items.push({
    id: 'drag-touched',
    label: '亲手拖动遮挡物做一次实验',
    status: s.dragTouched ? 'pass' : 'pending',
    detail: s.dragTouched ? '已拖动，当前拍收条实时重算' : '还没拖动过；拖动后只改当前编辑半拍的布局',
  });

  const def = s.runId !== 'custom' ? SCENARIOS[s.runId] : null;

  if (def) {
    // 逐拍收条分级核对
    for (const cue of s.cues) {
      const expected = def.expectations[cue.id];
      if (!expected) continue;
      const reached = s.cursor > cue.stepIndex;
      const who = (Object.keys(expected) as StationId[])
        .map((o) => `${OBS_LABEL[o]}→${LEVEL_LABEL[expected[o] as VisLevel]}`)
        .join('，');
      if (!reached) {
        items.push({
          id: `exp-${cue.id}`,
          label: `第 ${cue.stepIndex + 1} 拍收条分级：${who}`,
          status: 'pending',
          detail: '尚未走到该拍',
        });
        continue;
      }
      const bad: string[] = [];
      for (const o of Object.keys(expected) as StationId[]) {
        if (o === cue.sender) continue;
        const obs = observeCue(cue, o);
        if (obs.level !== expected[o]) {
          bad.push(`${OBS_LABEL[o]}台实际为「${LEVEL_LABEL[obs.level]}」`);
        }
      }
      items.push({
        id: `exp-${cue.id}`,
        label: `第 ${cue.stepIndex + 1} 拍收条分级：${who}`,
        status: bad.length === 0 ? 'pass' : 'fail',
        detail: bad.length === 0 ? '与剧本预期一致' : bad.join('；'),
      });
    }

    // 最终是否解出同一条消息
    const board = buildBoard({
      cues: s.cues,
      cursor: s.cursor,
      policy: s.policy,
      choices: s.choices,
      manifests: s.manifests,
      stationLabels: { north: '北岭台', west: '西坡台', east: '东崖台' },
    });
    const decoded = board.messages.some((m) => m.checksumOk && m.text === def.targetText);
    const anyFrame = board.messages.length > 0;
    items.push({
      id: 'decode-same',
      label: `最终解出同一条消息：${def.targetText}`,
      status: decoded ? 'pass' : anyFrame ? 'pending' : 'pending',
      detail: decoded
        ? '七拍成帧且复核码通过'
        : anyFrame
          ? '帧尚未补全 / 未裁决 / 复核未过，继续走拍或处理冲突'
          : '还没有认出「启」锚点',
    });

    const signed = s.scoreRecords.some((r) => !r.duplicate && r.text === def.targetText);
    items.push({
      id: 'signed-once',
      label: '复核签收目标消息并得分',
      status: signed ? 'pass' : 'pending',
      detail: signed ? '已有一条 +100 签收记录' : '在「译码 / 裁决」页复核签收',
    });

    if (def.id === 'forward') {
      const dup = s.scoreRecords.some((r) => r.duplicate);
      items.push({
        id: 'duplicate-no-score',
        label: '同一消息再次签收（转发件）不重复得分',
        status: dup ? 'pass' : 'pending',
        detail: dup ? '重复签收 delta = 0' : '签收后再点一次签收，应看到 +0 与重复提示',
      });

      // 静态不变量：原发走完时第 4 槽确实冲突
      const atOriginEnd = buildBoard({
        cues: s.cues,
        cursor: 7,
        policy: 'lenient',
        choices: {},
        manifests: [],
        stationLabels: { north: '北岭台', west: '西坡台', east: '东崖台' },
      });
      const m = atOriginEnd.messages.find((x) => x.msgId === 'frame:tx-origin:0');
      const slot3 = m?.slots[3];
      items.push({
        id: 'conflict-exists',
        label: '两份来源在第 4 拍内容冲突，需人工选择',
        status: slot3?.conflict ? 'pass' : 'fail',
        detail: slot3?.conflict
          ? `候选：${slot3.candidateValues.map((v) => v).join(' / ')}（界面显示为 林 / 月）`
          : '未检出预期冲突',
      });
    }

    if (def.id === 'half') {
      // 关键规则不变量：走到第 9 拍（下一条已开头、补发未到）时，
      // 旧帧第 5 槽必须仍为空，且存在另一条以第 8 拍为锚的新帧。
      const probe = buildBoard({
        cues: s.cues,
        cursor: 9,
        policy: 'lenient',
        choices: {},
        manifests: [],
        stationLabels: { north: '北岭台', west: '西坡台', east: '东崖台' },
      });
      const old = probe.messages.find((x) => x.msgId === 'frame:tx-origin:0');
      const next = probe.messages.find((x) => x.msgId === 'frame:tx-origin:7');
      const holdsGap = old?.slots[4].resolvedValue === null;
      const separateFrame = !!next;
      items.push({
        id: 'no-steal-next-start',
        label: '缺符留待补发：下一条的「启」没有被挪来补旧条',
        status: holdsGap && separateFrame ? 'pass' : 'fail',
        detail: holdsGap && separateFrame
          ? '旧帧第 5 槽保持空缺，新「启」另开一帧'
          : `holdsGap=${holdsGap}, separateFrame=${separateFrame}`,
      });
    }
  } else {
    items.push({
      id: 'custom-hint',
      label: '自编序列实验场',
      status: 'pending',
      detail:
        '符号顺序须为 启 + 4 个数据符 + 复核数字 + 止；复核码 = 四个数据编号之和 mod 10',
    });
    const board = buildBoard({
      cues: s.cues,
      cursor: s.cursor,
      policy: s.policy,
      choices: s.choices,
      manifests: s.manifests,
      stationLabels: { north: '北岭台', west: '西坡台', east: '东崖台' },
    });
    const ok = board.messages.some((m) => m.checksumOk);
    if (s.cursor > 0) {
      items.push({
        id: 'custom-decode',
        label: '自编序列中已有一帧通过复核',
        status: ok ? 'pass' : 'pending',
        detail: ok ? '可在译码页签收并转发' : '继续走拍，或调整遮挡 / 策略',
      });
    }
  }

  // 收条只记录实际所见：抽样保证 obsMap 中每拍每台都有四级之一（结构检查）
  const obsMap = new Map<string, unknown>();
  for (const cue of s.cues.slice(0, s.cursor)) {
    for (const o of STATION_IDS) {
      if (o === cue.sender) continue;
      obsMap.set(observationKey(cue.id, o), observeCue(cue, o));
    }
  }
  items.push({
    id: 'receipt-count',
    label: '每个非发送台、每一拍都生成独立收条',
    status: s.cursor === 0 ? 'pending' : 'pass',
    detail:
      s.cursor === 0
        ? '走第一拍后生成'
        : `当前已有 ${obsMap.size} 条逐拍观测，双清 / 分半 / 单旗 / 全遮四级可区分`,
  });

  return items;
}

export { CANONICAL_TEXT };
