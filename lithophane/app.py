"""PySide6 本地预览导出界面。"""

from __future__ import annotations

import os

import numpy as np
from PySide6.QtCore import Qt, QTimer, Signal, QPointF
from PySide6.QtGui import QImage, QPainter, QPen, QColor, QFont
from PySide6.QtWidgets import (
    QApplication, QCheckBox, QDoubleSpinBox, QFileDialog, QFrame, QGridLayout,
    QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPushButton,
    QSpinBox, QSplitter, QStatusBar, QVBoxLayout, QWidget,
)

from .geometry import BoardParams, HeightField, MAX_GRID_NODES, build_heightfield
from .imaging import (
    gray_to_qimage, load_image, make_staircase, make_thinline,
    rgba_qimage,
)
from .mapping import ThicknessParams
from .mesh import (
    analyze_mesh, build_mesh, check_watertight, read_stl_binary, write_stl_binary,
)


# ---------------------------------------------------------------- 颜色工具

def thickness_colormap(t: np.ndarray, lo: float, hi: float) -> QImage:
    """厚度 -> 蓝青(薄)→绿→黄→红(厚) 伪彩图。"""
    if hi - lo < 1e-12:
        norm = np.zeros_like(t)
    else:
        norm = np.clip((t - lo) / (hi - lo), 0.0, 1.0)
    stops_pos = np.array([0.00, 0.25, 0.50, 0.75, 1.00])
    stops_rgb = np.array([
        (30, 60, 200),
        (0, 200, 220),
        (40, 180, 70),
        (240, 210, 40),
        (220, 50, 40),
    ], dtype=np.float64)
    idx = np.clip(np.digitize(norm, stops_pos[1:-1]), 0, len(stops_pos) - 2)
    f = (norm - stops_pos[idx]) / (stops_pos[idx + 1] - stops_pos[idx])
    c0 = stops_rgb[idx]
    c1 = stops_rgb[idx + 1]
    rgb = np.rint(c0 + (c1 - c0) * f[..., None]).astype(np.uint8)
    rgba = np.dstack([rgb, np.full(t.shape, 255, dtype=np.uint8)])
    return rgba_qimage(rgba)


def backlight_qimage(field: HeightField) -> QImage:
    """简化背光预览：薄处亮、厚处暗，sRGB gamma 近似。"""
    t = field.thickness
    lo, hi = t.min(), t.max()
    if hi - lo < 1e-12:
        rel = np.ones_like(t)
    else:
        rel = np.clip((hi - t) / (hi - lo), 0.0, 1.0)
    shown = np.power(rel, 1.0 / 2.2)
    return gray_to_qimage(shown)


# ---------------------------------------------------------------- 图像视图

class ImageView(QWidget):
    """可点击选行的图像视图，点击/拖动发出自顶部的相对位置。"""

    rowSelected = Signal(float)

    def __init__(self, title: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._title = title
        self._image: QImage | None = None
        self._fraction: float | None = None
        self.setMinimumSize(220, 180)
        self.setMouseTracking(True)

    def set_image(self, image: QImage | None) -> None:
        self._image = image
        self.update()

    def set_fraction(self, fraction: float | None) -> None:
        self._fraction = fraction
        self.update()

    def _image_rect(self) -> tuple[int, int, int, int]:
        if self._image is None or self._image.isNull():
            return (0, 0, self.width(), self.height())
        iw, ih = self._image.width(), self._image.height()
        scale = min(self.width() / iw, self.height() / ih)
        dw, dh = iw * scale, ih * scale
        x = (self.width() - dw) / 2.0
        y = (self.height() - dh) / 2.0
        return (int(round(x)), int(round(y)), int(round(dw)), int(round(dh)))

    def paintEvent(self, event) -> None:  # noqa: N802 (Qt 命名)
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(30, 30, 34))
        p.setPen(QColor(220, 220, 220))
        p.setFont(QFont("", 10, QFont.Weight.Bold))
        p.drawText(8, 16, self._title)
        if self._image is None or self._image.isNull():
            p.setPen(QColor(150, 150, 150))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter, "（无图像）")
            return
        x, y, w, h = self._image_rect()
        p.drawImage(x, y, self._image.scaled(
            w, h, Qt.AspectRatioMode.IgnoreAspectRatio,
            Qt.TransformationMode.FastTransformation))
        p.setPen(QPen(QColor(255, 80, 80), 1))
        p.drawRect(x, y, w, h)
        if self._fraction is not None:
            ly = y + int(round(self._fraction * h))
            pen = QPen(QColor(255, 255, 0), 2)
            p.setPen(pen)
            p.drawLine(x, ly, x + w, ly)
        p.end()

    def _emit_at(self, py: int) -> None:
        x, y, w, h = self._image_rect()
        if h <= 0:
            return
        frac = (py - y) / h
        self.rowSelected.emit(float(np.clip(frac, 0.0, 1.0)))

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self._emit_at(event.position().y())

    def mouseMoveEvent(self, event) -> None:  # noqa: N802
        if event.buttons() & Qt.MouseButton.LeftButton:
            self._emit_at(event.position().y())


