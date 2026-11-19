export function RulesCard() {
  const rules = [
    {
      step: '①',
      title: '到期清理',
      text: '每个时刻先移除到期效果：攻击层、周期伤害、护盾。因此到期边界不会再触发周期伤害的一跳，护盾到期也不扣生命。',
    },
    {
      step: '②',
      title: '用户事件',
      text: '同一时刻按事件表里的次序（order）依次结算，界面会显示该次序；调整次序后结果立即重算。',
    },
    {
      step: '③',
      title: '周期伤害',
      text: '用户事件之后处理该时刻的周期伤害跳数；因此同一时刻先驱散，可以取消这一跳。',
    },
  ];
  return (
    <div className="card rules-card">
      <div className="card-head">
        <h2>结算规则（固定顺序）</h2>
      </div>
      <ol className="rules">
        {rules.map((rule) => (
          <li key={rule.step}>
            <span className="rule-step">{rule.step}</span>
            <div>
              <strong>{rule.title}</strong>
              <p>{rule.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="rules-notes">
        <p>
          <strong>攻击加成</strong>：最多 3 层，各层独立到期；满层重施刷新最早到期层，不新增层。最终攻击 = (基础 + Σ固定) × (1 + Σ百分比)，只乘一次，移除后按剩余层重算。
        </p>
        <p>
          <strong>周期伤害</strong>：第一次在施加后一个周期触发；同来源重施只刷新到期时间，下一跳节奏不变。
        </p>
        <p>
          <strong>护盾</strong>：按（到期时刻，施加次序）从早到晚吸收，剩余伤害再扣生命，生命最低为 0；护盾到期/驱散只移除吸收量。
        </p>
        <p>
          <strong>死亡</strong>：生命为 0 后的伤害与施加记为跳过；到期清理仍会执行并记录。
        </p>
      </div>
    </div>
  );
}
