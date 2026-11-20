"""Main window: 2x2 comparison panes plus palette, settings and inspector."""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QAction, QColor, QFontMetrics, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QColorDialog,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QPushButton,
    QScrollArea,
    QSlider,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from ..demo import DEMOS, demo_rgba
from ..imageio import ImageLoadError, load_image
from ..palette import MAX_COLORS, MIN_COLORS
from ..pngio import ExportError, export_indexed_png, read_indexed_png, readback_matches
from ..quantize import (
    ALL_MODES,
    MODE_DIFFUSION,
    MODE_LABELS,
    MODE_NONE,
    MODE_ORDERED,
    Quantized,
    Settings,
    render_rgba,
)
from ..session import Session
from .palette_panel import PalettePanel
from .view import ZOOM_LEVELS, PixelView, SharedView, rgba_to_qimage

APP_NAME = "Palettizer · 像素画调色工具"
APP_VERSION = "1.0.0"


class FittedLabel(QLabel):
    """QLabel that scales its font down to fit its width instead of clipping.

    Used for one-line numeric/status strips whose length varies with the
    image (pixel counts, colour counts).  Word-wrap would make the panel
    taller unpredictably, and eliding hides the numbers, so shrinking the
    font is the least bad option.
    """

    def __init__(self, text: str = "", base_size: float = 11.0, min_size: float = 7.0, parent=None):
        super().__init__(text, parent)
        self._base = float(base_size)
        self._min = float(min_size)
        self.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self._apply(self._base)

    def _apply(self, size: float) -> None:
        font = self.font()
        font.setPointSizeF(max(self._min, size))
        self.setFont(font)

    def setText(self, text: str) -> None:  # noqa: N802 (Qt naming)
        super().setText(text)
        self._fit()

    def resizeEvent(self, event):  # noqa: N802
        super().resizeEvent(event)
        self._fit()

    def _fit(self) -> None:
        text = self.text()
        if not text:
            return
        available = max(10, self.width() - 2)
        # Start from the base size every time, otherwise repeated setText /
        # resize calls would ratchet the font down and never grow it back.
        size = self._base
        self._apply(size)
        while size > self._min:
            if QFontMetrics(self.font()).horizontalAdvance(text) <= available:
                break
            size -= 0.5
            self._apply(size)


def _hex(rgb) -> str:
    return "#%02X%02X%02X" % tuple(int(v) for v in rgb)