# ---------------------------------------------------------------- 剖面视图

class ProfileWidget(QWidget):
    """同图绘制原图亮度剖面与毫米厚度剖面，厚度轴自动量程。"""

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self._gray_row: np.ndarray | None = None
        self._thick_row: np.ndarray | None = None
        self._x_mm: np.ndarray | None = None
        self.setMinimumHeight(200)

    def set_profiles(self, gray_row: np.ndarray, thick_row: np.ndarray,
                     x_mm: np.ndarray) -> None:
        self._gray_row = gray_row
        self._thick_row = thick_row
        self._x_mm = x_mm
        self.update()

    def clear(self) -> None:
        self._gray_row = None
        self.update()

    @staticmethod
    def _polyline(values: np.ndarray, rect, vmin: float, vmax: float,
                  color: QColor) -> list[tuple[float, float]]:
        n = values.size
        if n == 0:
            return []
        if vmax - vmin < 1e-15:
            vmin, vmax = vmin - 1e-3, vmax + 1e-3
        xs = np.linspace(rect.left(), rect.right(), n)
        ys = rect.bottom() - (values - vmin) / (vmax - vmin) * rect.height()
        return list(zip(xs.tolist(), ys.tolist()))

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.fillRect(self.rect(), QColor(245, 245, 247))
        p.setPen(QColor(40, 40, 40))
        p.setFont(QFont("", 10, QFont.Weight.Bold))
        p.drawText(10, 18, "横线剖面（左轴：原图亮度 0~1；右轴：毫米厚度，自动量程）")
        if self._gray_row is None or self._thick_row is None:
            p.setPen(QColor(130, 130, 130))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       "在任一视图点击选择一条横线")
            return

        margin_l, margin_r, margin_t, margin_b = 46, 56, 34, 26
        rect = self.rect().adjusted(margin_l, margin_t, -margin_r, -margin_b)
        p.setPen(QPen(QColor(190, 190, 190), 1))
        p.drawRect(rect)

        g, t = self._gray_row, self._thick_row
        t_lo, t_hi = float(t.min()), float(t.max())
        pad = max((t_hi - t_lo) * 0.15, 1e-4)
        t_view_lo, t_view_hi = t_lo - pad, t_hi + pad

        # 网格与右轴刻度（厚度）
        p.setFont(QFont("", 8))
        for k in range(5):
            val = t_view_lo + (t_view_hi - t_view_lo) * k / 4.0
            yy = rect.bottom() - k / 4.0 * rect.height()
            p.setPen(QPen(QColor(225, 225, 230), 1))
            p.drawLine(int(rect.left()), int(yy), int(rect.right()), int(yy))
            p.setPen(QColor(200, 70, 40))
            p.drawText(int(rect.right()) + 4, int(yy) + 4, f"{val:.3f}")
        # 左轴刻度（亮度）
        for k in range(5):
            val = k / 4.0
            yy = rect.bottom() - k / 4.0 * rect.height()
            p.setPen(QColor(60, 90, 180))
            p.drawText(6, int(yy) + 4, f"{val:.2f}")

        # 亮度剖面（蓝）
        pts_g = self._polyline(g, rect, 0.0, 1.0, QColor(60, 90, 180))
        if pts_g:
            p.setPen(QPen(QColor(60, 90, 180), 1.6))
            p.drawPolyline([QPointF(x, y) for x, y in pts_g])

        # 厚度剖面（红），自动量程，细线处的微小起伏也能看见
        pts_t = self._polyline(t, rect, t_view_lo, t_view_hi, QColor(200, 70, 40))
        if pts_t:
            p.setPen(QPen(QColor(200, 70, 40), 2.0))
            p.drawPolyline([QPointF(x, y) for x, y in pts_t])

        # 数值标注：即使整行厚度几乎相同，也明确给出极差
        span = t_hi - t_lo
        p.setFont(QFont("", 9))
        p.setPen(QColor(40, 40, 40))
        x_max = self._x_mm.max() if self._x_mm is not None else 0.0
        text = (f"厚度 最小 {t_lo:.4f} mm   最大 {t_hi:.4f} mm   "
                f"极差 {span:.4f} mm   板宽方向 0~{x_max:.2f} mm")
        p.drawText(int(rect.left()), int(rect.bottom()) + 18, text)
        p.setPen(QColor(60, 90, 180))
        p.drawText(int(rect.left()), int(rect.top()) - 8, "— 原图亮度")
        p.setPen(QColor(200, 70, 40))
        p.drawText(int(rect.left()) + 90, int(rect.top()) - 8, "— 厚度(mm)")
        p.end()


