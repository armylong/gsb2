"""Right dock: defect components, neighbourhood inspection and patching."""

from __future__ import annotations

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QColor
from PySide6.QtWidgets import (
    QAbstractItemView,
    QButtonGroup,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QPushButton,
    QRadioButton,
    QSpinBox,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..core import Component, Frame, ReferenceModel


def _rgb_u8(data: np.ndarray, lo: float, hi: float) -> np.ndarray:
    if hi <= lo:
        hi = lo + 1.0
    scaled = np.clip((data - lo) / (hi - lo) * 255.0, 0, 255)
    scaled = np.where(np.isfinite(scaled), scaled, 0).astype(np.uint8)
    return np.dstack([scaled, scaled, scaled])


class NeighborhoodCanvas(QWidget):
    """Enlarged view of one defect neighbourhood with the defect footprint marked."""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumSize(240, 200)
        self._image: np.ndarray | None = None
        self._labels: np.ndarray | None = None
        self._values: np.ndarray | None = None
        self._target: int | None = None
        self._bbox: tuple[int, int, int, int] | None = None

    def set_region(self, data: np.ndarray | None, labels: np.ndarray | None,
                   target: int | None, bbox: tuple[int, int, int, int] | None,
                   values: np.ndarray | None = None) -> None:
        self._labels = None if labels is None else np.asarray(labels)
        self._values = values
        if data is None:
            self._image = None
            self.update()
            return
        finite = np.isfinite(data)
        if finite.any():
            vals = data[finite]
            lo, hi = np.percentile(vals, [5, 95])
        else:
            lo, hi = 0.0, 1.0
        rgb = _rgb_u8(data, float(lo), float(hi))
        if self._labels is not None:
            mask = self._labels == target if target is not None else self._labels > 0
            rgb[mask] = [255, 90, 90]
        self._image = np.ascontiguousarray(np.dstack([rgb, np.full(rgb.shape[:2], 255, np.uint8)]))
        self._target = target
        self._bbox = bbox
        self.update()

    def paintEvent(self, event) -> None:  # noqa: N802
        from PySide6.QtGui import QImage, QPainter, QPen, QPixmap

        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(24, 26, 30))
        if self._image is None:
            painter.setPen(QColor(150, 155, 165))
            painter.drawText(self.rect(), Qt.AlignCenter, "在列表中选择一个缺陷像素或区域")
            painter.end()
            return
        h, w = self._image.shape[:2]
        image = QImage(self._image.data, w, h, w * 4, QImage.Format_RGBA8888).copy()
        scale = max(1, min(self.width() // max(w, 1), self.height() // max(h, 1)))
        rect_w, rect_h = w * scale, h * scale
        x0 = (self.width() - rect_w) // 2
        y0 = (self.height() - rect_h) // 2
        painter.drawPixmap(x0, y0, QPixmap.fromImage(image).scaled(
            rect_w, rect_h, Qt.IgnoreAspectRatio, Qt.FastTransformation))
        pen = QPen(QColor(255, 210, 90), 1)
        painter.setPen(pen)
        painter.drawRect(x0 - 1, y0 - 1, rect_w + 1, rect_h + 1)
        pen = QPen(QColor(120, 200, 255), 1, Qt.DashLine)
        painter.setPen(pen)
        cx, cy = x0 + rect_w // 2, y0 + rect_h // 2
        painter.drawLine(cx, y0, cx, y0 + rect_h)
        painter.drawLine(x0, cy, x0 + rect_w, cy)
        painter.end()

    def values_at_center(self) -> str:
        if self._values is None:
            return ""
        h, w = self._values.shape
        cy, cx = h // 2, w // 2
        v = self._values[cy, cx]
        return "—" if not np.isfinite(v) else f"{v:.1f}"


class DefectPanel(QWidget):
    """Lists invalid regions and exposes the patch decision."""

    patchPolicyChanged = Signal(str)
    selectionChanged = Signal(int)     # component id, -1 = none
    patchSelectionChanged = Signal(set)
    locateRequested = Signal(int)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumWidth(360)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(8, 8, 8, 8)
        layout.setSpacing(8)

        self.summary = QLabel("生成参考后显示缺陷分类统计。")
        self.summary.setWordWrap(True)
        self.summary.setTextInteractionFlags(Qt.TextSelectableByMouse)
        layout.addWidget(self.summary)

        legend = QLabel(
            '<span style="color:#4682ff">■</span> 亮场接近零 '
            '<span style="color:#ff3c3c">■</span> 长期饱和 '
            '<span style="color:#ffa500">■</span> 起伏很大 '
            '<span style="color:#00e6a0">■</span> 已修补')
        legend.setTextFormat(Qt.RichText)
        legend.setStyleSheet("font-size: 10px;")
        layout.addWidget(legend)

        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["#", "类别", "面积", "区域 行/列", "状态"])
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.ExtendedSelection)
        self.table.setAlternatingRowColors(True)
        header = self.table.horizontalHeader()
        header.setStretchLastSection(False)
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(3, QHeaderView.Stretch)
        header.setSectionResizeMode(4, QHeaderView.ResizeToContents)
        self.table.itemSelectionChanged.connect(self._on_table_selection)
        self.table.itemChanged.connect(self._on_item_changed)
        self.table.doubleClicked.connect(self._locate_selected)
        layout.addWidget(self.table, 1)

        patch_box = QGroupBox("修补策略")
        patch_layout = QVBoxLayout(patch_box)
        patch_layout.setContentsMargins(8, 8, 8, 8)
        self.group = QButtonGroup(self)
        options = [
            ("none", "不修补 (保留为无效, 导出 0 并写入掩膜)"),
            ("small", "只修补零散/小片缺陷"),
            ("selected", "只修补列表中勾选的区域"),
            ("all", "全部修补 (含大片遮挡区, 不推荐)"),
        ]
        for value, text in options:
            radio = QRadioButton(text)
            radio.setProperty("policy", value)
            if value == "none":
                radio.setChecked(True)
            self.group.addButton(radio)
            patch_layout.addWidget(radio)
        self.group.buttonToggled.connect(self._on_policy_toggled)
        layout.addWidget(patch_box)

        self.large_warning = QLabel("")
        self.large_warning.setWordWrap(True)
        self.large_warning.setTextFormat(Qt.RichText)
        self.large_warning.setStyleSheet(
            "font-size: 11px; background:#3a2a12; border:1px solid #7a5a20; "
            "border-radius:4px; padding:6px; color:#ffcf8a;")
        self.large_warning.setVisible(False)
        layout.addWidget(self.large_warning)

        inspect_box = QGroupBox("邻域检查")
        inspect_layout = QVBoxLayout(inspect_box)
        inspect_layout.setContentsMargins(8, 8, 8, 8)
        size_row = QHBoxLayout()
        size_row.addWidget(QLabel("邻域半径"))
        self.radius = QSpinBox()
        self.radius.setRange(2, 40)
        self.radius.setValue(6)
        self.radius.valueChanged.connect(self._refresh_neighborhood)
        size_row.addWidget(self.radius)
        size_row.addStretch(1)
        inspect_layout.addLayout(size_row)
        self.canvas = NeighborhoodCanvas()
        inspect_layout.addWidget(self.canvas)
        self.detail = QLabel("")
        self.detail.setWordWrap(True)
        self.detail.setTextInteractionFlags(Qt.TextSelectableByMouse)
        self.detail.setStyleSheet("font-size: 11px;")
        inspect_layout.addWidget(self.detail)
        locate = QPushButton("在主图上定位")
        locate.clicked.connect(self._locate_selected)
        inspect_layout.addWidget(locate)
        layout.addWidget(inspect_box)

        self._model: ReferenceModel | None = None
        self._sample: Frame | None = None
        self._components: list[Component] = []
        self._current: int = -1
        self._marked: set[int] = set()
        self._updating = False

    # ------------------------------------------------------------------ #
    def set_model(self, model: ReferenceModel | None,
                  sample: Frame | None = None) -> None:
        self._model = model
        self._sample = sample
        self._components = [] if model is None else model.defects.components
        self._current = -1
        valid_ids = {c.id for c in self._components}
        self._marked &= valid_ids   # keep user's ticked regions across rebuilds
        self._updating = True
        self.table.blockSignals(True)
        self.table.setRowCount(len(self._components))
        patched = set(model.patch_ids) if model is not None else set()
        for row, comp in enumerate(self._components):
            status = "已修补" if comp.id in patched else ("大面积保留" if comp.large else "保留")
            r0, c0, r1, c1 = comp.bbox
            cells = [f"{comp.id}", comp.category, f"{comp.area:,}",
                     f"{r0}-{r1} / {c0}-{c1}", status]
            for col, text in enumerate(cells):
                item = QTableWidgetItem(text)
                flags = Qt.ItemIsEnabled | Qt.ItemIsSelectable
                if col == 0:
                    item.setFlags(flags | Qt.ItemIsUserCheckable)
                    item.setCheckState(Qt.Checked if comp.id in self._marked else Qt.Unchecked)
                else:
                    item.setFlags(flags)
                if comp.large and col == 4:
                    item.setForeground(QColor("#ffb454"))
                if comp.id in patched and col == 4:
                    item.setForeground(QColor("#00e6a0"))
                if col == 3:
                    item.setToolTip("行范围 / 列范围")
                if col == 1:
                    item.setForeground(QColor({
                        "亮场接近零": "#4682ff",
                        "长期饱和": "#ff5c5c",
                        "起伏很大": "#ffa500",
                    }.get(comp.category, "#c8ccd4")))
                self.table.setItem(row, col, item)
        self.table.blockSignals(False)
        self._updating = False

        if model is None:
            self.summary.setText("生成参考后显示缺陷分类统计。")
            self.large_warning.setVisible(False)
            return
        defects = model.defects
        selected_note = ""
        if getattr(model, "patch_policy", "") == "selected" and not self._marked:
            selected_note = "\n<span style='color:#ffb454'>当前策略为“只修补勾选区域”, " \
                            "但尚未勾选任何区域。</span>"
        self.summary.setText(
            f"低响应 {int(defects.low.sum()):,} px · 饱和 {int(defects.saturated.sum()):,} px · "
            f"不稳定 {int(defects.unstable.sum()):,} px · 合计 {len(self._components)} 个连通区域\n"
            f"有效像素 {model.valid_fraction:.2%} · 已修补 {int(model.patched_mask.sum()):,} px"
            + selected_note)
        self.summary.setTextFormat(Qt.RichText)
        large = defects.large_components
        if large:
            biggest = max(large, key=lambda c: c.area)
            r0, c0, r1, c1 = biggest.bbox
            text = (f"<b>⚠ 检测到 {len(large)} 片连成一片的大面积无效数据</b><br>"
                    f"最大 {biggest.area:,} px, 行 {r0}-{r1}, 列 {c0}-{c1} "
                    f"(约 {biggest.area / max(model.valid_mask.size, 1):.1%} 画面)。<br>"
                    "这类区域多半是遮挡或镜头结构, 建议保持无效, 不要用邻域插值掩盖。")
            self.large_warning.setText(text)
            self.large_warning.setVisible(True)
        else:
            self.large_warning.setVisible(False)
        self.canvas.set_region(None, None, None, None)

    def set_policy(self, policy: str) -> None:
        for button in self.group.buttons():
            if button.property("policy") == policy:
                button.blockSignals(True)
                button.setChecked(True)
                button.blockSignals(False)

    def _on_policy_toggled(self, button, checked: bool) -> None:
        if not checked:
            return
        self.patchPolicyChanged.emit(button.property("policy"))

    def _on_table_selection(self) -> None:
        rows = sorted({index.row() for index in self.table.selectedIndexes()})
        if not rows:
            return
        comp = self._components[rows[0]]
        self._current = comp.id
        self.selectionChanged.emit(comp.id)
        self._refresh_neighborhood()

    def _on_item_changed(self, item: QTableWidgetItem) -> None:
        if self._updating or item.column() != 0:
            return
        marked = set()
        for row in range(self.table.rowCount()):
            cell = self.table.item(row, 0)
            if cell is not None and cell.checkState() == Qt.Checked and row < len(self._components):
                marked.add(self._components[row].id)
        self._marked = marked
        self.patchSelectionChanged.emit(set(marked))

    def _locate_selected(self) -> None:
        if self._current >= 0:
            self.locateRequested.emit(self._current)

    def _refresh_neighborhood(self) -> None:
        model = self._model
        if model is None or self._current < 0:
            return
        comp = next((c for c in self._components if c.id == self._current), None)
        if comp is None:
            return
        r0, c0, r1, c1 = comp.bbox
        radius = self.radius.value()
        pr0, pc0 = max(0, r0 - radius), max(0, c0 - radius)
        pr1 = min(model.shape[0], r1 + radius + 1)
        pc1 = min(model.shape[1], c1 + radius + 1)
        # flat response in ADU (patched where a patch policy was applied)
        window = model.flat_norm[pr0:pr1, pc0:pc1].astype(np.float32) * model.flat_scale
        labels = model.defects.labels[pr0:pr1, pc0:pc1]
        self.canvas.set_region(window, labels, comp.id, comp.bbox)
        ring = window[labels == 0]
        defect_vals = window[labels == comp.id]
        ring_text = f"{np.median(ring):.0f}" if ring.size else "—"
        defect_text = f"{np.median(defect_vals):.0f}" if defect_vals.size else "—"
        ratio_text = ""
        if ring.size and defect_vals.size and np.median(ring) > 0:
            ratio_text = f" (比值 {np.median(defect_vals) / np.median(ring):.3f})"
        reference_level = model.flat_scale
        self.detail.setText(
            f"区域 #{comp.id} · {comp.category} · {comp.area:,} px · "
            f"中心 ({comp.centroid[0]:.1f}, {comp.centroid[1]:.1f})\n"
            f"亮场信号 (ADU): 邻域正常像素中位 {ring_text} · 区域内中位 "
            f"{defect_text}{ratio_text}\n"
            f"归一化基准 {reference_level:.0f} ADU · "
            f"当前状态: {'已修补' if comp.id in model.patch_ids else '保留为无效'}")
        self.canvas.update()

    def set_sample(self, sample: Frame | None) -> None:
        self._sample = sample

    def current_component(self) -> Component | None:
        return next((c for c in self._components if c.id == self._current), None)

    def selected_ids(self) -> set[int]:
        return set(self._marked)

    def mark_patch(self, ids: set[int]) -> None:
        self._marked = set(ids)

    def select_component(self, comp_id: int) -> None:
        """Select a component by id (also used when clicking the main image)."""
        self._current = comp_id
        for row, comp in enumerate(self._components):
            if comp.id == comp_id:
                self.table.blockSignals(True)
                self.table.selectRow(row)
                self.table.blockSignals(False)
                self.selectionChanged.emit(comp_id)
                self._refresh_neighborhood()
                return
