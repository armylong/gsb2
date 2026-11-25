"""右侧阅读顺序列表面板: 可拖拽改序, 显示序号/跨行标记/归属带。"""

from __future__ import annotations

from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QDropEvent
from PySide6.QtWidgets import (
    QAbstractItemView,
    QListWidget,
    QListWidgetItem,
)

from ..ordering import OrderInfo


class OrderListWidget(QListWidget):
    order_swapped = Signal(int, int)  # 两个 panel 索引

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setDragDropMode(QAbstractItemView.DragDropMode.InternalMove)
        self.setDefaultDropAction(Qt.DropAction.MoveAction)
        self.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.setAlternatingRowColors(True)
        self._indices: list[int] = []

    def refresh(self, panels, info: OrderInfo, manual_order: list[int] | None):
        self.clear()
        order = manual_order if manual_order is not None else info.order
        self._indices = list(order)
        band_of = {}
        for bi, ids in info.bands:
            for i in ids:
                band_of[i] = bi

        for seq, idx in enumerate(order, start=1):
            x0, y0, x1, y1 = panels[idx]
            span = "跨行" if idx in info.spanning else ""
            band = band_of.get(idx, -1)
            text = (
                f"#{seq}  格{idx}  带{band}  "
                f"({x0},{y0})-({x1},{y1})  {span}"
            )
            item = QListWidgetItem(text)
            item.setData(Qt.ItemDataRole.UserRole, idx)
            if idx in info.spanning:
                from PySide6.QtGui import QColor
                item.setBackground(QColor(255, 236, 200))
            self.addItem(item)

    def dropEvent(self, event: QDropEvent):
        src = self.currentRow()
        super().dropEvent(event)
        dst = self.currentRow()
        if 0 <= src < len(self._indices) and 0 <= dst < len(self._indices):
            # 交换语义用用户拖动的源/目标面板索引
            a = self._indices[src]
            b = self._indices[dst]
            self.order_swapped.emit(a, b)