# ---------------------------------------------------------------- 数值控件

def _spin(minv: float, maxv: float, value: float, step: float,
          suffix: str, decimals: int = 3) -> QDoubleSpinBox:
    s = QDoubleSpinBox()
    s.setRange(minv, maxv)
    s.setValue(value)
    s.setSingleStep(step)
    s.setSuffix(suffix)
    s.setDecimals(decimals)
    return s


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("灰度浮雕板预览导出工具")
        self.resize(1280, 860)

        self.gray: np.ndarray | None = None     # 原图亮度 [0,1]
        self.is_color = False
        self.source_path = ""
        self.field: HeightField | None = None
        self.fraction = 0.5

        self._build_ui()
        self._refresh_enabled()

    # -- UI 构建 ------------------------------------------------------

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        # 左侧参数面板
        panel = QFrame()
        panel.setFixedWidth(312)
        pv = QVBoxLayout(panel)

        grp_file = QGroupBox("图像输入")
        gl = QGridLayout(grp_file)
        btn_open = QPushButton("打开图片（灰度/彩色）")
        btn_open.clicked.connect(self.on_open)
        btn_stair = QPushButton("载入灰度阶梯测试图")
        btn_stair.clicked.connect(lambda: self._load_array(make_staircase(), "阶梯测试图"))
        btn_thin = QPushButton("载入细线测试图")
        btn_thin.clicked.connect(lambda: self._load_array(make_thinline(), "细线测试图"))
        gl.addWidget(btn_open, 0, 0, 1, 2)
        gl.addWidget(btn_stair, 1, 0)
        gl.addWidget(btn_thin, 1, 1)
        self.lbl_source = QLabel("未载入图像")
        self.lbl_source.setWordWrap(True)
        gl.addWidget(self.lbl_source, 2, 0, 1, 2)
        pv.addWidget(grp_file)

        grp_map = QGroupBox("灰度 → 厚度映射")
        ml = QGridLayout(grp_map)
        self.sp_black = _spin(0.0, 1.0, 0.0, 0.01, "", 3)
        self.sp_white = _spin(0.0, 1.0, 1.0, 0.01, "", 3)
        self.sp_tmin = _spin(0.01, 50.0, 0.8, 0.1, " mm", 3)
        self.sp_tmax = _spin(0.01, 50.0, 3.0, 0.1, " mm", 3)
        self.chk_dark = QCheckBox("暗部更厚（背光浮雕惯例，取消则翻转方向）")
        self.chk_dark.setChecked(True)
        ml.addWidget(QLabel("黑点"), 0, 0)
        ml.addWidget(self.sp_black, 0, 1)
        ml.addWidget(QLabel("白点"), 1, 0)
        ml.addWidget(self.sp_white, 1, 1)
        ml.addWidget(QLabel("最小厚度"), 2, 0)
        ml.addWidget(self.sp_tmin, 2, 1)
        ml.addWidget(QLabel("最大厚度"), 3, 0)
        ml.addWidget(self.sp_tmax, 3, 1)
        ml.addWidget(self.chk_dark, 4, 0, 1, 2)
        pv.addWidget(grp_map)

        grp_board = QGroupBox("板体（毫米与采样密度独立）")
        bl = QGridLayout(grp_board)
        self.sp_w = _spin(1.0, 1000.0, 100.0, 1.0, " mm", 2)
        self.sp_h = _spin(1.0, 1000.0, 80.0, 1.0, " mm", 2)
        self.sp_cols = QSpinBox()
        self.sp_cols.setRange(2, 4000)
        self.sp_cols.setValue(200)
        self.sp_rows = QSpinBox()
        self.sp_rows.setRange(2, 4000)
        self.sp_rows.setValue(160)
        self.sp_border = _spin(0.0, 100.0, 4.0, 0.5, " mm", 2)
        self.sp_border_t = _spin(0.01, 50.0, 3.0, 0.1, " mm", 3)
        self.chk_aspect = QCheckBox("非正方形图等比例留边")
        bl.addWidget(QLabel("板宽"), 0, 0)
        bl.addWidget(self.sp_w, 0, 1)
        bl.addWidget(QLabel("板高"), 1, 0)
        bl.addWidget(self.sp_h, 1, 1)
        bl.addWidget(QLabel("左右采样密度"), 2, 0)
        bl.addWidget(self.sp_cols, 2, 1)
        bl.addWidget(QLabel("上下采样密度"), 3, 0)
        bl.addWidget(self.sp_rows, 3, 1)
        bl.addWidget(QLabel("边框宽度"), 4, 0)
        bl.addWidget(self.sp_border, 4, 1)
        bl.addWidget(QLabel("边框厚度"), 5, 0)
        bl.addWidget(self.sp_border_t, 5, 1)
        bl.addWidget(self.chk_aspect, 6, 0, 1, 2)
        self.lbl_limit = QLabel(f"网格节点上限 {MAX_GRID_NODES:,}（密度×密度）")
        self.lbl_limit.setWordWrap(True)
        bl.addWidget(self.lbl_limit, 7, 0, 1, 2)
        pv.addWidget(grp_board)

        grp_line = QGroupBox("剖面横线")
        ll = QGridLayout(grp_line)
        self.sp_row = QSpinBox()
        self.sp_row.setRange(0, 0)
        ll.addWidget(QLabel("原图行号"), 0, 0)
        ll.addWidget(self.sp_row, 0, 1)
        pv.addWidget(grp_line)

        grp_io = QGroupBox("网格导出 / 读回")
        il = QGridLayout(grp_io)
        btn_export = QPushButton("导出 STL（并自动读回）")
        btn_export.clicked.connect(self.on_export)
        btn_reload = QPushButton("读回已有 STL…")
        btn_reload.clicked.connect(self.on_reload_stl)
        il.addWidget(btn_export, 0, 0, 1, 2)
        il.addWidget(btn_reload, 1, 0, 1, 2)
        self.lbl_readback = QLabel("尚未读回")
        self.lbl_readback.setWordWrap(True)
        il.addWidget(self.lbl_readback, 2, 0, 1, 2)
        pv.addWidget(grp_io)
        pv.addStretch(1)
        root.addWidget(panel)

        # 右侧视图
        splitter_v = QSplitter(Qt.Orientation.Vertical)
        splitter_h = QSplitter(Qt.Orientation.Horizontal)
        self.view_gray = ImageView("灰度（原图亮度，点击选行）")
        self.view_thick = ImageView("毫米厚度（蓝薄→红厚）")
        self.view_back = ImageView("简化背光预览")
        for v in (self.view_gray, self.view_thick, self.view_back):
            v.rowSelected.connect(self.on_row_selected)
            splitter_h.addWidget(v)
        splitter_v.addWidget(splitter_h)

        self.profile = ProfileWidget()
        splitter_v.addWidget(self.profile)

        readback_box = QGroupBox("读回厚度图（来自 STL 正面顶点，行0=板顶）")
        rb = QHBoxLayout(readback_box)
        self.view_readback = ImageView("读回")
        self.view_readback.setMinimumHeight(140)
        rb.addWidget(self.view_readback, 1)
        splitter_v.addWidget(readback_box)
        splitter_v.setSizes([380, 260, 180])
        root.addWidget(splitter_v, 1)

        self.setStatusBar(QStatusBar())

        # 所有参数变更 -> 防抖重算
        for sp in (self.sp_black, self.sp_white, self.sp_tmin, self.sp_tmax,
                   self.sp_w, self.sp_h, self.sp_border, self.sp_border_t):
            sp.valueChanged.connect(self._schedule_recompute)
        for sp in (self.sp_cols, self.sp_rows):
            sp.valueChanged.connect(self._schedule_recompute)
        self.chk_dark.stateChanged.connect(self._schedule_recompute)
        self.chk_aspect.stateChanged.connect(self._schedule_recompute)
        self.sp_row.valueChanged.connect(self._on_row_spin)

        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.timeout.connect(self.recompute)

    # -- 参数收集 -----------------------------------------------------

    def _thickness_params(self) -> ThicknessParams:
        return ThicknessParams(
            t_min=self.sp_tmin.value(),
            t_max=self.sp_tmax.value(),
            black_point=self.sp_black.value(),
            white_point=self.sp_white.value(),
            dark_thick=self.chk_dark.isChecked(),
        )

    def _board_params(self) -> BoardParams:
        return BoardParams(
            width_mm=self.sp_w.value(),
            height_mm=self.sp_h.value(),
            cols=self.sp_cols.value(),
            rows=self.sp_rows.value(),
            border_mm=self.sp_border.value(),
            border_thickness_mm=self.sp_border_t.value(),
            keep_aspect=self.chk_aspect.isChecked(),
        )

    # -- 载入 ---------------------------------------------------------

    def on_open(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择图片", "", "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff)")
        if not path:
            return
        try:
            gray, is_color = load_image(path)
        except OSError as exc:
            QMessageBox.warning(self, "读取失败", str(exc))
            return
        self.gray = gray
        self.is_color = is_color
        self.source_path = path
        self.lbl_source.setText(
            f"{os.path.basename(path)}\n{gray.shape[1]}×{gray.shape[0]} "
            f"{'彩色（按亮度折算）' if is_color else '灰度'}")
        self._after_load()

    def _load_array(self, arr_u8: np.ndarray, name: str) -> None:
        self.gray = arr_u8.astype(np.float64) / 255.0
        self.is_color = False
        self.source_path = name
        self.lbl_source.setText(f"{name}\n{arr_u8.shape[1]}×{arr_u8.shape[0]} 灰度")
        self._after_load()

    def _after_load(self) -> None:
        assert self.gray is not None
        self.sp_row.setRange(0, self.gray.shape[0] - 1)
        self.fraction = 0.5
        self.sp_row.blockSignals(True)
        self.sp_row.setValue(self.gray.shape[0] // 2)
        self.sp_row.blockSignals(False)
        self.view_gray.set_image(gray_to_qimage(self.gray))
        self.recompute()
        self._refresh_enabled()

    # -- 选行 ---------------------------------------------------------

    def on_row_selected(self, fraction: float) -> None:
        self.fraction = float(np.clip(fraction, 0.0, 1.0))
        if self.gray is not None:
            row = int(round(self.fraction * (self.gray.shape[0] - 1)))
            self.sp_row.blockSignals(True)
            self.sp_row.setValue(row)
            self.sp_row.blockSignals(False)
        self._sync_fraction_views()
        self._update_profile()

    def _on_row_spin(self, row: int) -> None:
        if self.gray is None or self.gray.shape[0] <= 1:
            return
        self.fraction = row / (self.gray.shape[0] - 1)
        self._sync_fraction_views()
        self._update_profile()

    def _sync_fraction_views(self) -> None:
        for v in (self.view_gray, self.view_thick, self.view_back):
            v.set_fraction(self.fraction)

    # -- 重算（出错保留旧预览）----------------------------------------

    def _schedule_recompute(self) -> None:
        self._timer.start(120)

    def recompute(self) -> None:
        if self.gray is None:
            return
        try:
            new_field = build_heightfield(self.gray, self._board_params(),
                                          self._thickness_params())
        except Exception as exc:  # 超限/参数冲突：提示且保留旧预览
            self.statusBar().showMessage(f"⚠ {exc}（保留当前预览）", 8000)
            return
        self.field = new_field
        lo, hi = float(new_field.thickness.min()), float(new_field.thickness.max())
        self.view_thick.set_image(
            thickness_colormap(new_field.thickness, lo, hi))
        self.view_back.set_image(backlight_qimage(new_field))
        self._sync_fraction_views()
        self._update_profile()
        note = "整板厚度一致" if new_field.uniform else ""
        self.statusBar().showMessage(
            f"已更新：{new_field.thickness.shape[1]}×{new_field.thickness.shape[0]} "
            f"格点，厚度 {lo:.3f}~{hi:.3f} mm {note}", 5000)

    def _update_profile(self) -> None:
        if self.gray is None or self.field is None:
            self.profile.clear()
            return
        src_h = self.gray.shape[0]
        rows = self.field.thickness.shape[0]
        src_row = int(round(self.fraction * (src_h - 1))) if src_h > 1 else 0
        grid_row = int(round(self.fraction * (rows - 1))) if rows > 1 else 0
        gray_row = self.gray[src_row, :]
        thick_row = self.field.thickness[grid_row, :]
        self.profile.set_profiles(gray_row, thick_row, self.field.x_coords)

    # -- 导出 / 读回 --------------------------------------------------

    def on_export(self) -> None:
        if self.field is None:
            QMessageBox.information(self, "提示", "请先载入图像")
            return
        try:
            bp, tp = self._board_params(), self._thickness_params()
            bp.validate()
            tp.validate()
            mesh = build_mesh(self.field.thickness, self.field.x_coords,
                              self.field.y_coords)
            watertight, boundary = check_watertight(mesh)
            if not watertight:
                QMessageBox.warning(
                    self, "网格未闭合",
                    f"检测到 {boundary} 条边界边，导出中止，请检查参数。")
                return
            path, _ = QFileDialog.getSaveFileName(self, "导出 STL", "plate.stl",
                                                  "二进制 STL (*.stl)")
            if not path:
                return
            write_stl_binary(path, mesh)
            size_kb = os.path.getsize(path) / 1024.0
            self.statusBar().showMessage(
                f"已导出 {path}：{mesh.n_triangles} 个三角，{size_kb:.0f} KB", 8000)
            self._readback(path, mesh.triangles.shape[0])
        except Exception as exc:
            QMessageBox.warning(self, "导出失败", str(exc))

    def on_reload_stl(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "选择 STL", "", "STL (*.stl)")
        if path:
            try:
                self._readback(path, None)
            except Exception as exc:
                QMessageBox.warning(self, "读回失败", str(exc))

    def _readback(self, path: str, expected_tris: int | None) -> None:
        mesh = read_stl_binary(path)
        if self.field is None:
            QMessageBox.information(self, "读回", "已读回，但当前无预览参数可对照")
            return
        rows, cols = self.field.thickness.shape
        analysis = analyze_mesh(mesh, rows, cols)
        self.view_readback.set_image(
            thickness_colormap(analysis.thickness_grid,
                               analysis.t_min, analysis.t_max))

        # 方向核对：细线测试图/任意图，顶部与底部厚度分布应与高度场一致
        top_a = analysis.thickness_grid[: max(rows // 8, 1)].mean()
        top_b = self.field.thickness[: max(rows // 8, 1)].mean()
        bot_a = analysis.thickness_grid[-max(rows // 8, 1):].mean()
        bot_b = self.field.thickness[-max(rows // 8, 1):].mean()
        orient_ok = abs(top_a - top_b) < 0.02 and abs(bot_a - bot_b) < 0.02
        # 厚度位置核对：逐点差异（STL float32 精度）
        max_diff = float(np.abs(analysis.thickness_grid -
                                self.field.thickness).max())
        tri_text = (f"，三角 {analysis.n_triangles}"
                    if expected_tris is None or
                    analysis.n_triangles == expected_tris else
                    f"，三角 {analysis.n_triangles}（导出 {expected_tris}）")
        self.lbl_readback.setText(
            f"文件：{os.path.basename(path)}{tri_text}\n"
            f"实体范围：{analysis.width:.3f} × {analysis.height:.3f} × "
            f"{analysis.depth:.3f} mm\n"
            f"最薄 {analysis.t_min:.4f} mm @ 行{analysis.min_pos[0]} 列{analysis.min_pos[1]}\n"
            f"最厚 {analysis.t_max:.4f} mm @ 行{analysis.max_pos[0]} 列{analysis.max_pos[1]}\n"
            f"闭合性：{'闭合 ✓' if analysis.watertight else f'存在 {analysis.boundary_edges} 条边界边 ✗'}\n"
            f"上下方向核对：{'一致 ✓' if orient_ok else '不一致 ✗'}\n"
            f"厚度位置逐点最大偏差：{max_diff:.5f} mm")

    def _refresh_enabled(self) -> None:
        has = self.gray is not None
        for w in (self.view_thick, self.view_back, self.profile,
                  self.view_readback):
            w.setEnabled(has)


def main() -> int:
    import sys
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
