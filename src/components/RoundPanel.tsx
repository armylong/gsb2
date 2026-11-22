import type { LabAction, LabState } from '../state/reducer';
import { openStateSummary } from '../state/reducer';
import type { ScenarioRound } from '../game/types';
import { TEAM_IDS } from '../game/types';
import { roundStatusLabel, teamById, viewerTeamId } from '../format';
import { SpecimensTable, SpecimenLegend } from './SpecimensTable';
import { canEdit, currentPriority } from '../game/engine';

interface Props {
  state: LabState;
  dispatch: (action: LabAction) => void;
  round: ScenarioRound;
}

export function RoundPanel({ state, dispatch, round }: Props) {
  const { game, viewer } = state;
  const teamsById = new Map(game.teams.map((team) => [team.id, team]));
  const ownTeamId = viewerTeamId(viewer);
  const ownSelection = ownTeamId ? game.selections[ownTeamId] : null;
  const opened = game.phase === 'opened';
  const result = opened ? game.history[game.history.length - 1] ?? null : null;
  const isLast = game.roundIndex >= game.rounds.length - 1;
  const priority = result ? result.priority : currentPriority(game);
  const ownEditable = ownTeamId ? canEdit(game, ownTeamId) : false;
  const pickHint = !opened
    ? ownEditable
      ? '可直接点卡片上的按钮设首选 / 备用'
      : ownTeamId
        ? '本队为自动模式，选择由种子决定；改回手动即可自选'
        : '旁观视角看不到具体选择，切到某队后可点选'
    : null;

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>
          第 {game.roundIndex + 1} 轮 · {round.title}
        </h2>
        <span className="sub">
          {opened ? '已开牌' : '开选前'} · {openStateSummary(game)}
        </span>
      </div>

      <div className="round-strip">
        {game.rounds.map((entry, index) => {
          const status = roundStatusLabel(game, index);
          return (
            <span
              key={`${entry.title}-${index}`}
              className={`round-chip${status === '进行中' ? ' current' : ''}${
                status === '已完成' ? ' done' : ''
              }`}
            >
              <span className="num">{index + 1}</span>
              {entry.title}
            </span>
          );
        })}
      </div>

      <p className="round-brief">{round.brief}</p>

      <div className="priority-bar">
        <span className="priority-label">本轮优先</span>
        <span className="priority-seq">
          {priority.map((teamId, index) => {
            const team = teamById(game.teams, teamId);
            return (
              <span key={teamId} className="priority-item">
                <span className="ord">{index + 1}</span>
                <span
                  className="dot"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 99,
                    background: team.color,
                    display: 'inline-block',
                  }}
                />
                {team.name}
                {index === priority.length - 1 && <span className="ord">末位</span>}
              </span>
            );
          })}
        </span>
        {!opened && (
          <span className="chip plain" style={{ marginLeft: 'auto' }}>
            先首选，后备用，各按此序
          </span>
        )}
        {opened && result && (
          <span className="chip plain" style={{ marginLeft: 'auto' }}>
            共 {result.assignments.length} 件成交 · {result.misses.length} 队落空
          </span>
        )}
      </div>

      {pickHint && (
        <p className="round-brief" style={{ borderBottom: 'none', paddingBottom: 0 }}>
          {pickHint}
        </p>
      )}
      <SpecimensTable
        specimens={round.table}
        result={result}
        revealAll={opened}
        ownPrimary={ownSelection?.primary ?? null}
        ownBackup={ownSelection?.backup ?? null}
        showOwnMarks={!!ownTeamId && !opened}
        teamsById={teamsById}
        canPick={!opened && ownEditable}
        onPick={
          ownTeamId
            ? (role, specimenId) =>
                dispatch({
                  type: 'select',
                  teamId: ownTeamId,
                  patch:
                    role === 'primary'
                      ? { primary: specimenId }
                      : { backup: specimenId },
                })
            : undefined
        }
      />
      <SpecimenLegend revealAll={opened} />

      <div className="action-bar">
        <span className="action-hint">{actionHint(state, isLast)}</span>
        <div className="action-buttons">
          {!opened && round.recommendations && (
            <button
              type="button"
              className="btn"
              onClick={() => dispatch({ type: 'apply-demo' })}
              title="把本回合的演示选法填入所有手动队并确认"
            >
              套用演示选法
            </button>
          )}
          {!opened && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => dispatch({ type: 'open-round' })}
              disabled={!allConfirmed(game.selections)}
            >
              开牌
            </button>
          )}
          {opened && !isLast && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => dispatch({ type: 'next-round' })}
            >
              进入下一轮
            </button>
          )}
          {opened && isLast && (
            <button
              type="button"
              className="btn"
              onClick={() => dispatch({ type: 'restart' })}
            >
              同种子重开
            </button>
          )}
        </div>
      </div>
    </section>
  );
}

function allConfirmed(selections: LabState['game']['selections']): boolean {
  return TEAM_IDS.every((teamId) => selections[teamId].confirmed);
}

function actionHint(state: LabState, isLast: boolean): string {
  const { game } = state;
  if (game.phase === 'opened') {
    if (isLast) return `终局 · 可在下方查看计分与裁定明细`;
    return '开牌已完成，所有选择与裁定已公开';
  }
  if (allConfirmed(game.selections)) {
    return '三队均已确认，随时可以开牌';
  }
  const pending = TEAM_IDS.filter((teamId) => !game.selections[teamId].confirmed).map(
    (teamId) => teamById(game.teams, teamId).name,
  );
  return `等待确认：${pending.join('、')}`;
}

export function teamPriorityIndex(priority: readonly string[], teamId: string): number {
  return priority.indexOf(teamId);
}
