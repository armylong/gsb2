import type { LabAction, LabState } from '../state/reducer';
import type { RoundResult, Specimen, Team, TeamId } from '../game/types';
import { canConfigure, currentPriority } from '../game/engine';
import { specimenName, teamOrderIndex, viewerTeamId } from '../format';

interface Props {
  state: LabState;
  dispatch: (action: LabAction) => void;
}

export function TeamsPanel({ state, dispatch }: Props) {
  const { game, viewer } = state;
  const priority = currentPriority(game);
  const ownTeamId = viewerTeamId(viewer);
  const opened = game.phase === 'opened';
  const result = opened ? game.history[game.history.length - 1] ?? null : null;
  const table = game.rounds[game.roundIndex]?.table ?? [];
  const order = opened && result ? result.priority : priority;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>队伍与选择</h2>
        <span className="sub">
          {opened
            ? '开牌后：所有选择公开'
            : ownTeamId
              ? '开选前：只能看到自己队伍的选择'
              : '开选前：旁观视角，看不到任何队伍的具体选择'}
        </span>
      </div>

      <div className="team-grid">
        {[...game.teams]
          .sort((a, b) => teamOrderIndex(order, a.id) - teamOrderIndex(order, b.id))
          .map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              state={state}
              dispatch={dispatch}
              ownTeamId={ownTeamId}
              opened={opened}
              table={table}
              priorityIndex={order.indexOf(team.id)}
              result={result}
            />
          ))}
      </div>
    </section>
  );
}

function TeamCard({
  team,
  state,
  dispatch,
  ownTeamId,
  opened,
  table,
  priorityIndex,
  result,
}: {
  team: Team;
  state: LabState;
  dispatch: (action: LabAction) => void;
  ownTeamId: TeamId | null;
  opened: boolean;
  table: readonly Specimen[];
  priorityIndex: number;
  result: RoundResult | null;
}) {
  const { game, viewer } = state;
  const selection = game.selections[team.id];
  const isSelf = ownTeamId === team.id;
  const hidden = !opened && !isSelf;
  const configurable = canConfigure(game, viewer, team.id);
  const assignment = result
    ? result.assignments.find((entry) => entry.teamId === team.id) ?? null
    : null;
  const miss = result
    ? result.misses.find((entry) => entry.teamId === team.id) ?? null
    : null;

  return (
    <article className={`team-card${isSelf ? ' active-view' : ''}`}>
      <div className="team-card-head">
        <div className="team-id">
          <span className="team-sigil" style={{ background: team.color }} aria-hidden="true">
            {team.sigil}
          </span>
          <div>
            <div className="team-name">
              {team.name}
              {isSelf && (
                <span className="chip plain" style={{ marginLeft: 8 }}>
                  本队
                </span>
              )}
            </div>
            <div className="team-sub">
              优先位 {priorityIndex + 1} ·{' '}
              {team.control === 'manual' ? '手动' : '自动'} ·{' '}
              {team.strategy === 'set' ? '成套优先' : '单价优先'}
            </div>
          </div>
        </div>

        <div className="team-config">
          <select
            className="mini-select"
            aria-label={`${team.name} 操作方式`}
            value={team.control}
            disabled={!configurable}
            onChange={(event) =>
              dispatch({
                type: 'set-control',
                teamId: team.id,
                control: event.target.value === 'auto' ? 'auto' : 'manual',
              })
            }
          >
            <option value="manual">手动</option>
            <option value="auto">自动</option>
          </select>
          <select
            className="mini-select"
            aria-label={`${team.name} 自动偏好`}
            value={team.strategy}
            disabled={!configurable || team.control !== 'auto'}
            onChange={(event) =>
              dispatch({
                type: 'set-strategy',
                teamId: team.id,
                strategy: event.target.value === 'set' ? 'set' : 'value',
              })
            }
          >
            <option value="set">成套优先</option>
            <option value="value">单价优先</option>
          </select>
        </div>
      </div>

      {hidden ? (
        <div className="hidden-note">
          <span>🔒</span>
          <span>
            选择未公开。{selection.confirmed ? '该队已确认。' : '该队尚未确认。'}
            {selection.source === 'auto' ? '（自动提交）' : ''}
          </span>
        </div>
      ) : (
        <>
          <div className="team-picks">
            <PickLine label="首选" id={selection.primary} table={table} kind="primary" />
            <PickLine label="备用" id={selection.backup} table={table} kind="backup" />
          </div>

          {assignment && (
            <div className="team-picks">
              <span className="chip good">
                获得「{specimenName(table, assignment.specimenId)}」 ·{' '}
                {assignment.via === 'primary' ? '首选' : '备用递补'}
              </span>
            </div>
          )}
          {miss && (
            <div className="team-picks">
              <span className="chip bad">
                {miss.reason === 'no-backup' ? '没有合适备选' : '备用已被别人拿走'}
              </span>
            </div>
          )}
        </>
      )}

      {!opened && (
        <div className="team-actions">
          {isSelf ? (
            <>
              <span className={`chip ${selection.confirmed ? 'good' : 'warn'}`}>
                {selection.confirmed ? '已确认，等待开牌' : '尚未确认'}
              </span>
              {team.control === 'manual' &&
                (selection.confirmed ? (
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => dispatch({ type: 'unconfirm', teamId: team.id })}
                  >
                    撤回确认
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-small btn-primary"
                    onClick={() => dispatch({ type: 'confirm', teamId: team.id })}
                  >
                    确认选择
                  </button>
                ))}
              {team.control === 'auto' && (
                <span className="chip plain">自动提交，改偏好会立即重算</span>
              )}
            </>
          ) : (
            <span className={`chip ${selection.confirmed ? 'good' : 'warn'}`}>
              {selection.confirmed ? '已确认' : '尚未提交'}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

function PickLine({
  label,
  id,
  table,
  kind,
}: {
  label: string;
  id: string | null;
  table: readonly Specimen[];
  kind: 'primary' | 'backup';
}) {
  return (
    <span className={`pick-line ${kind}${id ? '' : ' empty'}`}>
      <span className="label">{label}</span>
      <span className="value">{id ? specimenName(table, id) : '未选择'}</span>
    </span>
  );
}
