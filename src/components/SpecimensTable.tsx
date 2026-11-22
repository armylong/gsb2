import { TEAM_IDS } from '../game/types';
import type { RoundResult, Specimen, TeamId } from '../game/types';

interface TeamsById {
  get(id: TeamId): { name: string; sigil: string; color: string } | undefined;
}

interface Props {
  specimens: Specimen[];
  result: RoundResult | null;
  revealAll: boolean;
  ownPrimary: string | null;
  ownBackup: string | null;
  showOwnMarks: boolean;
  teamsById: TeamsById;
  canPick?: boolean;
  onPick?: (role: 'primary' | 'backup', specimenId: string) => void;
}

export function SpecimensTable({
  specimens,
  result,
  revealAll,
  ownPrimary,
  ownBackup,
  showOwnMarks,
  teamsById,
  canPick = false,
  onPick,
}: Props) {
  return (
    <div className="table-grid">
      {specimens.map((specimen) => {
        const holders = result
          ? result.assignments.filter((entry) => entry.specimenId === specimen.id)
          : [];
        const isPrimary = showOwnMarks && ownPrimary === specimen.id;
        const isBackup = showOwnMarks && ownBackup === specimen.id;
        const className = [
          'specimen',
          isPrimary ? 'is-primary' : '',
          !isPrimary && isBackup ? 'is-backup' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return (
          <article key={specimen.id} className={className}>
            <div className="specimen-head">
              <span className="glyph" aria-hidden="true">
                {specimen.glyph}
              </span>
              <div className="specimen-title">
                <span className="name">{specimen.name}</span>
                <span className="meta">
                  {specimen.category} · {specimen.id}
                </span>
              </div>
            </div>
            <p className="specimen-note">{specimen.note}</p>
            <div className="specimen-actions">
              <span className="specimen-value">价值 {specimen.value}</span>
              {(isPrimary || isBackup) && (
                <span className={`chip ${isPrimary ? 'warn' : 'plain'}`}>
                  {isPrimary ? '本队首选' : '本队备用'}
                </span>
              )}
            </div>

            {canPick && onPick && (
              <div className="specimen-actions">
                <button
                  type="button"
                  className={isPrimary ? 'pick-btn primary' : 'pick-btn'}
                  aria-pressed={isPrimary}
                  onClick={() => onPick('primary', specimen.id)}
                >
                  设为首选
                </button>
                <button
                  type="button"
                  className={isBackup ? 'pick-btn backup' : 'pick-btn'}
                  aria-pressed={isBackup}
                  disabled={isPrimary}
                  onClick={() => onPick('backup', specimen.id)}
                >
                  设为备用
                </button>
              </div>
            )}

            {holders.length > 0 && revealAll && (
              <div className="specimen-badges">
                {holders.map((holder) => {
                  const team = teamsById.get(holder.teamId);
                  return (
                    <span
                      key={`${holder.teamId}-${holder.specimenId}`}
                      className={`badge${holder.via === 'backup' ? ' via-backup' : ''}`}
                    >
                      <span
                        className="sigil"
                        style={{ background: team?.color ?? '#666' }}
                        aria-hidden="true"
                      >
                        {team?.sigil ?? '?'}
                      </span>
                      {team?.name ?? holder.teamId}
                      <em style={{ fontStyle: 'normal', opacity: 0.7 }}>
                        {holder.via === 'primary' ? '首选' : '备用'}
                      </em>
                    </span>
                  );
                })}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}

export function SpecimenLegend({ revealAll }: { revealAll: boolean }) {
  return (
    <div className="legend">
      <span>
        <span className="dot primary" /> 本队首选
      </span>
      <span>
        <span className="dot backup" /> 本队备用
      </span>
      {revealAll ? (
        <span>
          <span className="dot" /> 徽记表示标本归属；来源为备用的用虚线圈标出
        </span>
      ) : (
        <span>
          <span className="dot" /> 开牌前只显示自己的标记与他队的确认状态
        </span>
      )}
      <span>共 {TEAM_IDS.length} 队 · 优先位每轮轮换</span>
    </div>
  );
}
