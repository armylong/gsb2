/** 稳定的 DOM id，供测试与无障碍描述引用。 */
export function CHOICE_EDGE_ID(nodeId: string, choiceId: string): string {
  return `edge-${nodeId}-${choiceId}`;
}
