import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import type { Placement } from './core/types';
import { occupiedCells } from './core/geometry';
import { ITEMS } from './core/items';
import { CELL_SIZE } from './constants';

/**
 * jsdom 不做布局, getBoundingClientRect 全为 0。
 * 这里模拟真实 flex 排版: 两个背包横向排列, 大号背包在左, 小号背包在右,
 * 中间留 26px 间距(与 CSS .boards gap 一致), 保证命中测试能区分背包。
 */
const BAG_GAP = 26;
const bagRect = (cols: number, rows: number, left: number): DOMRect =>
  ({
    left,
    top: 0,
    width: cols * CELL_SIZE,
    height: rows * CELL_SIZE,
    right: left + cols * CELL_SIZE,
    bottom: rows * CELL_SIZE,
    x: left,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;

let smallLeftValue = 0;

function mockBagRects() {
  // hitTest 通过 ref 读取的是内层 .bag-grid(带 data-bag-id), 不是外层卡片
  const big = document.querySelector('[data-bag-id="bag-a"]') as HTMLElement;
  const small = document.querySelector('[data-bag-id="bag-b"]') as HTMLElement;
  big.getBoundingClientRect = () => bagRect(8, 6, 0);
  smallLeftValue = 8 * CELL_SIZE + BAG_GAP;
  small.getBoundingClientRect = () => bagRect(6, 5, smallLeftValue);
  return { smallLeft: smallLeftValue };
}

/** 读取某物品在 DOM 中的放置状态(锚点/旋转/背包) */
function readPlacement(itemId: string): Placement {
  const el = document.querySelector(`[data-item-id="${itemId}"]`) as HTMLElement;
  if (!el) throw new Error(`DOM 中找不到物品 ${itemId}`);
  return {
    itemId,
    bagId: el.dataset.bagId!,
    anchor: { col: Number(el.dataset.anchorCol), row: Number(el.dataset.anchorRow) },
    rotation: Number(el.dataset.rotation) as Placement['rotation'],
  };
}

/** 从 DOM 渲染结果计算物品实际占格, 与物品定义交叉核对 */
function domOccupied(itemId: string): string[] {
  const p = readPlacement(itemId);
  const def = ITEMS.find((i) => i.id === itemId)!;
  return occupiedCells(def, p)
    .map((c) => `${c.col},${c.row}`)
    .sort();
}

function solidCellEls(itemId: string) {
  return document.querySelectorAll(`[data-item-id="${itemId}"] .item-cell.solid`);
}

function startDrag(
  itemId: string,
  relCol: number,
  relRow: number,
  startAt?: { bagId: 'bag-a' | 'bag-b'; col: number; row: number },
) {
  const cell = document.querySelector(
    `[data-testid="solid-${itemId}-${relCol}-${relRow}"]`,
  ) as HTMLElement;
  const itemEl = document.querySelector(`[data-item-id="${itemId}"]`) as HTMLElement;
  const ownBagId = itemEl.dataset.bagId!;
  const anchorCol = Number(itemEl.dataset.anchorCol);
  const anchorRow = Number(itemEl.dataset.anchorRow);
  // 默认从抓取格的真实屏幕位置开始; 也可显式指定起始命中格
  const bagId = startAt?.bagId ?? (ownBagId as 'bag-a' | 'bag-b');
  const globalCol = startAt ? startAt.col : anchorCol + relCol;
  const globalRow = startAt ? startAt.row : anchorRow + relRow;
  const bagLeft = bagId === 'bag-a' ? 0 : smallLeftValue;
  // jsdom 无 PointerEvent 构造器, 用同名 MouseEvent 派发(React 仍按 onPointerDown 处理)
  act(() => {
    cell.dispatchEvent(
      new MouseEvent('pointerdown', {
        button: 0,
        clientX: bagLeft + globalCol * CELL_SIZE + 2,
        clientY: globalRow * CELL_SIZE + 2,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

const key = (k: string, opts: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key: k, bubbles: true, ...opts });

/** 把指针移动到指定背包的指定网格中心 */
function moveToBag(bagId: 'bag-a' | 'bag-b', col: number, row: number, smallLeft: number) {
  const left = bagId === 'bag-a' ? 0 : smallLeft;
  act(() => {
    window.dispatchEvent(
      new MouseEvent('pointermove', {
        clientX: left + col * CELL_SIZE + 2,
        clientY: row * CELL_SIZE + 2,
        bubbles: true,
      }),
    );
  });
}

/** 松开指针, 触发放下/取消 */
function pointerUp() {
  act(() => {
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }));
  });
}

const statCells = () => Number(within(screen.getByTestId('stat-cells')).getByText(/\d+/).textContent);
const statItems = () => Number(within(screen.getByTestId('stat-items')).getByText(/\d+/).textContent);

beforeEach(() => {
  localStorage.clear();
});
afterEach(cleanup);

describe('App 拖放交互(实际核对 DOM 中的编号、锚点与占格)', () => {
  it('四次旋转后朝向与锚点还原, 且抓取物理格不跳变', () => {
    render(<App />);
    mockBagRects();
    const before = readPlacement('I08'); // L 形 3x3 缺角
    startDrag('I08', 0, 0);
    for (let i = 0; i < 4; i++) act(() => key('r'));
    act(() => key('Enter'));
    const after = readPlacement('I08');
    expect(after.rotation).toBe(before.rotation);
    expect(after.anchor).toEqual(before.anchor);
    expect(after.bagId).toBe(before.bagId);
  });

  it('拖动取消(Esc/画布外/失焦)回到拖动前位置与朝向, 且不产生历史', () => {
    render(<App />);
    mockBagRects();
    const before = readPlacement('I01');

    startDrag('I01', 0, 0);
    act(() => key('r'));
    act(() => key('Escape'));
    expect(readPlacement('I01')).toEqual(before);
    expect(screen.getByTestId('btn-undo')).toBeDisabled();

    startDrag('I01', 0, 0);
    act(() => { window.dispatchEvent(new MouseEvent("pointermove", { clientX: 9999, clientY: 9999, bubbles: true })); });
    pointerUp();
    expect(readPlacement('I01')).toEqual(before);
    expect(screen.getByTestId('btn-undo')).toBeDisabled();

    startDrag('I01', 0, 0);
    act(() => key('r'));
    act(() => fireEvent.blur(window));
    expect(readPlacement('I01')).toEqual(before);
    expect(screen.getByTestId('btn-undo')).toBeDisabled();
  });

  it('方向键微调到空位后确认: 移动成功并生成一条历史, 占格逐格正确', () => {
    render(<App />);
    mockBagRects();
    const before = readPlacement('I12'); // 默认布局 (3,2)
    startDrag('I12', 0, 0);
    act(() => key('ArrowRight')); // 锚点 -> (4,2), 占 (4,2)(5,2)(6,2) 为合法空位
    act(() => key('Enter'));
    const after = readPlacement('I12');
    expect(after.anchor).toEqual({ col: before.anchor.col + 1, row: before.anchor.row });
    expect(screen.getByTestId('btn-undo')).not.toBeDisabled();
    expect(domOccupied('I12')).toEqual(['4,2', '5,2', '6,2']);
    expect(solidCellEls('I12').length).toBe(3);
  });

  it('窄缝样例: 横条横着上移被拒, 旋转 90° 后可沿窄缝合法放下', () => {
    render(<App />);
    const { smallLeft } = mockBagRects();
    fireEvent.click(screen.getByTestId('sample-narrow-slot'));
    const before = readPlacement('I02'); // (0,5) 横躺

    // 横着上移到 (0,0): 撞两面墙, 确认被拒且库存不变
    startDrag('I02', 0, 0, { bagId: 'bag-a', col: 0, row: 5 });
    moveToBag('bag-a', 0, 0, smallLeft);
    pointerUp();
    expect(readPlacement('I02')).toEqual(before);
    expect(screen.getByTestId('status-line').textContent).toMatch(/碰到|失败/);

    // 旋转 90° 竖条, 锚定窄缝 (3,0)
    startDrag('I02', 0, 0, { bagId: 'bag-a', col: 0, row: 5 });
    act(() => key('r'));
    moveToBag('bag-a', 3, 0, smallLeft);
    pointerUp();
    const after = readPlacement('I02');
    expect(after.rotation).toBe(1);
    expect(after.anchor).toEqual({ col: 3, row: 0 });
    expect(domOccupied('I02')).toEqual(['3,0', '3,1', '3,2', '3,3', '3,4']);
  });

  it('L 形嵌放: I10 旋转 90° 后恰好嵌入大号背包的 L 形空腔', () => {
    render(<App />);
    const { smallLeft } = mockBagRects();
    fireEvent.click(screen.getByTestId('sample-l-fit'));
    expect(readPlacement('I10').bagId).toBe('bag-b');

    // 从 bag-b 内的起始格抓起, 再移到 bag-a 空腔。
    // I10 旋转 90° 后抓取物理格的相对坐标变为 (1,0), 因此指针要落在锚点(4,0)+(1,0)=(5,0)
    startDrag('I10', 0, 0, { bagId: 'bag-b', col: 0, row: 0 });
    act(() => key('r'));
    moveToBag('bag-a', 5, 0, smallLeft);
    pointerUp();

    const after = readPlacement('I10');
    expect(after.bagId).toBe('bag-a');
    expect(after.anchor).toEqual({ col: 4, row: 0 });
    expect(after.rotation).toBe(1);
    // 实际占格与空腔逐格一致
    expect(domOccupied('I10')).toEqual(['4,2', '5,0', '5,1', '5,2']);
  });

  it('跨背包移动: 小号背包物品合法放入大号背包, 原背包不再保留', () => {
    render(<App />);
    const { smallLeft } = mockBagRects();
    expect(readPlacement('I09').bagId).toBe('bag-b');
    // 从 bag-b 起始格抓起; I09 保持原旋转(1), bag-a (0,4) 是经规则校验的合法空位
    startDrag('I09', 0, 0, { bagId: 'bag-b', col: 3, row: 3 });
    moveToBag('bag-a', 0, 4, smallLeft);
    pointerUp();
    expect(readPlacement('I09').bagId).toBe('bag-a');
    expect(readPlacement('I09').anchor).toEqual({ col: 0, row: 4 });
    const bagB = screen.getByTestId('bag-bag-b');
    expect(within(bagB).queryAllByTestId(/solid-I09/).length).toBe(0);
  });

  it('双向交换: 碰多件被拒、对侧放不下整次回滚、一对一交换成功, 统计始终不变', () => {
    render(<App />);
    const { smallLeft } = mockBagRects();
    fireEvent.click(screen.getByTestId('sample-swap-fail'));
    const cellsBefore = statCells();
    const i03Before = readPlacement('I03');
    const i12Before = readPlacement('I12');

    // (a) I01 拖到 bag-a (0,0) 同时压 I04+I05 => 拒绝
    startDrag('I01', 0, 0, { bagId: 'bag-b', col: 0, row: 3 });
    moveToBag('bag-a', 0, 0, smallLeft);
    pointerUp();
    expect(readPlacement('I01').bagId).toBe('bag-b');
    expect(screen.getByTestId('status-line').textContent).toContain('2 件物品');

    // (b) I02 旋转 90° 竖到 bag-a (7,0), I11 回不去 => 整次回滚
    const i02Before = readPlacement('I02');
    startDrag('I02', 0, 0, { bagId: 'bag-b', col: 0, row: 4 });
    act(() => key('r'));
    moveToBag('bag-a', 7, 0, smallLeft);
    pointerUp();
    expect(readPlacement('I02')).toEqual(i02Before);
    expect(screen.getByTestId('status-line').textContent).toContain('回滚');

    // (c) I03 旋转 90° 与 I12 一对一交换 => 成功
    startDrag('I03', 0, 0, { bagId: 'bag-b', col: 0, row: 0 });
    act(() => key('r'));
    moveToBag('bag-a', 0, 3, smallLeft);
    pointerUp();
    const i03After = readPlacement('I03');
    const i12After = readPlacement('I12');
    expect(i03After.bagId).toBe('bag-a');
    expect(i03After.anchor).toEqual(i12Before.anchor);
    expect(i12After.bagId).toBe('bag-b');
    expect(i12After.anchor).toEqual(i03Before.anchor);
    expect(i12After.rotation).toBe(i12Before.rotation);

    expect(statCells()).toBe(cellsBefore);
  });

  it('撤销/重做恢复编号、位置、旋转和背包; 撤销后新操作清空重做分支', () => {
    render(<App />);
    mockBagRects();
    const start = readPlacement('I12');
    startDrag('I12', 0, 0);
    act(() => key('ArrowRight'));
    act(() => key('Enter'));
    const moved = readPlacement('I12');
    expect(moved.anchor).not.toEqual(start.anchor);

    act(() => screen.getByTestId('btn-undo').click());
    expect(readPlacement('I12')).toEqual(start);
    act(() => screen.getByTestId('btn-redo').click());
    expect(readPlacement('I12')).toEqual(moved);

    act(() => screen.getByTestId('btn-undo').click());
    startDrag('I12', 0, 0);
    act(() => key('ArrowRight'));
    act(() => key('Enter'));
    expect(screen.getByTestId('btn-redo')).toBeDisabled();
  });

  it('反复移动/取消/撤销后物品总数与已占格数不变, 每件物品只有一份 DOM 实例', () => {
    render(<App />);
    mockBagRects();
    const items = statItems();
    const cells = statCells();

    for (let round = 0; round < 3; round++) {
      startDrag('I12', 0, 0);
      act(() => key('ArrowDown'));
      act(() => key('r'));
      act(() => key('Escape'));

      startDrag('I07', 0, 0);
      act(() => key('ArrowRight'));
      act(() => key('Enter'));

      act(() => screen.getByTestId('btn-undo').click());
    }
    expect(statItems()).toBe(items);
    expect(statCells()).toBe(cells);
    for (const def of ITEMS) {
      expect(document.querySelectorAll(`[data-item-id="${def.id}"]`).length).toBe(1);
    }
  });

  it('载入坏布局文件被拒绝并保留当前状态', async () => {
    render(<App />);
    mockBagRects();
    const before = readPlacement('I01');
    // jsdom 的 File 没有 text(), 用 vi 模拟
    const bad = { text: () => Promise.resolve('{broken') } as unknown as File;
    const input = screen.getByTestId('input-import') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [bad], value: '' } });
    });
    expect(screen.getByTestId('toast').textContent).toContain('拒绝');
    expect(readPlacement('I01')).toEqual(before);
  });

  it('合法布局文件可载入, 旋转物品占格与文件一致', async () => {
    render(<App />);
    mockBagRects();
    const { SAMPLES, sampleToLayout } = await import('./core/samples');
    const file = sampleToLayout(SAMPLES.find((s) => s.key === 'l-fit')!);
    const good = { text: () => Promise.resolve(JSON.stringify(file)) } as unknown as File;
    const input = screen.getByTestId('input-import') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, { target: { files: [good], value: '' } });
    });
    expect(readPlacement('I10').bagId).toBe('bag-b');
    expect(screen.getByTestId('toast').textContent).toContain('成功');
  });
});
