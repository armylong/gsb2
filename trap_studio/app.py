"""Trap Studio — 两块专色墨版搭接打样工具 (PySide6 + numpy)。

预览里的偏移只用于模拟错版, 不参与搭接计算, 也不会进入导出;
导出的始终是原坐标下、仅做过搭接扩展的两张黑白墨版。
"""

from __future__ import annotations

import os
import sys

import numpy as np
from PySide6.QtCore import Qt, Signal
from PySide6.QtGui import QImage, QPixmap, QPen, QColor, QFont, QPainter
from PySide6.QtWidgets import (
    QApplication,
    QButtonGroup,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QGraphicsEllipseItem,
    QGraphicsLineItem,
    QGraphicsPixmapItem,
    QGraphicsScene,
    QGraphicsView,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .geometry import compute_trap, edt_nearest, shift_mask, nearest_pixel
from .sample import build_sample, SAMPLE_SIZE

# ---- 显色 (仅预览用, 导出仍是黑白) ----
PAPER = np.array([246, 244, 238], dtype=np.float64)
INK_A = np.array([25, 75, 190], dtype=np.float64)    # 专色 A: 蓝
INK_B = np.array([200, 60, 35], dtype=np.float64)    # 专色 B: 朱红
ADDED = np.array([46, 190, 90], dtype=np.float64)     # 搭接新增: 绿
GAP = np.array([255, 176, 80], dtype=np.float64)      # 露白: 琥珀
GRAY_INK = np.array([214, 214, 214], dtype=np.float64)

VIEW_OVERPRINT = "叠色预览"
VIEW_PLATE_A = "仅 A 版"
VIEW_PLATE_B = "仅 B 版"
VIEW_PAPER = "纸底 / 露白检查"
VIEW_DIFF = "最终像素变化"


def load_plate(path: str) -> np.ndarray:
    """读黑白 PNG 为布尔墨版 (True=有墨)。带 Alpha 时按不透明度折算。"""
    img = QImage(path)
    if img.isNull():
        raise ValueError(f"无法读取图片: {path}")
    if img.hasAlphaChannel():
        img = img.convertToFormat(QImage.Format.Format_RGBA8888)
        arr = np.frombuffer(img.bits().tobytes(), dtype=np.uint8).reshape(
            img.height(), img.width(), 4
        )
        gray = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
        coverage = gray * (arr[:, :, 3].astype(np.float64) / 255.0)
    else:
        img = img.convertToFormat(QImage.Format.Format_Grayscale8)
        coverage = np.frombuffer(img.bits().tobytes(), dtype=np.uint8).reshape(
            img.height(), img.width()
        ).astype(np.float64)
    return coverage < 128.0


def save_plate(mask: np.ndarray, path: str) -> None:
    """把布尔墨版写成 8 位灰度黑白 PNG (有墨=0, 纸=255)。"""
    h, w = mask.shape
    gray = np.where(mask, 0, 255).astype(np.uint8)
    img = QImage(gray.data.tobytes(), w, h, w, QImage.Format.Format_Grayscale8).copy()
    if not img.save(path, "PNG"):
        raise OSError(f"写出失败: {path}")


class ImageView(QGraphicsView):
    """点击探针 + 滚轮缩放 + 拖拽平移的画布。"""

    probed = Signal(int, int)

    def __init__(self) -> None:
        super().__init__()
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform, False)
        self.setDragMode(QGraphicsView.DragMode.ScrollHandDrag)
        self.setTransformationAnchor(QGraphicsView.ViewportAnchor.AnchorUnderMouse)
        self.setResizeAnchor(QGraphicsView.ViewportAnchor.AnchorViewCenter)
        self.setBackgroundBrush(QColor(232, 230, 226))
        self._pixmap_item: QGraphicsPixmapItem | None = None
        self._markers: list = []

    def set_image(self, rgb: np.ndarray) -> None:
        h, w, _ = rgb.shape
        img = QImage(rgb.data, w, h, 3 * w, QImage.Format.Format_RGB888).copy()
        pix = QPixmap.fromImage(img)
        if self._pixmap_item is None:
            self._pixmap_item = self._scene.addPixmap(pix)
        else:
            self._pixmap_item.setPixmap(pix)
        self._scene.setSceneRect(0, 0, w, h)

    def fit(self) -> None:
        self.fitInView(self._scene.sceneRect(), Qt.AspectRatioMode.KeepAspectRatio)

    def clear_markers(self) -> None:
        for item in self._markers:
            self._scene.removeItem(item)
        self._markers.clear()

    def add_crosshair(self, y: int, x: int) -> None:
        pen = QPen(QColor(20, 20, 20), 0.0)
        pen.setCosmetic(True)
        pen.setWidth(1)
        r = self._scene.sceneRect()
        l1 = QGraphicsLineItem(0, y + 0.5, r.width(), y + 0.5)
        l2 = QGraphicsLineItem(x + 0.5, 0, x + 0.5, r.height())
        for line in (l1, l2):
            line.setPen(pen)
            line.setZValue(10)
            self._scene.addItem(line)
            self._markers.append(line)

    def add_marker(self, y: int, x: int, radius: float, color: QColor) -> None:
        dot = QGraphicsEllipseItem(x - 3, y - 3, 6, 6)
        dot.setPen(QPen(color, 1))
        dot.setBrush(color)
        dot.setZValue(11)
        self._scene.addItem(dot)
        self._markers.append(dot)
        if radius > 0.5:
            ring = QGraphicsEllipseItem(
                x - radius, y - radius, 2 * radius, 2 * radius
            )
            pen = QPen(color, 0)
            pen.setCosmetic(True)
            pen.setStyle(Qt.PenStyle.DashLine)
            pen.setWidth(1)
            ring.setPen(pen)
            ring.setZValue(10)
            self._scene.addItem(ring)
            self._markers.append(ring)

    def wheelEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        factor = 1.25 if event.angleDelta().y() > 0 else 1 / 1.25
        self.scale(factor, factor)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            p = self.mapToScene(event.position().toPoint())
            r = self._scene.sceneRect()
            if r.contains(p):
                self.probed.emit(int(p.y()), int(p.x()))
        super().mousePressEvent(event)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Trap Studio — 专色搭接打样")
        self.resize(1280, 860)

        # ---- 状态 ----
        self.plate_a, self.plate_b = build_sample()
        self.name_a = "样图 A"
        self.name_b = "样图 B"
        self.path_a = ""
        self.path_b = ""
        self.width = 3.0
        self.spread = "A"
        self.trap_on = True
        self.off_a = (0, 0)
        self.off_b = (0, 0)
        self.trap_a = self.trap_b = self.added = None

        # ---- 画布 ----
        self.view = ImageView()
        self.view.probed.connect(self._on_probe)

        side = self._build_panel()
        splitter = QWidget()
        lay = QHBoxLayout(splitter)
        lay.setContentsMargins(6, 6, 6, 6)
        lay.addWidget(self.view, 1)
        lay.addWidget(side, 0)
        self.setCentralWidget(splitter)

        self._probe_text = QLabel("在画布上点击任意像素查看两版实际盖到的范围。")
        self._probe_text.setWordWrap(True)
        self.statusBar().addWidget(self._probe_text, 1)

        self._refresh_fields()
        self._recompute()
        self._render()
        self.view.fit()

    # ------------------------------------------------------------------ UI
    def _spin(self, lo: int, hi: int, value: int) -> QSpinBox:
        s = QSpinBox()
        s.setRange(lo, hi)
        s.setValue(value)
        s.setSuffix(" px")
        return s

    def _build_panel(self) -> QWidget:
        panel = QWidget()
        outer = QVBoxLayout(panel)
        box = QVBoxLayout()
        box.setSpacing(10)

        # --- 输入 ---
        g_in = QGroupBox("1. 输入墨版 (黑白 PNG, 同尺寸)")
        gl = QGridLayout(g_in)
        self.lbl_a = QLabel()
        self.lbl_b = QLabel()
        btn_a = QPushButton("载入 A 版 PNG…")
        btn_b = QPushButton("载入 B 版 PNG…")
        btn_sample = QPushButton("生成内置样图")
        btn_a.clicked.connect(lambda: self._load("A"))
        btn_b.clicked.connect(lambda: self._load("B"))
        btn_sample.clicked.connect(self._load_sample)
        gl.addWidget(btn_a, 0, 0)
        gl.addWidget(self.lbl_a, 0, 1)
        gl.addWidget(btn_b, 1, 0)
        gl.addWidget(self.lbl_b, 1, 1)
        gl.addWidget(btn_sample, 2, 0, 1, 2)
        box.addWidget(g_in)

        # --- 搭接参数 ---
        g_trap = QGroupBox("2. 搭接 (作用于原坐标墨版)")
        tl = QGridLayout(g_trap)
        self.spin_width = QDoubleSpinBox()
        self.spin_width.setRange(0.0, 100.0)
        self.spin_width.setSingleStep(0.5)
        self.spin_width.setDecimals(1)
        self.spin_width.setValue(self.width)
        self.spin_width.setSuffix(" px")
        self.spin_width.valueChanged.connect(self._on_width)
        tl.addWidget(QLabel("搭接宽度"), 0, 0)
        tl.addWidget(self.spin_width, 0, 1)

        self.radio_a = QRadioButton("A 版扩向 B 版 (A 为浅色/下印)")
        self.radio_b = QRadioButton("B 版扩向 A 版 (B 为浅色/下印)")
        self.radio_a.setChecked(True)
        grp = QButtonGroup(self)
        grp.addButton(self.radio_a)
        grp.addButton(self.radio_b)
        self.radio_a.toggled.connect(self._on_spread)
        tl.addWidget(self.radio_a, 1, 0, 1, 2)
        tl.addWidget(self.radio_b, 2, 0, 1, 2)

        self.btn_toggle = QPushButton("搭接对比: 开 (点击临时关闭)")
        self.btn_toggle.setCheckable(True)
        self.btn_toggle.setChecked(True)
        self.btn_toggle.clicked.connect(self._on_toggle_trap)
        tl.addWidget(self.btn_toggle, 3, 0, 1, 2)
        self.lbl_added = QLabel()
        tl.addWidget(self.lbl_added, 4, 0, 1, 2)
        box.addWidget(g_trap)

        # --- 偏移模拟 ---
        g_off = QGroupBox("3. 错版模拟 (只影响预览, 不进导出)")
        ol = QGridLayout(g_off)
        self.off_ax = self._spin(-50, 50, 0)
        self.off_ay = self._spin(-50, 50, 0)
        self.off_bx = self._spin(-50, 50, 0)
        self.off_by = self._spin(-50, 50, 0)
        for s in (self.off_ax, self.off_ay, self.off_bx, self.off_by):
            s.valueChanged.connect(self._on_offset)
        ol.addWidget(QLabel("A 版 dx/dy"), 0, 0)
        ol.addWidget(self.off_ax, 0, 1)
        ol.addWidget(self.off_ay, 0, 2)
        ol.addWidget(QLabel("B 版 dx/dy"), 1, 0)
        ol.addWidget(self.off_bx, 1, 1)
        ol.addWidget(self.off_by, 1, 2)
        btn_reset = QPushButton("偏移归零")
        btn_reset.clicked.connect(self._reset_offsets)
        ol.addWidget(btn_reset, 2, 0, 1, 3)
        box.addWidget(g_off)

        # --- 视图 ---
        g_view = QGroupBox("4. 视图")
        vl = QVBoxLayout(g_view)
        self.combo_view = QComboBox()
        self.combo_view.addItems(
            [VIEW_OVERPRINT, VIEW_PLATE_A, VIEW_PLATE_B, VIEW_PAPER, VIEW_DIFF]
        )
        self.combo_view.currentTextChanged.connect(lambda _: self._render())
        vl.addWidget(self.combo_view)
        btn_fit = QPushButton("适应窗口")
        btn_fit.clicked.connect(self.view.fit)
        vl.addWidget(btn_fit)
        hint = QLabel(
            "绿=搭接新增像素, 琥珀=未被任何版盖住的纸底/露白。\n"
            "滚轮缩放, 拖拽平移, 左键探针。"
        )
        hint.setWordWrap(True)
        vl.addWidget(hint)
        box.addWidget(g_view)

        # --- 导出 ---
        g_out = QGroupBox("5. 导出 (原坐标, 不含模拟偏移)")
        el = QVBoxLayout(g_out)
        btn_export = QPushButton("导出处理后的两张墨版 PNG…")
        btn_export.clicked.connect(self._export)
        el.addWidget(btn_export)
        box.addWidget(g_out)
        box.addStretch(1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        inner = QWidget()
        inner.setLayout(box)
        scroll.setWidget(inner)
        outer.addWidget(scroll)
        panel.setFixedWidth(330)
        self._update_name_labels()
        return panel

    # ------------------------------------------------------------- 状态逻辑
    def _refresh_fields(self) -> None:
        """墨版变化时重算两版的距离场; 只调宽度时可复用。"""
        self._fields_a = edt_nearest(self.plate_a)
        self._fields_b = edt_nearest(self.plate_b)

    def _recompute(self) -> None:
        """从原始墨版重算搭接, 结果与偏移无关、不累积。"""
        if not hasattr(self, "_fields_a"):
            self._refresh_fields()
        self.trap_a, self.trap_b, self.added = compute_trap(
            self.plate_a, self.plate_b, self.width, self.spread,
            fields_a=self._fields_a, fields_b=self._fields_b,
        )

    def _shifted_plates(self) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
        """返回预览用的四件套: (偏移后 A, 偏移后 B, 偏移后新增, 露白)。"""
        if self.trap_on:
            base_a, base_b = self.trap_a, self.trap_b
        else:
            base_a, base_b = self.plate_a, self.plate_b
        sa = shift_mask(base_a, *self.off_a)
        sb = shift_mask(base_b, *self.off_b)
        sadded = shift_mask(self.added if self.trap_on else np.zeros_like(self.added),
                            *self.off_a)
        gap = ~(sa | sb)
        return sa, sb, sadded, gap

    def _on_width(self, v: float) -> None:
        self.width = float(v)
        self._recompute()
        self._render()

    def _on_spread(self) -> None:
        self.spread = "A" if self.radio_a.isChecked() else "B"
        self._recompute()
        self._render()

    def _on_toggle_trap(self) -> None:
        self.trap_on = self.btn_toggle.isChecked()
        self.btn_toggle.setText(
            "搭接对比: 开 (点击临时关闭)" if self.trap_on
            else "搭接对比: 关 — 当前为无搭接原图"
        )
        self._render()

    def _on_offset(self) -> None:
        self.off_a = (self.off_ax.value(), self.off_ay.value())
        self.off_b = (self.off_bx.value(), self.off_by.value())
        self._render()

    def _reset_offsets(self) -> None:
        for s in (self.off_ax, self.off_ay, self.off_bx, self.off_by):
            s.blockSignals(True)
            s.setValue(0)
            s.blockSignals(False)
        self.off_a = self.off_b = (0, 0)
        self._render()

    # ---------------------------------------------------------------- 输入
    def _load(self, which: str) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, f"选择 {which} 版黑白 PNG", "", "PNG 图片 (*.png)"
        )
        if not path:
            return
        try:
            plate = load_plate(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "读取失败", str(exc))
            return
        other = self.plate_b if which == "A" else self.plate_a
        if plate.shape != other.shape:
            QMessageBox.warning(
                self, "尺寸不一致",
                f"新图尺寸 {plate.shape[::-1]} 与另一版 {other.shape[::-1]} 不同, "
                "两张墨版必须同大小。",
            )
            return
        if which == "A":
            self.plate_a, self.path_a, self.name_a = plate, path, os.path.basename(path)
        else:
            self.plate_b, self.path_b, self.name_b = plate, path, os.path.basename(path)
        self._update_name_labels()
        self._refresh_fields()
        self._recompute()
        self._render()

    def _load_sample(self) -> None:
        self.plate_a, self.plate_b = build_sample()
        self.path_a = self.path_b = ""
        self.name_a = f"样图 A ({SAMPLE_SIZE}×{SAMPLE_SIZE})"
        self.name_b = f"样图 B ({SAMPLE_SIZE}×{SAMPLE_SIZE})"
        self._update_name_labels()
        self._refresh_fields()
        self._recompute()
        self._render()

    def _update_name_labels(self) -> None:
        self.lbl_a.setText(self.name_a)
        self.lbl_b.setText(self.name_b)
        if self.added is not None:
            self.lbl_added.setText(
                f"搭接新增像素: {int(self.added.sum())} "
                f"(全部加在 {self.spread} 版, 原坐标)"
            )

    # ---------------------------------------------------------------- 渲染
    def _render(self) -> None:
        sa, sb, sadded, gap = self._shifted_plates()
        mode = self.combo_view.currentText()
        h, w = sa.shape
        rgb = np.tile(PAPER, (h, w, 1))
        self.view.clear_markers()  # 探针标记只在当次视图有效

        if mode == VIEW_OVERPRINT:
            rgb[sa] = INK_A
            rgb[sb] = INK_B
            both = sa & sb
            rgb[both] = INK_A * 0.45 + INK_B * 0.55   # 叠印: 可辨识的紫调混合
            rgb[gap] = PAPER                          # 露白即纸色
            rgb[sadded] = ADDED                       # 搭接带置顶高亮, 不被实色盖住
        elif mode == VIEW_PLATE_A:
            rgb[sa] = INK_A
            rgb[sadded] = ADDED
        elif mode == VIEW_PLATE_B:
            rgb[sb] = INK_B
            rgb[sadded] = ADDED
        elif mode == VIEW_PAPER:
            covered = sa | sb
            rgb[covered] = GRAY_INK
            rgb[gap] = GAP
            rgb[sadded] = ADDED
        elif mode == VIEW_DIFF:
            # 原坐标最终变化, 不受偏移影响; 先画底, 再把新增像素置顶为绿色
            rgb[self.plate_a] = INK_A * 0.45 + PAPER * 0.55
            rgb[self.plate_b] = INK_B * 0.45 + PAPER * 0.55
            both = self.plate_a & self.plate_b
            rgb[both] = INK_A * 0.25 + INK_B * 0.3 + PAPER * 0.45
            rgb[self.trap_a & ~self.plate_a] = ADDED
            rgb[self.trap_b & ~self.plate_b] = ADDED

        self.view.set_image(np.ascontiguousarray(rgb, dtype=np.uint8))
        self._update_name_labels()

    # ---------------------------------------------------------------- 探针
    def _on_probe(self, y: int, x: int) -> None:
        sa, sb, _, _ = self._shifted_plates()
        lines = [f"探针像素 (y={y}, x={x})"]
        cov = []
        if sa[y, x]:
            cov.append("A")
        if sb[y, x]:
            cov.append("B")
        lines.append("当前覆盖: " + ("、".join(cov) if cov else "露白(两版均未盖到)"))

        self.view.clear_markers()
        self.view.add_crosshair(y, x)
        for name, mask, color in (
            ("A", sa, QColor(25, 75, 190)),
            ("B", sb, QColor(200, 60, 35)),
        ):
            hit = nearest_pixel(mask, y, x, max_radius=160)
            if hit is None:
                lines.append(f"{name} 版: 160px 内无墨迹")
                continue
            (ny, nx), dist = hit
            state = "就盖在该像素上" if dist == 0 else f"最近墨迹 (y={ny}, x={nx}), 距离 {dist:.1f}px"
            lines.append(f"{name} 版: {state}")
            self.view.add_marker(ny, nx, dist, color)
        self._probe_text.setText("\n".join(lines))

    # ---------------------------------------------------------------- 导出
    def _export(self) -> None:
        d = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not d:
            return
        stem_a = os.path.splitext(self.name_a)[0] or "plate_A"
        stem_b = os.path.splitext(self.name_b)[0] or "plate_B"
        pa = os.path.join(d, f"{stem_a}_trap.png")
        pb = os.path.join(d, f"{stem_b}_trap.png")
        try:
            # 导出的是原坐标处理版, 偏移状态完全不参与。
            save_plate(self.trap_a, pa)
            save_plate(self.trap_b, pb)
        except OSError as exc:
            QMessageBox.warning(self, "导出失败", str(exc))
            return
        QMessageBox.information(
            self, "导出完成",
            f"{pa}\n{pb}\n\n均为原坐标黑白墨版, 未写入模拟偏移。",
        )


def main() -> int:
    app = QApplication(sys.argv)
    app.setFont(QFont())
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
