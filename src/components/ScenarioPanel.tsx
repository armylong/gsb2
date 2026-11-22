import type { GameState, Scenario, Viewer } from '../game/types';
import { viewerLabel } from '../format';
import { TEAM_IDS } from '../game/types';

interface Props {
  scenario: Scenario;
  game: GameState;
  viewer: Viewer;
}

export function ScenarioPanel({ scenario, game, viewer }: Props) {
  const heldCounts = TEAM_IDS.map(
    (teamId) =>
      game.history.reduce(
        (sum, round) =>
          sum + round.assignments.filter((entry) => entry.teamId === teamId).length,
        0,
      ),
  );

  return (
    <section className="panel scenario-card">
      <div className="panel-head">
        <h2>{scenario.name}</h2>
        <span className="sub">{scenario.tagline}</span>
      </div>
      <div className="panel-body">
        <p className="scenario-desc">{scenario.description}</p>
        <ul className="highlights">
          {scenario.highlights.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="viewer-note">
          当前视角：<strong>{viewerLabel(viewer, game.teams)}</strong>。种子{' '}
          <strong>{game.seed}</strong>，第 <strong>{game.roundIndex + 1}</strong> /{' '}
          {game.rounds.length} 轮，
          {game.phase === 'selecting'
            ? '开选前：仅可见公共信息，以及自己队伍的选择。'
            : '已开牌：所有队伍的选择与裁定公开。'}
          {game.history.length > 0
            ? ` 已打完 ${game.history.length} 轮（各队得分件数 ${heldCounts.join(' / ')}）。`
            : ''}
        </div>
      </div>
    </section>
  );
}
