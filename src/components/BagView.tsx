import { forwardRef } from 'react';
import type { BagDef, Cell, ItemDef, Placement } from '../core/types';
import { CELL_SIZE } from '../constants';
import { ItemView } from './ItemView';
import { occupiedCells } from '../core/geometry';
import type { BlockReason } from '../core/inventory';

export interface BagPreview {
  item: ItemDef;
  anchor: Cell;
  rotation: Placement['rotation'];
  ok: boolean;
  reasons: BlockReason[];
  swapWith?: string;
}

interface BagViewProps {
  bag: BagDef;
  items: ItemDef[];
  placements: Placement[];
  dragItemId: string | null;
  /** 拖动中被撞且可作为交换对象的物品 id */
  swapTargetId?: string;
  preview?: BagPreview;
  onCellPointerDown: (
    e: React.PointerEvent,
    bagId: string,
    itemId: string,
    relCol: number,
    relRow: number,
  ) => void;
}

export const BagView = forwardRef<HTMLDivElement, BagViewProps>(function BagView(
  { bag, items, placements, dragItemId, swapTargetId, preview, onCellPointerDown },
  ref,
) {
  const itemById = new Map(items.map((i) => [i.id, i]));
  const width = bag.cols * CELL_SIZE;
  const height = bag.rows * CELL_SIZE;

  const gridCells = [];
  for (let r = 0; r < bag.rows; r++) {
    for (let c = 0; c < bag.cols; c++) {
      gridCells.push(<div key={`${c}-${r}`} className="grid-cell" />);
    }
  }

  // 越界格无法显示在网格内, 仅展示落在网格范围内的问题标记
  const problemMarkers: { col: number; row: number; kind: 'collision' | 'out' }[] = [];
  if (preview) {
    for (const reason of preview.reasons) {
      for (const cell of reason.cells) {
        if (cell.col >= 0 && cell.col < bag.cols && cell.row >= 0 && cell.row < bag.rows) {
          problemMarkers.push({
            col: cell.col,
            row: cell.row,
            kind: reason.kind === 'out-of-bounds' ? 'out' : 'collision',
          });
        }
      }
    }
  }

  const usedCells = new Set<string>();
  for (const pl of placements) {
    const item = itemById.get(pl.itemId);
    if (!item) continue;
    for (const c of occupiedCells(item, pl)) usedCells.add(`${c.col},${c.row}`);
  }

  return (
    <div className="bag-card" data-testid={`bag-${bag.id}`}>
      <h2>{bag.name}</h2>
      <div className="bag-meta">
        {bag.cols} 列 × {bag.rows} 行 · 容量 {bag.cols * bag.rows} 格 · 已占 {usedCells.size} 格
      </div>
      <div
        ref={ref}
        className="bag-grid"
        data-bag-id={bag.id}
        data-cols={bag.cols}
        data-rows={bag.rows}
        style={{
          width,
          height,
          gridTemplateColumns: `repeat(${bag.cols}, ${CELL_SIZE}px)`,
          gridTemplateRows: `repeat(${bag.rows}, ${CELL_SIZE}px)`,
        }}
        onPointerDown={(e) => {
          // 空白格按下不启动拖动; 物品格的事件由 ItemView 处理
          e.stopPropagation();
        }}
      >
        {gridCells}

        {placements.map((pl) => {
          const item = itemById.get(pl.itemId);
          if (!item) return null;
          const isDragged = pl.itemId === dragItemId;
          return (
            <ItemView
              key={pl.itemId}
              item={item}
              placement={pl}
              ghost={isDragged}
              swapSource={!isDragged && pl.itemId === swapTargetId}
              nonInteractive={isDragged}
              onCellPointerDown={(e, itemId, relCol, relRow) =>
                onCellPointerDown(e, bag.id, itemId, relCol, relRow)
              }
            />
          );
        })}

        {preview && (
          <ItemView
            item={preview.item}
            placement={{
              itemId: preview.item.id,
              bagId: bag.id,
              anchor: preview.anchor,
              rotation: preview.rotation,
            }}
            preview={preview.ok ? 'ok' : 'bad'}
            nonInteractive
          />
        )}

        {problemMarkers.map((m, i) => (
          <div
            key={i}
            className={`problem-marker ${m.kind}`}
            data-testid={`problem-${m.kind}-${m.col}-${m.row}`}
            style={{ left: m.col * CELL_SIZE, top: m.row * CELL_SIZE }}
          >
            <div className="tag">{m.kind === 'out' ? '↥' : '✕'}</div>
          </div>
        ))}
      </div>
    </div>
  );
});
