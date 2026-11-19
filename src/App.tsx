import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Cell, ItemDef, Placement, Rotation, WorldState } from './core/types';
import { ITEMS } from './core/items';
import {
  baseCellFromRendered,
  cellKey,
  renderedRelOf,
  rotateAroundGrab,
  sameCell,
} from './core/geometry';
import {
  countOccupiedCells,
  executeDrop,
  planDrop,
  type DropPlan,
} from './core/inventory';
import { canRedo, canUndo, commit, createHistory, redo, undo } from './core/history';
import {
  buildLayoutFile,
  clearLocalStorage,
  loadFromLocalStorage,
  parseLayoutText,
  saveToLocalStorage,
} from './core/storage';
import { SAMPLES, type Sample } from './core/samples';
import { CELL_SIZE } from './constants';
import { BagView, type BagPreview } from './components/BagView';

interface DragState {
  itemId: string;
  /** 拖动开始时的放置快照; 取消时回到这里 */
  from: Placement;
  /** 基础形状中被按住的物理格(旋转前后对应关系的锚) */
  baseGrab: Cell;
  pointer: { x: number; y: number };
  hoverBagId: string | null;
  pointerCell: Cell | null;
  rotation: Rotation;
  /** 当前预览锚点(在 hoverBagId 坐标系内) */
  anchor: Cell;
  /** 方向键微调偏移; 鼠标移动后清零 */
  nudge: Cell;
}

interface Toast {
  kind: 'good' | 'bad';
  text: string;
}

function initialState(): { items: ItemDef[]; world: WorldState; sampleKey: string } {
  const stored = loadFromLocalStorage();
  if (stored?.ok && stored.file) {
    return { items: stored.file.items, world: stored.file.world, sampleKey: '__local__' };
  }
  return { items: ITEMS, world: structuredClone(SAMPLES[0].world), sampleKey: SAMPLES[0].key };
}