class HexPaletteDialog(QDialog):
    """Manual palette entry: one #RRGGBB per line.

    Locked colours from the existing palette are preserved automatically and
    listed read-only; the text box holds the colours that will replace the
    unlocked ones.
    """

    def __init__(self, existing_unlocked, n_locked: int, capacity: int,
                 locked_colors=(), parent=None):
        super().__init__(parent)
        self.setWindowTitle("手工指定调色板")
        self.resize(380, 460)
        self.capacity = capacity
        # Locks count toward the 4..32 total, so the text box may be empty
        # when enough colours are already locked.
        self.min_entries = max(0, MIN_COLORS - n_locked)
        lay = QVBoxLayout(self)
        info = QLabel(
            f"每行一个 #RRGGBB（也接受 #RGB），可用 // 或 # 注释行。\n"
            f"输入 {self.min_entries}..{capacity} 色；已有 {n_locked} 个锁定颜色会自动保留，"
            f"重复颜色将被合并。"
        )
        info.setWordWrap(True)
        info.setStyleSheet("color:#9aa0aa;")
        lay.addWidget(info)
        if locked_colors:
            locked = QLabel(
                "锁定保留：" + "  ".join(_hex(c) for c in locked_colors)
            )
            locked.setWordWrap(True)
            locked.setStyleSheet("color:#d8c98a; font-size:11px;")
            lay.addWidget(locked)
        self.editor = QPlainTextEdit()
        self.editor.setFont(self.font())
        self.editor.setPlainText("\n".join(_hex(c) for c in existing_unlocked))
        lay.addWidget(self.editor, 1)
        self.error = QLabel("")
        self.error.setStyleSheet("color:#ff8080;")
        self.error.setWordWrap(True)
        lay.addWidget(self.error)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(self._validate_accept)
        buttons.rejected.connect(self.reject)
        lay.addWidget(buttons)

    def parsed(self) -> list[tuple[int, int, int]]:
        colors = []
        for lineno, raw in enumerate(self.editor.toPlainText().splitlines(), 1):
            line = raw.strip()
            if not line:
                continue
            if line.startswith("//"):
                continue
            text = line.lstrip("#")
            if line.startswith("#") and len(text) not in (3, 6):
                # '# note' style comment rather than a colour.
                continue
            if len(text) == 3:
                text = "".join(ch * 2 for ch in text)
            if len(text) != 6 or any(ch not in "0123456789abcdefABCDEF" for ch in text):
                raise ValueError(f"第 {lineno} 行不是有效的 #RRGGBB：{raw!r}")
            rgb = tuple(int(text[i : i + 2], 16) for i in (0, 2, 4))
            colors.append(rgb)
        return colors

    def _validate_accept(self) -> None:
        try:
            colors = self.parsed()
        except ValueError as exc:
            self.error.setText(str(exc))
            return
        if not (self.min_entries <= len(colors) <= self.capacity):
            self.error.setText(
                f"需要 {self.min_entries}..{self.capacity} 个颜色，当前 {len(colors)} 个"
            )
            return
        self.accept()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.session = Session()
        self.view = SharedView(self)
        self.views: dict[str, PixelView] = {}
        self.export_mode = MODE_NONE
        self.show_grid = True
        self._pending = False
        self._recompute_timer = QTimer(self)
        self._recompute_timer.setSingleShot(True)
        self._recompute_timer.setInterval(40)
        self._recompute_timer.timeout.connect(self.recompute)
        self._results: dict[str, Quantized] = {}

        # Keep the toolbar zoom chooser in sync with wheel/double-click zoom,
        # and refresh the inspector whenever the selection changes.
        self.view.changed.connect(self._sync_zoom_combo)
        self.view.selectionChanged.connect(self._update_inspector)
        self.setWindowTitle(APP_NAME)
        from .icon import make_icon

        self.setWindowIcon(make_icon())
        self.resize(1440, 900)
        self._build_ui()
        self._build_menu()
        self._set_enabled(False)
        self.log("选择一个演示素材，或打开不超过 256×256 的 PNG。")

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(10, 8, 10, 8)
        root.setSpacing(8)

        root.addWidget(self._build_toolbar())

        splitter = QSplitter(Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        root.addWidget(splitter, 1)
        splitter.addWidget(self._build_preview_area())
        splitter.addWidget(self._build_side_panel())
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 0)
        splitter.setSizes([980, 420])

    def _build_toolbar(self) -> QWidget:
        box = QFrame()
        box.setObjectName("toolbar")
        box.setStyleSheet(
            "#toolbar { background:#2a2a30; border:1px solid #3a3a42; border-radius:6px; }"
            "QPushButton { padding:4px 10px; }"
        )
        lay = QHBoxLayout(box)
        lay.setContentsMargins(8, 6, 8, 6)
        lay.setSpacing(8)

        open_btn = QPushButton("打开 PNG…")
        open_btn.setShortcut(QKeySequence.Open)
        open_btn.clicked.connect(self.open_file)
        lay.addWidget(open_btn)

        self.demo_combo = QComboBox()
        self.demo_combo.addItem("生成演示素材…", None)
        for key, (label, _fn) in DEMOS.items():
            self.demo_combo.addItem(label, key)
        self.demo_combo.activated.connect(self._on_demo_selected)
        lay.addWidget(self.demo_combo)

        lay.addWidget(self._vline())
        lay.addWidget(QLabel("缩放"))
        self.zoom_combo = QComboBox()
        for z in ZOOM_LEVELS:
            self.zoom_combo.addItem(f"{z}×", z)
        self.zoom_combo.setCurrentIndex(0)
        self.zoom_combo.activated.connect(lambda _i: self.view.set_zoom(self.zoom_combo.currentData()))
        lay.addWidget(self.zoom_combo)
        fit_btn = QPushButton("适应")
        fit_btn.clicked.connect(self.fit_views)
        lay.addWidget(fit_btn)
        self.grid_btn = QPushButton("像素网格 ✓")
        self.grid_btn.setCheckable(True)
        self.grid_btn.setChecked(True)
        self.grid_btn.toggled.connect(self._on_grid_toggled)
        lay.addWidget(self.grid_btn)

        lay.addWidget(self._vline())
        lay.addWidget(QLabel("显示/导出对照"))
        self.mode_combo = QComboBox()
        for mode in ALL_MODES:
            self.mode_combo.addItem(MODE_LABELS[mode], mode)
        self.mode_combo.setCurrentIndex(list(ALL_MODES).index(MODE_ORDERED))
        # Keep the export/statistics mode in lock-step with the combo's
        # initial selection; otherwise the first export would disagree with
        # the label the user sees.
        self.export_mode = self.mode_combo.currentData()
        self.mode_combo.activated.connect(self._on_export_mode_changed)
        lay.addWidget(self.mode_combo)

        lay.addStretch(1)
        self.undo_btn = QPushButton("撤销")
        self.undo_btn.setShortcut(QKeySequence.Undo)
        self.undo_btn.setToolTip("撤销最近一次调色板编辑（Ctrl+Z）")
        self.undo_btn.clicked.connect(self.undo_palette)
        lay.addWidget(self.undo_btn)

        export_btn = QPushButton("导出索引 PNG…")
        export_btn.setShortcut(QKeySequence.Save)
        export_btn.clicked.connect(self.export_png)
        lay.addWidget(export_btn)
        return box

    @staticmethod
    def _vline() -> QFrame:
        line = QFrame()
        line.setFrameShape(QFrame.VLine)
        line.setStyleSheet("color:#44444c;")
        return line

    def _build_preview_area(self) -> QWidget:
        host = QWidget()
        grid = QGridLayout(host)
        grid.setContentsMargins(0, 0, 0, 0)
        grid.setSpacing(6)
        panes = [
            ("source", "原图（最近邻缩放）"),
            (MODE_NONE, "不抖动"),
            (MODE_ORDERED, "有序抖动"),
            (MODE_DIFFUSION, "误差扩散"),
        ]
        for i, (key, label) in enumerate(panes):
            panel = QWidget()
            lay = QVBoxLayout(panel)
            lay.setContentsMargins(0, 0, 0, 0)
            lay.setSpacing(2)
            header = QLabel(label)
            header.setStyleSheet("color:#c9cfd8; font-weight:600; padding-left:4px;")
            lay.addWidget(header)
            view = PixelView(self.view, panel)
            view.empty_message = ""
            lay.addWidget(view, 1)
            if key == "source":
                self.source_meta = QLabel("")
                self.source_meta.setStyleSheet("color:#8a909a; font-size:11px; padding-left:4px;")
                lay.addWidget(self.source_meta)
            else:
                meta = QLabel("")
                meta.setStyleSheet("color:#8a909a; font-size:11px; padding-left:4px;")
                meta.setProperty("mode", key)
                lay.addWidget(meta)
                setattr(self, f"meta_{key}", meta)
            self.views[key] = view
            view.pixelClicked.connect(lambda *_xy: self._update_inspector())
            grid.addWidget(panel, i // 2, i % 2)
        grid.setRowStretch(0, 1)
        grid.setRowStretch(1, 1)
        grid.setColumnStretch(0, 1)
        grid.setColumnStretch(1, 1)
        return host

    def _build_side_panel(self) -> QWidget:
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setMinimumWidth(400)
        scroll.setMaximumWidth(520)
        host = QWidget()
        scroll.setWidget(host)
        lay = QVBoxLayout(host)
        lay.setContentsMargins(2, 2, 2, 2)
        lay.setSpacing(8)

        # --- generation -------------------------------------------------
        gen = QGroupBox("调色板生成")
        gl = QVBoxLayout(gen)
        row = QHBoxLayout()
        row.addWidget(QLabel("目标色数"))
        self.count_spin = QSpinBox()
        self.count_spin.setRange(MIN_COLORS, MAX_COLORS)
        self.count_spin.setValue(16)
        self.count_spin.setFixedWidth(64)
        row.addWidget(self.count_spin)
        self.count_slider = QSlider(Qt.Horizontal)
        self.count_slider.setRange(MIN_COLORS, MAX_COLORS)
        self.count_slider.setValue(16)
        self.count_slider.valueChanged.connect(self.count_spin.setValue)
        self.count_spin.valueChanged.connect(self.count_slider.setValue)
        row.addWidget(self.count_slider, 1)
        gl.addLayout(row)

        btn_row = QHBoxLayout()
        self.gen_btn = QPushButton("自动生成（保留锁定色）")
        # clicked() carries a checked flag; bind a lambda so it is not
        # mistaken for the first_load argument.
        self.gen_btn.clicked.connect(lambda: self.generate_palette())
        btn_row.addWidget(self.gen_btn, 1)
        self.manual_btn = QPushButton("手工指定…")
        self.manual_btn.clicked.connect(self.manual_palette)
        btn_row.addWidget(self.manual_btn)
        gl.addLayout(btn_row)
        self.gen_note = QLabel("")
        self.gen_note.setWordWrap(True)
        self.gen_note.setStyleSheet("color:#8fbf8f; font-size:11px;")
        self.gen_note.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        self.gen_note.setMinimumWidth(0)
        gl.addWidget(self.gen_note)
        lay.addWidget(gen)

        # --- dither settings --------------------------------------------
        dith = QGroupBox("抖动与透明")
        dl = QGridLayout(dith)
        dl.setColumnStretch(1, 1)
        dl.addWidget(QLabel("抖动强度"), 0, 0)
        self.strength_slider = QSlider(Qt.Horizontal)
        self.strength_slider.setRange(0, 100)
        self.strength_slider.setValue(50)
        self.strength_slider.valueChanged.connect(self._on_strength_changed)
        dl.addWidget(self.strength_slider, 0, 1)
        self.strength_label = QLabel("50%")
        self.strength_label.setFixedWidth(44)
        dl.addWidget(self.strength_label, 0, 2)

        dl.addWidget(QLabel("透明阈值"), 1, 0)
        self.alpha_slider = QSlider(Qt.Horizontal)
        self.alpha_slider.setRange(1, 255)
        self.alpha_slider.setValue(128)
        self.alpha_slider.valueChanged.connect(self._on_alpha_changed)
        dl.addWidget(self.alpha_slider, 1, 1)
        self.alpha_label = QLabel("128")
        self.alpha_label.setFixedWidth(44)
        dl.addWidget(self.alpha_label, 1, 2)
        hint = QLabel("alpha ≥ 阈值为不透明，否则完全透明；半透明输入仅按阈值二值化。")
        hint.setWordWrap(True)
        hint.setStyleSheet("color:#8a909a; font-size:11px;")
        hint.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Preferred)
        hint.setMinimumWidth(0)
        dl.addWidget(hint, 2, 0, 1, 3)

        # Binary-alpha statistics get a full-width row of their own so the
        # numbers are legible at the base font size with 32 colours listed
        # below; the mask-preview toggle sits on the next line.
        self.alpha_stats = FittedLabel("—", base_size=10, min_size=7)
        self.alpha_stats.setStyleSheet("color:#b8bec8;")
        self.alpha_stats.setMinimumWidth(0)
        self.alpha_stats.setToolTip("半透明像素数 → 当前阈值下的不透明 / 透明像素数")
        dl.addWidget(self.alpha_stats, 3, 0, 1, 3)

        self.alpha_preview_btn = QPushButton("预览二值透明遮罩")
        self.alpha_preview_btn.setCheckable(True)
        self.alpha_preview_btn.setToolTip("在原图窗格叠加显示二值透明遮罩（红色 = 透明）")
        self.alpha_preview_btn.toggled.connect(self._on_mask_preview)
        row3 = QHBoxLayout()
        row3.addStretch(1)
        row3.addWidget(self.alpha_preview_btn)
        dl.addLayout(row3, 4, 0, 1, 3)
        lay.addWidget(dith)

        # --- palette ----------------------------------------------------
        self.palette_panel = PalettePanel()
        self.palette_panel.colorEditRequested.connect(self.edit_color)
        self.palette_panel.lockToggled.connect(self.toggle_lock)
        self.palette_panel.deleteRequested.connect(self.delete_color)
        self.palette_panel.addRequested.connect(self.add_color)
        self.palette_panel.setMinimumHeight(300)
        lay.addWidget(self.palette_panel, 1)

        # --- inspector ---------------------------------------------------
        insp = QGroupBox("像素检查")
        il = QVBoxLayout(insp)
        self.inspector_title = QLabel("点击任意预览中的像素查看")
        self.inspector_title.setStyleSheet("color:#9aa0aa; font-size:11px;")
        il.addWidget(self.inspector_title)
        self.inspector_table = QTableWidget(0, 4)
        self.inspector_table.setHorizontalHeaderLabels(["模式", "原色", "输出色 / 索引", "透明"])
        self.inspector_table.verticalHeader().setVisible(False)
        self.inspector_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.inspector_table.setSelectionMode(QTableWidget.NoSelection)
        self.inspector_table.horizontalHeader().setStretchLastSection(False)
        # Mode and alpha columns are short and fixed; give the rest of the
        # width to the colour / index column so hex values are never clipped.
        header = self.inspector_table.horizontalHeader()
        header.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        header.setSectionResizeMode(1, QHeaderView.Fixed)
        header.setSectionResizeMode(2, QHeaderView.Stretch)
        header.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        self.inspector_table.setColumnWidth(1, 82)
        self.inspector_table.setWordWrap(False)
        self.inspector_table.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self.inspector_table.setMinimumHeight(120)
        self.inspector_table.setMaximumHeight(132)
        il.addWidget(self.inspector_table)
        lay.addWidget(insp)

        log_box = QGroupBox("状态 / 记录")
        ll = QVBoxLayout(log_box)
        self.log_view = QPlainTextEdit()
        self.log_view.setReadOnly(True)
        self.log_view.setMaximumBlockCount(500)
        self.log_view.setMinimumHeight(70)
        ll.addWidget(self.log_view)
        lay.addWidget(log_box)
        return scroll

    def _build_menu(self) -> None:
        file_menu = self.menuBar().addMenu("文件")
        open_act = QAction("打开 PNG…", self)
        open_act.setShortcut(QKeySequence.Open)
        open_act.triggered.connect(self.open_file)
        file_menu.addAction(open_act)
        export_act = QAction("导出索引 PNG…", self)
        export_act.setShortcut(QKeySequence.Save)
        export_act.triggered.connect(self.export_png)
        file_menu.addAction(export_act)
        file_menu.addSeparator()
        quit_act = QAction("退出", self)
        quit_act.setShortcut(QKeySequence.Quit)
        quit_act.triggered.connect(self.close)
        file_menu.addAction(quit_act)

        edit_menu = self.menuBar().addMenu("编辑")
        undo_act = QAction("撤销调色板编辑", self)
        undo_act.setShortcut(QKeySequence.Undo)
        undo_act.triggered.connect(self.undo_palette)
        edit_menu.addAction(undo_act)

        view_menu = self.menuBar().addMenu("视图")
        grid_act = QAction("显示像素网格", self, checkable=True, checked=True)
        grid_act.toggled.connect(self._on_grid_toggled)
        view_menu.addAction(grid_act)
        self.grid_act = grid_act
        fit_act = QAction("适应窗口", self)
        fit_act.setShortcut(QKeySequence("Ctrl+0"))
        fit_act.triggered.connect(self.fit_views)
        view_menu.addAction(fit_act)

        help_menu = self.menuBar().addMenu("帮助")
        about_act = QAction("关于 / 操作说明", self)
        about_act.triggered.connect(self.show_help)
        help_menu.addAction(about_act)

    # ------------------------------------------------------------------
    # Loading
    # ------------------------------------------------------------------
    def open_file(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开 PNG", "", "PNG 图片 (*.png)")
        if not path:
            return
        try:
            rgba = load_image(path)
        except ImageLoadError as exc:
            QMessageBox.warning(self, "无法载入", str(exc))
            return
        self.load_rgba(rgba, Path(path).name)

    def _on_demo_selected(self, index: int) -> None:
        key = self.demo_combo.itemData(index)
        self.demo_combo.setCurrentIndex(0)
        if not key:
            return
        label = DEMOS[key][0]
        self.load_rgba(demo_rgba(key), f"演示：{label}")

    def load_rgba(self, rgba: np.ndarray, name: str) -> None:
        self.session.load(rgba, name)
        h, w = rgba.shape[:2]
        self.view.set_image_size(w, h)
        self.source_meta.setText(f"{name} · {w}×{h}px")
        for key, view in self.views.items():
            view.set_image(None)
        self.view.clear_selection()
        self._set_enabled(True)
        self.fit_views()
        self._update_alpha_stats()
        # A fresh document starts with a generated palette at the current
        # requested count; that is the expected starting point.
        self.generate_palette(first_load=True)
        self.log(f"已载入 {name}（{w}×{h}，保留原始像素尺寸）")
        self._refresh_undo_button()

    def _set_enabled(self, enabled: bool) -> None:
        for w in (
            self.gen_btn,
            self.manual_btn,
            self.count_spin,
            self.count_slider,
            self.strength_slider,
            self.alpha_slider,
            self.palette_panel,
            self.alpha_preview_btn,
            self.mode_combo,
        ):
            w.setEnabled(enabled)
        if not enabled:
            self.undo_btn.setEnabled(False)

    # ------------------------------------------------------------------
    # Palette actions
    # ------------------------------------------------------------------
    def generate_palette(self, first_load: bool = False) -> None:
        if not self.session.loaded:
            return
        target = self.count_spin.value()
        try:
            # The initial palette on load is not an edit; it must not consume
            # an undo slot.  User-triggered regenerations are undoable.
            summary = self.session.generate(target, record_undo=not first_load)
        except (RuntimeError, ValueError) as exc:
            QMessageBox.warning(self, "生成失败", str(exc))
            return
        self.gen_note.setText(summary)
        if not first_load:
            self.log("自动生成：" + summary)
        self._recompute_after_edit()

    def manual_palette(self) -> None:
        if not self.session.loaded:
            return
        locked_existing = [c for c, l in zip(self.session.palette.colors, self.session.palette.locked) if l]
        editable = [c for c, l in zip(self.session.palette.colors, self.session.palette.locked) if not l]
        if not editable:
            # Prefill only enough neutral entries to reach the minimum total,
            # since locked colours already count toward it.
            needed = max(0, MIN_COLORS - len(locked_existing))
            editable = [(128, 128, 128)] * needed
        dlg = HexPaletteDialog(editable, len(locked_existing),
                               MAX_COLORS - len(locked_existing), locked_colors=locked_existing,
                               parent=self)
        if dlg.exec() != QDialog.Accepted:
            return
        try:
            colors = dlg.parsed()
        except ValueError as exc:
            QMessageBox.warning(self, "调色板无效", str(exc))
            return
        from ..palette import Palette

        all_colors = locked_existing + list(colors)
        locks = [True] * len(locked_existing) + [False] * len(colors)
        pal = Palette(all_colors, locks)
        self.session.set_palette(pal, "手工指定调色板")
        merged = len(all_colors) - len(pal)
        note = f"手工指定：输入 {len(colors)} 色，锁定保留 {len(locked_existing)} 色，实际可见 {len(pal)} 色"
        if merged:
            note += f"（合并重复 {merged} 个）"
        self.gen_note.setText(note)
        self.log(note)
        self._recompute_after_edit()

    def edit_color(self, index: int) -> None:
        if not self.session.loaded or not (0 <= index < len(self.session.palette)):
            return
        current = self.session.palette.colors[index]
        if self.session.palette.locked[index]:
            ans = QMessageBox.question(
                self, "颜色已锁定",
                f"#{index} {_hex(current)} 处于锁定状态，仍要修改吗？\n（锁定只约束自动生成，手动改色可以覆盖）",
            )
            if ans != QMessageBox.Yes:
                return
        initial = QColor(*current)
        color = QColorDialog.getColor(initial, self, f"修改颜色 #{index}", QColorDialog.DontUseNativeDialog)
        if not color.isValid():
            return
        rgb = (color.red(), color.green(), color.blue())
        if rgb == current:
            return
        changed, merged = self.session.set_color(index, rgb, force=True)
        if changed:
            note = f"#{index} 改为 {_hex(rgb)}"
            if merged:
                note += f"；与已有颜色重复，已合并 {merged} 个，实际可见 {len(self.session.palette)} 色"
            self.log(note)
            self.gen_note.setText(note)
            self._recompute_after_edit()

    def toggle_lock(self, index: int, locked: bool) -> None:
        if not (0 <= index < len(self.session.palette)):
            return
        self.session.set_locked(index, locked)
        self.log(f"#{index} {'锁定' if locked else '解锁'}")
        # Locking does not change colours, so there is no need to re-quantise;
        # the palette list and undo depth are enough to refresh.
        self._refresh_palette()
        self._refresh_undo_button()

    def delete_color(self, index: int) -> None:
        if not self.session.loaded:
            return
        if not self.session.can_delete(index):
            QMessageBox.information(self, "无法删除", "锁定颜色不可删除。请先解锁。")
            return
        color = self.session.palette.colors[index]
        if len(self.session.palette) <= 1:
            ans = QMessageBox.question(
                self, "删除最后一个可见颜色",
                "删除后调色板为空，可见像素将无法上色。继续吗？",
            )
            if ans != QMessageBox.Yes:
                return
        if self.session.delete_color(index):
            self.log(f"删除 #{index} {_hex(color)}，剩余 {len(self.session.palette)} 色")
            self._recompute_after_edit()

    def add_color(self) -> None:
        if not self.session.loaded:
            return
        if len(self.session.palette) >= MAX_COLORS:
            QMessageBox.information(self, "调色板已满", f"最多 {MAX_COLORS} 个可见颜色，请先删除颜色。")
            return
        color = QColorDialog.getColor(QColor(200, 120, 60), self, "添加颜色", QColorDialog.DontUseNativeDialog)
        if not color.isValid():
            return
        rgb = (color.red(), color.green(), color.blue())
        idx, added = self.session.add_color(rgb)
        if added:
            self.log(f"新增 #{idx} {_hex(rgb)}，当前 {len(self.session.palette)} 色")
            self._recompute_after_edit()
        else:
            QMessageBox.information(self, "颜色已存在", f"{_hex(rgb)} 已在调色板中（#{idx}），不重复添加。")

    def undo_palette(self) -> None:
        label = self.session.undo()
        if label is None:
            self.log("没有可撤销的调色板编辑")
            return
        self.log(f"撤销：{label}")
        self._recompute_after_edit()

    def _refresh_undo_button(self) -> None:
        depth = self.session.undo_depth
        self.undo_btn.setEnabled(depth > 0)
        self.undo_btn.setText(f"撤销 ({depth})" if depth else "撤销")

    # ------------------------------------------------------------------
    # Settings
    # ------------------------------------------------------------------
    def _on_strength_changed(self, value: int) -> None:
        self.strength_label.setText(f"{value}%")
        if self.session.loaded:
            self.session.set_settings(strength=value / 100.0)
            self._schedule_recompute()

    def _on_alpha_changed(self, value: int) -> None:
        self.alpha_label.setText(str(value))
        if self.session.loaded:
            self.session.set_settings(alpha_threshold=int(value))
            self._update_alpha_stats()
            self._schedule_recompute()

    def _on_export_mode_changed(self, _index: int) -> None:
        self.export_mode = self.mode_combo.currentData()
        if self.export_mode in self._results:
            self.session.last_result = self._results[self.export_mode]
        self._refresh_palette()
        self._update_inspector()
        self.log(f"导出与统计使用模式：{MODE_LABELS[self.export_mode]}")

    def _on_grid_toggled(self, enabled: bool) -> None:
        self.show_grid = bool(enabled)
        self.grid_btn.setChecked(enabled)
        self.grid_btn.setText("像素网格 ✓" if enabled else "像素网格")
        if hasattr(self, "grid_act") and self.grid_act.isChecked() != enabled:
            self.grid_act.setChecked(enabled)
        for view in self.views.values():
            view.set_grid(enabled)

    def _on_mask_preview(self, enabled: bool) -> None:
        if not self.session.loaded:
            return
        self._update_source_preview(show_mask=enabled)

    def _update_alpha_stats(self) -> None:
        if not self.session.loaded:
            self.alpha_stats.setText("—")
            return
        alpha = self.session.alpha_array()
        semi = int(np.count_nonzero((alpha > 0) & (alpha < 255)))
        opaque = int(np.count_nonzero(alpha >= self.session.settings.alpha_threshold))
        transparent = int(alpha.size - opaque)
        self.alpha_stats.setText(f"半透明 {semi}px → 不透明 {opaque} / 透明 {transparent}")

    def fit_views(self) -> None:
        if self.session.loaded:
            self.view.fit(self.views["source"].size())
            self._sync_zoom_combo()

    def _sync_zoom_combo(self) -> None:
        idx = self.zoom_combo.findData(self.view.zoom)
        if idx >= 0 and idx != self.zoom_combo.currentIndex():
            self.zoom_combo.blockSignals(True)
            self.zoom_combo.setCurrentIndex(idx)
            self.zoom_combo.blockSignals(False)

    # ------------------------------------------------------------------
    # Computation and refresh
    # ------------------------------------------------------------------
    def _schedule_recompute(self) -> None:
        self._recompute_timer.start()

    def _recompute_after_edit(self) -> None:
        self.session.dirty = True
        self.recompute()

    def recompute(self) -> None:
        if not self.session.loaded:
            return
        app = QApplication.instance()
        app.setOverrideCursor(Qt.WaitCursor)
        try:
            self._update_source_preview(show_mask=self.alpha_preview_btn.isChecked())
            results: dict[str, Quantized] = {}
            # All three panes use the current palette and see the same
            # threshold/strength.  Only the dither mode differs, and the
            # session's own settings are left untouched so the comparison
            # never changes the document state.
            for mode in ALL_MODES:
                results[mode] = self.session.result_for(mode)
            self._results = results
            for mode, result in results.items():
                view = self.views[mode]
                view.set_image(rgba_to_qimage(render_rgba(result)))
                meta = getattr(self, f"meta_{mode}")
                used = result.used_visible_colors
                meta.setText(
                    f"使用 {used}/{result.visible_color_count} 色 · 透明 {result.transparent_count} px · 索引上限 #{result.transparent_index}"
                )
            self.session.last_result = results[self.export_mode]
        finally:
            app.restoreOverrideCursor()
        self._refresh_palette()
        self._update_inspector()
        self._refresh_undo_button()

    def _update_source_preview(self, show_mask: bool = False) -> None:
        if not self.session.loaded:
            return
        rgba = self.session.rgba.copy()
        if show_mask:
            mask = ~self.session.opaque_mask()
            # Tint transparent pixels red and make them fully opaque so the
            # binary mask is readable in the original-image pane.
            rgba[mask, :3] = (255, 40, 60)
            rgba[mask, 3] = 255
        self.views["source"].set_image(rgba_to_qimage(rgba))

    def _refresh_palette(self) -> None:
        result = self.session.last_result
        counts = result.counts if result is not None else []
        notes = []
        if self.session.generation_notes:
            notes.append(self.session.generation_notes)
        if self.session.palette.visible_count() < MIN_COLORS and self.session.loaded:
            notes.append(f"注意：当前可见颜色少于 {MIN_COLORS}（源图颜色较少或已删除），不影响导出。")
        self.palette_panel.refresh(
            self.session.palette,
            counts,
            result.transparent_count if result is not None else 0,
            "\n".join(notes),
        )
        self.palette_panel.header.setText(
            f"调色板（点击色块改色）· 撤销栈 {self.session.undo_depth}"
        )

    def _update_inspector(self) -> None:
        sel = self.view.selected
        result = self.session.last_result
        if not self.session.loaded or sel is None or result is None:
            self.inspector_title.setText("点击任意预览中的像素查看")
            self.inspector_table.setRowCount(0)
            return
        x, y = sel.x(), sel.y()
        src = self.session.rgba[y, x]
        visible = bool(result.visible_mask[y, x])
        if visible and result.palette_colors.shape[0] == 0:
            state = "调色板为空：无可见颜色可上色"
        elif visible:
            state = "不透明的可见像素"
        else:
            state = "完全透明"
        rr, gg, bb = (int(v) for v in src[:3])
        self.inspector_title.setText(
            f"像素 ({x}, {y}) · 原色 {_hex((rr, gg, bb))} · alpha {int(src[3])} · " + state
        )
        visible_colors = result.palette_colors.tolist()
        rows = []
        for mode in ALL_MODES:
            res = self._results.get(mode, result)
            if not res.transparent_mask[y, x] and visible_colors:
                idx = int(res.indices[y, x])
                color = visible_colors[idx]
                rows.append((MODE_LABELS[mode], _hex((rr, gg, bb)), f"{_hex(color)}  #{idx}", "否"))
            else:
                rows.append((MODE_LABELS[mode], "—", "透明索引 #%d" % res.transparent_index, "是"))
        self.inspector_table.setRowCount(len(rows))
        for r, (mode, orig, out, trans) in enumerate(rows):
            for c, text in enumerate((mode, orig, out, trans)):
                item = QTableWidgetItem(text)
                item.setFlags(Qt.ItemIsEnabled)
                self.inspector_table.setItem(r, c, item)
            if "  #" in out:
                idx_text = out.rsplit("#", 1)[1]
                try:
                    idx = int(idx_text)
                    if 0 <= idx < len(visible_colors):
                        swatch = QTableWidgetItem("")
                        swatch.setBackground(QColor(*visible_colors[idx]))
                        self.inspector_table.setItem(r, 2, swatch)
                        swatch.setText(out)
                except ValueError:
                    pass

    # ------------------------------------------------------------------
    # Export
    # ------------------------------------------------------------------
    def export_png(self) -> None:
        if not self.session.loaded:
            return
        default_name = (Path(self.session.source_name).stem or "pixel") + f"_{self.export_mode}.png"
        path, _ = QFileDialog.getSaveFileName(self, "导出索引 PNG", default_name, "PNG 图片 (*.png)")
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"
        # The exported file must be exactly what the selected comparison
        # pane shows, so export that pane's already-computed result.
        result = self._results.get(self.export_mode) or self.session.compute()
        settings = Settings(
            mode=self.export_mode,
            strength=self.session.settings.strength,
            alpha_threshold=self.session.settings.alpha_threshold,
        )
        try:
            export_indexed_png(
                path,
                result,
                settings,
                notes=self.session.generation_notes,
                version=APP_VERSION,
            )
            readback = read_indexed_png(path)
        except (ExportError, OSError) as exc:
            QMessageBox.critical(self, "导出失败", str(exc))
            self.log("导出失败：" + str(exc))
            return
        ok, message = readback_matches(result, readback)
        self.log(("导出成功并校验通过：" if ok else "导出后校验异常：") + message)
        self.log(f"文件：{path}（附参数 {Path(path).with_suffix('.json').name}）")
        self._refresh_palette()
        self._update_inspector()
        if ok:
            QMessageBox.information(
                self, "导出完成",
                f"已写入真正的索引 PNG（color type 3）。\n{message}\n\n"
                f"参数记录：{Path(path).with_suffix('.json').name}",
            )
        else:
            QMessageBox.warning(self, "导出校验失败", message)

    # ------------------------------------------------------------------
    def log(self, text: str) -> None:
        self.log_view.appendPlainText(text)
        sb = self.log_view.verticalScrollBar()
        sb.setValue(sb.maximum())

    def show_help(self) -> None:
        QMessageBox.information(
            self, "操作说明",
            "1. 用「打开 PNG…」载入 ≤256×256 的 PNG，或从下拉框生成演示素材。\n"
            "2. 「自动生成（保留锁定色）」按目标色数生成 4..32 色；锁定的颜色不会被改动。\n"
            "3. 点击调色板色块改色，🔒 锁定，✕ 删除未锁定颜色。\n"
            "4. 中间四个窗格对照：原图 / 不抖动 / 有序抖动 / 误差扩散，共享缩放与平移。\n"
            "   滚轮缩放、拖拽平移、双击适应窗口；网格与抖动样式固定在图像坐标。\n"
            "5. 拖动「抖动强度」与「透明阈值」，所有窗格与统计即时更新。\n"
            "6. 点击像素可在右侧查看原色、各模式输出色与索引。\n"
            "7. 「导出索引 PNG…」写出 8 位索引 PNG（PLTE + tRNS）和同名 .json 参数记录，\n"
            "   并在导出后自动回读校验。",
        )

    def closeEvent(self, event):  # noqa: N802
        self._recompute_timer.stop()
        super().closeEvent(event)
