"""Tab 3 — where the estimate is missing, and which readings failed where."""
from __future__ import annotations

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (QHBoxLayout, QLabel, QPushButton, QScrollArea,
                               QSizePolicy, QVBoxLayout, QWidget)

from .. import rendering, theme
from ..context import AppContext
from ..solver import (REASON_AMBIGUOUS, REASON_DARK, REASON_ILL_CONDITIONED,
                      REASON_NAMES, REASON_TOO_FEW, REASON_UNCERTAIN,
                      STATUS_NAMES, STATUS_NONLAMBERT, STATUS_SATURATED,
                      STATUS_SHADOW, STATUS_UNLIT)
from ..widgets.common import LegendChip, SectionTitle, StatCard
from ..widgets.imageview import ImageView

REASON_COLOURS = {
    REASON_TOO_FEW: theme.SHADOW_BLUE,
    REASON_ILL_CONDITIONED: theme.SAT_PINK,
    REASON_UNCERTAIN: theme.NONLAMBERT_AMBER,
    REASON_AMBIGUOUS: theme.NEUTRAL,
    REASON_DARK: theme.NEUTRAL,
}


class CoverageView(QWidget):
    def __init__(self, context: AppContext, parent=None):
        super().__init__(parent)
        self.ctx = context
        self.light_index = 0
        self.mode = "coverage"

        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(8)

        header = QHBoxLayout()
        header.setSpacing(8)
        title = QLabel("估计覆盖与失效原因")
        title.setObjectName("Title")
        header.addWidget(title)
        header.addStretch(1)
        self.btn_coverage = QPushButton("缺失区域")
        self.btn_status = QPushButton("逐图读数状态")
        self.btn_uncertainty = QPushButton("不确定度")
        for btn, mode in ((self.btn_coverage, "coverage"),
                          (self.btn_status, "status"),
                          (self.btn_uncertainty, "uncertainty")):
            btn.setCheckable(True)
            btn.clicked.connect(lambda _=False, m=mode: self._set_mode(m))
            header.addWidget(btn)
        root.addLayout(header)

        self.caption = QLabel("")
        self.caption.setWordWrap(True)
        self.caption.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        self.caption.setMinimumHeight(30)
        root.addWidget(self.caption)

        body = QHBoxLayout()
        body.setSpacing(12)
        left = QVBoxLayout()
        left.setSpacing(6)
        self.view = ImageView()
        self.view.setMinimumSize(380, 360)
        self.view.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
        self.view.pixelClicked.connect(self.ctx.set_pinned)
        self.view.pixelHovered.connect(self.ctx.set_hover)
        self.view.left.connect(lambda: self.ctx.set_hover(None))
        left.addWidget(self.view, 1)

        legend_host = QWidget()
        self.legend_row = QHBoxLayout(legend_host)
        self.legend_row.setContentsMargins(0, 0, 0, 0)
        self.legend_row.setSpacing(14)
        self.legend_row.setAlignment(Qt.AlignmentFlag.AlignLeft)
        left.addWidget(legend_host)
        body.addLayout(left, 1)

        side = QVBoxLayout()
        side.setSpacing(6)
        side.addWidget(SectionTitle("估计不足的像素"))
        self.cards: dict[int, StatCard] = {}
        for code in (REASON_TOO_FEW, REASON_ILL_CONDITIONED, REASON_UNCERTAIN,
                     REASON_AMBIGUOUS, REASON_DARK):
            card = StatCard(REASON_NAMES[code])
            self.cards[code] = card
            side.addWidget(card)
        side.addWidget(SectionTitle("逐图读数分项"))
        status_host = QWidget()
        self.status_host = QVBoxLayout(status_host)
        self.status_host.setContentsMargins(0, 0, 0, 0)
        self.status_host.setSpacing(2)
        side.addWidget(status_host)
        side.addStretch(1)

        side_host = QWidget()
        side_host.setLayout(side)
        side_scroll = QScrollArea()
        side_scroll.setWidgetResizable(True)
        side_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        side_scroll.setWidget(side_host)
        side_scroll.setFixedWidth(330)
        body.addWidget(side_scroll)
        root.addLayout(body, 1)

        context.resultChanged.connect(self.refresh)
        context.sceneChanged.connect(self.refresh)
        context.pinnedChanged.connect(self._sync_pin)

    def _sync_pin(self) -> None:
        self.view.set_pinned(self.ctx.pinned)

    def _set_mode(self, mode: str) -> None:
        self.mode = mode
        self.refresh()

    # ---------------------------------------------------------------- refresh
    def refresh(self) -> None:
        self.btn_coverage.setChecked(self.mode == "coverage")
        self.btn_status.setChecked(self.mode == "status")
        self.btn_uncertainty.setChecked(self.mode == "uncertainty")
        self._clear_legend()
        result = self.ctx.result
        if result is None:
            self.view.set_image(None, "先运行一次估计")
            self.caption.setText("")
            for card in self.cards.values():
                card.set_value("—")
            return

        if self.mode == "status":
            scene_light = max(0, min(self.light_index, result.status.shape[0] - 1))
            row = result.row_for_scene_light(scene_light)
            if row is None:
                row = 0
            rgb = rendering.overlay_invalid(
                rendering.status_map_rgb(result)[row], result, silhouette=False)
            self.view.set_image(rgb)
            self.view.set_badge(f"图 {result.scene_index(row) + 1} 读数状态")
            self.caption.setText(
                "逐张判定：蓝色 = 该灯被挡住（投射阴影），洋红 = 数值饱和，"
                "琥珀 = 类似高光的非朗伯读数，灰色 = 该方向未照到。"
                "没有可靠法线的像素整体压暗，可以直接看出它们落在哪些读数上。")
            for code in (STATUS_SHADOW, STATUS_SATURATED, STATUS_NONLAMBERT, STATUS_UNLIT):
                self._add_legend(rendering.hex_of(rendering.STATUS_RGB[code]),
                                 STATUS_NAMES[code])
        elif self.mode == "uncertainty":
            self.view.set_image(rendering.uncertainty_rgb(result))
            self.view.set_badge("不确定度")
            self.caption.setText(
                "按法线矩阵的逆与残差噪声传播得到的方向不确定度（度）。"
                "浅色 = 可靠；蓝色越深表示该处朝向越不确定，"
                "通常是有效读数接近共面所致。")
            self._add_legend("#cde2fb", "0°")
            self._add_legend("#5598e7", "5°")
            self._add_legend("#0d366b", "≥10°")
        else:
            self.view.set_image(rendering.overlay_invalid(
                rendering.normal_map_rgb(result), result, dim=0.6, desaturate=True))
            self.view.set_badge("缺失区域")
            self.caption.setText(
                "法线颜色只在有可靠估计处显示，其余物体像素按原因着色——"
                "这些就是“估计不足、一眼看见”的位置。")
            for code in (REASON_TOO_FEW, REASON_ILL_CONDITIONED, REASON_UNCERTAIN,
                         REASON_AMBIGUOUS):
                self._add_legend(REASON_COLOURS[code], REASON_NAMES[code])
        self._add_legend("#575b63", "法线可用")

        self.view.set_pinned(self.ctx.pinned)
        self.view.set_cursor(self.ctx.hover)

        counts = result.invalid_counts()
        total = max(1, int(result.object_mask.sum()))
        for code, card in self.cards.items():
            n = counts.get(code, 0)
            card.set_value(f"{n:,}", f"{n / total * 100:.1f}% 的物体像素",
                           colour=REASON_COLOURS[code])
        self._rebuild_status_rows(result)

    def _rebuild_status_rows(self, result) -> None:
        while self.status_host.count():
            item = self.status_host.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        for i in range(result.status.shape[0]):
            st = result.status[i][result.object_mask]
            row = QWidget()
            lay = QHBoxLayout(row)
            lay.setContentsMargins(0, 0, 0, 0)
            lay.setSpacing(6)
            label = QLabel(f"图 {result.scene_index(i) + 1}")
            label.setFixedWidth(38)
            label.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
            lay.addWidget(label)
            total = max(1, st.size)
            for code, colour in [
                (STATUS_SHADOW, theme.SHADOW_BLUE),
                (STATUS_SATURATED, theme.SAT_PINK),
                (STATUS_NONLAMBERT, theme.NONLAMBERT_AMBER),
                (STATUS_UNLIT, theme.NEUTRAL),
            ]:
                n = int((st == code).sum())
                chip = LegendChip(colour, f"{n / total * 100:.0f}%")
                chip.setToolTip(f"{STATUS_NAMES[code]}：{n:,} 像素")
                lay.addWidget(chip)
            lay.addStretch(1)
            self.status_host.addWidget(row)

    def _clear_legend(self) -> None:
        while self.legend_row.count():
            item = self.legend_row.takeAt(0)
            if item.widget():
                item.widget().deleteLater()

    def _add_legend(self, colour: str, text: str) -> None:
        self.legend_row.addWidget(LegendChip(colour, text))

    def set_light(self, index: int) -> None:
        self.light_index = index
        if self.mode == "status":
            self.refresh()
