"""主窗口: 工具条 + 画布 + 顺序列表, 串起切分、人工纠正与导出。"""

from __future__ import annotations

import os

import cv2
from PySide6.QtCore import Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QComboBox,
    QFileDialog,
    QLabel,
    QMainWindow,
    QMessageBox,
    QSpinBox,
    QSplitter,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from ..demo_image import generate_demo_page
from ..exporting import export_panels
from ..model import PageModel
from ..ordering import compute_order
from ..segmentation import segment_image
from .canvas import (
    MODE_DRAG_SEAM,
    MODE_MERGE,
    MODE_REORDER,
    MODE_SELECT,
    MODE_SPLIT_H,
    MODE_SPLIT_V,
    CanvasWidget,
)
from .order_panel import OrderListWidget


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("离线分格拆图工具")
        self.resize(1440, 920)

        self.image_bgr = None
        self.image_path: str | None = None
        self.model: PageModel | None = None

        self.canvas = CanvasWidget()
        self.order_list = OrderListWidget()
        self.order_list.order_swapped.connect(self._on_order_swapped)

        right = QWidget()
        layout = QVBoxLayout(right)
        layout.addWidget(QLabel("阅读顺序 (可拖拽调整, 导出按此顺序)"))
        layout.addWidget(self.order_list, 1)
        self.order_summary = QLabel("")
        self.order_summary.setWordWrap(True)
        layout.addWidget(self.order_summary)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self.canvas)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        self.setCentralWidget(splitter)

        self.canvas.panels_changed.connect(self._refresh_after_edit)
        self.canvas.status_message.connect(self.statusBar().showMessage)

        self._build_toolbar()

    # ---------- 工具条 ----------
    def _build_toolbar(self):
        bar = QToolBar("主工具条")
        bar.setMovable(False)
        self.addToolBar(bar)

        act_open = QAction("打开图片", self)
        act_open.triggered.connect(self.open_image)
        bar.addAction(act_open)

        act_demo = QAction("生成演示页", self)
        act_demo.triggered.connect(self.load_demo)
        bar.addAction(act_demo)

        act_reseg = QAction("重新自动切分", self)
        act_reseg.triggered.connect(self.resegment)
        bar.addAction(act_reseg)
        bar.addSeparator()

        self.mode_actions = {}
        for key, label in (
            (MODE_SELECT, "选择/浏览"),
            (MODE_DRAG_SEAM, "拖动缝"),
            (MODE_SPLIT_V, "补竖缝"),
            (MODE_SPLIT_H, "补横缝"),
            (MODE_MERGE, "框选合并"),
            (MODE_REORDER, "点击前移排序"),
        ):
            act = QAction(label, self, checkable=True)
            act.triggered.connect(lambda checked=False, k=key: self._set_mode(k))
            bar.addAction(act)
            self.mode_actions[key] = act
        self._set_mode(MODE_SELECT)
        bar.addSeparator()

        act_undo = QAction("撤销", self)
        act_undo.setShortcut(QKeySequence.StandardKey.Undo)
        act_undo.triggered.connect(self._undo)
        bar.addAction(act_undo)

        act_redo = QAction("重做", self)
        act_redo.setShortcut(QKeySequence.StandardKey.Redo)
        act_redo.triggered.connect(self._redo)
        bar.addAction(act_redo)
        bar.addSeparator()

        bar.addWidget(QLabel(" 方向 "))
        self.direction = QComboBox()
        self.direction.addItems(["左到右 LTR", "右到左 RTL"])
        self.direction.currentIndexChanged.connect(self._refresh_order)
        bar.addWidget(self.direction)

        bar.addWidget(QLabel(" 留边(px) "))
        self.margin = QSpinBox()
        self.margin.setRange(0, 500)
        self.margin.setValue(0)
        bar.addWidget(self.margin)

        act_export = QAction("导出小图", self)
        act_export.triggered.connect(self.export)
        bar.addAction(act_export)

    def _set_mode(self, mode: str):
        self.canvas.set_mode(mode)
        for key, act in self.mode_actions.items():
            act.setChecked(key == mode)

    # ---------- 数据装载 ----------
    def _load(self, image_bgr, path: str | None):
        self.image_bgr = image_bgr
        self.image_path = path
        seg = segment_image(image_bgr)
        self.model = PageModel(image_bgr.shape, seg.panels)
        self.canvas.set_image(
            image_bgr, self.model, seg.cuts, seg.partial_cuts
        )
        self.statusBar().showMessage(
            f"初次切分: {len(seg.panels)} 格, {len(seg.cuts)} 条通缝, "
            f"{len(seg.partial_cuts)} 条断缝提示, 背景阈值 {seg.background_threshold}"
        )
        self._refresh_order()

    def open_image(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择分格讲解图", "",
            "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff *.webp)",
        )
        if not path:
            return
        img = cv2.imdecode(
            np_from_path(path), cv2.IMREAD_COLOR
        )
        if img is None:
            QMessageBox.warning(self, "读取失败", f"无法解码: {path}")
            return
        self._load(img, path)

    def load_demo(self):
        img = generate_demo_page()
        self._load(img, None)

    def resegment(self):
        if self.image_bgr is None:
            return
        seg = segment_image(self.image_bgr)
        self.model = PageModel(self.image_bgr.shape, seg.panels)
        self.canvas.model = self.model
        self.canvas.auto_cuts = seg.cuts
        self.canvas.partial_cuts = seg.partial_cuts
        self._refresh_order()
        self.canvas.update()
        self.statusBar().showMessage("已重新自动切分, 人工修改已重置")

    # ---------- 编辑联动 ----------
    def _refresh_after_edit(self):
        self._refresh_order()
        self.canvas.update()

    def _current_direction(self):
        return "rtl" if self.direction.currentIndex() == 1 else "ltr"

    def _refresh_order(self):
        if self.model is None:
            return
        info = compute_order(self.model.panels, self._current_direction())
        self.canvas.set_order_info(info)
        self.order_list.refresh(
            self.model.panels, info, self.model.manual_order
        )
        span = sorted(info.spanning)
        self.order_summary.setText(
            f"共 {len(self.model.panels)} 格; 跨行格索引 {span}; "
            f"归属规则: 重叠最大的行带; 方向 {info.direction.upper()}"
        )
        self.canvas.update()

    def _on_order_swapped(self, a: int, b: int):
        self.canvas.swap_order(a, b)
        self._refresh_order()

    def _undo(self):
        if self.model and self.model.undo():
            self._refresh_order()

    def _redo(self):
        if self.model and self.model.redo():
            self._refresh_order()

    # ---------- 导出 ----------
    def export(self):
        if self.model is None or self.image_bgr is None:
            QMessageBox.information(self, "提示", "请先打开图片或生成演示页")
            return
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        info = compute_order(self.model.panels, self._current_direction())
        try:
            items, manifest, review = export_panels(
                self.image_bgr,
                self.model.panels,
                info,
                out_dir,
                margin_px=self.margin.value(),
                order_override=self.model.manual_order,
            )
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self,
            "导出完成",
            f"导出 {len(items)} 张小图\n清单: {os.path.basename(manifest)}\n"
            f"回查图: {os.path.basename(review)}\n目录: {out_dir}",
        )
        self.statusBar().showMessage(f"导出完成 -> {out_dir}")


def np_from_path(path: str):
    # 用 numpy + imdecode 支持中文路径
    import numpy as np
    with open(path, "rb") as f:
        data = f.read()
    return np.frombuffer(data, dtype=np.uint8)
