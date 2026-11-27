"""PySide6 双面透印修复窗口。

布局: 2x2 图像视图(正面原图 / 背面 / 修复结果 / 实际改动), 右侧控制坞。
所有标注(点对、保护笔画、局部块)都存原图像素坐标, 缩放只改视图变换,
标注落点永远钉在原图上。
"""

from __future__ import annotations

import cv2
import numpy as np
from PySide6.QtCore import QPoint, QPointF, QRect, Qt, QTimer
from PySide6.QtGui import (
    QAction,
    QBrush,
    QColor,
    QImage,
    QPainter,
    QPen,
    QPixmap,
)
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QVBoxLayout,
    QWidget,
)

from .alignment import (
    Alignment,
    coverage_mask,
    fit_transform,
    residuals,
    warp_back,
)
from .bleed import (
    LocalPatch,
    ProcessParams,
    calibrate_strength,
    process_front,
)

# ---------------------------------------------------------------- 工具模式
MODE_PAN = "pan"
MODE_POINT = "point"
MODE_CALIB = "calib"
MODE_PROTECT = "protect"
MODE_ERASE_PROTECT = "erase"
MODE_PATCH = "patch"

VIEW_ORIGINAL = "original"
VIEW_RESULT = "result"
VIEW_DIFF = "diff"
VIEW_REF = "reference"
VIEW_PROTECT = "protect"


def gray_to_qimage(img: np.ndarray) -> QImage:
    """灰度 numpy -> QImage(拷贝, 避免生命周期问题)。"""
    if img.dtype != np.uint8:
        img = np.clip(img, 0, 255).astype(np.uint8)
    h, w = img.shape
    qimg = QImage(img.data, w, h, w, QImage.Format.Format_Grayscale8)
    return qimg.copy()


def color_overlay_qimage(base_gray: np.ndarray, mask: np.ndarray,
                         color: tuple[int, int, int], alpha: int = 110) -> QImage:
    """在灰度底图上叠加半透明彩色掩膜。"""
    rgb = cv2.cvtColor(base_gray, cv2.COLOR_GRAY2RGB)
    m = mask > 0
    overlay = rgb.copy()
    overlay[m] = color
    blended = cv2.addWeighted(overlay, alpha / 255.0, rgb, 1 - alpha / 255.0, 0)
    h, w, _ = blended.shape
    qimg = QImage(blended.data, w, h, 3 * w, QImage.Format.Format_RGB888)
    return qimg.copy()


