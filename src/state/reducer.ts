import {
  applyDemoScript,
  canConfigure,
  checkOpen,
  choiceErrors,
  confirmSelection,
  createGame,
  isFinalRound,
  nextRound,
  openRound,
  restartGame,
  setSelection,
  setTeamControl,
  setTeamStrategy,
  unconfirmSelection,
} from '../game/engine';
import { getScenario } from '../game/scenarios';
import { addSave, createSave, loadSaves, removeSave } from '../game/storage';
import { viewerLabel } from '../format';
import type {
  GameState,
  SaveFile,
  Selection,
  StorageLike,
  TeamControl,
  TeamId,
  Viewer,
} from '../game/types';

export interface LabState {
  game: GameState;
  viewer: Viewer;
  saves: SaveFile[];
  saveLabel: string;
  notice: Notice | null;
}

export interface Notice {
  kind: 'info' | 'error';
  text: string;
}

export type LabAction =
  | { type: 'set-viewer'; viewer: Viewer }
  | { type: 'new-game'; scenarioId: string; seed?: number }
  | { type: 'restart'; seed?: number }
  | { type: 'select'; teamId: TeamId; patch: Partial<Pick<Selection, 'primary' | 'backup'>> }
  | { type: 'confirm'; teamId: TeamId }
  | { type: 'unconfirm'; teamId: TeamId }
  | { type: 'set-control'; teamId: TeamId; control: TeamControl }
  | { type: 'set-strategy'; teamId: TeamId; strategy: 'set' | 'value' }
  | { type: 'apply-demo' }
  | { type: 'open-round' }
  | { type: 'next-round' }
  | { type: 'save-label'; label: string }
  | { type: 'save'; storage: StorageLike | null }
  | { type: 'load'; saveId: string }
  | { type: 'delete-save'; saveId: string; storage: StorageLike | null }
  | { type: 'clear-notice' };

export function createInitialState(storage: StorageLike | null): LabState {
  const scenario = getScenario('collision-lab');
  return {
    game: createGame(scenario),
    viewer: 'observer',
    saves: loadSaves(storage),
    saveLabel: '',
    notice: null,
  };
}

function notice(kind: Notice['kind'], text: string): Notice {
  return { kind, text };
}

export function labReducer(state: LabState, action: LabAction): LabState {
  switch (action.type) {
    case 'set-viewer':
      return { ...state, viewer: action.viewer, notice: null };

    case 'new-game': {
      const scenario = getScenario(action.scenarioId);
      return {
        ...state,
        game: createGame(scenario, action.seed === undefined ? {} : { seed: action.seed }),
        saveLabel: '',
        notice: notice('info', `已开局：${scenario.name}`),
      };
    }

    case 'restart': {
      const game = restartGame(state.game, action.seed ?? state.game.seed);
      return {
        ...state,
        game,
        notice: notice('info', `已重新开局，种子 ${game.seed}`),
      };
    }

    case 'select': {
      const isSelf = state.viewer === action.teamId;
      if (!isSelf) {
        return { ...state, notice: notice('error', '只能修改自己队伍的选择') };
      }
      const game = setSelection(state.game, action.teamId, action.patch);
      return { ...state, game, notice: null };
    }

    case 'confirm': {
      if (state.viewer !== action.teamId) {
        return { ...state, notice: notice('error', '只能确认自己队伍的选择') };
      }
      const errors = choiceErrors(state.game, action.teamId);
      if (errors.length > 0) {
        return { ...state, notice: notice('error', errors.join('；')) };
      }
      return { ...state, game: confirmSelection(state.game, action.teamId), notice: null };
    }

    case 'unconfirm': {
      if (state.viewer !== action.teamId) {
        return { ...state, notice: notice('error', '只能撤回自己队伍的确认') };
      }
      return { ...state, game: unconfirmSelection(state.game, action.teamId), notice: null };
    }

    case 'set-control': {
      if (!canConfigure(state.game, state.viewer, action.teamId)) {
        return { ...state, notice: notice('error', '当前视角不能调整该队配置') };
      }
      return {
        ...state,
        game: setTeamControl(state.game, action.teamId, action.control),
        notice: null,
      };
    }

    case 'set-strategy': {
      if (!canConfigure(state.game, state.viewer, action.teamId)) {
        return { ...state, notice: notice('error', '当前视角不能调整该队配置') };
      }
      return {
        ...state,
        game: setTeamStrategy(state.game, action.teamId, action.strategy),
        notice: null,
      };
    }

    case 'apply-demo': {
      const round = state.game.rounds[state.game.roundIndex];
      if (!round?.recommendations) {
        return { ...state, notice: notice('error', '本回合没有演示选法') };
      }
      const game = applyDemoScript(state.game);
      return {
        ...state,
        game,
        notice: notice('info', '已套用本回合演示选法（仅影响手动队）'),
      };
    }

    case 'open-round': {
      const check = checkOpen(state.game);
      if (!check.canOpen) {
        const pending = check.pendingTeamIds.length
          ? `等待确认：${check.pendingTeamIds.join('、')}`
          : check.errors.join('；');
        return { ...state, notice: notice('error', `还不能开牌。${pending}`) };
      }
      return {
        ...state,
        game: openRound(state.game),
        notice: notice('info', '开牌完成，选择与裁定已公开'),
      };
    }

    case 'next-round': {
      if (state.game.phase !== 'opened') {
        return { ...state, notice: notice('error', '本回合尚未开牌') };
      }
      if (isFinalRound(state.game)) {
        return { ...state, notice: notice('error', '已经是最后一轮') };
      }
      return {
        ...state,
        game: nextRound(state.game),
        notice: notice('info', `进入第 ${state.game.roundIndex + 2} 轮`),
      };
    }

    case 'save-label':
      return { ...state, saveLabel: action.label };

    case 'save': {
      try {
        const save = createSave(state.game, state.viewer, state.saveLabel || null);
        const saves = addSave(action.storage, save, state.saves);
        return {
          ...state,
          saves,
          saveLabel: '',
          notice: notice('info', `已保存：${save.label}`),
        };
      } catch (error) {
        return {
          ...state,
          notice: notice('error', error instanceof Error ? error.message : '保存失败'),
        };
      }
    }

    case 'load': {
      const save = state.saves.find((entry) => entry.id === action.saveId);
      if (!save) {
        return { ...state, notice: notice('error', '找不到该存档') };
      }
      return {
        ...state,
        game: cloneGame(save.game),
        viewer: save.viewTeam,
        notice: notice(
          'info',
          `已读取：${save.label}（${save.game.phase === 'selecting' ? '开选前' : '开牌后'} · 视角 ${viewerLabel(save.viewTeam, save.game.teams)}）`,
        ),
      };
    }

    case 'delete-save': {
      try {
        const saves = removeSave(action.storage, action.saveId, state.saves);
        return { ...state, saves, notice: notice('info', '存档已删除') };
      } catch (error) {
        return {
          ...state,
          notice: notice('error', error instanceof Error ? error.message : '删除失败'),
        };
      }
    }

    case 'clear-notice':
      return { ...state, notice: null };

    default:
      return state;
  }
}

function cloneGame(game: GameState): GameState {
  return JSON.parse(JSON.stringify(game)) as GameState;
}

export function openStateSummary(game: GameState): string {
  const check = checkOpen(game);
  if (game.phase === 'opened') return '本回合已开牌';
  if (check.canOpen) return '三队均已确认，可以开牌';
  return `还有 ${check.pendingTeamIds.length} 队未确认`;
}
