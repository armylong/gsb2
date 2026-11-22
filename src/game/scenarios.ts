import type { Scenario, ScenarioRound, Specimen } from './types';

function specimen(
  id: string,
  name: string,
  glyph: string,
  category: Specimen['category'],
  value: number,
  note: string,
): Specimen {
  return { id, name, glyph, category, value, note };
}

/**
 * 回合 1 — 首选相撞。
 * 赤陶队与青玉队首选同一件；赤陶位次靠前拿到，青玉按备用递给玉璧。
 */
const roundOne: ScenarioRound = {
  title: '首选相撞',
  brief: '赤陶队与青玉队都盯上了同一件素面陶罐。优先顺序 赤陶 → 青玉 → 鎏金，先手直接拿走，青玉改用备用。',
  table: [
    specimen('r1-pot', '素面陶罐', '罐', '陶器', 4, '器形完整，口沿一处磕缺。'),
    specimen('r1-dou', '绳纹陶豆', '豆', '陶器', 3, '高柄浅盘，纹样清晰。'),
    specimen('r1-bi', '玉璧残片', '璧', '玉器', 5, '青碧色，仅余三分之一。'),
    specimen('r1-bone', '刻符骨针', '针', '骨器', 3, '针身有七道刻符。'),
    specimen('r1-slip', '残卷简', '简', '简牍', 4, '字迹漫漶，可辨数字。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'r1-pot', backup: 'r1-dou' },
    blue: { primary: 'r1-pot', backup: 'r1-bi' },
    gold: { primary: 'r1-bone', backup: 'r1-slip' },
  },
};

/**
 * 回合 2 — 备用再撞。
 * 三队首选同一件，青玉队先手拿走；鎏金队与赤陶队的备用又是同一件，
 * 鎏金位次靠前拿到，赤陶两手落空 (备用已被别人拿走)。
 */
const roundTwo: ScenarioRound = {
  title: '备用再撞',
  brief: '三队首选都压在同一件青玉琮上。青玉队先手拿到后，鎏金队与赤陶队的备用又撞在一起——鎏金位次在前，赤陶两手落空。',
  table: [
    specimen('r2-cong', '青玉琮', '琮', '玉器', 6, '外方内圆，四角刻简化兽面。'),
    specimen('r2-pot', '朱绘陶壶', '壶', '陶器', 5, '颈腹交界处有朱色云纹。'),
    specimen('r2-shell', '龟甲卜辞', '甲', '骨器', 4, '存卜辞两条，灼痕明显。'),
    specimen('r2-slip', '律令残简', '律', '简牍', 5, '可辨「盗」字与两行条文。'),
    specimen('r2-arrow', '铜镞', '镞', '骨器', 3, '三棱有銎，锈蚀较重。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'r2-cong', backup: 'r2-pot' },
    blue: { primary: 'r2-cong', backup: 'r2-shell' },
    gold: { primary: 'r2-cong', backup: 'r2-pot' },
  },
};

/**
 * 回合 3 — 没有合适备选。
 * 鎏金队与青玉队首选同一件；鎏金先手拿到，青玉没有提交备用，
 * 记录为「没有合适备选」，与「备选已被别人拿走」区分开。
 */
const roundThree: ScenarioRound = {
  title: '毫无后备',
  brief: '鎏金队与青玉队首选同一件卜骨。鎏金先手拿走，青玉队没有提交备用——这一手记为「没有合适备选」。',
  table: [
    specimen('r3-yue', '青玉钺', '钺', '玉器', 5, '刃部抛光，孔壁有旋痕。'),
    specimen('r3-gui', '白陶鬶', '鬶', '陶器', 4, '袋足三只，流口残缺。'),
    specimen('r3-bone', '卜骨', '卜', '骨器', 5, '牛肩胛骨，钻凿并施灼。'),
    specimen('r3-slip', '医书简', '医', '简牍', 6, '记三方剂，字迹工整。'),
    specimen('r3-pin', '骨簪', '簪', '骨器', 2, '簪首作鸟形，尾部断裂。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'r3-slip', backup: 'r3-gui' },
    blue: { primary: 'r3-bone', backup: null },
    gold: { primary: 'r3-bone', backup: 'r3-yue' },
  },
};

/**
 * 回合 4 — 铺成套。三队各取一件，互不相撞，为末轮平分埋下伏笔。
 */
const roundFour: ScenarioRound = {
  title: '铺陈成套',
  brief: '三队分别补齐自己的品类：赤陶补陶器，青玉补简牍，鎏金补玉器。本回合无撞选。',
  table: [
    specimen('r4-cup', '黑陶杯', '杯', '陶器', 4, '薄胎磨光，壁厚不足两毫米。'),
    specimen('r4-huang', '玉璜', '璜', '玉器', 4, '两端穿孔，可系绳佩戴。'),
    specimen('r4-knife', '骨匕', '匕', '骨器', 4, '柄部刻网格纹。'),
    specimen('r4-daybook', '日书简', '日', '简牍', 4, '记建除十二辰。'),
    specimen('r4-wheel', '陶纺轮', '轮', '陶器', 3, '圆饼形，中心穿孔。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'r4-cup', backup: 'r4-wheel' },
    blue: { primary: 'r4-daybook', backup: 'r4-huang' },
    gold: { primary: 'r4-huang', backup: 'r4-knife' },
  },
};

/**
 * 回合 5 — 平分。
 * 三队各自完成一个二件套，最终总分同为 29，形成三队平分。
 */
const roundFive: ScenarioRound = {
  title: '终局平分',
  brief: '最后一轮：赤陶补第二件简牍、青玉取高价陶器、鎏金补第二件简牍。三队总分将停在同一点上。',
  table: [
    specimen('r5-jar', '彩陶壶', '彩', '陶器', 10, '腹部绘连续旋涡纹，色彩鲜亮。'),
    specimen('r5-bi', '玉璧', '环', '玉器', 7, '通体素面，好孔规整。'),
    specimen('r5-tablet', '木牍', '牍', '简牍', 8, '两面书写，记名籍。'),
    specimen('r5-chronicle', '编年简', '年', '简牍', 7, '逐年记事，字距均匀。'),
    specimen('r5-ruler', '骨尺', '尺', '骨器', 6, '一刻度为半寸。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'r5-chronicle', backup: 'r5-ruler' },
    blue: { primary: 'r5-jar', backup: 'r5-bi' },
    gold: { primary: 'r5-tablet', backup: 'r5-ruler' },
  },
};

export const COLLISION_LAB: Scenario = {
  id: 'collision-lab',
  name: '撞选试验场',
  tagline: '首选相撞、备用再撞、无备可选与终局平分',
  description:
    '五轮手工对局。每轮都带一份演示选法，点一下即可填进所有手动队并确认，随后开牌观察裁定。所有队伍默认手动，便于逐步改选、对比结果。',
  highlights: [
    '第 1 轮：首选相撞，后手改用备用',
    '第 2 轮：备用再相撞，赤陶两手落空',
    '第 3 轮：没有合适备选 (区别于备选被拿走)',
    '第 5 轮：三队总分同为 29，形成平分',
  ],
  seed: 20261123,
  rounds: [roundOne, roundTwo, roundThree, roundFour, roundFive],
  teamSetups: {
    red: { control: 'manual', strategy: 'set' },
    blue: { control: 'manual', strategy: 'value' },
    gold: { control: 'manual', strategy: 'value' },
  },
};

const autoRoundOne: ScenarioRound = {
  title: '开局抢价',
  brief: '全自动三队。青玉、鎏金按单价优先，赤陶按成套优先。开牌后可以核对选择是否随种子固定。',
  table: [
    specimen('a1-pot', '灰陶罐', '灰', '陶器', 5, '口径较大，底部有烟炱。'),
    specimen('a1-jade', '玉镯', '镯', '玉器', 9, '整器琢磨，色如凝脂。'),
    specimen('a1-bone', '骨锥', '锥', '骨器', 4, '尖端磨制锋利。'),
    specimen('a1-slip', '历谱简', '历', '简牍', 6, '按月排列朔日。'),
    specimen('a1-bead', '玛瑙珠', '珠', '玉器', 7, '半透明，有天然纹带。'),
  ] satisfies Specimen[],
};

const autoRoundTwo: ScenarioRound = {
  title: '品类拉扯',
  brief: '赤陶队继续追陶器成套，青玉与鎏金继续取高单价。撞选后由备用递补。',
  table: [
    specimen('a2-pot', '红陶鼎', '鼎', '陶器', 6, '三足短小，腹饰弦纹。'),
    specimen('a2-jade', '玉龙', '龙', '玉器', 10, '蜷体龙形，首尾相接。'),
    specimen('a2-bone', '骨镞', '镞', '骨器', 4, '锋刃对称，铤部完整。'),
    specimen('a2-slip', '算书简', '算', '简牍', 7, '列算题四道。'),
    specimen('a2-pot2', '彩绘陶豆', '绘', '陶器', 5, '盘内绘鱼纹。'),
  ] satisfies Specimen[],
};

const autoRoundThree: ScenarioRound = {
  title: '纯价收束',
  brief: '最后一轮。自动选择完全由种子与历史持有决定，同种子同历史重开即完全复现。',
  table: [
    specimen('a3-pot', '印纹陶瓮', '瓮', '陶器', 6, '肩部拍印席纹。'),
    specimen('a3-jade', '玉圭', '圭', '玉器', 8, '尖首平底，边缘有扉牙。'),
    specimen('a3-bone', '骨梳', '梳', '骨器', 5, '背刻兽面，齿列整齐。'),
    specimen('a3-slip', '法律简', '法', '简牍', 9, '抄录律条三条。'),
    specimen('a3-shell', '蚌饰', '蚌', '骨器', 3, '穿双孔，可缝缀。'),
  ] satisfies Specimen[],
};

export const AUTO_DUEL: Scenario = {
  id: 'auto-duel',
  name: '自动对局',
  tagline: '固定种子下的可复现自动选择',
  description:
    '三队全部自动。赤陶按成套优先，青玉与鎏金按单价优先。修改种子后重开，可观察自动选择与开牌结果如何一同变化；种子不变则完全复现。',
  highlights: [
    '三队自动提交，仍须全部确认后一起开牌',
    '成套优先与单价优先两种简单偏好',
    '同种子、同历史下选择与结果完全可重复',
  ],
  seed: 77003,
  rounds: [autoRoundOne, autoRoundTwo, autoRoundThree],
  teamSetups: {
    red: { control: 'auto', strategy: 'set' },
    blue: { control: 'auto', strategy: 'value' },
    gold: { control: 'auto', strategy: 'value' },
  },
};

const mixedRoundOne: ScenarioRound = {
  title: '人机同席',
  brief: '赤陶队手动，青玉与鎏金自动。赤陶填好首选与备用并确认后，全部确认即可开牌。',
  table: [
    specimen('m1-pot', '弦纹陶罐', '弦', '陶器', 5, '肩部两道弦纹。'),
    specimen('m1-jade', '玉环', '环', '玉器', 8, '肉好相若，打磨光滑。'),
    specimen('m1-bone', '骨笄', '笄', '骨器', 4, '笄首圆雕鸟首。'),
    specimen('m1-slip', '仓廪简', '仓', '简牍', 6, '记粮仓出入。'),
    specimen('m1-jade2', '玉玦', '玦', '玉器', 5, '有缺口，可作耳饰。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'm1-jade', backup: 'm1-pot' },
  },
};

const mixedRoundTwo: ScenarioRound = {
  title: '成套压力',
  brief: '赤陶已有一对陶器，本轮继续补陶；自动队则按各自偏好出手。',
  table: [
    specimen('m2-pot', '彩陶罐', '彩', '陶器', 7, '黑彩绘弧线三角纹。'),
    specimen('m2-jade', '玉琀', '琀', '玉器', 6, '蝉形，阴线刻翼。'),
    specimen('m2-bone', '骨管', '管', '骨器', 3, '中空，外壁刻斜线。'),
    specimen('m2-slip', '封检简', '检', '简牍', 5, '有封泥槽与绳痕。'),
    specimen('m2-pot2', '陶鬲', '鬲', '陶器', 4, '三袋足，足尖残。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'm2-pot', backup: 'm2-pot2' },
  },
};

const mixedRoundThree: ScenarioRound = {
  title: '收官对照',
  brief: '末轮。可在开牌后展开逐件计分，对照自动队凭单价堆出的分值。',
  table: [
    specimen('m3-pot', '彩绘陶盆', '盆', '陶器', 6, '内壁绘鱼藻纹。'),
    specimen('m3-jade', '玉带钩', '钩', '玉器', 9, '钩首作兽头。'),
    specimen('m3-bone', '骨哨', '哨', '骨器', 4, '吹之有声。'),
    specimen('m3-slip', '日谱简', '谱', '简牍', 7, '逐日记录天象。'),
    specimen('m3-pot2', '陶壶', '壶', '陶器', 5, '圈足外撇。'),
  ] satisfies Specimen[],
  recommendations: {
    red: { primary: 'm3-pot', backup: 'm3-pot2' },
  },
};

export const MIXED_TABLE: Scenario = {
  id: 'mixed-table',
  name: '混编对局',
  tagline: '一队手动、两队自动的合桌试验',
  description:
    '赤陶队由你手动操作，青玉队与鎏金队自动提交。适合检查手动与自动混桌时的确认门槛、备用递补和计分。切到「赤陶」视角即可在桌面上直接点选首选与备用。',
  highlights: [
    '手动队确认后才允许开牌',
    '自动队按固定种子即时提交',
    '开牌后可逐件展开计分来由',
  ],
  seed: 314159,
  rounds: [mixedRoundOne, mixedRoundTwo, mixedRoundThree],
  teamSetups: {
    red: { control: 'manual', strategy: 'set' },
    blue: { control: 'auto', strategy: 'set' },
    gold: { control: 'auto', strategy: 'value' },
  },
};

export const SCENARIOS: readonly Scenario[] = [COLLISION_LAB, AUTO_DUEL, MIXED_TABLE];

export function getScenario(id: string): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.id === id);
  if (!scenario) {
    throw new Error(`未知场景: ${id}`);
  }
  return scenario;
}
