"""可撤销的逐块修补会话.

语义:
  * 已提交结果按顺序构成历史, undo() 逐条回退;
  * 当前遮罩只参与 preview(), 不触碰已提交结果;
  * commit() 把"当前遮罩 + 所选方法"作用在已提交结果之上并入栈;
  * 任何方法都保证遮罩外像素不变 (由 inpaint 层保证, 此处再次校验).
"""

from __future__ import annotations

import numpy as np

from .inpaint import inpaint, METHODS


class RepairSession:
    def __init__(self, image: np.ndarray):
        self._base = image.copy()
        self._committed = image.copy()
        self._history: list[tuple[np.ndarray, np.ndarray]] = []  # (mask, 之前的图像)

    @property
    def result(self) -> np.ndarray:
        """当前已提交结果 (不含未提交的预览)."""
        return self._committed

    @property
    def depth(self) -> int:
        return len(self._history)

    def preview(self, mask: np.ndarray, method: str, **kw) -> np.ndarray:
        """在当前已提交结果上试算, 不改变任何状态."""
        if method not in METHODS:
            raise ValueError(f"未知方法: {method}")
        m = (mask > 0).astype(np.uint8)
        if not m.any():
            return self._committed.copy()
        return inpaint(self._committed, m, method, **kw)

    def commit(self, mask: np.ndarray, method: str, **kw) -> np.ndarray:
        """把当前遮罩的修补结果提交到历史."""
        m = (mask > 0).astype(np.uint8)
        if not m.any():
            return self._committed
        new = inpaint(self._committed, m, method, **kw)
        # 双保险: 遮罩外必须与提交前一致
        assert np.array_equal(new[m == 0], self._committed[m == 0]), "遮罩外像素被改动"
        self._history.append((m, self._committed))
        self._committed = new
        return self._committed

    def undo(self) -> bool:
        """撤销最近一次提交. 返回是否有可撤销项."""
        if not self._history:
            return False
        _, prev = self._history.pop()
        self._committed = prev
        return True

    def reset(self) -> None:
        self._history.clear()
        self._committed = self._base.copy()
