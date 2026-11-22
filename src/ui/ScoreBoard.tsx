import { useMemo } from 'react';
import { scoreGame, tiedTeamIds } from '../game/engine.ts';
import { useStore } from '../game/store.tsx';

const MISS_TEXT = {
  noBackup: '没有合适备选',
  backupTaken: '备选已被别人拿走',
} as const;

export function ScoreBoard() {
  const { state } = useStore();
  const scores = useMemo(() => (state ? scoreGame(state.rounds) : null), [state]);
  if (!state || !scores) return null;

  const tied = new Set(tiedTeamIds(scores));

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>
        积分榜
        {tied.size > 1 && <span className="tie-mark">平分：{[...tied].join(' 队与 ')} 队并列第一</span>}
      </h2>
      <div className="score-grid">
        {state.teams.map((team) => {
          const score = scores[team.id];
          return (
            <div
              key={team.id}
              className={`score-card${tied.has(team.id) ? ' tied' : ''}`}
              style={{ ['--team-color' as string]: team.color }}
            >
              <div className="team-line">
                <span className="team-dot" style={{ background: team.color }} />
                {team.label}
                {tied.has(team.id) && <span className="tie-mark">并列第一</span>}
              </div>
              <div className="total">{score.total} 分</div>
              <div className="meta-line">
                到手 {score.items.length} 件 · 成套 {score.setsCompleted} 套
              </div>

              <details>
                <summary>展开逐件计分来由（{score.items.length} 件）</summary>
                {score.items.map((item) => (
                  <div className="item-line" key={`${item.roundIndex}-${item.specimen.id}`}>
                    <div className="head">
                      <strong>{item.specimen.label}</strong>
                      <span>
                        +{item.base}
                        {item.setBonus > 0 && ` +${item.setBonus}`} = {item.total}
                      </span>
                    </div>
                    <div className="why">
                      第 {item.roundIndex + 1} 轮 · {item.note}
                    </div>
                  </div>
                ))}
                {score.items.length === 0 && <div className="why">尚未拿到标本。</div>}
              </details>

              {score.missedRounds.length > 0 && (
                <details>
                  <summary>空手记录（{score.missedRounds.length} 轮）</summary>
                  {score.missedRounds.map((m) => (
                    <div className="miss-line" key={m.roundIndex}>
                      第 {m.roundIndex + 1} 轮：{MISS_TEXT[m.reason]}
                    </div>
                  ))}
                </details>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
