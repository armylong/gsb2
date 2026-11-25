"""Tab 2 — the estimated surface: shading, normal colour, arrows, probe table."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QHBoxLayout, QLabel, QPushButton, QScrollArea,
                               QTableWidget, QTableWidgetItem, QVBoxLayout,
                               QWidget)

from .. import rendering, theme, vecmath
from ..context import AppContext
from ..solver import (REASON_NAMES, STATUS_NAMES, STATUS_NONLAMBERT,
                      STATUS_OK, STATUS_SATURATED, STATUS_SHADOW, STATUS_UNLIT)
from ..widgets.common import LegendChip, SectionTitle, StatCard
from ..widgets.gizmo import NormalGizmo
from ..widgets.imageview import ImageView

DISPLAY_MODES = [
    ("正常颜色", "normal"),
    ("方向色相", "direction"),
    ("反照率", "albedo"),
    ("光照灰阶", "shading"),
]


class NormalsView(QWidget):
    def __init__(self, context: AppContext, parent=None):
        super().__init__(parent)
        self.ctx = context
        self.mode = "normal"

        root = QHBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(12)

        left = QVBoxLayout()
        left.setSpacing(8)
        header = QHBoxLayout()
        title = QLabel("表面朝向")
        title.setObjectName("Title")
        header.addWidget(title)
        header.addStretch(1)
        for text, key in DISPLAY_MODES:
            btn = QPushButton(text)
            btn.setCheckable(True)
            btn.setChecked(key == self.mode)
            btn.clicked.connect(lambda _=False, k=key: self._set_mode(k))
            setattr(self, f"btn_{key}", btn)
            header.addWidget(btn)
        left.addLayout(header)

        opts = QHBoxLayout()
        opts.setSpacing(10)
        self.arrow_btn = QPushButton("方向箭头")
        self.arrow_btn.setCheckable(True)
        self.arrow_btn.setChecked(True)
        self.arrow_btn.toggled.connect(self._refresh_image)
        opts.addWidget(self.arrow_btn)
        self.mask_btn = QPushButton("标出估计不足")
        self.mask_btn.setCheckable(True)
        self.mask_btn.setChecked(True)
        self.mask_btn.setToolTip("把没有可靠估计的区域叠上提示色")
        self.mask_btn.toggled.connect(self._refresh_image)
        opts.addWidget(self.mask_btn)
        opts.addStretch(1)
        self.hint = QLabel("在图上单击固定采样点；中键拖动平移，Ctrl+滚轮缩放")
        self.hint.setObjectName("Muted")
        opts.addWidget(self.hint)
        left.addLayout(opts)

        self.view = ImageView()
        self.view.setMinimumSize(420, 420)
        self.view.pixelClicked.connect(self.ctx.set_pinned)
        self.view.pixelHovered.connect(self.ctx.set_hover)
        self.view.left.connect(lambda: self.ctx.set_hover(None))
        left.addWidget(self.view, 1)

        legend = QHBoxLayout()
        legend.setSpacing(12)
        legend.addWidget(QLabel("箭头 = 表面法线在像平面上的投影"))
        legend.addStretch(1)
        for colour, text in [
            (theme.SHADOW_BLUE, "有效读数不足 3 个"),
            (theme.SAT_PINK, "方向组合病态"),
            (theme.NONLAMBERT_AMBER, "不确定度过大"),
            (theme.NEUTRAL, "方向存在歧义 / 反射率过低"),
        ]:
            legend.addWidget(LegendChip(colour, text))
        left.addLayout(legend)
        root.addLayout(left, 1)

        side = QVBoxLayout()
        side.setSpacing(8)
        self.gizmo = NormalGizmo()
        self.gizmo.setMinimumHeight(168)
        self.gizmo.setMaximumHeight(188)
        side.addWidget(self.gizmo)

        self.card_normal = StatCard("法线 (x, y, z)")
        self.card_angle = StatCard("方位 / 倾角")
        self.card_quality = StatCard("估计质量")
        for card in (self.card_normal, self.card_angle, self.card_quality):
            side.addWidget(card)

        side.addWidget(SectionTitle("逐张读数对上"))
        self.table = QTableWidget(0, 5)
        self.table.setHorizontalHeaderLabels(["图", "读数", "预测", "差", "状态"])
        self.table.verticalHeader().setVisible(False)
        self.table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.table.setSelectionMode(QTableWidget.SelectionMode.NoSelection)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setStyleSheet(
            f"QTableWidget {{ background:{theme.PANEL_ALT}; border:1px solid {theme.BORDER}; "
            f"border-radius:6px; gridline-color:{theme.BORDER}; }}"
            f"QHeaderView::section {{ background:{theme.PANEL}; color:{theme.MUTED}; "
            f"border:none; padding:4px; }}"
        )
        self.table.setMinimumHeight(170)
        side.addWidget(self.table)

        side_host = QWidget()
        side_host.setLayout(side)
        side_scroll = QScrollArea()
        side_scroll.setWidgetResizable(True)
        side_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        side_scroll.setWidget(side_host)
        side_scroll.setFixedWidth(342)
        root.addWidget(side_scroll)

        context.resultChanged.connect(self.refresh)
        context.pinnedChanged.connect(self._on_pin)
        context.sceneChanged.connect(self.refresh)
        context.hoverChanged.connect(self._on_hover)

    # ------------------------------------------------------------------ mode
    def _set_mode(self, key: str) -> None:
        self.mode = key
        for _, mode_key in DISPLAY_MODES:
            getattr(self, f"btn_{mode_key}").setChecked(mode_key == key)
        self._refresh_image()

    # --------------------------------------------------------------- refresh
    def refresh(self) -> None:
        self._refresh_image()
        self._update_probe()

    def _refresh_image(self) -> None:
        result = self.ctx.result
        if result is None:
            self.view.set_image(None, "先运行一次估计")
            self.view.set_arrows([])
            return
        if self.mode == "normal":
            rgb = rendering.normal_map_rgb(result)
        elif self.mode == "direction":
            rgb = rendering.direction_rgb(result)
        elif self.mode == "albedo":
            rgb = rendering.albedo_rgb(result)
        else:
            rgb = rendering.shading_rgb(result)
        if self.mask_btn.isChecked():
            rgb = rendering.overlay_invalid(rgb, result, dim=0.92)
        self.view.set_image(rgb)
        show_arrows = self.arrow_btn.isChecked() and self.mode in ("normal", "direction", "shading")
        self.view.set_show_arrows(show_arrows)
        arrow_colour = "#ffffff" if self.mode in ("normal", "direction") else theme.ACCENT
        self.view.set_arrows(rendering.arrow_field(result) if show_arrows else [],
                             color=arrow_colour)
        self.view.set_pinned(self.ctx.pinned)
        self.view.set_cursor(self.ctx.hover)

    # ---------------------------------------------------------------- probe
    def _on_pin(self) -> None:
        self.view.set_pinned(self.ctx.pinned)
        self._update_probe()

    def _on_hover(self) -> None:
        self.view.set_cursor(self.ctx.hover)

    def _update_probe(self) -> None:
        info = self.ctx.probe_info()
        if info is None:
            self.gizmo.set_normal(None)
            self.card_normal.set_value("—", "在图上单击取样")
            self.card_angle.set_value("—")
            self.card_quality.set_value("—")
            self.table.setRowCount(0)
            return
        self.gizmo.set_normal(info.normal)
        if self.ctx.result is not None:
            self.gizmo.set_lights(self.ctx.result.directions)
        if info.normal is None:
            self.card_normal.set_value("无有效法线", REASON_NAMES.get(info.reason, ""),
                                       theme.WARN)
            self.card_angle.set_value("—")
        else:
            n = info.normal
            self.card_normal.set_value(
                f"{n[0]:+.3f}  {n[1]:+.3f}  {n[2]:+.3f}",
                f"单位向量 · 像素 ({info.x}, {info.y})")
            az, tilt = vecmath.normal_az_el(n[..., :2], n[2])
            self.card_angle.set_value(f"{float(az):.0f}° / {float(tilt):.0f}°",
                                      "方位（自 +x 逆时针）· 倾角（0=正对镜头）")
        self.card_quality.set_value(
            f"±{info.uncertainty_deg:.2f}°",
            f"参与拟合 {info.readings_used} 张 · 一致度 {info.confidence * 100:.0f}% · 反照率 {info.albedo:.2f}",
            theme.OK if info.valid else theme.WARN)

        self.table.setRowCount(len(info.readings))
        for row, reading in enumerate(info.readings):
            values = [
                f"图 {reading.light + 1}",
                f"{reading.intensity:.3f}",
                f"{reading.predicted:.3f}",
                f"{reading.residual:+.3f}",
                STATUS_NAMES.get(reading.status, "?"),
            ]
            for col, text in enumerate(values):
                item = QTableWidgetItem(text)
                item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                if col == 4 and reading.status != STATUS_OK:
                    item.setForeground(Qt.GlobalColor.white)
                    colour = {
                        STATUS_SHADOW: theme.SHADOW_BLUE,
                        STATUS_SATURATED: theme.SAT_PINK,
                        STATUS_NONLAMBERT: theme.NONLAMBERT_AMBER,
                        STATUS_UNLIT: theme.NEUTRAL,
                    }.get(reading.status, theme.MUTED)
                    from PySide6.QtGui import QColor
                    item.setBackground(QColor(colour))
                self.table.setItem(row, col, item)
        self.table.resizeColumnsToContents()
