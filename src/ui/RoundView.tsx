import { useStore } from '../game/store.tsx';
import { canSeeChoices, visibleChoices, allConfirmed } from '../game/permissions.ts';
import type { RoundState, TeamId } from '../game/types.ts';
import type { ViewAs } from '../game/permissions.ts';

const CAT_LABEL: Record<string, string> = { rock: '岩矿', insect: '昆虫', plant: '植物' };

export function RoundView({ round, viewAs }: { round: RoundState; viewAs: ViewAs }) {
  const { state, dispatch } = useStore();
  if (!state) return null;

  const revealed = round.log !== null;
  const visible = visibleChoices(round, viewAs);
  const ownerOf = new Map<string, TeamId>();
  round.log?.forEach((e) => {
    if (e.wonSpecimenId) ownerOf.set(e.wonSpecimenId, e.teamId);
  });

  const teamById = (id: TeamId) => state.teams.find((t) => t.id === id)!;

  return (
    <>
      <div className="card" style={{ marginTop: 14 }}>
        <h2>桌上标本（第 {round.index + 1} 轮，共 {round.specimens.length} 件）</h2>
        <div className="specimen-grid">
          {round.specimens.map((spec) => {
            const owner = ownerOf.get(spec.id);
            return (
              <div
                key={spec.id}
                className={`specimen${owner ? ' taken' : ''}`}
              >
                <span className={`cat cat-${spec.category}`}>{CAT_LABEL[spec.category]}</span>
                {owner && (
                  <span className="taken-tag" style={{ background: teamById(owner).color }}>
                    {teamById(owner).label}
                  </span>
                )}
                <div className="name">{spec.label}</div>
                <div className="value">
                  基础分 {spec.value} · {state.categories[spec.category].setSize} 件成套 +
                  {state.categories[spec.category].setBonus}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="teams">
        {state.teams.map((team) => {
          const choice = visible[team.id]!;
          const ownView = viewAs === team.id;
          const seeChoice = canSeeChoices(round, viewAs) && (revealed || ownView);
          // 自动队伍的偏好选择只读；只有手动队在本队视角、未开牌时可改选
          const editable = !revealed && ownView && team.autoStrategy === null;
          const selectable = round.specimens;

          return (
            <div className="team-card" key={team.id} style={{ ['--team-color' as string]: team.color }}>
              <h3>
                <span className="team-dot" />
                {team.label}
                {team.autoStrategy && (
                  <span className="badge" title="自动队伍">
                    {team.autoStrategy === 'valueFirst' ? '自动·择高分' : '自动·凑成套'}
                  </span>
                )}
                <span className={`confirm-state ${choice.confirmed ? 'ok' : 'wait'}`}>
                  {choice.confirmed ? '✓ 已确认' : '未确认'}
                </span>
              </h3>

              {!seeChoice && !revealed && (
                <>
                  <div className="pick-row">
                    <label>首选</label>
                    <span className="hidden-pick">🔒 仅 {team.label} 可见</span>
                  </div>
                  <div className="pick-row">
                    <label>备用</label>
                    <span className="hidden-pick">🔒 仅 {team.label} 可见</span>
                  </div>
                  <p className="locked-note">
                    开选前只能看到公共信息与本队选择；开牌后所有选择公开。
                  </p>
                </>
              )}

              {seeChoice && (
                <>
                  <PickSelect
                    label="首选"
                    value={choice.primaryId}
                    disabled={!editable}
                    specimens={selectable}
                    onChange={(v) =>
                      dispatch({ type: 'setChoice', teamId: team.id, slot: 'primaryId', specimenId: v })
                    }
                  />
                  <PickSelect
                    label="备用"
                    value={choice.backupId}
                    disabled={!editable}
                    specimens={selectable}
                    allowEmpty
                    onChange={(v) =>
                      dispatch({ type: 'setChoice', teamId: team.id, slot: 'backupId', specimenId: v })
                    }
                  />
                  {editable && (
                    <div className="actions-row">
                      {!choice.confirmed ? (
                        <button
                          className="btn primary"
                          disabled={!choice.primaryId || choice.primaryId === choice.backupId}
                          onClick={() => dispatch({ type: 'confirm', teamId: team.id })}
                          title={choice.primaryId ? '' : '先选一个首选'}
                        >
                          确认提交
                        </button>
                      ) : (
                        <button
                          className="btn"
                          onClick={() => dispatch({ type: 'unconfirm', teamId: team.id })}
                        >
                          撤回确认并修改
                        </button>
                      )}
                    </div>
                  )}
                  {!editable && !revealed && (
                    <p className="locked-note">
                      {team.autoStrategy
                        ? '自动队伍按种子与偏好在开局时定选，不可手动修改。'
                        : `当前为 ${team.label} 的已提交选择，切换到该队视角可修改。`}
                    </p>
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>

      {revealed && round.log && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>
            开牌来由
            <span className="meta-line" style={{ margin: 0 }}>
              （按本轮优先顺序 {round.priority.join(' → ')} 逐队处理）
            </span>
          </h2>
          <table className="log-table">
            <thead>
              <tr>
                <th>顺序</th>
                <th>队伍</th>
                <th>首选</th>
                <th>备用</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {round.log.map((entry) => {
                const team = teamById(entry.teamId);
                const specName = (id: string | null) =>
                  id ? round.specimens.find((s) => s.id === id)?.label ?? id : '—';
                return (
                  <tr key={entry.teamId}>
                    <td>{entry.priorityIndex + 1}</td>
                    <td>
                      <span className="team-dot" style={{ background: team.color }} /> {team.label}
                    </td>
                    <td>{specName(entry.primaryId)}</td>
                    <td>{specName(entry.backupId)}</td>
                    <td>
                      {entry.outcome === 'primaryWon' && (
                        <span className="tag tag-primary">首选到手：{specName(entry.wonSpecimenId)}</span>
                      )}
                      {entry.outcome === 'backupWon' && (
                        <>
                          <span className="tag tag-backup">备用到手：{specName(entry.wonSpecimenId)}</span>
                          <div className="miss-note">
                            首选 {specName(entry.primaryId)} 被
                            {entry.primaryTakenBy && teamById(entry.primaryTakenBy).label}优先拿走
                          </div>
                        </>
                      )}
                      {entry.outcome === 'missedNoBackup' && (
                        <>
                          <span className="tag tag-miss">空手而归</span>
                          <div className="miss-note">
                            首选被抢，且没有合适备选（本队未提交备用）
                          </div>
                        </>
                      )}
                      {entry.outcome === 'missedBackupTaken' && (
                        <>
                          <span className="tag tag-miss">空手而归</span>
                          <div className="miss-note">
                            首选被
                            {entry.primaryTakenBy && teamById(entry.primaryTakenBy).label}拿走；备用「
                            {specName(entry.backupId)}」又被
                            {entry.backupTakenBy && teamById(entry.backupTakenBy).label}分走（备选已被别人拿走）
                          </div>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="meta-line" style={{ marginTop: 10 }}>
            全员确认状态：{allConfirmed(round) ? '三队均已确认' : '存在未确认'}；未被任何队拿走的标本留桌。
          </p>
        </div>
      )}
    </>
  );
}

function PickSelect({
  label,
  value,
  specimens,
  disabled,
  allowEmpty = false,
  onChange,
}: {
  label: string;
  value: string | null;
  specimens: RoundState['specimens'];
  disabled: boolean;
  allowEmpty?: boolean;
  onChange: (id: string | null) => void;
}) {
  return (
    <div className="pick-row">
      <label>{label}</label>
      {disabled ? (
        <span className="pick-display">
          {value ? specimens.find((s) => s.id === value)?.label ?? value : allowEmpty ? '未提交' : '—'}
        </span>
      ) : (
        <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          {allowEmpty && <option value="">（不提交备用）</option>}
          {!allowEmpty && <option value="">请选择…</option>}
          {specimens.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}（{CAT_LABEL[s.category]} · {s.value} 分）
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
