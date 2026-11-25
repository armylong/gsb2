import { armTarget, eye, lerpPose, shoulder, STATION_MAP } from './layout';
import { cloneParked } from './obstacles';
import { CANONICAL_MESSAGE, SYMBOL_MAP } from './symbols';
import type {
  Cue,
  Half,
  MisreadSpec,
  PoseMap,
  ScenarioId,
  StationId,
  VisLevel,
} from './types';

export interface ScenarioDef {
  id: ScenarioId;
  name: string;
  duration: string;
  tagline: string;
  description: string;
  question: string;
  targetText: string;
  cues: Cue[];
  sequences: Record<StationId, string[]>;
  /** cueId -> 该拍各观测台应记录的能见度（验收用） */
  expectations: Record<string, Partial<Record<StationId, VisLevel>>>;
  guide: string[];
}

type Effect =
  | {
      op: 'blockArm';
      observer: StationId;
      arm: 0 | 1;
      half: Half | 'both';
      obstacle?: string;
      t?: number;
    }
  | { op: 'coverSender'; half: Half | 'both'; obstacle?: string };

interface CueSpec {
  beatIndex: number;
  txId?: string;
  sender?: StationId;
  symbolId: string;
  kind?: Cue['kind'];
  assign?: Cue['assign'];
  note?: string;
  tag?: string;
  effects?: Effect[];
  misreads?: MisreadSpec[];
}

function applyEffects(
  layouts: [PoseMap, PoseMap],
  sender: StationId,
  symbolId: string,
  effects: Effect[],
) {
  const sym = SYMBOL_MAP[symbolId];
  for (const e of effects) {
    const halves: Half[] = e.half === 'both' ? [0, 1] : [e.half];
    for (const h of halves) {
      if (e.op === 'coverSender') {
        layouts[h][e.obstacle ?? 'veil'] = { ...shoulder(sender) };
      } else {
        const trueDir = sym.pair[e.arm];
        const target = armTarget(sender, trueDir);
        const t = e.t ?? 0.8;
        const pose = lerpPose(eye(e.observer), target, t);
        layouts[h][e.obstacle ?? 'shield'] = pose;
      }
    }
  }
}

function buildCues(scenarioId: string, specs: CueSpec[]): Cue[] {
  return specs.map((spec, i) => {
    const layouts: [PoseMap, PoseMap] = [cloneParked(), cloneParked()];
    const sender = spec.sender ?? 'north';
    if (spec.effects) applyEffects(layouts, sender, spec.symbolId, spec.effects);
    return {
      id: `${scenarioId}-c${i}`,
      txId: spec.txId ?? 'tx-origin',
      stepIndex: i,
      beatIndex: spec.beatIndex,
      sender,
      symbolId: spec.symbolId,
      kind: spec.kind ?? 'origin',
      assign: spec.assign,
      layouts,
      misreads: spec.misreads,
      note: spec.note,
      tag: spec.tag,
    } satisfies Cue;
  });
}

const OWN_SEQUENCES: Record<StationId, string[]> = {
  north: [...CANONICAL_MESSAGE],
  // 1+2+3+4 = 10 -> 0
  west: ['start', 'd1', 'd2', 'd3', 'd4', 'c0', 'end'],
  // 7+6+5+4 = 22 -> 2
  east: ['start', 'd7', 'd6', 'd5', 'd4', 'c2', 'end'],
};

const stationNames = Object.fromEntries(
  (Object.keys(STATION_MAP) as StationId[]).map((id) => [id, STATION_MAP[id].name]),
) as Record<StationId, string>;

export { stationNames };

// ---------------- 剧本一：完整 ----------------

