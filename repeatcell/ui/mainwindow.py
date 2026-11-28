"""主窗口: 输入图像 -> 框选区域 -> 估算候选 -> 检查单元/样本 -> 导出。"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import numpy as np
from PySide6.QtCore import QPointF, QRectF, Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPushButton, QSplitter,
    QTabWidget, QTextEdit, QToolBar, QVBoxLayout, QWidget,
)

from .. import synth
from ..estimator import (BasisAdvice, PeriodicityAnalysis, assess_basis,
                         estimate_periodicity)
from ..geometry import (CellBasis, choose_complete_cell, coverage_fraction,
                        fully_inside_cells, normalize_basis)
from ..sampler import (CellSample, clean_unit, gather_samples, sample_cell,
                       sample_stats)
from ..tiling import export_cell
from .cellpreview import CellPreview
from .compareview import TileCompare
from .imageview import ImageView
from .overlayview import SampleOverlay


def _load_image_rgb(path: Path) -> np.ndarray:
    """读图并转成 float32 的 HxWx3, 0..1。"""
    from PIL import Image
    with Image.open(path) as im:
        im = im.convert("RGB")
        arr = np.asarray(im).astype(np.float32) / 255.0
    return arr


def _fmt_vec(v) -> str:
    return f"({v[0]:.2f}, {v[1]:.2f})"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("重复单元测量窗")
        self.resize(1480, 900)

        self.image: Optional[np.ndarray] = None
        self.image_path: Optional[Path] = None
        self.analysis: Optional[PeriodicityAnalysis] = None
        self.component_candidates: List[CellBasis] = []
        self.active_candidate: int = -1
        self.basis: Optional[CellBasis] = None
        self.samples: List[CellSample] = []
        self.clean = None
        self._updating_controls = False
        self._analysis_rect: tuple = (0, 0, 0, 0)
        self._advice: Optional[BasisAdvice] = None

        self._build_toolbar()
        self._build_ui()

    # ------------------------------------------------------------------
    # 界面
    # ------------------------------------------------------------------
    def _build_toolbar(self) -> None:
        tb = QToolBar("主工具栏")
        tb.setMovable(False)
        self.addToolBar(tb)

        act_open = QAction("打开图片…", self)
        act_open.setShortcut(QKeySequence.Open)
        act_open.triggered.connect(self.open_image_dialog)
        tb.addAction(act_open)

        tb.addSeparator()
        tb.addWidget(QLabel("  示例: "))
        self.example_combo = QComboBox()
        for key, title in synth.list_examples():
            self.example_combo.addItem(title, key)
        tb.addWidget(self.example_combo)
        act_example = QAction("载入", self)
        act_example.triggered.connect(self.load_example)
        tb.addAction(act_example)

        tb.addSeparator()
        act_fit = QAction("适应窗口", self)
        act_fit.triggered.connect(lambda: self.view.fit_to_window())
        tb.addAction(act_fit)

        self.mode_combo = QComboBox()
        self.mode_combo.addItem("拖动态: 框选区域", ImageView.MODE_REGION)
        self.mode_combo.addItem("拖动态: 向量 O/1/2", ImageView.MODE_VECTORS)
        self.mode_combo.currentIndexChanged.connect(
            lambda: self.view.set_mode(self.mode_combo.currentData()))
        tb.addWidget(self.mode_combo)

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QHBoxLayout(central)
        root.setContentsMargins(4, 4, 4, 4)

        splitter = QSplitter(Qt.Horizontal)
        root.addWidget(splitter, 1)

        self.view = ImageView()
        self.view.regionChanged.connect(self._on_region_changed)
        self.view.basisEdited.connect(self._on_basis_dragged)
        self.view.cursorMoved.connect(self._on_cursor)
        splitter.addWidget(self.view)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(0, 0, 0, 0)
        splitter.addWidget(right)
        splitter.setSizes([900, 560])

        self.tabs = QTabWidget()
        right_layout.addWidget(self.tabs, 1)

        self._build_tab_estimate()
        self._build_tab_cell()
        self._build_tab_samples()
        self._build_tab_export()

        self.status = self.statusBar()
        self.cursor_label = QLabel("")
        self.status.addPermanentWidget(self.cursor_label)

    # ---- 估算页 ----
    def _build_tab_estimate(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.region_label = QLabel("区域: 未选择")
        lay.addWidget(self.region_label)

        row = QHBoxLayout()
        self.btn_estimate = QPushButton("估算重复方向")
        self.btn_estimate.clicked.connect(self.estimate)
        self.btn_estimate.setEnabled(False)
        row.addWidget(self.btn_estimate)
        btn_region_all = QPushButton("整幅图")
        btn_region_all.clicked.connect(self._region_full_image)
        row.addWidget(btn_region_all)
        lay.addLayout(row)

        self.advice_view = QTextEdit()
        self.advice_view.setReadOnly(True)
        self.advice_view.setMinimumHeight(150)
        lay.addWidget(self.advice_view, 1)

        lay.addWidget(QLabel("候选组 (点开可切换查看):"))
        self.candidate_buttons: List[QPushButton] = []
        self.candidate_box = QWidget()
        self.candidate_layout = QVBoxLayout(self.candidate_box)
        self.candidate_layout.setContentsMargins(0, 0, 0, 0)
        lay.addWidget(self.candidate_box)

        form_box = QGroupBox("当前两根向量 (原图像素, 可含小数)")
        form = QFormLayout(form_box)
        self.ox = self._spin(-99999, 99999, 2)
        self.oy = self._spin(-99999, 99999, 2)
        self.t1x = self._spin(-99999, 99999, 3)
        self.t1y = self._spin(-99999, 99999, 3)
        self.t2x = self._spin(-99999, 99999, 3)
        self.t2y = self._spin(-99999, 99999, 3)
        form.addRow("原点 O (x, y)", self._pair(self.ox, self.oy))
        form.addRow("向量 t1 (x, y)", self._pair(self.t1x, self.t1y))
        form.addRow("向量 t2 (x, y)", self._pair(self.t2x, self.t2y))
        for spin in (self.ox, self.oy, self.t1x, self.t1y, self.t2x, self.t2y):
            spin.valueChanged.connect(self._on_spin_basis_changed)
        lay.addWidget(form_box)

        row2 = QHBoxLayout()
        btn_snap = QPushButton("原点吸附到图内完整单元")
        btn_snap.clicked.connect(self.snap_origin)
        row2.addWidget(btn_snap)
        self.btn_apply_advice = QPushButton("应用提示的一组向量")
        self.btn_apply_advice.setEnabled(False)
        self.btn_apply_advice.clicked.connect(self.apply_suggested_basis)
        row2.addWidget(self.btn_apply_advice)
        lay.addLayout(row2)

        lay.addStretch(1)
        self.tabs.addTab(w, "1 估算")

    @staticmethod
    def _spin(lo: float, hi: float, decimals: int) -> QDoubleSpinBox:
        s = QDoubleSpinBox()
        s.setRange(lo, hi)
        s.setDecimals(decimals)
        s.setSingleStep(0.1 if decimals else 1.0)
        s.setKeyboardTracking(False)
        return s

    @staticmethod
    def _pair(a: QDoubleSpinBox, b: QDoubleSpinBox) -> QWidget:
        box = QWidget()
        h = QHBoxLayout(box)
        h.setContentsMargins(0, 0, 0, 0)
        h.addWidget(a)
        h.addWidget(b)
        return box

    # ---- 单元页 ----
    def _build_tab_cell(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)

        self.coverage_label = QLabel("单元覆盖率: -")
        self.coverage_label.setWordWrap(True)
        lay.addWidget(self.coverage_label)

        self.preview = CellPreview()
        self.preview.cellClicked.connect(self._on_cell_tile_clicked)
        lay.addWidget(self.preview, 1)

        row = QHBoxLayout()
        row.addWidget(QLabel("单元分辨率:"))
        self.unit_size = QComboBox()
        for n in (64, 96, 128, 192, 256, 384):
            self.unit_size.addItem(str(n), n)
        self.unit_size.setCurrentIndex(3)
        self.unit_size.currentIndexChanged.connect(self._refresh_cell_preview)
        row.addWidget(self.unit_size)
        btn_complete = QPushButton("取图内完整单元")
        btn_complete.clicked.connect(self.use_complete_cell)
        row.addWidget(btn_complete)
        lay.addLayout(row)

        self.complete_hint = QLabel("")
        self.complete_hint.setWordWrap(True)
        lay.addWidget(self.complete_hint)

        self.tabs.addTab(w, "2 单元")

    # ---- 样本页 ----
    def _build_tab_samples(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)

        row = QHBoxLayout()
        row.addWidget(QLabel("样本数:"))
        self.sample_count = QComboBox()
        for n in (2, 3, 4, 6, 9, 12):
            self.sample_count.addItem(str(n), n)
        self.sample_count.setCurrentIndex(4)
        self.sample_count.currentIndexChanged.connect(self._rebuild_samples)
        row.addWidget(self.sample_count)
        row.addWidget(QLabel("叠图:"))
        self.overlay_mode = QComboBox()
        self.overlay_mode.addItem("差值与色偏", "difference")
        self.overlay_mode.addItem("直接平均", "mean")
        self.overlay_mode.addItem("棋盘拼图", "checker")
        self.overlay_mode.currentIndexChanged.connect(self._refresh_overlay)
        row.addWidget(self.overlay_mode)
        lay.addLayout(row)

        self.overlay = SampleOverlay()
        lay.addWidget(self.overlay, 1)

        row2 = QHBoxLayout()
        row2.addWidget(QLabel("拼接方式:"))
        self.clean_method = QComboBox()
        self.clean_method.addItem("逐像素中位数 (最抗缺损)", "median")
        self.clean_method.addItem("剔除离群层后平均 (保细节)", "robust")
        self.clean_method.addItem("直接平均 (保留磨损)", "mean")
        self.clean_method.currentIndexChanged.connect(self._refresh_overlay)
        row2.addWidget(self.clean_method)
        btn_clean = QPushButton("生成干净单元")
        btn_clean.clicked.connect(self.build_clean_unit)
        row2.addWidget(btn_clean)
        lay.addLayout(row2)

        self.clean_preview = CellPreview()
        self.clean_preview.setMinimumHeight(200)
        self.clean_preview.cellClicked.connect(lambda _i: None)
        lay.addWidget(self.clean_preview, 1)

        self.sample_note = QLabel("")
        self.sample_note.setWordWrap(True)
        lay.addWidget(self.sample_note)

        self.tabs.addTab(w, "3 样本")

    # ---- 导出页 ----
    def _build_tab_export(self) -> None:
        w = QWidget()
        lay = QVBoxLayout(w)
        self.compare = TileCompare()
        lay.addWidget(self.compare, 1)

        row = QHBoxLayout()
        btn = QPushButton("导出单元 / JSON / 比对图…")
        btn.clicked.connect(self.export)
        row.addWidget(btn)
        self.export_note = QLabel("")
        self.export_note.setWordWrap(True)
        row.addWidget(self.export_note, 1)
        lay.addLayout(row)

        self.tabs.addTab(w, "4 导出")

    # ------------------------------------------------------------------
    # 载入
    # ------------------------------------------------------------------
    def open_image_dialog(self) -> None:
        name, _ = QFileDialog.getOpenFileName(
            self, "打开图片", "",
            "图片 (*.png *.jpg *.jpeg *.bmp *.tif *.tiff *.webp);;所有文件 (*)")
        if not name:
            return
        try:
            rgb = _load_image_rgb(Path(name))
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "读取失败", f"无法读取图片:\n{exc}")
            return
        self._set_image(rgb, Path(name))

    def load_example(self) -> None:
        key = self.example_combo.currentData()
        try:
            ex = synth.generate_example(key)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "示例生成失败", str(exc))
            return
        self.image_path = None
        self._set_image(ex.image.copy(), None)
        x, y, w, h = ex.region
        self.view.set_region(QRectF(x, y, w, h))
        self.region_label.setText(
            f"区域: x={x}, y={y}, w={w}, h={h}   (示例真值 t1={_fmt_vec(ex.truth_t1)} "
            f"t2={_fmt_vec(ex.truth_t2)})")
        self.status.showMessage(ex.description, 12000)
        if ex.truth_t1 and ex.truth_t2:
            self._truth_basis = CellBasis(ex.truth_origin, ex.truth_t1, ex.truth_t2)
        else:
            self._truth_basis = None

    def _set_image(self, rgb: np.ndarray, path: Optional[Path]) -> None:
        self.image = rgb
        self.image_path = path
        self.analysis = None
        self.component_candidates = []
        self.active_candidate = -1
        self.basis = None
        self.samples = []
        self.clean = None
        self.view.set_image(rgb)
        self.view.set_mode(self.mode_combo.currentData())
        self.btn_estimate.setEnabled(True)
        self.advice_view.clear()
        self._clear_candidate_buttons()
        self.preview.set_cells([], [])
        self.clean_preview.set_cells([], [])
        self.overlay.set_samples([])
        self.compare.clear()
        self.export_note.setText("")
        self.coverage_label.setText("单元覆盖率: -")
        self.complete_hint.setText("")
        self.sample_note.setText("")
        self._sync_controls_from_basis()
        self.tabs.setCurrentIndex(0)
        if path is not None:
            self.status.showMessage(f"已载入 {path.name}  ({rgb.shape[1]}×{rgb.shape[0]})")

    # ------------------------------------------------------------------
    # 事件
    # ------------------------------------------------------------------
    def _on_cursor(self, x: float, y: float) -> None:
        self.cursor_label.setText(f"x={x:.2f}  y={y:.2f}")

    def _on_region_changed(self, rect: QRectF) -> None:
        r = rect.normalized()
        self.region_label.setText(
            f"区域: x={r.x():.0f}, y={r.y():.0f}, "
            f"w={r.width():.0f}, h={r.height():.0f}")

    def _region_full_image(self) -> None:
        if self.image is None:
            return
        h, w = self.image.shape[:2]
        self.view.set_region(QRectF(2, 2, w - 4, h - 4))
        self.region_label.setText(f"区域: 整幅图 {w}×{h}")

    def _on_basis_dragged(self, o: QPointF, t1: QPointF, t2: QPointF) -> None:
        self.basis = CellBasis((o.x(), o.y()), (t1.x(), t1.y()), (t2.x(), t2.y()))
        self._sync_controls_from_basis()
        self._on_basis_changed(refresh_advice=True)

    def _on_spin_basis_changed(self) -> None:
        if self._updating_controls:
            return
        try:
            basis = CellBasis(
                (self.ox.value(), self.oy.value()),
                (self.t1x.value(), self.t1y.value()),
                (self.t2x.value(), self.t2y.value()))
        except Exception:  # noqa: BLE001
            return
        if abs(basis.area) < 1e-6:
            return
        self.basis = basis
        self.view.set_basis(basis)
        self._on_basis_changed(refresh_advice=True)

    def _sync_controls_from_basis(self) -> None:
        if self.basis is None:
            return
        self._updating_controls = True
        b = self.basis
        self.ox.setValue(b.origin[0])
        self.oy.setValue(b.origin[1])
        self.t1x.setValue(b.t1[0])
        self.t1y.setValue(b.t1[1])
        self.t2x.setValue(b.t2[0])
        self.t2y.setValue(b.t2[1])
        self._updating_controls = False

    # ------------------------------------------------------------------
    # 估算
    # ------------------------------------------------------------------
    def estimate(self) -> None:
        if self.image is None:
            return
        rect = self.view.region
        h, w = self.image.shape[:2]
        if rect is None or rect.width() < 16 or rect.height() < 16:
            rect = QRectF(0, 0, w, h)
        x0 = int(max(0, min(w - 1, round(rect.left()))))
        y0 = int(max(0, min(h - 1, round(rect.top()))))
        x1 = int(max(x0 + 8, min(w, round(rect.right()))))
        y1 = int(max(y0 + 8, min(h, round(rect.bottom()))))
        crop = self.image[y0:y1, x0:x1]
        QApplication.setOverrideCursor(Qt.WaitCursor)
        try:
            self.analysis = estimate_periodicity(crop)
        except ValueError as exc:
            QApplication.restoreOverrideCursor()
            self.advice_view.setPlainText(f"估算失败: {exc}")
            return
        finally:
            QApplication.restoreOverrideCursor()

        self._analysis_rect = (x0, y0, x1 - x0, y1 - y0)
        self._build_candidate_buttons()
        self.select_candidate(0)

    def _clear_candidate_buttons(self) -> None:
        for btn in self.candidate_buttons:
            btn.setParent(None)
        self.candidate_buttons = []

    def _build_candidate_buttons(self) -> None:
        self._clear_candidate_buttons()
        if self.analysis is None:
            return
        for idx, c in enumerate(self.analysis.groups):
            btn = QPushButton()
            btn.setCheckable(True)
            btn.setText(self._candidate_caption(idx, c))
            btn.clicked.connect(lambda _=False, i=idx: self.select_candidate(i))
            self.candidate_layout.addWidget(btn)
            self.candidate_buttons.append(btn)

    def _candidate_caption(self, idx: int, c) -> str:
        tag = {"primitive": "最小周期", "multiple": "整步",
               "alternative": "另一组"}.get(c.kind, c.kind)
        letter = "AB"[idx] if idx < 2 else str(idx + 1)
        return (f"{letter}. [{tag}] {c.label}   点阵相关 {c.lattice_score:.3f}"
                f"   面积 {c.area:.0f} px²")

    def apply_suggested_basis(self) -> None:
        if (self._advice is None or self._advice.suggested_basis is None
                or self.basis is None or self.image is None):
            return
        t1, t2 = self._advice.suggested_basis
        self.basis = normalize_basis(self.basis.origin, t1, t2,
                                     self.image.shape[1], self.image.shape[0])
        self.view.set_basis(self.basis)
        self._sync_controls_from_basis()
        self._on_basis_changed(refresh_advice=True)

    def select_candidate(self, idx: int) -> None:
        if self.analysis is None or idx >= len(self.analysis.groups):
            return
        self.active_candidate = idx
        cand = self.analysis.groups[idx]
        self.component_candidates = [cand]
        for i, btn in enumerate(self.candidate_buttons):
            btn.setChecked(i == idx)

        # 平移向量与裁剪原点无关, 可直接用; 原点取在估算区域中心附近,
        # 再让用户拖动或用"吸附到完整单元"调整。
        x0, y0, rw, rh = getattr(self, "_analysis_rect", (0, 0, 0, 0))
        origin = (x0 + rw / 2.0, y0 + rh / 2.0)
        self.basis = normalize_basis(origin, cand.t1, cand.t2,
                                     self.image.shape[1], self.image.shape[0])
        self.view.set_basis(self.basis)
        self._sync_controls_from_basis()
        self._on_basis_changed(refresh_advice=True)

    def _refresh_advice(self) -> None:
        if self.analysis is None or self.basis is None:
            return
        # 平移量与裁剪原点无关, 可直接用
        advice = assess_basis(self.analysis, self.basis.t1, self.basis.t2)
        self._advice = advice
        self.btn_apply_advice.setEnabled(advice.suggested_basis is not None)
        lines = [self._advice_headline(advice)]
        lines.append("")
        lines.append(advice.message)
        if advice.suggested_basis is not None:
            lines.append("")
            label = {"longer": "更长的一组", "shorter": "更短的一组"}.get(
                advice.preferred, "建议的一组")
            lines.append(label + ": t1=" + _fmt_vec(advice.suggested_basis[0])
                         + "  t2=" + _fmt_vec(advice.suggested_basis[1]))
        self.advice_view.setPlainText("\n".join(lines))

    @staticmethod
    def _advice_headline(advice: BasisAdvice) -> str:
        return {
            "shorter": "提示: 半步更可信 —— 可以缩短一半",
            "longer": "提示: 当前取短了 —— 真正的周期更长",
            "selected": "提示: 整步更可信 —— 不要误取半步",
            "ambiguous": "提示: 半步和整步都像重复 —— 请对照两组候选",
            "unknown": "提示: 无法从像素相关判断",
        }.get(advice.preferred, advice.preferred)

    # ------------------------------------------------------------------
    # 单元
    # ------------------------------------------------------------------
    def _on_basis_changed(self, refresh_advice: bool = True) -> None:
        if self.basis is None or self.image is None:
            return
        self.view.set_basis(self.basis)
        if refresh_advice:
            self._refresh_advice()
        # 换了单元之后, 之前拼好的"干净单元"就不再对应当前位置了
        self.clean = None
        self.clean_preview.set_cells([], [])
        self._refresh_cell_preview()
        self._rebuild_samples()
        self._refresh_compare()

    def _unit_resolution(self) -> int:
        return int(self.unit_size.currentData())

    def _refresh_cell_preview(self) -> None:
        if self.basis is None or self.image is None:
            return
        h, w = self.image.shape[:2]
        n = self._unit_resolution()
        tiles: List[CellSample] = []
        labels: List[str] = []
        basis = self.basis
        cur = sample_cell(self.image, basis, n=n)
        tiles.append(cur)
        labels.append("当前单元" + (" (有缺口)" if not cur.valid.all() else ""))
        info = coverage_fraction(basis.corners(), w, h)
        self.coverage_label.setText(
            f"单元覆盖率: {info * 100:.1f}%   面积 {basis.area:.1f} px²   "
            f"t1={_fmt_vec(basis.t1)}   t2={_fmt_vec(basis.t2)}"
            + ("" if info >= 0.9999 else "   (洋红斜纹 = 图外/缺口)"))

        complete = choose_complete_cell(basis, w, h,
                                        prefer_point=(w / 2.0, h / 2.0))
        self._preview_complete = complete
        if complete is not None:
            s = sample_cell(self.image, complete, n=n)
            tiles.append(s)
            labels.append(f"图内完整单元 @({complete.origin[0]:.1f},"
                          f"{complete.origin[1]:.1f})  (点我切过去)")
            self.complete_hint.setText(
                f"可换用的完整单元: 原点 ({complete.origin[0]:.2f}, "
                f"{complete.origin[1]:.2f}), 覆盖率 "
                f"{coverage_fraction(complete.corners(), w, h) * 100:.0f}%。"
                "点选下面的方块可查看。")
        else:
            # 没有完整单元时, 列出所有候选的覆盖情况
            cells = fully_inside_cells(basis, w, h)
            if cells:
                self.complete_hint.setText(
                    f"图内有 {len(cells)} 个完整单元可用。")
            else:
                self.complete_hint.setText(
                    "这张图里放不下一个完整的单元; 当前预览的缺口部分已标出。"
                    "可以缩小步长, 或换一个更大的图/更小的区域。")
        self.preview.set_cells(tiles, labels, active=0)
        self._preview_tiles = tiles

    def _on_cell_tile_clicked(self, idx: int) -> None:
        if idx == 1 and getattr(self, "_preview_complete", None) is not None:
            self.use_complete_cell()

    def use_complete_cell(self) -> None:
        if self.basis is None or self.image is None:
            return
        h, w = self.image.shape[:2]
        complete = choose_complete_cell(self.basis, w, h,
                                        prefer_point=(w / 2.0, h / 2.0))
        if complete is None:
            QMessageBox.information(
                self, "没有完整单元",
                "当前步长下, 图内放不下一个完整的平行四边形单元。")
            return
        self.basis = complete
        self.view.set_basis(complete)
        self._sync_controls_from_basis()
        self._on_basis_changed(refresh_advice=False)

    def snap_origin(self) -> None:
        if self.basis is None or self.image is None:
            return
        h, w = self.image.shape[:2]
        complete = choose_complete_cell(self.basis, w, h,
                                        prefer_point=self.basis.origin)
        target = complete or normalize_basis(
            self.basis.origin, self.basis.t1, self.basis.t2, w, h)
        self.basis = target
        self.view.set_basis(target)
        self._sync_controls_from_basis()
        self._on_basis_changed(refresh_advice=False)

    # ------------------------------------------------------------------
    # 样本
    # ------------------------------------------------------------------
    def _rebuild_samples(self) -> None:
        if self.basis is None or self.image is None:
            return
        n = min(192, self._unit_resolution())
        count = int(self.sample_count.currentData())
        self.samples = gather_samples(self.image, self.basis, n=n,
                                      max_samples=count)
        self._refresh_overlay()

    def _refresh_overlay(self) -> None:
        mode = self.overlay_mode.currentData()
        self.overlay.set_samples(self.samples, mode=mode)
        if not self.samples:
            self.sample_note.setText(
                "没有可用于拼接的完整同位置样本。先让单元完整落在图内。")
            return
        stats = sample_stats(self.samples)
        self.overlay.set_stats(stats)
        offsets = stats.get("color_offsets", [])
        rms = stats.get("mean_pair_rms", 0.0)
        lines = [f"已用 {stats['count']} 个完整单元做同位置样本。"]
        if offsets:
            spread = np.array(offsets)
            lines.append(
                "样本平均色偏 (R,G,B): "
                + "; ".join(f"({o[0]:+.3f},{o[1]:+.3f},{o[2]:+.3f})"
                            for o in offsets[:6])
                + (" …" if len(offsets) > 6 else ""))
            lines.append(
                f"色偏幅度约 {np.abs(spread).max():.3f}, 两两 RMS 差 {rms:.3f}。")
        lines.append(
            "这些差异是织物本身的磨损/色差; 除非花纹位置明显对不上, "
            "不要当成周期测量错误。")
        self.sample_note.setText("\n".join(lines))

    def build_clean_unit(self) -> None:
        if not self.samples:
            QMessageBox.information(self, "没有样本",
                                    "先让单元完整落在图内, 才能取同位置样本。")
            return
        method = self.clean_method.currentData()
        clean = clean_unit(self.samples, method=method)
        self.clean = clean
        self.clean_preview.set_cells(
            [CellSample(clean.rgb, clean.mask, self.basis or CellBasis((0, 0), (1, 0), (0, 1)))],
            [f"干净单元 · { {'median': '中位数', 'robust': '剔除离群', 'mean': '平均'}.get(method, method)}"
             f" · {clean.n_samples} 层" +
             (f" · 补洞 {int(clean.filled.sum())} px" if clean.filled.any() else "")],
            active=0)
        self._refresh_compare()

    # ------------------------------------------------------------------
    # 导出
    # ------------------------------------------------------------------
    def _export_unit(self) -> Optional[tuple]:
        if self.clean is not None:
            return self.clean.rgb, self.clean.mask
        if self.basis is None or self.image is None:
            return None
        s = sample_cell(self.image, self.basis, n=self._unit_resolution())
        return s.rgb, s.valid

    def _refresh_compare(self) -> None:
        if self.basis is None or self.image is None:
            self.compare.clear()
            return
        unit = self._export_unit()
        if unit is None:
            return
        self.compare.set_data(self.image, unit[0], self.basis, mask=unit[1])

    def export(self) -> None:
        unit = self._export_unit()
        if unit is None or self.basis is None or self.image is None:
            QMessageBox.information(self, "还没有单元", "先选定一组向量。")
            return
        folder = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not folder:
            return
        name = self.image_path.stem if self.image_path else "example"
        out = Path(folder) / f"{name}_cell"
        try:
            res = export_cell(
                out, unit[0], unit[1], self.basis, self.image,
                source_name=name,
                extra={
                    "estimate": None if self.analysis is None else {
                        "groups": [
                            {"kind": c.kind, "t1": list(c.t1), "t2": list(c.t2),
                             "lattice_score": c.lattice_score,
                             "area": c.area}
                            for c in self.analysis.groups
                        ],
                    },
                    "clean": None if self.clean is None else {
                        "method": self.clean.method,
                        "samples": self.clean.n_samples,
                        "filled_pixels": int(self.clean.filled.sum()),
                    },
                })
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        self.export_note.setText(
            f"已导出到 {out}\nunit.png / compare.png / tiled.png / cell.json"
            + ("\n" + "\n".join(res.warnings) if res.warnings else ""))
        self.status.showMessage(f"导出完成: {out}", 8000)