class ImageView(QWidget):
    """单张图像的缩放/平移视图, 标注以原图像素坐标存储与绘制。"""

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self.setMinimumSize(320, 260)
        self.setMouseTracking(True)
        self.setFocusPolicy(Qt.FocusPolicy.StrongFocus)
        self.title = title
        self._qimg: QImage | None = None
        self._base_gray: np.ndarray | None = None
        self.scale = 1.0
        self.offset = QPointF(0, 0)
        self.tool = MODE_PAN
        self.panning = False
        self._last_pos = QPoint()
        self.drawing_stroke = False
        self.current_stroke: list[tuple[int, int]] = []
        self.on_mouse_info = None       # 回调(原图 x,y)
        self.on_click_image = None      # 回调(原图 x,y, button)
        self.on_stroke_done = None      # 回调(点序列)
        self.on_rect_drawn = None       # 回调(x,y,w,h)
        self.scale_changed = None       # 回调()
        self.offset_changed = None      # 回调()
        self._rect_start: QPointF | None = None
        self.paint_overlay = None       # 外部注入的额外绘制回调(painter, self)

    def set_image_gray(self, img: np.ndarray):
        self._base_gray = img
        self._qimg = gray_to_qimage(img)
        self.fit_to_window()
        self.update()

    def set_qimage(self, qimg: QImage):
        self._qimg = qimg
        self.update()

    def update_pixels_keep_view(self, img: np.ndarray | QImage):
        """换图像内容但保留当前缩放/平移(标注钉在原图像素, 视野不应跳)。"""
        if isinstance(img, np.ndarray):
            img = gray_to_qimage(img)
        self._qimg = img
        self.update()

    def base_gray(self) -> np.ndarray | None:
        return self._base_gray

    def fit_to_window(self):
        if self._qimg is None:
            return
        s = min(self.width() / self._qimg.width(),
                self.height() / self._qimg.height())
        self.scale = max(s, 1e-6)
        self.offset = QPointF(
            (self.width() - self._qimg.width() * self.scale) / 2,
            (self.height() - self._qimg.height() * self.scale) / 2,
        )
        self.update()

    # ------------------------------------------------ 坐标换算
    def widget_to_image(self, pos: QPointF) -> QPointF:
        return QPointF((pos.x() - self.offset.x()) / self.scale,
                       (pos.y() - self.offset.y()) / self.scale)

    def image_to_widget(self, x: float, y: float) -> QPointF:
        return QPointF(x * self.scale + self.offset.x(),
                       y * self.scale + self.offset.y())

    def clamp_to_image(self, pt: QPointF) -> tuple[int, int]:
        if self._qimg is None:
            return 0, 0
        x = int(np.clip(pt.x(), 0, self._qimg.width() - 1))
        y = int(np.clip(pt.y(), 0, self._qimg.height() - 1))
        return x, y

    # ------------------------------------------------ 事件
    def wheelEvent(self, event):
        if self._qimg is None:
            return
        factor = 1.25 if event.angleDelta().y() > 0 else 1 / 1.25
        new_scale = float(np.clip(self.scale * factor, 0.05, 40.0))
        anchor = self.widget_to_image(event.position())
        self.scale = new_scale
        self.offset = QPointF(
            event.position().x() - anchor.x() * new_scale,
            event.position().y() - anchor.y() * new_scale,
        )
        self.update()
        if self.scale_changed:
            self.scale_changed()

    def mousePressEvent(self, event):
        if self._qimg is None:
            return
        self.setFocus()
        img_pt = self.widget_to_image(event.position())
        if event.button() == Qt.MouseButton.MiddleButton or (
            event.button() == Qt.MouseButton.LeftButton and self.tool == MODE_PAN
        ):
            self.panning = True
            self._last_pos = event.position().toPoint()
            return
        if event.button() != Qt.MouseButton.LeftButton:
            return
        x, y = self.clamp_to_image(img_pt)
        if self.tool in (MODE_CALIB, MODE_PATCH):
            self._rect_start = QPointF(x, y)
        elif self.tool in (MODE_PROTECT, MODE_ERASE_PROTECT):
            self.drawing_stroke = True
            self.current_stroke = [(x, y)]
        elif self.tool == MODE_POINT and self.on_click_image:
            self.on_click_image(x, y, event.button)

    def mouseMoveEvent(self, event):
        img_pt = self.widget_to_image(event.position())
        if self.on_mouse_info and self._qimg is not None:
            x, y = self.clamp_to_image(img_pt)
            self.on_mouse_info(x, y)
        if self.panning:
            delta = event.position().toPoint() - self._last_pos
            self.offset += QPointF(delta)
            self._last_pos = event.position().toPoint()
            self.update()
            if self.offset_changed:
                self.offset_changed()
            return
        if self.drawing_stroke:
            x, y = self.clamp_to_image(img_pt)
            if not self.current_stroke or self.current_stroke[-1] != (x, y):
                self.current_stroke.append((x, y))
            self.update()
        elif self._rect_start is not None:
            self.update()

    def mouseReleaseEvent(self, event):
        if event.button() in (Qt.MouseButton.MiddleButton,):
            self.panning = False
        if event.button() == Qt.MouseButton.LeftButton:
            self.panning = False
            if self.drawing_stroke:
                self.drawing_stroke = False
                if self.on_stroke_done and self.current_stroke:
                    self.on_stroke_done(list(self.current_stroke))
                self.current_stroke = []
            elif self._rect_start is not None:
                end = self.widget_to_image(event.position())
                x0, y0 = self.clamp_to_image(self._rect_start)
                x1, y1 = self.clamp_to_image(end)
                rx, ry = min(x0, x1), min(y0, y1)
                rw, rh = abs(x1 - x0), abs(y1 - y0)
                self._rect_start = None
                if rw >= 4 and rh >= 4 and self.on_rect_drawn:
                    self.on_rect_drawn(rx, ry, rw, rh)
            self.update()

    def resizeEvent(self, event):
        if self._qimg is not None and self.scale <= 1e-5 + 1e-9:
            self.fit_to_window()
        super().resizeEvent(event)

    # ------------------------------------------------ 绘制
    def paintEvent(self, event):
        painter = QPainter(self)
        painter.fillRect(self.rect(), QColor(45, 45, 48))
        if self._qimg is None:
            painter.setPen(QColor(200, 200, 200))
            painter.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                             f"{self.title}\n(未载入图像)")
            return
        target = QRect(
            self.offset.toPoint(),
            (QPointF(self._qimg.width() * self.scale,
                     self._qimg.height() * self.scale)).toPoint(),
        )
        painter.drawImage(target, self._qimg)

        painter.setRenderHint(QPainter.RenderHint.Antialiasing, True)
        if self.paint_overlay:
            self.paint_overlay(painter, self)
        # 正在拖的矩形
        if self._rect_start is not None:
            cur = self.widget_to_image(self.mapFromGlobal(
                self.cursor().pos()))
            a = self.image_to_widget(self._rect_start.x(), self._rect_start.y())
            b = self.image_to_widget(cur.x(), cur.y())
            pen = QPen(QColor(80, 220, 255), 1.5, Qt.PenStyle.DashLine)
            painter.setPen(pen)
            painter.drawRect(QRect(a.toPoint(), b.toPoint()))
        # 正在画的保护笔画
        if self.current_stroke:
            painter.setPen(QPen(QColor(255, 170, 0), 2.5))
            pts = [self.image_to_widget(x, y) for x, y in self.current_stroke]
            for p, q in zip(pts, pts[1:]):
                painter.drawLine(p, q)
        painter.setPen(QColor(230, 230, 230))
        painter.drawText(12, 20, self.title)
        painter.end()


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("双面透印试修窗口 (descan)")
        self.front_gray: np.ndarray | None = None
        self.back_gray: np.ndarray | None = None
        self.front_clean: np.ndarray | None = None   # 合成数据才有真值底稿
        self.alignment = Alignment((0, 0), (0, 0))
        self.back_warped: np.ndarray | None = None
        self.coverage: np.ndarray | None = None
        self.params = ProcessParams()
        self.result = None
        self.calib_rect: tuple[int, int, int, int] | None = None
        self.reference_mask: np.ndarray | None = None
        self.calib_preview_rect: tuple[int, int, int, int] | None = None
        self.current_tool = MODE_PAN
        self.front_view_mode = VIEW_ORIGINAL
        self._last_mirror: bool | None = None
        self._debounce = QTimer(self)
        self._debounce.setSingleShot(True)
        self._debounce.timeout.connect(self._reprocess)

        self._build_ui()

    # ------------------------------------------------ UI 搭建
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        splitter = QSplitter(Qt.Orientation.Horizontal)
        root.addWidget(splitter)

        # 左侧 2x2 视图
        views = QWidget()
        grid = QVBoxLayout(views)
        row1 = QHBoxLayout()
        row2 = QHBoxLayout()
        self.view_front = ImageView("① 正面(可加点/保护/标定框)")
        self.view_back = ImageView("② 背面(镜像显示, 点对应点)")
        self.view_result = ImageView("③ 修复结果")
        self.view_diff = ImageView("④ 实际改动(越亮=修得越多)")
        self._all_views = [
            self.view_front, self.view_back,
            self.view_result, self.view_diff,
        ]
        for v in self._all_views:
            v.on_click_image = self._image_clicked
            v.on_stroke_done = self._stroke_done
            v.on_rect_drawn = self._rect_drawn
            v.on_mouse_info = self._mouse_info
        # 缩放/平移联动: 以正面视图为基准, 其他视图跟随(原图像素坐标系一致)
        self.view_front.scale_changed = self._sync_views
        self.view_front.offset_changed = self._sync_views
        self.view_front.paint_overlay = self._front_overlay
        self.view_back.paint_overlay = self._back_overlay
        row1.addWidget(self.view_front)
        row1.addWidget(self.view_back)
        row2.addWidget(self.view_result)
        row2.addWidget(self.view_diff)
        grid.addLayout(row1, 1)
        grid.addLayout(row2, 1)
        splitter.addWidget(views)

        # 右侧控制坞
        dock = self._build_dock()
        splitter.addWidget(dock)
        splitter.setSizes([1100, 320])

        self._build_menu()
        self.statusBar().showMessage(
            "先用 文件 菜单载入正背面; 选『对齐点』模式在两面各点对应点"
        )
        self.resize(1500, 950)

    def _build_dock(self) -> QWidget:
        dock = QWidget()
        layout = QVBoxLayout(dock)
        dock.setMaximumWidth(360)

        # --- 工具 ---
        tool_box = QGroupBox("工具(作用于①正面, 对齐点作用于①②)")
        tlay = QVBoxLayout(tool_box)
        self.tool_combo = QComboBox()
        self.tool_combo.addItems([
            "平移/缩放 (中键或左键拖)",
            "对齐点: 正面①点一下, 背面②点对应位置",
            "留白标定框: 框一块基本留白区域",
            "保护笔: 画出正面必须保留的字/线",
            "擦除保护笔",
            "局部强度块: 框选后设置增益",
        ])
        self.tool_combo.currentIndexChanged.connect(self._tool_changed)
        tlay.addWidget(self.tool_combo)
        h = QHBoxLayout()
        self.btn_undo_point = QPushButton("撤销最后点对")
        self.btn_undo_point.clicked.connect(self._undo_last_pair)
        self.btn_clear_protect = QPushButton("清空保护笔")
        self.btn_clear_protect.clicked.connect(self._clear_strokes)
        h.addWidget(self.btn_undo_point)
        h.addWidget(self.btn_clear_protect)
        tlay.addLayout(h)
        layout.addWidget(tool_box)

        # --- 对齐 ---
        align_box = QGroupBox("对齐")
        alay = QFormLayout(align_box)
        self.chk_mirror = QCheckBox("背面水平镜像(薄纸扫描默认开)")
        self.chk_mirror.setChecked(True)
        self.chk_mirror.toggled.connect(self._invalidate_alignment)
        alay.addRow(self.chk_mirror)
        self.combo_method = QComboBox()
        self.combo_method.addItems(["similarity", "translate", "affine", "homography"])
        self.combo_method.currentTextChanged.connect(self._invalidate_alignment)
        alay.addRow("变换类型", self.combo_method)
        self.btn_align = QPushButton("拟合对齐并 warp 背面")
        self.btn_align.clicked.connect(self._do_align)
        alay.addRow(self.btn_align)
        self.lbl_align_info = QLabel("尚未对齐")
        alay.addRow(self.lbl_align_info)
        layout.addWidget(align_box)

        # --- 标定与强度 ---
        proc_box = QGroupBox("透印标定与修复参数")
        play = QFormLayout(proc_box)
        self.btn_calib = QPushButton("用标定框估计透印强度")
        self.btn_calib.clicked.connect(self._do_calibrate)
        play.addRow(self.btn_calib)
        self.spin_k = QDoubleSpinBox()
        self.spin_k.setRange(0.0, 3.0)
        self.spin_k.setSingleStep(0.02)
        self.spin_k.setDecimals(3)
        self.spin_k.valueChanged.connect(self._param_changed)
        play.addRow("全局强度 k", self.spin_k)
        self.spin_min_dark = QDoubleSpinBox()
        self.spin_min_dark.setRange(10.0, 240.0)
        self.spin_min_dark.setValue(self.params.protect_min_dark)
        self.spin_min_dark.valueChanged.connect(self._param_changed)
        play.addRow("保护: 正面墨最小变暗", self.spin_min_dark)
        self.spin_threshold = QDoubleSpinBox()
        self.spin_threshold.setRange(0.0, 120.0)
        self.spin_threshold.setValue(self.params.protect_threshold)
        self.spin_threshold.valueChanged.connect(self._param_changed)
        play.addRow("保护: 相对超出量", self.spin_threshold)
        self.spin_brush = QSpinBox()
        self.spin_brush.setRange(1, 80)
        self.spin_brush.setValue(self.params.protect_radius)
        self.spin_brush.valueChanged.connect(self._param_changed)
        play.addRow("保护笔半径(原图像素)", self.spin_brush)
        self.chk_ref = QCheckBox("正面叠加显示实际参照像素")
        self.chk_ref.toggled.connect(self._refresh_views)
        play.addRow(self.chk_ref)
        self.chk_cov = QCheckBox("标出无背面参考的缺数据区")
        self.chk_cov.setChecked(True)
        self.chk_cov.toggled.connect(self._refresh_views)
        play.addRow(self.chk_cov)
        layout.addWidget(proc_box)

        # --- 局部块 ---
        patch_box = QGroupBox("局部强度块(原图像素坐标)")
        play2 = QFormLayout(patch_box)
        self.spin_patch_gain = QDoubleSpinBox()
        self.spin_patch_gain.setRange(0.0, 3.0)
        self.spin_patch_gain.setSingleStep(0.1)
        self.spin_patch_gain.setValue(1.0)
        play2.addRow("新块增益(倍)", self.spin_patch_gain)
        self.btn_del_patch = QPushButton("删除最后一个块")
        self.btn_del_patch.clicked.connect(self._undo_patch)
        play2.addRow(self.btn_del_patch)
        self.lbl_patches = QLabel("无局部块")
        play2.addRow(self.lbl_patches)
        layout.addWidget(patch_box)

        # --- 视图模式 ---
        view_box = QGroupBox("①正面视图显示内容")
        vlay = QVBoxLayout(view_box)
        self.combo_front_view = QComboBox()
        self.combo_front_view.addItems([
            "原图", "修复结果", "实际改动(放大)",
            "参照像素", "保护掩膜",
        ])
        self.combo_front_view.currentIndexChanged.connect(self._view_mode_changed)
        vlay.addWidget(self.combo_front_view)
        self.chk_clean = QCheckBox("若载入了真值底稿, ③旁叠加对照")
        self.chk_clean.toggled.connect(self._refresh_views)
        vlay.addWidget(self.chk_clean)
        layout.addWidget(view_box)

        # --- 导出 ---
        export_box = QGroupBox("导出")
        elay = QVBoxLayout(export_box)
        self.btn_export = QPushButton("导出灰度 PNG(原尺寸)")
        self.btn_export.clicked.connect(self._export)
        elay.addWidget(self.btn_export)
        layout.addWidget(export_box)
        layout.addStretch(1)

        self.lbl_coord = QLabel("坐标: -")
        layout.addWidget(self.lbl_coord)
        return dock

    def _build_menu(self):
        mb = self.menuBar()
        m_file = mb.addMenu("文件")
        for text, slot in (
            ("载入正面灰度图…", self._load_front),
            ("载入背面灰度图…", self._load_back),
            ("载入真值底稿(可选, 校对用)…", self._load_clean),
            ("生成合成双面样例", self._load_synth),
        ):
            act = QAction(text, self)
            act.triggered.connect(slot)
            m_file.addAction(act)
        m_file.addSeparator()
        act = QAction("退出", self)
        act.triggered.connect(self.close)
        m_file.addAction(act)

        m_view = mb.addMenu("视图")
        act = QAction("全部适应窗口", self)
        act.triggered.connect(self._fit_all)
        m_view.addAction(act)

    # ------------------------------------------------ 工具与模式
    def _tool_changed(self, idx: int):
        self.current_tool = [
            MODE_PAN, MODE_POINT, MODE_CALIB,
            MODE_PROTECT, MODE_ERASE_PROTECT, MODE_PATCH,
        ][idx]
        for v in (self.view_front, self.view_back,
                  self.view_result, self.view_diff):
            v.tool = self.current_tool

    def _view_mode_changed(self, idx: int):
        self.front_view_mode = [
            VIEW_ORIGINAL, VIEW_RESULT, VIEW_DIFF,
            VIEW_REF, VIEW_PROTECT,
        ][idx]
        self._refresh_views()

    # ------------------------------------------------ 载入
    def _load_gray(self, title: str) -> np.ndarray | None:
        path, _ = QFileDialog.getOpenFileName(
            self, title, "", "图像 (*.png *.tif *.tiff *.jpg *.jpeg *.bmp)"
        )
        if not path:
            return None
        img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
        if img is None:
            QMessageBox.warning(self, "载入失败", f"无法读取: {path}")
            return None
        return img

    def _load_front(self):
        img = self._load_gray("选择正面灰度图")
        if img is None:
            return
        self.front_gray = img
        self._reset_session_state()
        self.view_front.set_image_gray(img)
        self.statusBar().showMessage(f"正面已载入: {img.shape[1]}x{img.shape[0]}")

    def _load_back(self):
        img = self._load_gray("选择背面灰度图")
        if img is None:
            return
        self.back_gray = img
        self._last_mirror = None
        self._refresh_views()
        self.statusBar().showMessage(f"背面已载入: {img.shape[1]}x{img.shape[0]}")

    def _load_clean(self):
        img = self._load_gray("选择无透印真值底稿")
        if img is not None:
            self.front_clean = img
            self.statusBar().showMessage("真值底稿已载入, 可在结果视图对照")

    def _load_synth(self):
        from .synth import SynthConfig, generate_pair
        data = generate_pair(SynthConfig())
        self.front_gray = data["front"]
        self.back_gray = data["back"]
        self.front_clean = data["front_clean"]
        self._reset_session_state()
        self._last_mirror = None
        self.calib_rect = tuple(data["meta"]["calib_rect"])
        self.view_front.set_image_gray(self.front_gray)
        self._refresh_views()
        self.statusBar().showMessage(
            "合成样例已生成(含真值底稿与标定框); 切到对齐点模式加点后拟合"
        )
        self._refresh_views()

    def _reset_session_state(self):
        self.params = ProcessParams()
        self.alignment = Alignment(
            self.front_gray.shape if self.front_gray is not None else (0, 0),
            self.back_gray.shape if self.back_gray is not None else (0, 0),
            mirror_back=self.chk_mirror.isChecked(),
            method=self.combo_method.currentText(),
        )
        self.back_warped = None
        self.coverage = None
        self.result = None
        self.reference_mask = None
        self.spin_k.blockSignals(True)
        self.spin_k.setValue(0.0)
        self.spin_k.blockSignals(False)
        self.lbl_align_info.setText("尚未对齐")
        self.lbl_patches.setText("无局部块")

    # ------------------------------------------------ 交互回调
    def _mouse_info(self, x, y):
        self.lbl_coord.setText(f"坐标(原图像素): {x}, {y}")

    def _image_clicked(self, x, y, button):
        if self.current_tool != MODE_POINT:
            return
        sender = self.sender()
        if sender is self.view_front:
            self.alignment.front_pts.append((float(x), float(y)))
        elif sender is self.view_back:
            self.alignment.back_pts.append((float(x), float(y)))
        n = min(len(self.alignment.front_pts), len(self.alignment.back_pts))
        self.statusBar().showMessage(
            f"点对: 正面 {len(self.alignment.front_pts)} 个 / "
            f"背面 {len(self.alignment.back_pts)} 个, 完整点对 {n} 对"
        )
        self._invalidate_alignment()
        self.view_front.update()
        self.view_back.update()

    def _stroke_done(self, stroke):
        if self.current_tool == MODE_PROTECT:
            self.params.protect_strokes.append(stroke)
            self._schedule_reprocess()
        elif self.current_tool == MODE_ERASE_PROTECT:
            self._erase_strokes_at(stroke)

    def _erase_strokes_at(self, stroke):
        """擦除: 删掉与擦除轨迹邻近的已存笔画。"""
        erase = np.asarray(stroke, dtype=np.int32)
        kept = []
        for s in self.params.protect_strokes:
            arr = np.asarray(s, dtype=np.int32)
            d = np.min(np.abs(arr[:, None, :] - erase[None, :, :]).sum(axis=2))
            if d > self.params.protect_radius * 2:
                kept.append(s)
        removed = len(kept) != len(self.params.protect_strokes)
        self.params.protect_strokes = kept
        if removed:
            self._schedule_reprocess()

    def _clear_strokes(self):
        self.params.protect_strokes.clear()
        self._schedule_reprocess()

    def _rect_drawn(self, x, y, w, h):
        if self.current_tool == MODE_CALIB:
            self.calib_rect = (x, y, w, h)
            self.statusBar().showMessage(
                f"标定框(原图像素): x={x} y={y} w={w} h={h}; 点『估计透印强度』"
            )
        elif self.current_tool == MODE_PATCH:
            gain = float(self.spin_patch_gain.value())
            self.params.patches.append(LocalPatch(x, y, w, h, gain))
            self._update_patch_label()
            self._schedule_reprocess()
        self._refresh_views()

    def _undo_last_pair(self):
        if self.alignment.front_pts:
            self.alignment.front_pts.pop()
        if self.alignment.back_pts:
            self.alignment.back_pts.pop()
        self._invalidate_alignment()

    def _update_patch_label(self):
        if not self.params.patches:
            self.lbl_patches.setText("无局部块")
            return
        p = self.params.patches[-1]
        self.lbl_patches.setText(
            f"{len(self.params.patches)} 个块, 末块增益 {p.gain:.2f} "
            f"@({p.x},{p.y},{p.w},{p.h})"
        )

    def _undo_patch(self):
        if self.params.patches:
            self.params.patches.pop()
            self._update_patch_label()
            self._schedule_reprocess()

    # ------------------------------------------------ 对齐
    def _invalidate_alignment(self):
        if self.front_gray is None or self.back_gray is None:
            return
        self.alignment.front_shape = self.front_gray.shape
        self.alignment.back_shape = self.back_gray.shape
        self.alignment.mirror_back = self.chk_mirror.isChecked()
        self.alignment.method = self.combo_method.currentText()
        self.alignment.matrix = None
        self._last_mirror = None   # 强制背面视图按新镜像状态重建
        self.lbl_align_info.setText("参数已改, 需重新拟合")
        self.view_front.update()
        self.view_back.update()
        self._refresh_views()

    def _do_align(self):
        if self.front_gray is None or self.back_gray is None:
            QMessageBox.warning(self, "缺图", "请先载入正背面图像")
            return
        n = min(len(self.alignment.front_pts), len(self.alignment.back_pts))
        need = {"translate": 1, "similarity": 2,
                "affine": 3, "homography": 4}[self.alignment.method]
        if n < need:
            QMessageBox.warning(
                self, "点对不足",
                f"{self.alignment.method} 至少需要 {need} 对完整点对, 当前 {n} 对"
            )
            return
        try:
            fit_transform(self.alignment)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "对齐失败", str(exc))
            return
        self.back_warped = warp_back(
            self.back_gray, self.alignment, self.front_gray.shape
        )
        self.coverage = coverage_mask(self.alignment, self.front_gray.shape)
        rms = residuals(self.alignment)
        self.lbl_align_info.setText(
            f"已对齐: RMS {rms.mean():.2f}px, 最大 {rms.max():.2f}px; "
            f"覆盖率 {(self.coverage > 0).mean() * 100:.1f}%"
        )
        self.view_result.set_image_gray(self.back_warped)
        self.view_result.title = "③ warp 后背面(对齐后自动替换为修复结果)"
        self._schedule_reprocess()
        self._refresh_views()

    # ------------------------------------------------ 标定/处理
    def _do_calibrate(self):
        if self.back_warped is None or self.coverage is None:
            QMessageBox.warning(self, "未对齐", "请先拟合对齐")
            return
        if self.calib_rect is None:
            QMessageBox.warning(self, "缺标定框", "先用『留白标定框』工具框一块区域")
            return
        from .bleed import back_ink_map
        ink, _ = back_ink_map(
            self.back_warped, self.coverage,
            int(self.params.paper_sigma),
            self.params.detail_sigma, self.params.min_ink,
        )
        k, ref = calibrate_strength(
            self.front_gray, ink, self.coverage, self.calib_rect
        )
        if k <= 0:
            QMessageBox.warning(self, "标定失败",
                                "标定框内有效参照像素不足, 换一块有明显背透的留白")
            return
        self.reference_mask = ref
        self.spin_k.blockSignals(True)
        self.spin_k.setValue(k)
        self.spin_k.blockSignals(False)
        self.params.base_strength = k
        count = int((ref > 0).sum())
        self.statusBar().showMessage(
            f"标定 k={k:.3f}, 实际参照像素 {count} 个(可勾选叠加显示)"
        )
        self._schedule_reprocess()

    def _param_changed(self):
        self.params.base_strength = float(self.spin_k.value())
        self.params.protect_min_dark = float(self.spin_min_dark.value())
        self.params.protect_threshold = float(self.spin_threshold.value())
        self.params.protect_radius = int(self.spin_brush.value())
        self._schedule_reprocess()

    def _schedule_reprocess(self):
        self._debounce.start(120)

    def _reprocess(self):
        if self.front_gray is None or self.back_warped is None:
            return
        self.params.base_strength = float(self.spin_k.value())
        self.result = process_front(
            self.front_gray, self.back_warped, self.coverage, self.params
        )
        self._refresh_views()

    # ------------------------------------------------ 视图刷新
    def _refresh_views(self):
        if self.front_gray is None:
            return
        # 正面视图按模式切换
        mode = self.front_view_mode
        if mode == VIEW_ORIGINAL or self.result is None:
            qimg = gray_to_qimage(self.front_gray)
            if self.chk_ref.isChecked() and self.reference_mask is not None:
                qimg = color_overlay_qimage(
                    self.front_gray, self.reference_mask, (60, 220, 255), 90
                )
        elif mode == VIEW_RESULT:
            base = self.result.result
            qimg = gray_to_qimage(base)
            if self.chk_ref.isChecked() and self.reference_mask is not None:
                qimg = color_overlay_qimage(
                    base, self.reference_mask, (60, 220, 255), 70
                )
        elif mode == VIEW_DIFF:
            amp = cv2.normalize(self.result.diff, None, 0, 255,
                                cv2.NORM_MINMAX)
            qimg = gray_to_qimage(amp)
        elif mode == VIEW_REF:
            qimg = color_overlay_qimage(
                self.front_gray, self.result.reference_pixels,
                (60, 220, 255), 120
            )
        elif mode == VIEW_PROTECT:
            pm = (self.result.protect_mask * 255).astype(np.uint8)
            qimg = color_overlay_qimage(self.front_gray, pm, (255, 170, 0), 120)
        # 缺数据区斜纹提示(覆盖在最上层)
        if self.chk_cov.isChecked() and self.coverage is not None:
            qimg = self._paint_coverage(qimg, self.coverage)
        self.view_front.set_qimage(qimg)

        # 背面视图: 镜像状态变化才需要重建并重新适应, 否则保留缩放/平移
        if self.back_gray is not None:
            mirrored = self.chk_mirror.isChecked()
            if getattr(self, "_last_mirror", None) != mirrored:
                shown = cv2.flip(self.back_gray, 1) if mirrored else self.back_gray
                self.view_back.set_image_gray(shown)
                self._last_mirror = mirrored
            else:
                self.view_back.update()

        # 结果视图 / 改动视图: 仅像素内容变化, 保留视野
        if self.result is not None:
            if self.chk_clean.isChecked() and self.front_clean is not None:
                pair = np.hstack([self.result.result, self.front_clean])
                self.view_result.update_pixels_keep_view(pair)
                self.view_result.title = "③ 左:修复结果  右:无透印底稿"
            else:
                self.view_result.update_pixels_keep_view(self.result.result)
                self.view_result.title = "③ 修复结果"
            diff_amp = cv2.normalize(self.result.diff, None, 0, 255,
                                     cv2.NORM_MINMAX)
            self.view_diff.update_pixels_keep_view(diff_amp)
            self.view_diff.title = "④ 实际改动(越亮=修得越多)"

    def _paint_coverage(self, qimg: QImage, coverage: np.ndarray) -> QImage:
        """缺背面数据区画红色斜纹, 明确告诉用户哪里没有参考。"""
        canvas = QPixmap(qimg)
        painter = QPainter(canvas)
        missing = (coverage == 0).astype(np.uint8) * 255
        contours, _ = cv2.findContours(
            missing, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        pen = QPen(QColor(255, 80, 80), 1.0, Qt.PenStyle.DashLine)
        painter.setPen(pen)
        painter.setBrush(QBrush(QColor(255, 80, 80, 28)))
        for c in contours:
            if cv2.contourArea(c) < 30:
                continue
            poly = [QPoint(int(p[0][0]), int(p[0][1])) for p in c]
            painter.drawPolygon(poly)
        painter.end()
        return canvas.toImage()

    # ------------------------------------------------ 标注绘制
    def _front_overlay(self, painter: QPainter, view: ImageView):
        # 点对(正面): 编号
        for i, (x, y) in enumerate(self.alignment.front_pts):
            p = view.image_to_widget(x, y)
            painter.setPen(QPen(QColor(80, 255, 120), 2))
            painter.drawEllipse(p, 5, 5)
            painter.setPen(QColor(80, 255, 120))
            painter.drawText(p + QPointF(7, -7), str(i + 1))
        # 保护笔画
        painter.setPen(QPen(QColor(255, 170, 0), 2.2))
        for stroke in self.params.protect_strokes:
            pts = [view.image_to_widget(x, y) for x, y in stroke]
            for a, b in zip(pts, pts[1:]):
                painter.drawLine(a, b)
            if len(pts) == 1:
                painter.drawEllipse(pts[0], 2, 2)
        # 标定框
        if self.calib_rect is not None:
            x, y, w, h = self.calib_rect
            a = view.image_to_widget(x, y)
            b = view.image_to_widget(x + w, y + h)
            painter.setPen(QPen(QColor(80, 220, 255), 1.8, Qt.PenStyle.DashLine))
            painter.drawRect(QRect(a.toPoint(), b.toPoint()))
        # 局部块
        for i, pch in enumerate(self.params.patches):
            a = view.image_to_widget(pch.x, pch.y)
            b = view.image_to_widget(pch.x + pch.w, pch.y + pch.h)
            painter.setPen(QPen(QColor(200, 120, 255), 1.6))
            painter.drawRect(QRect(a.toPoint(), b.toPoint()))
            painter.setPen(QColor(200, 120, 255))
            painter.drawText(a + QPointF(4, 12),
                             f"g={pch.gain:.2f} #{i+1}")

    def _back_overlay(self, painter: QPainter, view: ImageView):
        w = self.back_gray.shape[1] if self.back_gray is not None else 0
        for i, (x, y) in enumerate(self.alignment.back_pts):
            # 背面点画在镜像显示坐标系
            dx = (w - x) if self.chk_mirror.isChecked() else x
            p = view.image_to_widget(dx, y)
            painter.setPen(QPen(QColor(255, 120, 80), 2))
            painter.drawEllipse(p, 5, 5)
            painter.setPen(QColor(255, 120, 80))
            painter.drawText(p + QPointF(7, -7), str(i + 1))
        # 对齐成功后, 把正面点的预测位置画成空心绿圈, 便于看残差
        if self.alignment.is_ready:
            painter.setPen(QPen(QColor(80, 255, 120), 1.5, Qt.PenStyle.DashLine))
            for fx, fy in self.alignment.front_pts:
                p = view.image_to_widget(fx, fy)
                painter.drawEllipse(p, 7, 7)
        # 标定框投影到背面(取四角逆变换), 帮助确认框内确实有背面参照
        if self.calib_rect is not None and self.alignment.is_ready \
                and self.back_gray is not None:
            x, y, w, h = self.calib_rect
            full_inv = np.linalg.inv(self.alignment.full_matrix())
            W = self.back_gray.shape[1]
            poly = []
            for fx, fy in [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]:
                bx, by, bz = full_inv @ np.array([fx, fy, 1.0])
                bx, by = bx / bz, by / bz
                dx = (W - bx) if self.chk_mirror.isChecked() else bx
                poly.append(view.image_to_widget(dx, by))
            painter.setPen(QPen(QColor(80, 220, 255), 1.4, Qt.PenStyle.DashLine))
            for a, b in zip(poly, poly[1:] + poly[:1]):
                painter.drawLine(a, b)

    def _fit_all(self):
        for v in (self.view_front, self.view_back,
                  self.view_result, self.view_diff):
            v.fit_to_window()

    def _sync_views(self):
        """正面视图缩放/平移后, 让其他视图跟随同一原图像素视野。

        结果视图可能是『结果 | 底稿』水平拼接, 宽度是单页两倍,
        其缩放与偏移要按宽度比例换算, 保证左半页与正面视野重合。
        """
        src = self.view_front
        if src._qimg is None:
            return
        for v in (self.view_back, self.view_result, self.view_diff):
            if v._qimg is None or v is src:
                continue
            ratio = src._qimg.width() / v._qimg.width()
            v.scale = src.scale / ratio
            v.offset = QPointF(src.offset.x() / ratio, src.offset.y())
            v.update()

    # ------------------------------------------------ 导出
    def _export(self):
        if self.result is None:
            QMessageBox.warning(self, "无结果", "请先对齐并生成修复结果")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出灰度 PNG", "descan_result.png", "PNG (*.png)"
        )
        if not path:
            return
        # 缺数据区保持原图像素(process_front 已保证), 直接写结果
        ok = cv2.imwrite(path, self.result.result)
        if not ok:
            QMessageBox.critical(self, "导出失败", path)
            return
        self.statusBar().showMessage(
            f"已导出 {path} ({self.result.result.shape[1]}x"
            f"{self.result.result.shape[0]} 灰度, 原尺寸; 缺背面区未补白)"
        )


def run():
    import sys
    app = QApplication.instance() or QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    run()