function clearScenario(): ScenarioDef {
  const specs: CueSpec[] = CANONICAL_MESSAGE.map((symbolId, beatIndex) => ({
    beatIndex,
    symbolId,
    note: ['开头「启」', '数据 风', '数据 山', '数据 月', '数据 关', '复核数 6', '结尾「止」'][
      beatIndex
    ],
  }));
  const cues = buildCues('clear', specs);
  const expectations: ScenarioDef['expectations'] = {};
  for (const c of cues) expectations[c.id] = { west: 'both', east: 'both' };
  return {
    id: 'clear',
    name: '剧本一 · 全程清楚',
    duration: '7 拍',
    tagline: '两山视线均无遮挡，用于对照基线',
    description:
      '北岭台完整打出「启 风 山 月 关 6 止」。西坡、东崖两台每一拍都应记录「两面同清」，宽松与严格规则结果一致。',
    question: '基线：没有遮挡时，界面收条与最终消息必须完全一致。',
    targetText: '启 风 山 月 关 6 止',
    cues,
    sequences: { ...OWN_SEQUENCES, north: [...CANONICAL_MESSAGE] },
    expectations,
    guide: [
      '逐拍推进，观察西 / 东两张收条每拍都是绿色「双清」。',
      '走到第 7 拍后打开「译码 / 裁决」，应直接解出目标消息。',
      '复核通过后签收，得 100 分。',
    ],
  };
}

// ---------------- 剧本二：半拍遮挡 ----------------

function halfScenario(): ScenarioDef {
  const MSG = 'frame:tx-origin:0';
  const specs: CueSpec[] = [
    { beatIndex: 0, symbolId: 'start', note: '开头「启」，全场清楚' },
    {
      beatIndex: 1,
      symbolId: 'd0',
      note: '皮盾在西坡视线 80% 处遮住青旗，整拍只见朱旗',
      effects: [
        { op: 'blockArm', observer: 'west', arm: 1, half: 'both' },
      ],
    },
    {
      beatIndex: 2,
      symbolId: 'd3',
      note: '大雾只盖前半拍，后半拍两面同清：严格 / 宽松都可认',
      effects: [{ op: 'coverSender', half: 0 }],
    },
    {
      beatIndex: 3,
      symbolId: 'd7',
      note: '云在前半拍遮朱旗、后半拍遮青旗：宽松可拼出「月」，严格不拼',
      effects: [
        { op: 'blockArm', observer: 'west', arm: 0, half: 0, obstacle: 'shield' },
        { op: 'blockArm', observer: 'west', arm: 1, half: 1, obstacle: 'shield' },
      ],
    },
    {
      beatIndex: 4,
      symbolId: 'd6',
      note: '雾幕整拍罩住旗台，两台全遮：此槽留缺，等待补发',
      effects: [{ op: 'coverSender', half: 'both' }],
    },
    { beatIndex: 5, symbolId: 'c6', note: '复核数 6，清楚' },
    { beatIndex: 6, symbolId: 'end', note: '结尾「止」，第一帧收口' },
    {
      beatIndex: 7,
      symbolId: 'start',
      tag: '下一条开头',
      note: '北岭台已开始打下一条，这个「启」必须另开一帧，不能挪去补第 5 拍',
    },
    { beatIndex: 8, symbolId: 'd2', tag: '下一条第 2 拍', note: '下一条的数据符，与旧条无关' },
    {
      beatIndex: 0,
      txId: 'tx-resend-s4',
      symbolId: 'd6',
      kind: 'resend',
      assign: { msgId: MSG, slot: 4 },
      note: '原发台申报：这是原消息第 5 拍「关」的补发，直接入旧条第 5 槽',
    },
  ];
  const cues = buildCues('half', specs);
  const expectations: ScenarioDef['expectations'] = {
    'half-c0': { west: 'both', east: 'both' },
    'half-c1': { west: 'one', east: 'both' },
    'half-c2': { west: 'both', east: 'both' },
    'half-c3': { west: 'stitch', east: 'both' },
    'half-c4': { west: 'none', east: 'none' },
    'half-c5': { west: 'both', east: 'both' },
    'half-c6': { west: 'both', east: 'both' },
    'half-c7': { west: 'both', east: 'both' },
    'half-c8': { west: 'both', east: 'both' },
    'half-c9': { west: 'both', east: 'both' },
  };
  return {
    id: 'half',
    name: '剧本二 · 半拍遮挡与补发',
    duration: '9 + 1 补发拍',
    tagline: '只见一面、分半拼见、全没看见一次试全',
    description:
      '同一消息中：第 2 拍西台只见一旗；第 3 拍大雾只盖前半拍（后半拍双清，可认）；第 4 拍两台遭遇「半拍各遮一旗」的拼合陷阱；第 5 拍整拍全遮，必须留缺。随后下一条的「启」到来，最后原发台申报补发第 5 拍。',
    question:
      '旗子被遮半拍之后还该不该认出整条消息？——后半拍双清则该认；两半各见一旗时，宽松规则拼认、严格规则留缺，可切换对比。',
    targetText: '启 风 山 月 关 6 止',
    cues,
    sequences: {
      ...OWN_SEQUENCES,
      north: [...CANONICAL_MESSAGE, 'start', 'd2'],
    },
    expectations,
    guide: [
      '走到第 2 拍，西台收条是「单旗」，东台仍是「双清」。',
      '第 4 拍（月）西台为紫色「分半拼见」：切换宽松 / 严格规则看其判读变化。',
      '第 5 拍（关）两台全遮，译码板该槽留缺；继续走到下一条的「启」，它会另开一帧而不是补旧槽。',
      '走完最后的补发拍，旧消息复核通过。',
    ],
  };
}

