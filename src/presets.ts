import { levels } from './levels';
import type { Level, Plan } from './types';

export function cloneData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export interface ConflictPreset {
  id: string;
  levelId: string;
  name: string;
  description: string;
  expectedCode: string;
  plan: Plan;
}

function levelById(id: string): Level {
  const level = levels.find((item) => item.id === id);
  if (!level) throw new Error(`unknown level ${id}`);
  return level;
}

function mutateAction(plan: Plan, actionId: string, patch: Record<string, unknown>): void {
  const action = plan.actions.find((item) => item.id === actionId);
  if (!action) throw new Error(`missing action ${actionId}`);
  Object.assign(action, patch);
}

function addAction(plan: Plan, action: Plan['actions'][number]): void {
  plan.actions.push(action);
}

/** 可从 UI 一键载入的典型冲突；同一批构造也被本地验证脚本断言。 */
export function buildConflictPresets(): ConflictPreset[] {
  const roomPlan = cloneData(levelById('room-race-coat').solution);
  mutateAction(roomPlan, 'l2_da_change_uniform', { start: 11, duration: 3 });
  mutateAction(roomPlan, 'l2_da_b_to_r', { start: 14, duration: 3 });

  const overlapPlan = cloneData(levelById('lone-quickchange').solution);
  mutateAction(overlapPlan, 'l1_lin_change_jiang', { start: 8 });

  const latePlan = cloneData(levelById('lone-quickchange').solution);
  mutateAction(latePlan, 'l1_lin_to_a', { start: 8 });
  mutateAction(latePlan, 'l1_lin_change_jiang', { start: 11 });
  mutateAction(latePlan, 'l1_lin_a_to_r', { start: 15 });

  const costumePlan = cloneData(levelById('lone-quickchange').solution);
  mutateAction(costumePlan, 'l1_lin_change_jiang', { duration: 2 });

  const doorPlan = cloneData(levelById('lone-quickchange').solution);
  mutateAction(doorPlan, 'l1_lin_a_to_r', { path: ['A', 'H', 'L'] });

  const coatPlan = cloneData(levelById('room-race-coat').solution);
  coatPlan.actions = coatPlan.actions.filter((a) => a.id !== 'l2_cheng_leave_coat');
  mutateAction(coatPlan, 'l2_da_b_to_r', { start: 14, duration: 3 });
  addAction(coatPlan, {
    id: 'conflict_da_grab_coat',
    type: 'change',
    actorId: 'da',
    start: 12,
    duration: 2,
    room: 'B',
    garmentId: 'coat',
  });

  return [
    {
      id: 'conflict-room',
      levelId: 'room-race-coat',
      name: '冲突：两人抢 B 间',
      description: '阿达的制服换装拉长到 11–14，正好压住阿程 13–15 的白礼服。',
      expectedCode: 'room-busy',
      plan: roomPlan,
    },
    {
      id: 'conflict-actor-overlap',
      levelId: 'lone-quickchange',
      name: '冲突：同一人走路时换装',
      description: '林一的换装提前到第 8 拍，但左后楼梯第 9 拍才走完。',
      expectedCode: 'actor-overlap',
      plan: overlapPlan,
    },
    {
      id: 'conflict-late',
      levelId: 'lone-quickchange',
      name: '赶不上：迟到两拍',
      description: '林一整段换装路线后移，第二幕开演时仍在 A→R 的路上。',
      expectedCode: 'late',
      plan: latePlan,
    },
    {
      id: 'conflict-costume',
      levelId: 'lone-quickchange',
      name: '衣服没换好',
      description: '武将靠需要连续 4 拍，却只安排了 2 拍。',
      expectedCode: 'costume-not-ready',
      plan: costumePlan,
    },
    {
      id: 'conflict-door',
      levelId: 'lone-quickchange',
      name: '走错舞台口',
      description: '林一换好后沿 A-H-L 去了左口，而第二幕在右口。',
      expectedCode: 'wrong-door',
      plan: doorPlan,
    },
    {
      id: 'conflict-coat',
      levelId: 'room-race-coat',
      name: '衣服还穿在前一个人身上',
      description: '删掉阿程把外套留到中转台的动作，阿达却想在 B 间直接穿这件外套。',
      expectedCode: 'garment-worn',
      plan: coatPlan,
    },
  ];
}
