import type { LabAction, LabState } from '../state/reducer';
import type { StorageLike } from '../game/types';
import { defaultSaveLabel } from '../game/storage';
import { viewerLabel } from '../format';

interface Props {
  state: LabState;
  dispatch: (action: LabAction) => void;
  storage: StorageLike | null;
}

export function SavesPanel({ state, dispatch, storage }: Props) {
  const { game, saves } = state;
  const placeholder = defaultSaveLabel(game);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>本地存档</h2>
        <span className="sub">{storage ? '存入浏览器 localStorage' : '当前环境不支持本地存储'}</span>
      </div>

      <div className="save-form">
        <div className="field">
          <label htmlFor="save-label">存档名称（留空用默认）</label>
          <input
            id="save-label"
            value={state.saveLabel}
            placeholder={placeholder}
            maxLength={60}
            onChange={(event) => dispatch({ type: 'save-label', label: event.target.value })}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!storage}
          onClick={() => dispatch({ type: 'save', storage })}
        >
          保存当前局面
        </button>
      </div>

      <div className="save-list">
        {saves.length === 0 ? (
          <p className="empty-note">
            还没有存档。保存时会连同当前视角一起记录：开选前恢复只显示该阶段的可见信息，开牌后恢复则全部公开。
          </p>
        ) : (
          saves.map((save) => {
            const isSelecting = save.game.phase === 'selecting';
            return (
              <div key={save.id} className="save-row">
                <div className="meta">
                  <div className="label">{save.label}</div>
                  <div className="sub">
                    {save.savedAt.replace('T', ' ').slice(0, 19)} ·{' '}
                    {isSelecting ? '开选前' : '开牌后'} · 视角{' '}
                    {viewerLabel(save.viewTeam, save.game.teams)} · 种子 {save.game.seed}
                  </div>
                </div>
                <div className="save-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => dispatch({ type: 'load', saveId: save.id })}
                  >
                    读取
                  </button>
                  <button
                    type="button"
                    className="btn btn-small btn-danger"
                    disabled={!storage}
                    onClick={() => dispatch({ type: 'delete-save', saveId: save.id, storage })}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}
