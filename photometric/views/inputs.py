"""Tab 1 — the input photographs and the light-rig verdict."""
from __future__ import annotations

from PySide6.QtWidgets import (QGridLayout, QHBoxLayout, QLabel, QScrollArea,
                               QSizePolicy, QVBoxLayout, QWidget)

from .. import theme
from ..context import AppContext
from ..rig import RigQuality, assess
from ..solver import (STATUS_NAMES, STATUS_NONLAMBERT, STATUS_SATURATED,
                      STATUS_SHADOW, STATUS_UNLIT)
from .. import rendering
from ..widgets.common import LegendChip
from ..widgets.imageview import ImageView


class RigVerdictCard(QWidget):
    """One compact line: does this rig separate orientations, and how well."""

    def __init__(self, context: AppContext, parent=None):
        super().__init__(parent)
        self.ctx = context
        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.setFixedHeight(30)
        row = QHBoxLayout(self)
        row.setContentsMargins(0, 0, 0, 0)
        row.setSpacing(14)
        self.headline = QLabel("—")
        self.headline.setStyleSheet("font-size:13px; font-weight:700;")
        row.addWidget(self.headline)
        self.detail = QLabel("")
        self.detail.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        row.addWidget(self.detail, 1)
        self.hint = QLabel("")
        self.hint.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
        row.addWidget(self.hint)
        self._bars = [
            (QLabel("最小特征值"), QLabel("—")),
            (QLabel("条件数"), QLabel("—")),
            (QLabel("方位空档"), QLabel("—")),
        ]
        row.addStretch(1)
        for title, value in self._bars:
            pair = QWidget()
            lay = QHBoxLayout(pair)
            lay.setContentsMargins(0, 0, 0, 0)
            lay.setSpacing(4)
            title.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
            value.setStyleSheet("font-size:12px; font-weight:600;")
            lay.addWidget(title)
            lay.addWidget(value)
            row.addWidget(pair)

    def update_from(self, quality: RigQuality) -> None:
        if quality.well_posed and quality.covers_hemisphere:
            colour, hint = theme.OK, "这组方向可以区分朝向"
        elif quality.well_posed:
            colour, hint = theme.WARN, "可用，但某侧覆盖不足"
        else:
            colour, hint = theme.INVALID_COLOR, "无法区分所有朝向"
        self.headline.setText(quality.headline)
        self.headline.setStyleSheet(f"font-size:13px; font-weight:700; color:{colour};")
        self.hint.setText(hint)
        self.hint.setStyleSheet(f"color:{colour}; font-size:11px;")
        self.detail.setText("")
        cond_text = "∞" if quality.condition == float("inf") else f"{quality.condition:.2f}"
        values = [
            (f"{quality.smallest_eigenvalue:.3f}", quality.smallest_eigenvalue >= 0.12),
            (cond_text, quality.condition <= 8.0),
            (f"{quality.max_gap_deg:.0f}°", quality.covers_hemisphere),
        ]
        for (_, value), (text, ok) in zip(self._bars, values):
            value.setText(text)
            value.setStyleSheet(
                f"font-size:12px; font-weight:600; color:{theme.TEXT if ok else theme.WARN};"
            )