export default function App() {
  const [items, setItems] = useState<ItemDef[]>(() => initialState().items);
  const [history, setHistory] = useState(() => createHistory(initialState().world));
  const [sampleKey, setSampleKey] = useState(() => initialState().sampleKey);
  const [drag, setDrag] = useState<DragState | null>(null);
  // 同步保存最新 drag, 供全局 pointerup 监听读取, 避免闭包拿到过期状态
  const dragRef = useRef<DragState | null>(null);
  useEffect(() => {
    dragRef.current = drag;
  }, [drag]);
  const [toast, setToast] = useState<Toast | null>(null);
  const [actionMsg, setActionMsg] = useState('准备就绪: 按住物品实占格开始拖动');
  const [sampleHint, setSampleHint] = useState(SAMPLES[0].hint);
  const bagRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const fileInputRef = useRef<HTMLInputElement>(null);
  const world = history.present;
  const itemById = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const showToast = useCallback((t: Toast) => {
    setToast(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5200);
    return () => window.clearTimeout(t);
  }, [toast]);

  /* ---------------- 命中测试: 指针坐标 -> 背包 + 网格格 + 格内偏移 ---------------- */
  const hitTest = useCallback(
    (x: number, y: number): { bagId: string; cell: Cell; offset: Cell; rectLeft: number; rectTop: number } | null => {
      for (const bag of world.bags) {
        const el = bagRefs.current.get(bag.id);
        if (!el) continue;
        const rect = el.getBoundingClientRect();
        // 宽高优先用背包定义, jsdom 下 rect 尺寸为 0 也能正确命中
        const width = bag.cols * CELL_SIZE;
        const height = bag.rows * CELL_SIZE;
        if (x >= rect.left && x < rect.left + width && y >= rect.top && y < rect.top + height) {
          const relX = x - rect.left;
          const relY = y - rect.top;
          return {
            bagId: bag.id,
            cell: { col: Math.floor(relX / CELL_SIZE), row: Math.floor(relY / CELL_SIZE) },
            offset: { col: relX % CELL_SIZE, row: relY % CELL_SIZE },
            rectLeft: rect.left,
            rectTop: rect.top,
          };
        }
      }
      return null;
    },
    [world.bags],
  );

  /* ---------------- 开始拖动 ---------------- */
  const handleCellPointerDown = useCallback(
    (e: React.PointerEvent, bagId: string, itemId: string, relCol: number, relRow: number) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const item = itemById.get(itemId);
      const from = world.placements.find((p) => p.itemId === itemId);
      if (!item || !from) return;
      // 鼠标按住的是"渲染后形状"里的格, 映射回基础形状物理格
      const baseGrab = baseCellFromRendered(item.shape, from.rotation, {
        col: relCol,
        row: relRow,
      });
      const hit = hitTest(e.clientX, e.clientY);
      const next: DragState = {
        itemId,
        from: structuredClone(from),
        baseGrab,
        pointer: { x: e.clientX, y: e.clientY },
        hoverBagId: hit?.bagId ?? bagId,
        pointerCell: hit?.cell ?? null,
        rotation: from.rotation,
        // 初始预览锚点就是原锚点; pointermove 时按"指针格 - 抓取相对格"持续更新
        anchor: { ...from.anchor },
        nudge: { col: 0, row: 0 },
      };
      dragRef.current = next;
      setDrag(next);
      setActionMsg(`开始拖动 ${item.name}(${itemId}), 原位置已预留`);
    },
    [hitTest, itemById, world.placements],
  );

  /* ---------------- 拖动中的预览锚点 ---------------- */
  const dragItem = drag ? itemById.get(drag.itemId) : undefined;

  const previewAnchor = useMemo<Cell | null>(() => {
    if (!drag || !dragItem || !drag.pointerCell) return null;
    return {
      col: drag.anchor.col + drag.nudge.col,
      row: drag.anchor.row + drag.nudge.row,
    };
  }, [drag, dragItem]);

  const plan: DropPlan | null = useMemo(() => {
    if (!drag || !dragItem || !previewAnchor || !drag.hoverBagId) return null;
    return planDrop(items, world, {
      item: dragItem,
      from: drag.from,
      toBagId: drag.hoverBagId,
      anchor: previewAnchor,
      rotation: drag.rotation,
    });
  }, [drag, dragItem, previewAnchor, items, world]);

  /* ---------------- 全局指针移动 / 失焦监听(放下由独立 effect 处理) ---------------- */
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const hit = hitTest(e.clientX, e.clientY);
      const item = itemById.get(d.itemId);
      // 锚点 = 指针所在格 - 被按住物理格在当前朝向下的相对坐标;
      // 这样指针始终停在同一物理格, 跨背包时也自然换算到目标背包坐标系
      let anchor = d.anchor;
      if (hit && item) {
        const rel = renderedRelOf(item.shape, d.rotation, d.baseGrab);
        anchor = { col: hit.cell.col - rel.col, row: hit.cell.row - rel.row };
      }
      const next: DragState = {
        ...d,
        pointer: { x: e.clientX, y: e.clientY },
        hoverBagId: hit?.bagId ?? null,
        pointerCell: hit?.cell ?? null,
        anchor,
        nudge: { col: 0, row: 0 },
      };
      dragRef.current = next;
      setDrag(next);
    };
    const onBlur = () => {
      dragRef.current = null;
      setDrag(null);
      setActionMsg('窗口失焦: 拖动已取消, 物品回到拖动前的位置和朝向');
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('blur', onBlur);
    };
  }, [drag !== null, hitTest]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 旋转(抓取格不动) ---------------- */
  const rotateDrag = useCallback(
    (delta: 1 | -1) => {
      const d = dragRef.current;
      if (!d) return;
      const item = itemById.get(d.itemId);
      if (!item) return;
      // 以当前预览锚点(含微调)为基准, 让被按住的物理格全局位置保持不动
      const baseAnchor = { col: d.anchor.col + d.nudge.col, row: d.anchor.row + d.nudge.row };
      const next = rotateAroundGrab(
        item,
        { itemId: d.itemId, bagId: d.from.bagId, anchor: baseAnchor, rotation: d.rotation },
        d.baseGrab,
        delta,
      );
      const updated: DragState = {
        ...d,
        rotation: next.rotation,
        anchor: next.anchor,
        nudge: { col: 0, row: 0 },
      };
      dragRef.current = updated;
      setDrag(updated);
    },
    [itemById],
  );

  /* ---------------- 键盘: 旋转/微调/取消/确认 ---------------- */
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dragRef.current = null;
        setDrag(null);
        setActionMsg('已按 Esc 取消: 物品回到拖动前的位置和朝向, 不产生历史记录');
        return;
      }
      if (e.key === 'r' || e.key === 'R') {
        e.preventDefault();
        rotateDrag(e.shiftKey ? -1 : 1);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        finishDragRef.current();
        return;
      }
      const nudgeMap: Record<string, Cell> = {
        ArrowUp: { col: 0, row: -1 },
        ArrowDown: { col: 0, row: 1 },
        ArrowLeft: { col: -1, row: 0 },
        ArrowRight: { col: 1, row: 0 },
      };
      const n = nudgeMap[e.key];
      if (n) {
        e.preventDefault();
        const d = dragRef.current;
        if (!d) return;
        const updated: DragState = {
          ...d,
          nudge: { col: d.nudge.col + n.col, row: d.nudge.row + n.row },
        };
        dragRef.current = updated;
        setDrag(updated);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drag !== null, rotateDrag]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 放下 / 取消 ---------------- */
  const finishDrag = useCallback(() => {
    const d = dragRef.current;
    if (!d) return;
    const item = itemById.get(d.itemId);
    if (!item) {
      dragRef.current = null;
      setDrag(null);
      return;
    }
    // 用 ref 中的最新锚点, 不受渲染闭包影响
    const anchor: Cell = { col: d.anchor.col + d.nudge.col, row: d.anchor.row + d.nudge.row };
    if (!d.hoverBagId || !d.pointerCell) {
      setActionMsg('落点在画布外: 拖动取消, 物品回到原位置与朝向');
      dragRef.current = null;
      setDrag(null);
      return;
    }
    const req = {
      item,
      from: d.from,
      toBagId: d.hoverBagId,
      anchor,
      rotation: d.rotation,
    };
    const p = planDrop(items, history.present, req);
    if (p.ok && p.kind !== 'none') {
      const next = executeDrop(history.present, req, p);
      setHistory((h) => commit(h, next));
      const targetBag = history.present.bags.find((b) => b.id === d.hoverBagId)?.name ?? d.hoverBagId;
      if (p.kind === 'swap') {
        const swapItem = itemById.get(p.swapWith ?? '');
        setActionMsg(
          `交换成功: ${item.name}(${item.id}) 与 ${swapItem?.name}(${p.swapWith}) 互换, 各自编号/朝向按规则就位`,
        );
      } else {
        setActionMsg(`放下成功: ${item.name}(${item.id}) 已放入 ${targetBag} 锚点 ${cellKey(anchor)}`);
      }
    } else if (
      // kind 'none' 既可能是 no-op, 也可能是拒绝(碰撞/越界); 用位置朝向是否一致区分
      p.kind === 'none' &&
      d.from.bagId === d.hoverBagId &&
      sameCell(d.from.anchor, anchor) &&
      d.from.rotation === d.rotation
    ) {
      setActionMsg('落点与原位置一致, 未产生变化');
    } else {
      setActionMsg(`放下被拒, 库存未修改: ${p.message ?? '落点非法'}`);
    }
    dragRef.current = null;
    setDrag(null);
  }, [history.present, itemById, items]);

  const finishDragRef = useRef(finishDrag);
  finishDragRef.current = finishDrag;

  // 全局 pointerup 触发 finish
  useEffect(() => {
    if (!drag) return;
    const onUp = () => finishDragRef.current();
    window.addEventListener('pointerup', onUp);
    return () => window.removeEventListener('pointerup', onUp);
  }, [drag !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ---------------- 撤销/重做 ---------------- */
  const doUndo = useCallback(() => {
    if (drag) return;
    setHistory((h) => undo(h));
    setActionMsg('已撤销: 编号、位置、旋转和所在背包一起恢复');
  }, [drag]);

  const doRedo = useCallback(() => {
    if (drag) return;
    setHistory((h) => redo(h));
    setActionMsg('已重做');
  }, [drag]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) doRedo();
        else doUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo]);

  /* ---------------- 样例/持久化 ---------------- */
  const loadSample = useCallback((sample: Sample) => {
    setItems(structuredClone(ITEMS));
    setHistory(createHistory(structuredClone(sample.world)));
    setSampleKey(sample.key);
    setSampleHint(sample.hint);
    setDrag(null);
    setActionMsg(`已载入样例: ${sample.label}`);
  }, []);

  const replaceWorld = useCallback((newItems: ItemDef[], newWorld: WorldState, label: string) => {
    setItems(structuredClone(newItems));
    setHistory(createHistory(structuredClone(newWorld)));
    setSampleKey('__local__');
    setDrag(null);
    setActionMsg(label);
  }, []);

  const handleSaveBrowser = () => {
    saveToLocalStorage(buildLayoutFile(items, world));
    showToast({ kind: 'good', text: '布局已保存到浏览器 localStorage, 刷新页面会自动恢复' });
  };

  const handleExport = () => {
    const file = buildLayoutFile(items, world);
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `grid-inventory-layout-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast({ kind: 'good', text: '布局文件已导出' });
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    const result = parseLayoutText(text);
    if (!result.ok || !result.file) {
      showToast({ kind: 'bad', text: `布局被拒绝, 当前状态保留: ${result.errors.join('; ')}` });
      setActionMsg('载入失败: 布局存在重叠/越界/编号重复等问题, 已保留当前状态');
      return;
    }
    replaceWorld(result.file.items, result.file.world, '布局文件已载入并通过校验');
    showToast({ kind: 'good', text: '布局载入成功, 已旋转物品的占格与文件一致' });
  };

  const handleClearStorage = () => {
    clearLocalStorage();
    showToast({ kind: 'good', text: '浏览器本地存档已清除(当前画面不受影响)' });
  };

  /* ---------------- 统计与预览 ---------------- */
  const totalItems = items.length;
  const occupiedCount = countOccupiedCells(items, world);

  const previews = new Map<string, BagPreview>();
  if (drag && dragItem && previewAnchor && drag.hoverBagId && plan) {
    previews.set(drag.hoverBagId, {
      item: dragItem,
      anchor: previewAnchor,
      rotation: drag.rotation,
      ok: plan.ok,
      reasons: plan.targetCheck.reasons,
      swapWith: plan.swapWith,
    });
  }

  const statusText = (() => {
    if (!drag) return actionMsg;
    if (!drag.hoverBagId || !drag.pointerCell) {
      return '画布外: 松开鼠标或按 Esc 将取消拖动, 物品回到原位置与朝向';
    }
    if (plan?.ok && plan.kind === 'swap') {
      const swapItem = itemById.get(plan.swapWith ?? '');
      const swapOk = plan.swapCheck?.ok;
      return swapOk
        ? `可交换: ${dragItem?.name} ↔ ${swapItem?.name}(${plan.swapWith}), 被换物品保持原朝向放回原锚点`
        : `交换不可行: ${plan.message}`;
    }
    if (plan?.ok) {
      return `落点合法: 松开即可放下(移动到 ${drag.hoverBagId} 锚点 ${cellKey(previewAnchor!)})`;
    }
    return `落点非法: ${plan?.message ?? '未知原因'} (松开将取消, 不修改库存)`;
  })();

  const statusKind = !drag ? 'info' : plan?.ok ? 'ok' : 'bad';

  return (
    <div className="app">
      <header className="app-header">
        <h1>网格背包实验台 · 多格物品旋转 / 跨包拖动 / 交换回滚</h1>
        <p>纯本地运行, 无服务端、无装备后台; 所有图形由 CSS 程序生成。</p>
      </header>

      <div className="sample-bar">
        {SAMPLES.map((s) => (
          <button
            key={s.key}
            data-sample-key={s.key}
            data-testid={`sample-${s.key}`}
            className={sampleKey === s.key ? 'active' : ''}
            onClick={() => loadSample(s)}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="hint-box">{sampleHint}</div>

      <div className="toolbar">
        <button data-testid="btn-undo" onClick={doUndo} disabled={!canUndo(history) || !!drag}>
          ↶ 撤销
        </button>
        <button data-testid="btn-redo" onClick={doRedo} disabled={!canRedo(history) || !!drag}>
          ↷ 重做
        </button>
        <span className="spacer" />
        <button data-testid="btn-save" onClick={handleSaveBrowser}>
          保存到浏览器
        </button>
        <button data-testid="btn-export" onClick={handleExport}>
          导出布局文件
        </button>
        <button data-testid="btn-import" onClick={() => fileInputRef.current?.click()}>
          载入布局文件
        </button>
        <button data-testid="btn-clear-storage" onClick={handleClearStorage}>
          清除本地存档
        </button>
        <input
          ref={fileInputRef}
          className="hidden-file"
          type="file"
          accept="application/json,.json"
          data-testid="input-import"
          onChange={handleImportFile}
        />
      </div>

      <div className="stats">
        <span className="stat-pill" data-testid="stat-items">
          物品总数<b>{totalItems}</b>
        </span>
        <span className="stat-pill" data-testid="stat-cells">
          已占格数(去重)<b>{occupiedCount}</b>
        </span>
        <span className="stat-pill">
          历史栈<b>{history.past.length}</b>
        </span>
        <span className="stat-pill">
          重做栈<b>{history.future.length}</b>
        </span>
      </div>

      <div className="boards">
        {world.bags.map((bag) => (
          <BagView
            key={bag.id}
            ref={(el) => {
              if (el) bagRefs.current.set(bag.id, el);
              else bagRefs.current.delete(bag.id);
            }}
            bag={bag}
            items={items}
            placements={world.placements.filter((p) => p.bagId === bag.id)}
            dragItemId={drag?.itemId ?? null}
            swapTargetId={previews.get(bag.id)?.swapWith}
            preview={previews.get(bag.id)}
            onCellPointerDown={handleCellPointerDown}
          />
        ))}
      </div>

      <div className={`status-line ${statusKind}`} data-testid="status-line">
        {statusText}
      </div>

      <div className="legend">
        <span>
          <i className="dot" style={{ background: '#38d39f' }} /> 合法落点
        </span>
        <span>
          <i className="dot" style={{ background: '#ff5d6c' }} /> 碰撞格 ✕
        </span>
        <span>
          <i className="dot" style={{ background: '#ffb020' }} /> 越界格 ↥
        </span>
        <span>
          <i className="dot" style={{ background: '#5b8cff' }} /> 交换对象
        </span>
      </div>

      <p className="kbd-help" style={{ marginTop: 14 }}>
        操作: 按住物品任意<strong>实占格</strong>拖动 · <kbd>R</kbd> 顺时针旋转 / <kbd>Shift</kbd>+
        <kbd>R</kbd> 逆时针 · 方向键微调锚点 · <kbd>Enter</kbd> 确认放下 · <kbd>Esc</kbd> 取消 ·{' '}
        <kbd>Ctrl</kbd>+<kbd>Z</kbd> 撤销 · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd> 重做。
        拖动中原位置以半透明虚像预留, 库存里每件物品始终只有一份真实占位。
      </p>

      {toast && (
        <div className={`toast ${toast.kind}`} data-testid="toast">
          {toast.text}
        </div>
      )}
    </div>
  );
}
