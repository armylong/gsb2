import type { CSSProperties } from 'react';
import type { ItemDef, Placement } from '../core/types';
import { boundsOf, rotatedShape } from '../core/geometry';
import { CELL_SIZE } from '../constants';

interface ItemViewProps {
  item: ItemDef;
  placement: Placement;
  /** 虚像: 拖动中的原位置预留, 不再响应指针 */
  ghost?: boolean;
  /** 落点预览状态 */
  preview?: 'ok' | 'bad';
  /** 交换中被换物品的高亮 */
  swapSource?: boolean;
  /** 仅渲染(预览层)时不接收事件 */
  nonInteractive?: boolean;
  onCellPointerDown?: (e: React.PointerEvent, itemId: string, relCol: number, relRow: number) => void;
}

/**
 * 渲染一件物品:
 * - 实占格为实色斜纹块, 包围盒内的空缺格渲染为虚线块(同一物品的空缺可容纳别的物品)
 * - 编号印在每个实占格上, 保证"实际占用哪些格"一眼可见
 */
export function ItemView({
  item,
  placement,
  ghost = false,
  preview,
  swapSource = false,
  nonInteractive = false,
  onCellPointerDown,
}: ItemViewProps) {
  const shape = rotatedShape(item.shape, placement.rotation);
  const bounds = boundsOf(shape);
  const occupied = new Set(shape.map((c) => `${c.col},${c.row}`));

  const classes = ['item'];
  if (ghost) classes.push('ghost');
  if (!nonInteractive) classes.push('interactive');
  if (preview === 'ok') classes.push('preview-ok');
  if (preview === 'bad') classes.push('preview-bad');
  if (swapSource) classes.push('swap-source');

  const style: CSSProperties = {
    left: placement.anchor.col * CELL_SIZE,
    top: placement.anchor.row * CELL_SIZE,
    width: bounds.cols * CELL_SIZE,
    height: bounds.rows * CELL_SIZE,
    // @ts-expect-error 自定义属性传给 CSS
    '--hue': item.hue,
  };

  const cells = [];
  for (let row = 0; row < bounds.rows; row++) {
    for (let col = 0; col < bounds.cols; col++) {
      const isSolid = occupied.has(`${col},${row}`);
      cells.push(
        <div
          key={`${col}-${row}`}
          className={`item-cell ${isSolid ? 'solid' : 'hollow'}`}
          data-testid={isSolid ? `solid-${item.id}-${col}-${row}` : undefined}
          style={{ left: col * CELL_SIZE, top: row * CELL_SIZE }}
          onPointerDown={
            isSolid && !nonInteractive && onCellPointerDown
              ? (e) => onCellPointerDown(e, item.id, col, row)
              : undefined
          }
        >
          <div className="fill">{isSolid ? item.id.slice(1) : ''}</div>
        </div>,
      );
    }
  }

  return (
    <div
      className={classes.join(' ')}
      style={style}
      data-item-id={item.id}
      data-bag-id={placement.bagId}
      data-rotation={placement.rotation}
      data-anchor-col={placement.anchor.col}
      data-anchor-row={placement.anchor.row}
    >
      {cells}
    </div>
  );
}