// ---------------- 剧本三：重复转发 + 来源冲突 ----------------

function forwardScenario(): ScenarioDef {
  const MSG = 'frame:tx-origin:0';
  const originSpecs: CueSpec[] = CANONICAL_MESSAGE.map((symbolId, beatIndex) => {
    const spec: CueSpec = { beatIndex, symbolId };
    if (beatIndex === 3) {
      spec.note = '西台视线有云气擦过旗角，误把朱旗的右上看成正上';
      spec.misreads = [
        {
          observer: 'west',
          arm: 0,
          recordedDir: 0,
          note: '云气折光：右上 → 正上',
        },
      ];
    }
    return spec;
  });

  const fwdSpecs: CueSpec[] = CANONICAL_MESSAGE.map((symbolId, slot) => ({
    txId: 'tx-fwd-east',
    beatIndex: slot,
    sender: 'east',
    symbolId,
    kind: 'forward',
    assign: { msgId: MSG, slot },
    note: `东崖台从另一处转发第 ${slot + 1} 拍`,
  }));

  const cues = buildCues('fwd', [...originSpecs, ...fwdSpecs]);
  // 转发拍的 id 是 fwd-c7..fwd-c13（buildCues 用总下标）
  const expectations: ScenarioDef['expectations'] = {
    'fwd-c3': { west: 'both', east: 'both' }, // 几何上两面都可见，西台是「记错」而非没看见
  };
  for (let i = 0; i < 7; i++) expectations[`fwd-c${i}`] = { west: 'both', east: 'both' };
  for (let i = 7; i < 14; i++) {
    expectations[`fwd-c${i}`] = { west: 'both', north: 'both' };
  }

  return {
    id: 'forward',
    name: '剧本三 · 异台转发与冲突裁决',
    duration: '7 原发 + 7 转发',
    tagline: '重复签收不加分；两份收条冲突时翻看原收条人工选择',
    description:
      '北岭台原发时，西坡台把「月」误记成「林」，东台记录正确。随后东崖台从另一处全文转发同一消息，转发件与东台收条一致。译码板在第 4 槽给出冲突，可打开两份原收条逐半拍比对并人工采信。',
    question: '两个来源内容冲突时怎么办？——系统不替你猜：调出原收条，人工选择；选错复核码会拦下。',
    targetText: '启 风 山 月 关 6 止',
    cues,
    sequences: { ...OWN_SEQUENCES, east: [...CANONICAL_MESSAGE] },
    expectations,
    guide: [
      '走完原发 7 拍，译码板第 4 槽出现红色「来源冲突」。',
      '点击冲突槽打开原收条：西台写「林」且有误判备注，东台写「月」。',
      '人工采信东台（或东崖转发件）后复核通过、签收 +100。',
      '再点一次「签收 / 复核」验证同一消息重复收到得 0 分。',
    ],
  };
}

export const SCENARIOS: Record<ScenarioId, ScenarioDef> = {
  clear: clearScenario(),
  half: halfScenario(),
  forward: forwardScenario(),
};

export const SCENARIO_ORDER: ScenarioId[] = ['clear', 'half', 'forward'];
