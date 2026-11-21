"""PySide6 本地降噪对比窗口。

四视图（同一缩放、同一选区、同一显示通道）：
    上排：普通平滑结果 | 保边降噪结果
    下排：普通平滑差值图 | 保边降噪差值图（叠加疑似纹理抹除块）

干净参考只出现在右侧“评估（干净参考）”面板里，由按钮显式触发，
处理与估计控件的回调中不持有 clean 的访问路径。
"""
from __future__ import annotations

import sys

import cv2
import numpy as np
from PySide6.QtCore import Qt, QTimer, QRectF, Signal
from PySide6.QtGui import QImage, QPixmap, QPen, QColor, QBrush, QFont
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QSplitter,
    QGraphicsView, QGraphicsScene, QGraphicsPixmapItem, QGraphicsRectItem,
    QLabel, QSlider, QComboBox, QCheckBox, QPushButton, QSpinBox, QGroupBox,
    QListWidget, QListWidgetItem, QTextEdit, QScrollArea, QFrame,
)

from .synthetic import make_sample, default_estimation_rects, IMG_H, IMG_W
from .noise_estimation import fit_noise_model
from .processing import (
    ALGO_SMOOTH, ALGO_EDGE, ALGO_LABELS, RegionParams,
    process, diff_map, texture_erasure_mask, feather_alpha,
)
from .metrics import evaluate

Rect = tuple[int, int, int, int]

CHANNELS = ("RGB", "Luma", "Cr", "Cb")
REGION_COLORS = (QColor(58, 160, 255), QColor(67, 209, 122))
SELECTION_PEN = QPen(QColor(255, 214, 64), 2, Qt.DashLine)
ERASE_COLOR = QColor(255, 40, 40, 95)


def to_qpixmap(arr01: np.ndarray) -> QPixmap:
    arr = np.clip(arr01, 0.0, 1.0)
    if arr.ndim == 2:
        arr = np.repeat(arr[..., None], 3, axis=2)
    arr8 = (arr * 255.0 + 0.5).astype(np.uint8)
    h, w = arr8.shape[:2]
    img = QImage(arr8.tobytes(), w, h, 3 * w, QImage.Format_RGB888)
    return QPixmap.fromImage(img.copy())


def channel_image(img01: np.ndarray, channel: str) -> np.ndarray:
    if channel == "RGB":
        return img01
    ycrcb = cv2.cvtColor(img01.astype(np.float32), cv2.COLOR_RGB2YCrCb)
    idx = {"Luma": 0, "Cr": 1, "Cb": 2}[channel]
    return np.repeat(ycrcb[..., idx:idx + 1], 3, axis=2)


