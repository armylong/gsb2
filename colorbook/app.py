"""PySide6 图形界面：加载限色 PNG，检查/合并碎块，调整标签，导出涂色稿。"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image
from PySide6.QtCore import Qt, QPointF, QRectF
from PySide6.QtGui import QAction, QPixmap, QImage, QPainter
from PySide6.QtWidgets import (
    QApplication,
    QAbstractItemView,
    QButtonGroup,
    QFileDialog,
    QGraphicsPixmapItem,
    QGraphicsScene,
    QGraphicsView,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QStatusBar,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from .model import RegionModel
from .render import (
    VIEW_COLOR,
    VIEW_LINE,
    VIEW_ORIGINAL,
    export_line_art,
    export_reference,
    load_font,
    plan_all_labels,
    render_view,
)
from .sample import build_sample_image
from .labels import LabelPlan


def pil_to_qpixmap(image: Image.Image) -> QPixmap:
    """PIL RGB 图转 QPixmap。"""
    rgb = image.convert("RGB")
    arr = rgb.tobytes("raw", "RGB")
    qimg = QImage(arr, rgb.width, rgb.height, rgb.width * 3, QImage.Format_RGB888)
    # data 由 bytes 持有，copy 防止悬空引用
    return QPixmap.fromImage(qimg.copy())


class CanvasView(QGraphicsView):
    """支持点击选区域、拖动数字标签、双击复位的画布。"""

    def __init__(self, window: "MainWindow") -> None:
        super().__init__()
        self.window = window
        self.scene_ = QGraphicsScene(self)
        self.setScene(self.scene_)
        self.pixmap_item: QGraphicsPixmapItem | None = None
        self.setRenderHints(QPainter.Antialiasing | QPainter.SmoothPixmapTransform)
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.NoDrag)
        self._dragging_region: int | None = None

    def set_pixmap(self, pixmap: QPixmap) -> None:
        self.scene_.clear()
        self.pixmap_item = self.scene_.addPixmap(pixmap)
        self.scene_.setSceneRect(QRectF(pixmap.rect()))

    def fit_once(self) -> None:
        if self.pixmap_item is not None:
            self.fitInView(self.pixmap_item, Qt.KeepAspectRatio)

    def to_image_coords(self, pos) -> tuple[int, int]:
        scene_pt: QPointF = self.mapToScene(pos)
        return int(scene_pt.x()), int(scene_pt.y())

    def _plan_at(self, x: int, y: int) -> int | None:
        plans = self.window.current_plans()
        for lid, plan in plans.items():
            ax, ay = plan.anchor
            bw, bh = plan.box_size
            if ax <= x < ax + bw and ay <= y < ay + bh:
                return lid
        return None

    def mousePressEvent(self, event) -> None:
        if event.button() != Qt.LeftButton or self.window.model is None:
            return super().mousePressEvent(event)
        x, y = self.to_image_coords(event.position().toPoint())
        hit_label = self._plan_at(x, y)
        if hit_label is not None and event.modifiers() & Qt.ShiftModifier:
            # Shift+拖动数字：手动移动标签锚点
            self._dragging_region = hit_label
            self.setDragMode(QGraphicsView.NoDrag)
            return
        region_id = self.window.model.region_at(x, y)
        if region_id is not None:
            self.window.select_regions({region_id})
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event) -> None:
        if self._dragging_region is None:
            return super().mouseMoveEvent(event)
        x, y = self.to_image_coords(event.position().toPoint())
        self.window.drag_anchor(self._dragging_region, x, y)

    def mouseReleaseEvent(self, event) -> None:
        self._dragging_region = None
        super().mouseReleaseEvent(event)

    def mouseDoubleClickEvent(self, event) -> None:
        if self.window.model is None:
            return super().mouseDoubleClickEvent(event)
        x, y = self.to_image_coords(event.position().toPoint())
        hit_label = self._plan_at(x, y)
        if hit_label is not None:
            self.window.model.clear_manual_anchor(hit_label)
            self.window.refresh()
        else:
            super().mouseDoubleClickEvent(event)

    def wheelEvent(self, event) -> None:
        if event.modifiers() & Qt.ControlModifier:
            factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
            self.scale(factor, factor)
        else:
            super().wheelEvent(event)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("涂色页转换工具 — 限色 PNG → 数字涂色稿")
        self.model: RegionModel | None = None
        self._plans: dict[int, LabelPlan] = {}
        self._selected: set[int] = set()
        self._view = VIEW_LINE

        self.resize(1280, 860)
        self._build_toolbar()
        self._build_body()
        self.setStatusBar(QStatusBar())

        font_size = 16
        self.font = load_font(font_size)

    # ------------------------------------------------------------------ #
    # 界面搭建
    # ------------------------------------------------------------------ #
    def _build_toolbar(self) -> None:
        bar = QToolBar("主工具栏")
        bar.setMovable(False)
        self.addToolBar(bar)

        act_open = QAction("打开 PNG", self)
        act_open.triggered.connect(self.action_open)
        bar.addAction(act_open)

        act_sample = QAction("载入内置测试图", self)
        act_sample.triggered.connect(self.action_load_sample)
        bar.addAction(act_sample)

        bar.addSeparator()

        self.view_group = QButtonGroup(self)
        self.view_buttons: dict[str, QPushButton] = {}
        for key, label in (
            (VIEW_ORIGINAL, "原图"),
            (VIEW_COLOR, "填色方案"),
            (VIEW_LINE, "黑白稿"),
        ):
            btn = QPushButton(label)
            btn.setCheckable(True)
            btn.setChecked(key == self._view)
            btn.clicked.connect(lambda _=False, k=key: self.switch_view(k))
            self.view_group.addButton(btn)
            self.view_buttons[key] = btn
            bar.addWidget(btn)

        bar.addSeparator()

        bar.addWidget(QLabel(" 碎块面积阈值 "))
        self.area_spin = QSpinBox()
        self.area_spin.setRange(1, 1_000_000)
        self.area_spin.setValue(1500)
        self.area_spin.setSuffix(" px")
        bar.addWidget(self.area_spin)

        act_merge = QAction("合并小碎块", self)
        act_merge.triggered.connect(self.action_merge_small)
        bar.addAction(act_merge)

        act_protect = QAction("保护/取消保护选中岛", self)
        act_protect.triggered.connect(self.action_toggle_protection)
        bar.addAction(act_protect)

        bar.addSeparator()

        act_export_line = QAction("导出黑白稿", self)
        act_export_line.triggered.connect(self.action_export_line)
        bar.addAction(act_export_line)

        act_export_ref = QAction("导出参考图", self)
        bar.addAction(act_export_ref)
        act_export_ref.triggered.connect(self.action_export_reference)

    def _build_body(self) -> None:
        central = QWidget()
        layout = QHBoxLayout(central)

        self.canvas = CanvasView(self)
        layout.addWidget(self.canvas, stretch=4)

        side = QWidget()
        side_layout = QVBoxLayout(side)
        side_layout.addWidget(QLabel("图例（点击检查同编号位置）"))
        self.legend = QListWidget()
        self.legend.setSelectionMode(QAbstractItemView.SingleSelection)
        self.legend.itemSelectionChanged.connect(self.on_legend_selected)
        side_layout.addWidget(self.legend, stretch=3)

        side_layout.addWidget(QLabel("放不下数字的区域"))
        self.problem_list = QListWidget()
        self.problem_list.itemClicked.connect(self._on_problem_clicked)
        side_layout.addWidget(self.problem_list, stretch=2)

        self.info_label = QLabel("尚未载入图像")
        self.info_label.setWordWrap(True)
        side_layout.addWidget(self.info_label)

        layout.addWidget(side, stretch=1)
        self.setCentralWidget(central)

    # ------------------------------------------------------------------ #
    # 文件操作
    # ------------------------------------------------------------------ #
    def action_open(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择限色 PNG", "", "PNG 图像 (*.png)"
        )
        if path:
            try:
                image = Image.open(path)
                image.load()
            except OSError as exc:
                QMessageBox.critical(self, "打开失败", str(exc))
                return
            self.load_model(image, source_name=Path(path).name)

    def action_load_sample(self) -> None:
        self.load_model(build_sample_image(), source_name="内置测试图")

    def load_model(self, image: Image.Image, source_name: str) -> None:
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            self.model = RegionModel(image)
        finally:
            QApplication.restoreOverrideCursor()
        self._selected.clear()
        # 字号随图尺寸定，保证导出图里数字清晰
        font_size = max(12, round(min(self.model.height, self.model.width) * 0.035))
        self.font = load_font(font_size)
        self.setWindowTitle(f"涂色页转换工具 — {source_name}")
        self.refresh()
        self.canvas.fit_once()

    # ------------------------------------------------------------------ #
    # 视图 / 刷新
    # ------------------------------------------------------------------ #
    def switch_view(self, key: str) -> None:
        self._view = key
        self.view_buttons[key].setChecked(True)
        self.refresh()

    def current_plans(self) -> dict[int, LabelPlan]:
        return self._plans

    def refresh(self) -> None:
        if self.model is None:
            return
        self._plans = plan_all_labels(self.model, self.font)
        image = render_view(
            self.model,
            self._view,
            self.font,
            show_labels=True,
            selected=self._selected,
            plans=self._plans,
        )
        self.canvas.set_pixmap(pil_to_qpixmap(image))
        self._refresh_legend()
        self._refresh_problems()
        self._refresh_info()

    def _refresh_legend(self) -> None:
        self.legend.blockSignals(True)
        self.legend.clear()
        color_map = self.model.color_number_map()
        number_to_color = {num: color for color, num in color_map.items()}
        for number in sorted(number_to_color):
            color = number_to_color[number]
            region_ids = self.model.regions_of_color(color)
            item = QListWidgetItem(
                f"编号 {number}    RGB{color}    {len(region_ids)} 处"
            )
            item.setData(Qt.UserRole, color)
            self.legend.addItem(item)
        self.legend.blockSignals(False)

    def _refresh_problems(self) -> None:
        self.problem_list.clear()
        for lid, plan in self._plans.items():
            if not plan.fits:
                tag = "无法放置"
            elif not plan.inside:
                tag = "外部引线"
            elif plan.overflow:
                tag = "数字压边界"
            else:
                continue
            item = QListWidgetItem(
                f"区域 {lid}（编号 {plan.text}）{tag}：{plan.reason}"
            )
            item.setData(Qt.UserRole, lid)
            self.problem_list.addItem(item)

    def _on_problem_clicked(self, item: QListWidgetItem) -> None:
        lid = item.data(Qt.UserRole)
        if lid is not None and lid in self.model.regions:
            self.select_regions({int(lid)})

    def _refresh_info(self) -> None:
        m = self.model
        protected = sum(1 for r in m.regions.values() if r.protected)
        fillable = [
            r for lid, r in m.regions.items() if lid != m.background_id
        ]
        smallest = min(fillable, key=lambda r: r.area)
        self.info_label.setText(
            f"尺寸: {m.width}×{m.height}\n"
            f"区域数: {len(m.regions)}（含背景，同色不接触各自独立）\n"
            f"待填色区域: {len(fillable)}\n"
            f"颜色编号数: {len(m.color_number_map())}\n"
            f"受保护岛: {protected}\n"
            f"最小待填区域: id={smallest.id}，面积 {smallest.area}px\n"
            f"撤销栈: {len(m._undo)}，重做栈: {len(m._redo)}"
        )

    # ------------------------------------------------------------------ #
    # 选择与图例联动
    # ------------------------------------------------------------------ #
    def select_regions(self, ids: set[int]) -> None:
        self._selected = {lid for lid in ids if lid in self.model.regions}
        self.refresh()

    def on_legend_selected(self) -> None:
        items = self.legend.selectedItems()
        if not items:
            self._selected.clear()
            self.refresh()
            return
        color = items[0].data(Qt.UserRole)
        ids = set(self.model.regions_of_color(color))
        self.select_regions(ids)
        self.statusBar().showMessage(
            f"颜色编号 {self.model.color_number(next(iter(ids)))} 共 {len(ids)} 处区域",
            4000,
        )

    # ------------------------------------------------------------------ #
    # 合并 / 保护 / 标签拖动
    # ------------------------------------------------------------------ #
    def action_merge_small(self) -> None:
        if self.model is None:
            return
        threshold = self.area_spin.value()
        merged = self.model.merge_small_regions(threshold)
        self._selected.clear()
        self.refresh()
        if merged:
            self.statusBar().showMessage(
                f"合并了 {len(merged)} 个面积小于 {threshold}px 的碎块", 5000
            )
        else:
            self.statusBar().showMessage(
                f"没有面积小于 {threshold}px 的未保护碎块", 5000
            )

    def action_toggle_protection(self) -> None:
        if self.model is None or not self._selected:
            self.statusBar().showMessage("先在画布上点选要保护的区域", 4000)
            return
        for lid in self._selected:
            self.model.set_protected(lid, not self.model.regions[lid].protected)
        self.refresh()
        names = ", ".join(str(lid) for lid in sorted(self._selected))
        states = [self.model.regions[lid].protected for lid in self._selected]
        verb = "已保护" if all(states) else "已取消保护"
        self.statusBar().showMessage(f"区域 {names} {verb}", 4000)

    def drag_anchor(self, region_id: int, x: int, y: int) -> None:
        if self.model is None:
            return
        self.model.set_manual_anchor(region_id, x, y)
        self.refresh()

    # ------------------------------------------------------------------ #
    # 导出
    # ------------------------------------------------------------------ #
    def _ask_save_path(self, suffix: str) -> Path | None:
        path, _ = QFileDialog.getSaveFileName(
            self, "导出图像", f"colorbook_{suffix}.png", "PNG 图像 (*.png)"
        )
        return Path(path) if path else None

    def action_export_line(self) -> None:
        if self.model is None:
            return
        path = self._ask_save_path("line")
        if path:
            export_line_art(self.model, path, self.font, plans=self._plans)
            self.statusBar().showMessage(f"黑白稿已导出: {path}", 6000)

    def action_export_reference(self) -> None:
        if self.model is None:
            return
        path = self._ask_save_path("reference")
        if path:
            export_reference(self.model, path, self.font, plans=self._plans)
            self.statusBar().showMessage(f"参考图已导出: {path}", 6000)

    # ------------------------------------------------------------------ #
    # 快捷键
    # ------------------------------------------------------------------ #
    def keyPressEvent(self, event) -> None:
        if event.modifiers() & Qt.ControlModifier and event.key() == Qt.Key_Z:
            if self.model and self.model.undo():
                self._selected.clear()
                self.refresh()
            return
        if event.modifiers() & Qt.ControlModifier and event.key() == Qt.Key_Y:
            if self.model and self.model.redo():
                self._selected.clear()
                self.refresh()
            return
        super().keyPressEvent(event)


def main() -> int:
    app = QApplication(sys.argv)
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