class InputsView(QWidget):
    """Grid of input photographs with per-light status overlays."""

    THUMB = 250

    def __init__(self, context: AppContext, parent=None):
        super().__init__(parent)
        self.ctx = context
        root = QVBoxLayout(self)
        root.setContentsMargins(12, 12, 12, 12)
        root.setSpacing(10)

        header = QHBoxLayout()
        self.title = QLabel("输入照片")
        self.title.setObjectName("Title")
        header.addWidget(self.title)
        header.addStretch(1)
        self.mode_hint = QLabel("点击任意一张图：把采样点定在该像素，其它视图同步跟随")
        self.mode_hint.setObjectName("Muted")
        header.addWidget(self.mode_hint)
        root.addLayout(header)

        self.verdict = RigVerdictCard(context)
        root.addWidget(self.verdict)

        legend = QHBoxLayout()
        legend.setSpacing(14)
        legend.addWidget(QLabel("每张图的读数标记:"))
        for colour, text in [
            (theme.SHADOW_BLUE, "投射阴影"),
            (theme.SAT_PINK, "数值饱和"),
            (theme.NONLAMBERT_AMBER, "非朗伯（高光）"),
            (theme.NEUTRAL, "未受照"),
        ]:
            legend.addWidget(LegendChip(colour, text))
        legend.addStretch(1)
        self.show_status = QLabel("叠加标记已开启")
        self.show_status.setObjectName("Muted")
        legend.addWidget(self.show_status)
        root.addLayout(legend)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        self.grid_host = QWidget()
        self.grid = QGridLayout(self.grid_host)
        self.grid.setSpacing(10)
        self.grid.setContentsMargins(0, 0, 0, 0)
        scroll.setWidget(self.grid_host)
        root.addWidget(scroll, 1)

        self.views: list[ImageView] = []
        self.titles: list[QLabel] = []
        self.captions: list[QLabel] = []
        self.cards: list[QWidget] = []

        context.sceneChanged.connect(self.rebuild)
        context.resultChanged.connect(self.refresh)
        context.pinnedChanged.connect(self._on_pin)
        context.hoverChanged.connect(self._sync_hover)

    # ------------------------------------------------------------------ build
    def rebuild(self) -> None:
        while self.grid.count():
            item = self.grid.takeAt(0)
            if item.widget():
                item.widget().deleteLater()
        self.views.clear()
        self.titles.clear()
        self.captions.clear()
        self.cards.clear()
        scene = self.ctx.scene
        if scene is None:
            return
        cols = 3 if scene.n_lights >= 4 else max(1, scene.n_lights)
        for i in range(scene.n_lights):
            card = QWidget()
            card.setObjectName("Card")
            card.setStyleSheet(
                f"background:{theme.PANEL}; border:1px solid {theme.BORDER}; border-radius:8px;"
            )
            lay = QVBoxLayout(card)
            lay.setContentsMargins(8, 8, 8, 6)
            lay.setSpacing(4)
            top = QHBoxLayout()
            title = QLabel(f"图 {i + 1}")
            title.setStyleSheet("font-weight:700; font-size:12px;")
            top.addWidget(title)
            top.addStretch(1)
            spec = scene.lights[i]
            meta = QLabel(f"方位 {spec.azimuth_deg:.0f}° · 仰角 {spec.elevation_deg:.0f}°")
            meta.setStyleSheet(f"color:{theme.MUTED}; font-size:11px;")
            top.addWidget(meta)
            lay.addLayout(top)

            view = ImageView()
            view.setMinimumHeight(self.THUMB)
            view.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Expanding)
            view.pixelClicked.connect(lambda x, y, i=i: self._pick(i, x, y))
            view.pixelHovered.connect(self.ctx.set_hover)
            view.left.connect(lambda: self.ctx.set_hover(None))
            view._image = None
            lay.addWidget(view, 1)

            caption = QLabel("")
            caption.setStyleSheet(f"color:{theme.MUTED}; font-size:10px;")
            caption.setWordWrap(True)
            lay.addWidget(caption)

            self.grid.addWidget(card, i // cols, i % cols)
            self.views.append(view)
            self.titles.append(title)
            self.captions.append(caption)
            self.cards.append(card)
        self.refresh()

    def _pick(self, light: int, x: int, y: int) -> None:
        self.ctx.pinned_light = light
        self.ctx.set_pinned((x, y))

    # ---------------------------------------------------------------- refresh
    def refresh(self) -> None:
        scene = self.ctx.scene
        if scene is None or not self.views:
            return
        quality = assess(scene.lights)
        self.verdict.update_from(quality)
        result = self.ctx.result
        # the light list may be mid-edit and briefly disagree with the scene;
        # never index past either side
        lights = scene.lights
        for i, view in enumerate(self.views):
            if i >= len(lights) or i >= scene.n_lights:
                view.set_image(None, "方向行已改动")
                self.captions[i].setText("")
                continue
            gray = scene.images[i]
            row = None if result is None else result.row_for_scene_light(i)
            if row is not None:
                rgb = rendering.status_overlay(rendering.gray_rgb(gray), result, row)
            else:
                rgb = rendering.gray_rgb(gray)
            view.set_image(rgb)
            view.set_badge(f"图 {i + 1}")
            caption = "尚未估计"
            row = None if result is None else result.row_for_scene_light(i)
            if row is not None:
                pin = self.ctx.pinned
                if pin is not None:
                    px, py = pin
                    if 0 <= py < result.height and 0 <= px < result.width:
                        reading = float(scene.images[i, py, px])
                        predicted = float(result.predictions[row, py, px])
                        code = int(result.status[row, py, px])
                        caption = (f"采样点读数 {reading:.3f} · 模型预测 {predicted:.3f} · "
                                   f"{STATUS_NAMES.get(code, '?')}")
                if pin is None:
                    st = result.status[row]
                    counts = {
                        "阴影": int((st == STATUS_SHADOW).sum()),
                        "饱和": int((st == STATUS_SATURATED).sum()),
                        "非朗伯": int((st == STATUS_NONLAMBERT).sum()),
                        "未受照": int((st == STATUS_UNLIT).sum()),
                    }
                    active = [f"{k} {v}" for k, v in counts.items() if v]
                    caption = " · ".join(active) if active else "全部读数可用"
            elif result is not None:
                caption = "此方向已停用，未参与估计"
            self.captions[i].setText(caption)
            colour = theme.ACCENT if i == self.ctx.pinned_light else theme.BORDER
            self.cards[i].setStyleSheet(
                f"background:{theme.PANEL}; border:1px solid {colour}; border-radius:8px;"
            )

    # --------------------------------------------------------------- linkage
    def _on_pin(self) -> None:
        xy = self.ctx.pinned
        for view in self.views:
            view.set_pinned(xy)
        self.refresh()

    def _sync_hover(self) -> None:
        xy = self.ctx.hover
        for view in self.views:
            view.set_cursor(xy)