class ImageView(QGraphicsView):
    """带框选/联动缩放/覆盖层的图像视图。"""

    selectionMade = Signal(tuple)
    transformChanged = Signal(object)

    def __init__(self, title: str, parent=None):
        super().__init__(parent)
        self._title = title
        self._scene = QGraphicsScene(self)
        self.setScene(self._scene)
        self.setRenderHints(self.renderHints())
        self.setTransformationAnchor(QGraphicsView.AnchorUnderMouse)
        self.setDragMode(QGraphicsView.NoDrag)
        self._pix_item = QGraphicsPixmapItem()
        self._scene.addItem(self._pix_item)
        self._selection_item: QGraphicsRectItem | None = None
        self._overlay_items: list[QGraphicsRectItem] = []
        self._feather_items: list[QGraphicsPixmapItem] = []
        self._erasure_items: list[QGraphicsRectItem] = []
        self._drag_start = None
        self._pan_start = None
        self._linking = False
        self.title_label = QLabel(title)
        self.title_label.setAlignment(Qt.AlignCenter)
        f = QFont()
        f.setBold(True)
        self.title_label.setFont(f)

    # ---- 图像与覆盖层 -------------------------------------------------
    def set_image(self, arr01: np.ndarray):
        self._pix_item.setPixmap(to_qpixmap(arr01))
        self.setSceneRect(QRectF(0, 0, arr01.shape[1], arr01.shape[0]))

    def set_selection(self, rect: Rect | None):
        if self._selection_item is not None:
            self._scene.removeItem(self._selection_item)
            self._selection_item = None
        if rect is not None:
            y0, y1, x0, x1 = rect
            it = QGraphicsRectItem(x0, y0, x1 - x0, y1 - y0)
            it.setPen(SELECTION_PEN)
            it.setBrush(QBrush(QColor(255, 214, 64, 30)))
            self._scene.addItem(it)
            self._selection_item = it

    def set_regions(self, regions: list[RegionParams], winner: int):
        for it in self._overlay_items:
            self._scene.removeItem(it)
        for it in self._feather_items:
            self._scene.removeItem(it)
        self._overlay_items.clear()
        self._feather_items.clear()

        for i, r in enumerate(regions):
            if not r.enabled:
                continue
            y0, y1, x0, x1 = r.rect
            if y1 <= y0 or x1 <= x0:
                continue
            color = REGION_COLORS[i]
            # 羽化 alpha 可视化：过渡带直接显示为半透明颜色
            alpha = feather_alpha(r.rect, r.feather, (IMG_H, IMG_W))
            overlay = np.zeros((IMG_H, IMG_W, 4), np.uint8)
            overlay[..., 0] = color.red()
            overlay[..., 1] = color.green()
            overlay[..., 2] = color.blue()
            overlay[..., 3] = (alpha * 110).astype(np.uint8)
            qimg = QImage(overlay.tobytes(), IMG_W, IMG_H, 4 * IMG_W,
                          QImage.Format_RGBA8888)
            pm_item = QGraphicsPixmapItem(QPixmap.fromImage(qimg.copy()))
            self._scene.addItem(pm_item)
            self._feather_items.append(pm_item)

            pen = QPen(color, 2)
            if i == winner:
                pen.setStyle(Qt.SolidLine)
                pen.setWidth(3)
            box = QGraphicsRectItem(x0, y0, x1 - x0, y1 - y0)
            box.setPen(pen)
            self._scene.addItem(box)
            self._overlay_items.append(box)
            label = self._scene.addSimpleText(
                f"R{i + 1}{' 优先' if i == winner else ''}")
            label.setBrush(QBrush(color))
            label.setPos(x0, max(0, y0 - 16))
            self._overlay_items.append(label)

    def set_erasure(self, heat: np.ndarray, threshold: float, visible: bool):
        for it in self._erasure_items:
            self._scene.removeItem(it)
        self._erasure_items.clear()
        if not visible:
            return
        block = 16
        gy, gx = heat.shape
        for iy in range(gy // block):
            for ix in range(gx // block):
                v = float(heat[iy * block, ix * block])
                if v < threshold:
                    continue
                rect = QGraphicsRectItem(ix * block, iy * block, block, block)
                rect.setPen(QPen(QColor(255, 40, 40, 180), 1))
                rect.setBrush(QBrush(ERASE_COLOR))
                self._scene.addItem(rect)
                self._erasure_items.append(rect)

    # ---- 交互 ---------------------------------------------------------
    def wheelEvent(self, event):
        factor = 1.2 if event.angleDelta().y() > 0 else 1 / 1.2
        self.scale(factor, factor)
        if not self._linking:
            self.transformChanged.emit(self.transform())

    def link_transform(self, t):
        self._linking = True
        self.setTransform(t)
        self._linking = False

    def mousePressEvent(self, event):
        if event.button() == Qt.LeftButton:
            self._drag_start = self.mapToScene(event.position().toPoint())
        elif event.button() == Qt.MiddleButton:
            self._pan_start = event.position()
            self.setCursor(Qt.ClosedHandCursor)
        else:
            super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._drag_start is not None:
            cur = self.mapToScene(event.position().toPoint())
            r = QRectF(self._drag_start, cur).normalized()
            if self._selection_item is None:
                it = QGraphicsRectItem(r)
                it.setPen(SELECTION_PEN)
                self._scene.addItem(it)
                self._selection_item = it
            else:
                self._selection_item.setRect(r)
        elif self._pan_start is not None:
            delta = event.position() - self._pan_start
            self._pan_start = event.position()
            self.horizontalScrollBar().setValue(
                self.horizontalScrollBar().value() - int(delta.x()))
            self.verticalScrollBar().setValue(
                self.verticalScrollBar().value() - int(delta.y()))
        else:
            super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.LeftButton and self._drag_start is not None:
            r = self._selection_item.rect() if self._selection_item else None
            self._drag_start = None
            if r is not None and r.width() >= 3 and r.height() >= 3:
                rect = (int(r.top()), int(r.bottom()),
                        int(r.left()), int(r.right()))
                self.selectionMade.emit(rect)
            else:
                self.selectionMade.emit(None)
        elif event.button() == Qt.MiddleButton:
            self._pan_start = None
            self.setCursor(Qt.ArrowCursor)
        else:
            super().mouseReleaseEvent(event)


def _slider(minv: int, maxv: int, value: int) -> QSlider:
    s = QSlider(Qt.Horizontal)
    s.setRange(minv, maxv)
    s.setValue(value)
    return s


class RegionEditor(QGroupBox):
    """单个降噪范围的编辑控件。"""

    changed = Signal()

    def __init__(self, index: int):
        super().__init__(f"降噪范围 R{index + 1}")
        self.index = index
        lay = QVBoxLayout(self)
        self.enable = QCheckBox("启用")
        self.enable.setChecked(True)
        lay.addWidget(self.enable)

        coord = QHBoxLayout()
        self.spins = {}
        for name in ("y0", "y1", "x0", "x1"):
            coord.addWidget(QLabel(name))
            sp = QSpinBox()
            sp.setRange(0, max(IMG_H, IMG_W))
            self.spins[name] = sp
            coord.addWidget(sp)
        lay.addLayout(coord)
        self.use_sel = QPushButton("使用当前选区")
        lay.addWidget(self.use_sel)

        line = QHBoxLayout()
        line.addWidget(QLabel("强度"))
        self.strength = _slider(0, 100, 50)
        self.strength_val = QLabel("50")
        line.addWidget(self.strength)
        line.addWidget(self.strength_val)
        lay.addLayout(line)

        line2 = QHBoxLayout()
        line2.addWidget(QLabel("羽化px"))
        self.feather = _slider(0, 40, 12)
        self.feather_val = QLabel("12")
        line2.addWidget(self.feather)
        line2.addWidget(self.feather_val)
        lay.addLayout(line2)

        for sp in self.spins.values():
            sp.valueChanged.connect(self.changed)
        self.enable.toggled.connect(self.changed)
        self.strength.valueChanged.connect(
            lambda v: (self.strength_val.setText(str(v)), self.changed.emit()))
        self.feather.valueChanged.connect(
            lambda v: (self.feather_val.setText(str(v)), self.changed.emit()))

    def set_from_selection(self, rect: Rect | None):
        if rect is None:
            return
        y0, y1, x0, x1 = rect
        for name, val in zip(("y0", "y1", "x0", "x1"), (y0, y1, x0, x1)):
            self.spins[name].blockSignals(True)
            self.spins[name].setValue(val)
            self.spins[name].blockSignals(False)
        self.changed.emit()

    def params(self) -> RegionParams:
        return RegionParams(
            rect=(self.spins["y0"].value(), self.spins["y1"].value(),
                  self.spins["x0"].value(), self.spins["x1"].value()),
            strength=self.strength.value(),
            feather=self.feather.value(),
            enabled=self.enable.isChecked(),
        )

    def load_params(self, r: RegionParams):
        y0, y1, x0, x1 = r.rect
        for name, val in zip(("y0", "y1", "x0", "x1"), (y0, y1, x0, x1)):
            self.spins[name].blockSignals(True)
            self.spins[name].setValue(val)
            self.spins[name].blockSignals(False)
        self.strength.blockSignals(True)
        self.strength.setValue(r.strength)
        self.strength.blockSignals(False)
        self.strength_val.setText(str(r.strength))
        self.feather.blockSignals(True)
        self.feather.setValue(r.feather)
        self.feather.blockSignals(False)
        self.feather_val.setText(str(r.feather))
        self.enable.blockSignals(True)
        self.enable.setChecked(r.enabled)
        self.enable.blockSignals(False)


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("低光降噪实验室 · 平滑 vs 保边（本地，无干净参考泄漏）")
        self.resize(1500, 980)

        self.sample = make_sample()
        self.est_rects: list[Rect] = default_estimation_rects()
        self.noise_model = None
        self.selection: Rect | None = None
        self._updating = False
        # 控件构建过程中就会触发 changed 信号，定时器必须先于控件存在
        self._recompute_timer = QTimer(self)
        self._recompute_timer.setSingleShot(True)
        self._recompute_timer.timeout.connect(self.recompute)

        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)

        root.addWidget(self._build_control_panel(), 0)
        root.addWidget(self._build_view_area(), 1)

        # 默认两个区域覆盖全图并在中部大带重叠，便于直接看优先级效果；
        # 想验证“区外不修改”时把某区域缩小即可（有测试逐像素守护）
        self.editors[0].load_params(
            RegionParams((0, 330, 0, IMG_W), 55, 12, True))
        self.editors[1].load_params(
            RegionParams((220, IMG_H, 0, IMG_W), 70, 16, True))
        for ed in self.editors:
            ed.changed.connect(self.schedule_recompute)
            ed.use_sel.clicked.connect(
                lambda _=False, e=ed: e.set_from_selection(self.selection))

        self.regenerate()
        self.statusBar().showMessage(
            "左键拖拽框选（四视图同步）· 滚轮缩放（联动）· 中键拖拽平移")

    # ================= UI 构建 =================
    def _build_control_panel(self) -> QWidget:
        panel = QScrollArea()
        panel.setWidgetResizable(True)
        panel.setMinimumWidth(340)
        holder = QWidget()
        panel.setWidget(holder)
        v = QVBoxLayout(holder)

        # --- 样例与噪声 ---
        g1 = QGroupBox("1. 内置样例与合成噪声")
        l1 = QVBoxLayout(g1)
        self.mode_combo = QComboBox()
        self.mode_combo.addItem("亮度相关噪声 sigma(y)=a+b·√y", "luminance")
        self.mode_combo.addItem("固定噪声 sigma=const", "fixed")
        l1.addWidget(self.mode_combo)
        self.sigma_slider = _slider(5, 80, 30)
        self.sigma_label = QLabel()
        l1.addWidget(QLabel("基础 sigma (0..1)"))
        l1.addWidget(self.sigma_slider)
        l1.addWidget(self.sigma_label)
        self.k_slider = _slider(0, 120, 50)
        self.k_label = QLabel()
        l1.addWidget(QLabel("信号相关系数 b（仅亮度相关模式）"))
        l1.addWidget(self.k_slider)
        l1.addWidget(self.k_label)
        self.seed_spin = QSpinBox()
        self.seed_spin.setRange(0, 10_000)
        self.seed_spin.setValue(42)
        l1.addWidget(self.seed_spin)
        self.btn_regen = QPushButton("重新生成样例")
        l1.addWidget(self.btn_regen)
        v.addWidget(g1)
        self.mode_combo.currentIndexChanged.connect(self._sync_noise_labels)
        self.sigma_slider.valueChanged.connect(self._sync_noise_labels)
        self.k_slider.valueChanged.connect(self._sync_noise_labels)
        self.btn_regen.clicked.connect(self.regenerate)
        self._sync_noise_labels()

        # --- 噪声估计（只用带噪图） ---
        g2 = QGroupBox("2. 噪声估计（仅读取带噪图，不接触干净参考）")
        l2 = QVBoxLayout(g2)
        self.est_list = QListWidget()
        l2.addWidget(self.est_list)
        row = QHBoxLayout()
        btn_add = QPushButton("加入选区")
        btn_del = QPushButton("删除选中")
        btn_reset = QPushButton("重置默认")
        row.addWidget(btn_add)
        row.addWidget(btn_del)
        row.addWidget(btn_reset)
        l2.addLayout(row)
        self.btn_estimate = QPushButton("估计逐级噪声强度")
        l2.addWidget(self.btn_estimate)
        self.est_text = QTextEdit()
        self.est_text.setReadOnly(True)
        self.est_text.setMaximumHeight(170)
        l2.addWidget(self.est_text)
        v.addWidget(g2)
        btn_add.clicked.connect(self._add_est_rect)
        btn_del.clicked.connect(self._del_est_rect)
        btn_reset.clicked.connect(self._reset_est_rects)
        self.btn_estimate.clicked.connect(self.run_estimation)
        self._refresh_est_list()

        # --- 降噪范围 ---
        g3 = QGroupBox("3. 两个可重叠降噪范围")
        l3 = QVBoxLayout(g3)
        self.editors = [RegionEditor(0), RegionEditor(1)]
        for ed in self.editors:
            l3.addWidget(ed)
        pr = QHBoxLayout()
        pr.addWidget(QLabel("重叠优先级"))
        self.priority_combo = QComboBox()
        self.priority_combo.addItem("R1 优先（R2 在重叠处让位）", 0)
        self.priority_combo.addItem("R2 优先（R1 在重叠处让位）", 1)
        self.priority_combo.setCurrentIndex(1)
        pr.addWidget(self.priority_combo)
        l3.addLayout(pr)
        v.addWidget(g3)
        self.priority_combo.currentIndexChanged.connect(self.schedule_recompute)

        # --- 显示 ---
        g4 = QGroupBox("4. 对比显示")
        l4 = QVBoxLayout(g4)
        cr = QHBoxLayout()
        cr.addWidget(QLabel("抽查通道"))
        self.channel_combo = QComboBox()
        for c in CHANNELS:
            self.channel_combo.addItem(c)
        cr.addWidget(self.channel_combo)
        l4.addLayout(cr)
        dr = QHBoxLayout()
        dr.addWidget(QLabel("差值增益"))
        self.diff_gain = _slider(1, 20, 6)
        self.diff_gain_label = QLabel("6x")
        dr.addWidget(self.diff_gain)
        dr.addWidget(self.diff_gain_label)
        l4.addLayout(dr)
        self.chk_erasure = QCheckBox("叠加疑似纹理抹除块（红）")
        self.chk_erasure.setChecked(True)
        l4.addWidget(self.chk_erasure)
        self.erasure_thr = _slider(10, 90, 40)
        self.erasure_thr_label = QLabel("阈值 0.40")
        l4.addWidget(self.erasure_thr)
        l4.addWidget(self.erasure_thr_label)
        v.addWidget(g4)
        self.channel_combo.currentIndexChanged.connect(self.refresh_views)
        self.diff_gain.valueChanged.connect(
            lambda x: (self.diff_gain_label.setText(f"{x}x"),
                       self.schedule_recompute()))
        self.chk_erasure.toggled.connect(self.refresh_views)
        self.erasure_thr.valueChanged.connect(
            lambda x: (self.erasure_thr_label.setText(f"阈值 {x/100:.2f}"),
                       self.refresh_views()))

        # --- 评估（唯一接触干净参考的地方） ---
        g5 = QGroupBox("5. 客观评估（本面板才允许读取干净参考）")
        l5 = QVBoxLayout(g5)
        self.btn_eval = QPushButton("运行评估（读取干净参考）")
        l5.addWidget(self.btn_eval)
        self.eval_text = QTextEdit()
        self.eval_text.setReadOnly(True)
        self.eval_text.setMinimumHeight(260)
        l5.addWidget(self.eval_text)
        v.addWidget(g5)
        self.btn_eval.clicked.connect(self.run_evaluation)
        v.addStretch(1)
        return panel

    def _build_view_area(self) -> QWidget:
        box = QWidget()
        outer = QVBoxLayout(box)
        splitter = QSplitter(Qt.Vertical)

        top = QSplitter(Qt.Horizontal)
        bottom = QSplitter(Qt.Horizontal)
        self.view_smooth = ImageView(ALGO_LABELS[ALGO_SMOOTH])
        self.view_edge = ImageView(ALGO_LABELS[ALGO_EDGE])
        self.view_diff_s = ImageView("差值图 · 普通平滑（|带噪-结果|×增益）")
        self.view_diff_e = ImageView("差值图 · 保边降噪（|带噪-结果|×增益）")
        self.views = (self.view_smooth, self.view_edge,
                      self.view_diff_s, self.view_diff_e)
        for vw in (self.view_smooth, self.view_edge):
            top.addWidget(self._titled(vw))
        for vw in (self.view_diff_s, self.view_diff_e):
            bottom.addWidget(self._titled(vw))
        splitter.addWidget(top)
        splitter.addWidget(bottom)
        splitter.setSizes([560, 360])
        outer.addWidget(splitter)

        for vw in self.views:
            vw.selectionMade.connect(self.on_selection)
            vw.transformChanged.connect(self._link_zoom)
        return box

    @staticmethod
    def _titled(view: ImageView) -> QWidget:
        w = QFrame()
        lay = QVBoxLayout(w)
        lay.setContentsMargins(2, 2, 2, 2)
        lay.addWidget(view.title_label)
        lay.addWidget(view)
        return w

    # ================= 状态与计算 =================
    def _sigma_kwargs(self) -> dict:
        mode = self.mode_combo.currentData()
        sigma = self.sigma_slider.value() / 1000.0
        k = self.k_slider.value() / 1000.0
        return {"mode": mode, "sigma_base": sigma,
                "k_signal": k, "rng_seed": self.seed_spin.value()}

    def _sync_noise_labels(self):
        kw = self._sigma_kwargs()
        self.sigma_label.setText(f"sigma_base = {kw['sigma_base']:.3f}")
        self.k_label.setText(f"b = {kw['k_signal']:.3f}")
        self.k_slider.setEnabled(kw["mode"] == "luminance")
        self.schedule_recompute()

    def regenerate(self):
        self.sample = make_sample(**self._sigma_kwargs())
        self.noise_model = None
        self.est_text.clear()
        self.run_estimation()
        self.recompute()

    def _refresh_est_list(self):
        self.est_list.clear()
        for i, (y0, y1, x0, x1) in enumerate(self.est_rects):
            QListWidgetItem(
                f"平坦区{i + 1}: y[{y0},{y1}) x[{x0},{x1})", self.est_list)

    def _add_est_rect(self):
        if self.selection is not None:
            self.est_rects.append(self.selection)
            self._refresh_est_list()

    def _del_est_rect(self):
        row = self.est_list.currentRow()
        if row >= 0:
            del self.est_rects[row]
            self._refresh_est_list()

    def _reset_est_rects(self):
        self.est_rects = default_estimation_rects()
        self._refresh_est_list()

    def run_estimation(self):
        mode = self.mode_combo.currentData()
        # 注意：只传 noisy，clean 在此调用链中不可达
        self.noise_model = fit_noise_model(
            self.sample.noisy, self.est_rects, mode)
        m = self.noise_model
        lines = ["逐级估计（MAD 稳健 sigma，仅带噪图）:"]
        for lv in m.levels:
            lines.append(
                f"  luma={lv.median_luma:.3f}  sigma={lv.sigma:.4f}"
                f"  ({lv.n_pixels} px)")
        if mode == "fixed":
            lines.append(f"→ 固定模式全局 sigma = {m.sigma_fixed:.4f}")
        else:
            lines.append(
                f"→ 拟合 sigma(y) = {m.read_sigma:.4f} + "
                f"{m.signal_k:.4f}·√y   (RMSE={m.fit_residual:.5f})")
        self.est_text.setText("\n".join(lines))

    def on_selection(self, rect: Rect | None):
        self.selection = rect
        for vw in self.views:
            vw.set_selection(rect)
        if rect is not None:
            y0, y1, x0, x1 = rect
            self.statusBar().showMessage(
                f"选区 y[{y0},{y1}) x[{x0},{x1})  "
                f"尺寸 {y1 - y0}×{x1 - x0}（四视图与差值图同步）")

    def _link_zoom(self, transform):
        for vw in self.views:
            if vw is not self.sender():
                vw.link_transform(transform)

    def schedule_recompute(self, *_):
        if self._updating:
            return
        self._recompute_timer.start(120)

    def _current_regions(self) -> list[RegionParams]:
        return [ed.params() for ed in self.editors]

    def recompute(self):
        self._updating = True
        try:
            regions = self._current_regions()
            winner = self.priority_combo.currentData()
            noisy = self.sample.noisy
            # 同一套区域参数，仅算法不同 —— 两侧严格可比
            self.out_smooth = process(noisy, ALGO_SMOOTH, regions, winner)
            self.out_edge = process(noisy, ALGO_EDGE, regions, winner)
            gain = self.diff_gain.value()
            self.diff_s = diff_map(noisy, self.out_smooth, gain)
            self.diff_e = diff_map(noisy, self.out_edge, gain)
            self.heat_s = texture_erasure_mask(noisy, self.out_smooth)
            self.heat_e = texture_erasure_mask(noisy, self.out_edge)
            self.refresh_views()
        finally:
            self._updating = False

    def refresh_views(self):
        ch = self.channel_combo.currentText()
        pairs = (
            (self.view_smooth, self.out_smooth, None),
            (self.view_edge, self.out_edge, None),
            (self.view_diff_s, self.diff_s, self.heat_s),
            (self.view_diff_e, self.diff_e, self.heat_e),
        )
        thr = self.erasure_thr.value() / 100.0
        show_e = self.chk_erasure.isChecked()
        regions = self._current_regions()
        winner = self.priority_combo.currentData()
        for vw, img, heat in pairs:
            vw.set_image(channel_image(img, ch))
            vw.set_selection(self.selection)
            vw.set_regions(regions, winner)
            if heat is not None:
                vw.set_erasure(heat, thr, show_e)
            else:
                vw.set_erasure(np.zeros((IMG_H, IMG_W), np.float32),
                               thr, False)

    def run_evaluation(self):
        """唯一读取 clean 的入口；结果仅用于报告，不回流行处理。"""
        report_s = evaluate(self.sample.clean, self.sample.noisy,
                            self.out_smooth, self.sample.zones)
        report_e = evaluate(self.sample.clean, self.sample.noisy,
                            self.out_edge, self.sample.zones)
        self.eval_text.setText(self._format_report(report_s, report_e))

    @staticmethod
    def _format_report(rs, re_) -> str:
        def block(title, r):
            lines = [f"【{title}】", "平坦区噪声下降："]
            for z in r.flat:
                lines.append(
                    f"  {z.name:<12} σ {z.noisy_std:.4f}→{z.processed_std:.4f}"
                    f"  下降 {z.noise_drop_db:5.1f} dB"
                    f"  对参考RMSE {z.residual_rmse:.4f}")
            lines.append(f"  汇总噪声下降: {r.flat_noise_drop_db:.1f} dB")
            e = r.edge
            lines.append(
                f"边缘保留: 梯度相关 {e.grad_corr:.3f} | "
                f"幅度保持 {e.amplitude_keep:.3f} | EPI {e.epi:.3f}")
            lines.append("纹理能量保持率（<0.8 提示纹理被抹）:")
            for t in r.textures:
                mark = "  ← 明显被抹" if t.energy_keep < 0.8 else ""
                lines.append(f"  {t.zone:<9} {t.energy_keep:.3f}{mark}")
            c = r.chroma
            lines.append(
                f"色度细节保持: Cr {c.cr_keep:.3f} | Cb {c.cb_keep:.3f}"
                f"（原始 {c.cr_raw:.2f}/{c.cb_raw:.2f}，>1 表示仍有残余色度噪声）")
            return "\n".join(lines)

        return (block(ALGO_LABELS[ALGO_SMOOTH], rs) + "\n\n"
                + block(ALGO_LABELS[ALGO_EDGE], re_))


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
