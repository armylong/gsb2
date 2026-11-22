"""Main window: source loading, cache generation, levels, export."""

from __future__ import annotations

import math
import os
from pathlib import Path

from PySide6.QtCore import QSettings, QSize, Qt, QThread, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QDesktopServices, QFont, QKeySequence
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressBar,
    QPushButton,
    QScrollArea,
    QSizePolicy,
    QSlider,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QVBoxLayout,
    QWidget,
)

from .cache import (
    CacheConfig,
    CacheManager,
    LevelState,
    LevelStatus,
)
from .exporter import export_region, save_export
from .geometry import Rect, map_original_to_level
from .sample import build_sample
from .source import ImageSource, SourceError, load_source, platform_cache_root
from .viewer import MAX_ZOOM, MIN_ZOOM, ViewerWidget
from .workers import GenerationWorker, VerificationWorker

__all__ = ["MainWindow", "APP_NAME"]

APP_NAME = "tileviewer"

_STATE_COLORS = {
    LevelState.COMPLETE: QColor(120, 220, 150),
    LevelState.PARTIAL: QColor(240, 190, 90),
    LevelState.MISSING: QColor(170, 172, 180),
    LevelState.STALE: QColor(240, 120, 120),
}

_STATE_LABELS = {
    LevelState.COMPLETE: "完整",
    LevelState.PARTIAL: "未完成",
    LevelState.MISSING: "未生成",
    LevelState.STALE: "已过期",
}


class MainWindow(QMainWindow):
    def __init__(
        self,
        cache_root: Path | None = None,
        settings: QSettings | None = None,
        restore_last: bool = True,
        auto_generate: bool = True,
    ) -> None:
        super().__init__()
        self.setWindowTitle("影像分块预览器")
        self.resize(1440, 900)
        self.setMinimumSize(1024, 680)

        self.settings = settings or QSettings(APP_NAME, APP_NAME)
        self._restore_last = restore_last
        self._auto_generate = auto_generate
        self.cache_root = Path(cache_root or platform_cache_root()).expanduser()
        self.source: ImageSource | None = None
        self.manager: CacheManager | None = None
        self._thread: QThread | None = None
        self._worker: GenerationWorker | VerificationWorker | None = None
        self._busy_kind: str | None = None
        self._pending_refresh = False

        self._build_actions()
        self._build_ui()
        self._restore_settings()
        self._update_source_panel()
        self._update_level_table()
        self._update_selection_panel()
        self._update_probe_label()

    # ------------------------------------------------------------------
    # actions / menus
    # ------------------------------------------------------------------
    def _build_actions(self) -> None:
        self.action_open = QAction("打开图像…", self)
        self.action_open.setShortcut(QKeySequence.StandardKey.Open)
        self.action_open.triggered.connect(self.open_image_dialog)

        self.action_open_sample = QAction("生成并打开示例图像", self)
        self.action_open_sample.triggered.connect(self.open_sample)

        self.action_reload = QAction("重新读取当前文件", self)
        self.action_reload.setShortcut("Ctrl+R")
        self.action_reload.triggered.connect(self.reload_current)

        self.action_export = QAction("导出选区…", self)
        self.action_export.setShortcut("Ctrl+E")
        self.action_export.triggered.connect(self.export_selection_dialog)

        self.action_quit = QAction("退出", self)
        self.action_quit.setShortcut(QKeySequence.StandardKey.Quit)
        self.action_quit.triggered.connect(self.close)

        self.action_fit = QAction("适应窗口", self)
        self.action_fit.setShortcut("F")
        self.action_fit.triggered.connect(self._fit_view)
        self.action_actual = QAction("原始像素 1:1", self)
        self.action_actual.setShortcut("1")
        self.action_actual.triggered.connect(self._zoom_actual)
        self.action_zoom_in = QAction("放大", self)
        self.action_zoom_in.setShortcut(QKeySequence.StandardKey.ZoomIn)
        self.action_zoom_in.triggered.connect(
            lambda: self.viewer.zoom_by(1.25)
        )
        self.action_zoom_out = QAction("缩小", self)
        self.action_zoom_out.setShortcut(QKeySequence.StandardKey.ZoomOut)
        self.action_zoom_out.triggered.connect(
            lambda: self.viewer.zoom_by(0.8)
        )

        self.action_generate = QAction("生成缺失层级", self)
        self.action_generate.setShortcut("G")
        self.action_generate.triggered.connect(self.generate_missing)
        self.action_rebuild_level = QAction("重新生成当前层", self)
        self.action_rebuild_level.triggered.connect(self.regenerate_current)
        self.action_rebuild_all = QAction("强制重建全部层级", self)
        self.action_rebuild_all.triggered.connect(self.rebuild_all)
        self.action_cancel = QAction("取消生成", self)
        # Esc belongs to the viewer (clear selection); use Ctrl+. to cancel.
        self.action_cancel.setShortcut("Ctrl+.")
        self.action_cancel.setEnabled(False)
        self.action_cancel.triggered.connect(self.cancel_generation)
        self.action_verify = QAction("校验当前层拼接", self)
        self.action_verify.triggered.connect(self.verify_current_level)
        self.action_verify_all = QAction("校验全部完整层级", self)
        self.action_verify_all.triggered.connect(self.verify_all_levels)
        self.action_open_cache = QAction("打开缓存目录", self)
        self.action_open_cache.triggered.connect(self._open_cache_dir)
        self.action_clear_cache = QAction("清空当前图像的缓存", self)
        self.action_clear_cache.triggered.connect(self.clear_current_cache)

        self.action_about = QAction("关于 / 快捷键", self)
        self.action_about.triggered.connect(self.show_about)

        file_menu = self.menuBar().addMenu("文件")
        file_menu.addAction(self.action_open)
        file_menu.addAction(self.action_open_sample)
        file_menu.addAction(self.action_reload)
        file_menu.addSeparator()
        file_menu.addAction(self.action_export)
        file_menu.addSeparator()
        file_menu.addAction(self.action_quit)

        view_menu = self.menuBar().addMenu("视图")
        view_menu.addAction(self.action_fit)
        view_menu.addAction(self.action_actual)
        view_menu.addAction(self.action_zoom_in)
        view_menu.addAction(self.action_zoom_out)
        view_menu.addSeparator()
        self.view_menu = view_menu

        preview_menu = self.menuBar().addMenu("预览块")
        preview_menu.addAction(self.action_generate)
        preview_menu.addAction(self.action_rebuild_level)
        preview_menu.addAction(self.action_rebuild_all)
        preview_menu.addSeparator()
        preview_menu.addAction(self.action_cancel)
        preview_menu.addSeparator()
        preview_menu.addAction(self.action_verify)
        preview_menu.addAction(self.action_verify_all)
        preview_menu.addSeparator()
        preview_menu.addAction(self.action_open_cache)
        preview_menu.addAction(self.action_clear_cache)

        help_menu = self.menuBar().addMenu("帮助")
        help_menu.addAction(self.action_about)

        toolbar = self.addToolBar("主工具栏")
        toolbar.setMovable(False)
        toolbar.setIconSize(QSize(18, 18))
        toolbar.addAction(self.action_open)
        toolbar.addAction(self.action_open_sample)
        toolbar.addSeparator()
        toolbar.addAction(self.action_fit)
        toolbar.addAction(self.action_actual)
        toolbar.addSeparator()
        toolbar.addAction(self.action_generate)
        toolbar.addAction(self.action_cancel)
        toolbar.addSeparator()
        toolbar.addAction(self.action_export)

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------
    def _build_ui(self) -> None:
        self.viewer = ViewerWidget()
        self.viewer.cursorMoved.connect(self._on_cursor_moved)
        self.viewer.viewChanged.connect(self._on_view_changed)
        self.viewer.selectionChanged.connect(self._on_selection_changed)
        self.viewer.hoveredTileChanged.connect(self._on_hovered_tile)

        self.splitter = QSplitter(Qt.Orientation.Horizontal)
        self.splitter.addWidget(self._build_side_panel())
        self.splitter.addWidget(self.viewer)
        self.splitter.setStretchFactor(0, 0)
        self.splitter.setStretchFactor(1, 1)
        self.splitter.setSizes([390, 1050])
        self.setCentralWidget(self.splitter)

        self.progress = QProgressBar()
        self.progress.setMaximumWidth(260)
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.statusBar().addPermanentWidget(self.progress)
        self.status_label = QLabel("打开一张本地单帧 RGB 图像开始")
        self.statusBar().addWidget(self.status_label, 1)
        self.coord_label = QLabel("")
        self.coord_label.setFont(QFont("Menlo", 11))
        self.statusBar().addPermanentWidget(self.coord_label)

    def _build_side_panel(self) -> QWidget:
        panel = QWidget()
        layout = QVBoxLayout(panel)
        layout.setContentsMargins(10, 10, 10, 10)
        layout.setSpacing(8)

        # ---- source -----------------------------------------------------
        source_box = QGroupBox("图像")
        source_layout = QVBoxLayout(source_box)
        self.source_path_label = QLineEdit()
        self.source_path_label.setReadOnly(True)
        self.source_path_label.setPlaceholderText("未打开")
        self.source_path_label.setToolTip("当前文件的完整路径")
        self.source_path_label.setFrame(False)
        self.source_path_label.setCursorPosition(0)
        self.source_info_label = QLabel("")
        self.source_info_label.setWordWrap(True)
        self.source_info_label.setFont(QFont("Menlo", 10))
        self.source_info_label.setSizePolicy(
            QSizePolicy.Policy.Ignored, QSizePolicy.Policy.Preferred
        )
        self.source_info_label.setMinimumWidth(1)
        source_layout.addWidget(self.source_path_label)
        source_layout.addWidget(self.source_info_label)
        layout.addWidget(source_box)

        # ---- preview configuration -------------------------------------
        config_box = QGroupBox("预览层级与分块")
        config_form = QFormLayout(config_box)
        config_form.setLabelAlignment(Qt.AlignmentFlag.AlignRight)

        self.tile_size_combo = QComboBox()
        for size in (256, 512, 1024):
            self.tile_size_combo.addItem(f"{size} px", size)
        self.tile_size_combo.setCurrentIndex(
            self.tile_size_combo.findData(512)
        )
        self.margin_spin = QSpinBox()
        self.margin_spin.setRange(0, 1023)
        self.margin_spin.setSuffix(" px")
        self.margin_spin.setValue(16)
        self.margin_spin.setToolTip(
            "每块额外保留的邻边宽度（读取时裁掉，不参与拼接）"
        )
        self.resample_combo = QComboBox()
        for name in ("lanczos", "bicubic", "bilinear", "nearest"):
            self.resample_combo.addItem(name, name)
        self.min_level_spin = QSpinBox()
        self.min_level_spin.setRange(16, 100000)
        self.min_level_spin.setSuffix(" px")
        self.min_level_spin.setValue(256)
        self.max_levels_spin = QSpinBox()
        self.max_levels_spin.setRange(1, 24)
        self.max_levels_spin.setValue(10)

        config_form.addRow("块边长", self.tile_size_combo)
        config_form.addRow("保留邻边", self.margin_spin)
        config_form.addRow("重采样", self.resample_combo)
        config_form.addRow("最粗层不低于", self.min_level_spin)
        config_form.addRow("最多层数", self.max_levels_spin)

        apply_row = QHBoxLayout()
        self.apply_config_button = QPushButton("应用分块设置")
        self.apply_config_button.clicked.connect(self.apply_config)
        apply_row.addWidget(self.apply_config_button)
        config_form.addRow("", self._wrap(apply_row))
        layout.addWidget(config_box)

        # ---- levels -----------------------------------------------------
        levels_box = QGroupBox("层级状态")
        levels_layout = QVBoxLayout(levels_box)
        self.level_table = QTableWidget(0, 5)
        self.level_table.setHorizontalHeaderLabels(
            ["层", "尺寸", "分块", "状态", "说明"]
        )
        self.level_table.verticalHeader().setVisible(False)
        self.level_table.setSelectionBehavior(
            QTableWidget.SelectionBehavior.SelectRows
        )
        self.level_table.setSelectionMode(
            QTableWidget.SelectionMode.SingleSelection
        )
        self.level_table.setEditTriggers(
            QTableWidget.EditTrigger.NoEditTriggers
        )
        self.level_table.horizontalHeader().setSectionResizeMode(
            4, QHeaderView.ResizeMode.Stretch
        )
        for column in range(4):
            self.level_table.horizontalHeader().setSectionResizeMode(
                column, QHeaderView.ResizeMode.ResizeToContents
            )
        self.level_table.setMinimumHeight(190)
        self.level_table.itemSelectionChanged.connect(
            self._on_level_table_selected
        )
        self.level_table.doubleClicked.connect(self._on_level_table_double_clicked)
        levels_layout.addWidget(self.level_table)

        gen_row = QGridLayout()
        self.general_button = QPushButton("生成缺失层级")
        self.general_button.clicked.connect(self.generate_missing)
        self.regen_level_button = QPushButton("重建选中层")
        self.regen_level_button.clicked.connect(self.regenerate_selected_level)
        self.cancel_button = QPushButton("取消")
        self.cancel_button.setEnabled(False)
        self.cancel_button.clicked.connect(self.cancel_generation)
        self.verify_button = QPushButton("校验选中层")
        self.verify_button.clicked.connect(self.verify_selected_level)
        self.rebuild_all_button = QPushButton("全部重建…")
        self.rebuild_all_button.clicked.connect(self.rebuild_all)
        self.clear_cache_button = QPushButton("清空缓存")
        self.clear_cache_button.clicked.connect(self.clear_current_cache)
        gen_row.addWidget(self.general_button, 0, 0, 1, 2)
        gen_row.addWidget(self.regen_level_button, 1, 0)
        gen_row.addWidget(self.verify_button, 1, 1)
        gen_row.addWidget(self.cancel_button, 2, 0)
        gen_row.addWidget(self.rebuild_all_button, 2, 1)
        gen_row.addWidget(self.clear_cache_button, 3, 0, 1, 2)
        levels_layout.addLayout(gen_row)
        layout.addWidget(levels_box)

        # ---- view controls ---------------------------------------------
        view_box = QGroupBox("视图")
        view_layout = QVBoxLayout(view_box)
        zoom_row = QHBoxLayout()
        self.zoom_slider = QSlider(Qt.Orientation.Horizontal)
        self.zoom_slider.setRange(0, 1000)
        self.zoom_slider.valueChanged.connect(self._on_zoom_slider)
        self.zoom_spin = QDoubleSpinBox()
        self.zoom_spin.setRange(MIN_ZOOM * 100.0, MAX_ZOOM * 100.0)
        self.zoom_spin.setDecimals(3)
        self.zoom_spin.setSuffix(" %")
        self.zoom_spin.setKeyboardTracking(False)
        self.zoom_spin.valueChanged.connect(self._on_zoom_spin)
        zoom_row.addWidget(self.zoom_slider, 1)
        zoom_row.addWidget(self.zoom_spin)
        view_layout.addLayout(zoom_row)

        fit_row = QHBoxLayout()
        self.fit_button = QPushButton("适应窗口")
        self.fit_button.clicked.connect(self._fit_view)
        self.actual_button = QPushButton("1:1")
        self.actual_button.clicked.connect(self._zoom_actual)
        self.double_button = QPushButton("2×")
        self.double_button.clicked.connect(lambda: self.viewer.zoom_to(2.0))
        self.eight_button = QPushButton("8×")
        self.eight_button.clicked.connect(lambda: self.viewer.zoom_to(8.0))
        fit_row.addWidget(self.fit_button)
        fit_row.addWidget(self.actual_button)
        fit_row.addWidget(self.double_button)
        fit_row.addWidget(self.eight_button)
        view_layout.addLayout(fit_row)

        level_row = QHBoxLayout()
        self.auto_level_check = QCheckBox("自动选层")
        self.auto_level_check.setChecked(True)
        self.auto_level_check.toggled.connect(self._on_auto_level_toggled)
        self.level_spin = QSpinBox()
        self.level_spin.setRange(0, 0)
        self.level_spin.setPrefix("L")
        self.level_spin.valueChanged.connect(self._on_level_spin)
        level_row.addWidget(self.auto_level_check)
        level_row.addStretch(1)
        level_row.addWidget(QLabel("当前层"))
        level_row.addWidget(self.level_spin)
        view_layout.addLayout(level_row)

        self.grid_check = QCheckBox("显示网格线（块边界 + 原图像素刻度）")
        self.grid_check.toggled.connect(self._on_grid_toggled)
        self.margin_check = QCheckBox("显示邻边（粉色 = 重叠采样区）")
        self.margin_check.toggled.connect(self._on_margin_toggled)
        view_layout.addWidget(self.grid_check)
        view_layout.addWidget(self.margin_check)

        jump_row = QHBoxLayout()
        self.jump_x = QSpinBox()
        self.jump_x.setRange(0, 0)
        self.jump_y = QSpinBox()
        self.jump_y.setRange(0, 0)
        self.jump_button = QPushButton("跳转")
        self.jump_button.clicked.connect(self._jump_to_coordinate)
        jump_row.addWidget(QLabel("原图 x"))
        jump_row.addWidget(self.jump_x)
        jump_row.addWidget(QLabel("y"))
        jump_row.addWidget(self.jump_y)
        jump_row.addWidget(self.jump_button)
        view_layout.addLayout(jump_row)

        probe_row = QHBoxLayout()
        self.probe_button = QPushButton("锁定参照点")
        self.probe_button.setToolTip(
            "在当前光标位置放置一个原图坐标参照点；切换层级时它必须停在"
            "原图的同一处特征上"
        )
        self.probe_button.clicked.connect(self._set_probe_at_cursor)
        self.probe_clear_button = QPushButton("清除参照点")
        self.probe_clear_button.clicked.connect(self._clear_probe)
        self.probe_label = QLabel("-")
        self.probe_label.setFont(QFont("Menlo", 10))
        probe_row.addWidget(self.probe_button)
        probe_row.addWidget(self.probe_clear_button)
        view_layout.addLayout(probe_row)
        view_layout.addWidget(self.probe_label)
        layout.addWidget(view_box)

        # ---- selection / export ---------------------------------------
        export_box = QGroupBox("选区与导出")
        export_layout = QVBoxLayout(export_box)
        self.selection_label = QLabel("尚未选择（左键拖动划选，Esc 清除）")
        self.selection_label.setWordWrap(True)
        self.selection_label.setTextInteractionFlags(
            Qt.TextInteractionFlag.TextSelectableByMouse
        )
        self.selection_label.setFont(QFont("Menlo", 10))
        export_layout.addWidget(self.selection_label)

        export_form = QFormLayout()
        self.fill_combo = QComboBox()
        self.fill_combo.addItem("透明（PNG/TIFF）", "transparent")
        self.fill_combo.addItem("黑色", "black")
        self.fill_combo.addItem("白色", "white")
        self.size_mode_combo = QComboBox()
        self.size_mode_combo.addItem("严格按选区尺寸（图外补色）", "exact")
        self.size_mode_combo.addItem("裁到图内（尺寸随交集）", "clip")
        export_form.addRow("图外区域", self.fill_combo)
        export_form.addRow("超出边缘时", self.size_mode_combo)
        export_layout.addLayout(export_form)

        self.export_button = QPushButton("导出选区…")
        self.export_button.clicked.connect(self.export_selection_dialog)
        self.copy_selection_button = QPushButton("复制选区坐标")
        self.copy_selection_button.clicked.connect(self.copy_selection_coords)
        export_layout.addWidget(self.export_button)
        export_layout.addWidget(self.copy_selection_button)
        layout.addWidget(export_box)

        # ---- cursor readout -------------------------------------------
        cursor_box = QGroupBox("光标 / 分块")
        cursor_layout = QVBoxLayout(cursor_box)
        self.cursor_label = QLabel("-")
        self.cursor_label.setFont(QFont("Menlo", 10))
        self.cursor_label.setWordWrap(True)
        self.tile_label = QLabel("-")
        self.tile_label.setFont(QFont("Menlo", 10))
        self.tile_label.setWordWrap(True)
        cursor_layout.addWidget(self.cursor_label)
        cursor_layout.addWidget(self.tile_label)
        layout.addWidget(cursor_box)

        # ---- log -------------------------------------------------------
        self.log = QPlainTextEdit()
        self.log.setReadOnly(True)
        self.log.setMaximumBlockCount(500)
        self.log.setFont(QFont("Menlo", 9))
        self.log.setMinimumHeight(90)
        layout.addWidget(self.log, 1)

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(panel)
        panel.layout().setSizeConstraint(
            QVBoxLayout.SizeConstraint.SetMinAndMaxSize
        )
        scroll.setMinimumWidth(330)
        scroll.setHorizontalScrollBarPolicy(
            Qt.ScrollBarPolicy.ScrollBarAlwaysOff
        )
        return scroll

    @staticmethod
    def _wrap(layout) -> QWidget:
        widget = QWidget()
        widget.setLayout(layout)
        layout.setContentsMargins(0, 0, 0, 0)
        return widget

    # ------------------------------------------------------------------
    # settings
    # ------------------------------------------------------------------
    def _restore_settings(self) -> None:
        geometry = self.settings.value("window/geometry")
        if geometry is not None:
            self.restoreGeometry(geometry)
        splitter = self.settings.value("window/splitter")
        if splitter is not None:
            self.splitter.restoreState(splitter)

        config = self._config()
        index = self.tile_size_combo.findData(config.tile_size)
        if index >= 0:
            self.tile_size_combo.setCurrentIndex(index)
        self.margin_spin.setValue(config.margin)
        index = self.resample_combo.findData(config.resample)
        if index >= 0:
            self.resample_combo.setCurrentIndex(index)
        self.min_level_spin.setValue(config.min_level_size)
        self.max_levels_spin.setValue(config.max_levels)
        self.viewer.set_show_grid(bool(self.settings.value("view/grid", False, bool)))
        self.viewer.set_show_margins(
            bool(self.settings.value("view/margins", False, bool))
        )
        self.grid_check.setChecked(self.viewer.show_grid)
        self.margin_check.setChecked(self.viewer.show_margins)
        last = self.settings.value("source/last", "", str)
        if last and self._restore_last:
            QTimer.singleShot(0, lambda: self.open_image(last, quiet=True))

    def _save_settings(self) -> None:
        self.settings.setValue("window/geometry", self.saveGeometry())
        self.settings.setValue("window/splitter", self.splitter.saveState())
        self.settings.setValue("config/tile_size", self._config().tile_size)
        self.settings.setValue("config/margin", self._config().margin)
        self.settings.setValue("config/resample", self._config().resample)
        self.settings.setValue(
            "config/min_level", self._config().min_level_size
        )
        self.settings.setValue("config/max_levels", self._config().max_levels)
        self.settings.setValue("view/grid", self.viewer.show_grid)
        self.settings.setValue("view/margins", self.viewer.show_margins)
        if self.source is not None:
            self.settings.setValue("source/last", str(self.source.path))
        self.settings.sync()

    def closeEvent(self, event) -> None:  # noqa: N802 - Qt API
        if self._thread is not None:
            if self._worker is not None:
                self._worker.cancel()
            self._thread.quit()
            self._thread.wait(5000)
        self.viewer.shutdown()
        self._save_settings()
        super().closeEvent(event)

    # ------------------------------------------------------------------
    # source
    # ------------------------------------------------------------------
    def _config(self) -> CacheConfig:
        tile_size = int(self.tile_size_combo.currentData() or 512)
        margin = min(self.margin_spin.value(), tile_size - 1)
        resample = str(self.resample_combo.currentData() or "lanczos")
        min_level = self.min_level_spin.value() or 256
        max_levels = self.max_levels_spin.value() or 10
        return CacheConfig(
            tile_size=tile_size,
            margin=margin,
            resample=resample,
            min_level_size=min_level,
            max_levels=max_levels,
        )

    def _update_source_panel(self) -> None:
        if self.source is None:
            self.source_path_label.clear()
            self.source_info_label.setText("")
            return
        source = self.source
        self.source_path_label.setText(str(source.path))
        self.source_path_label.setToolTip(str(source.path))
        self.source_path_label.setCursorPosition(0)
        self.source_info_label.setText(
            f"{source.width} × {source.height} px  {source.file_format}\n"
            f"{source.file_size / 1e6:.2f} MB   sha256 {source.short_hash}…\n"
            f"块目录 {self.manager.config.directory_name if self.manager else '-'}"
        )

    def open_image_dialog(self) -> None:
        start = str(self.source.path.parent) if self.source else str(Path.home())
        path, _ = QFileDialog.getOpenFileName(
            self,
            "打开单帧 RGB 图像",
            start,
            "图像 (*.png *.tif *.tiff *.jpg *.jpeg *.bmp *.webp);;所有文件 (*)",
        )
        if path:
            self.open_image(path)

    def open_image(self, path: str | os.PathLike[str], quiet: bool = False) -> None:
        if self._thread is not None:
            QMessageBox.warning(self, "正在生成", "请先取消当前生成任务。")
            return
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            source = load_source(path)
        except SourceError as exc:
            QApplication.restoreOverrideCursor()
            if quiet:
                self._log(f"未能恢复上次文件：{exc}")
            else:
                QMessageBox.critical(self, "无法打开图像", str(exc))
            return
        finally:
            if QApplication.overrideCursor() is not None:
                QApplication.restoreOverrideCursor()

        self.source = source
        self._log(
            f"已载入 {source.path.name} {source.width}x{source.height} "
            f"{source.file_format} sha256={source.short_hash}"
        )
        if source.exif_orientation not in (0, 1):
            self._log(
                f"警告：EXIF orientation={source.exif_orientation}，"
                "本工具按原始像素网格显示，不应用方向旋转。"
            )
            QMessageBox.warning(
                self,
                "EXIF 方向",
                "该文件的 EXIF orientation 不是 1。\n"
                "预览器按文件中的原始像素网格显示与导出，不会自动旋转。",
            )
        self._attach_manager()

    def reload_current(self) -> None:
        if self.source is None:
            return
        self.open_image(self.source.path)

    def open_sample(self) -> None:
        target_dir = self.cache_root / "samples"
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "sample_grid_4001x2501.png"
        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            image = build_sample()
            image.save(target, format="PNG", compress_level=6)
        finally:
            QApplication.restoreOverrideCursor()
        self._log(f"示例图像：{target}")
        self.open_image(target)

    def _attach_manager(self, *, auto_generate: bool | None = None) -> None:
        assert self.source is not None
        config = self._config()
        self.manager = CacheManager(self.cache_root, self.source, config)
        self.viewer.set_source(self.manager)
        info = self.manager.info
        self._log(
            f"缓存目录：{self.manager.directory}\n"
            f"层级：{info.level_count} 层，"
            f"L0 {self.source.width}x{self.source.height} → "
            f"L{info.level_count - 1:02d} {info.sizes[-1][0]}x{info.sizes[-1][1]}"
        )
        self._update_source_panel()
        self.level_spin.setRange(0, max(0, info.level_count - 1))
        self.zoom_spin.blockSignals(True)
        self.zoom_spin.setValue(self.viewer.zoom * 100.0)
        self.zoom_spin.blockSignals(False)
        self.jump_x.setRange(0, self.source.width - 1)
        self.jump_y.setRange(0, self.source.height - 1)
        self.jump_x.setValue(self.source.width // 2)
        self.jump_y.setValue(self.source.height // 2)
        self._refresh_statuses()
        self._update_selection_panel()
        self._update_probe_label()
        self.status_label.setText(
            f"{self.source.path.name}  {self.source.width}x{self.source.height}  "
            f"{config.tile_size}px/块  邻边 {config.margin}px"
        )
        if auto_generate is None:
            auto_generate = self._auto_generate
        should_generate = auto_generate and any(
            status.state is not LevelState.COMPLETE
            for status in self.manager.statuses()
        )
        if should_generate:
            QTimer.singleShot(0, self.generate_missing)

    def apply_config(self) -> None:
        if self.source is None:
            return
        if self._thread is not None:
            QMessageBox.warning(self, "正在处理", "请先完成或取消当前任务。")
            return
        new_config = self._config()
        if self.manager is not None and new_config == self.manager.config:
            self._log("分块设置未变化。")
            return
        self._attach_manager()
        self._log(
            "已切换分块设置；已有块位于不同目录，不会混用。"
        )

    # ------------------------------------------------------------------
    # status / level table
    # ------------------------------------------------------------------
    def _refresh_statuses(self) -> None:
        if self.manager is None:
            return
        statuses = self.manager.statuses()
        self.viewer.refresh_statuses(statuses)
        self._update_level_table(statuses)
        if self.viewer.level >= 0:
            self.level_spin.blockSignals(True)
            self.level_spin.setValue(self.viewer.level)
            self.level_spin.blockSignals(False)
        self._update_action_states()

    def _update_level_table(
        self, statuses: list[LevelStatus] | None = None
    ) -> None:
        if self.manager is None:
            self.level_table.setRowCount(0)
            return
        statuses = statuses or self.manager.statuses()
        self.level_table.blockSignals(True)
        self.level_table.setRowCount(len(statuses))
        for row, status in enumerate(statuses):
            values = [
                f"L{status.index:02d}",
                f"{status.width} × {status.height}",
                f"{status.cols} × {status.rows} = {status.tile_count}",
                _STATE_LABELS[status.state],
                status.detail
                or (f"{status.tiles_present}/{status.tile_count} 块"),
            ]
            for column, text in enumerate(values):
                item = QTableWidgetItem(text)
                if column == 3:
                    item.setForeground(_STATE_COLORS[status.state])
                if column in (0, 1, 2, 3):
                    item.setTextAlignment(
                        Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter
                    )
                self.level_table.setItem(row, column, item)
        self.level_table.blockSignals(False)

    def _selected_level_row(self) -> int | None:
        rows = self.level_table.selectionModel().selectedRows()
        if not rows:
            return None
        return rows[0].row()

    def _on_level_table_selected(self) -> None:
        # Selecting a row only picks the target for "rebuild/verify selected";
        # it must not change what is currently displayed (double-click does).
        self._update_action_states()

    def _on_level_table_double_clicked(self, index) -> None:
        if self.manager is None:
            return
        self.auto_level_check.setChecked(False)
        self.viewer.set_level(index.row())
        status = self.manager.level_status(index.row())
        if status.state is not LevelState.COMPLETE:
            self._log(
                f"L{index.row():02d} 尚未完整（{_STATE_LABELS[status.state]}），"
                "已显示现有块并标出缺口。"
            )

    def _update_action_states(self) -> None:
        busy = self._thread is not None
        has_source = self.manager is not None
        self.action_open.setEnabled(not busy)
        self.action_open_sample.setEnabled(not busy)
        self.action_reload.setEnabled(not busy and has_source)
        self.action_generate.setEnabled(not busy and has_source)
        self.action_rebuild_all.setEnabled(not busy and has_source)
        self.action_cancel.setEnabled(
            busy and self._busy_kind == "generate"
        )
        self.action_verify.setEnabled(not busy and has_source)
        self.action_verify_all.setEnabled(not busy and has_source)
        self.action_export.setEnabled(has_source)
        self.action_clear_cache.setEnabled(not busy and has_source)
        self.action_rebuild_level.setEnabled(not busy and has_source)
        self.action_fit.setEnabled(has_source)
        self.action_actual.setEnabled(has_source)
        self.action_zoom_in.setEnabled(has_source)
        self.action_zoom_out.setEnabled(has_source)
        for widget in (
            self.tile_size_combo,
            self.margin_spin,
            self.resample_combo,
            self.min_level_spin,
            self.max_levels_spin,
            self.apply_config_button,
            self.general_button,
            self.rebuild_all_button,
            self.clear_cache_button,
            self.level_table,
        ):
            widget.setEnabled(not busy and has_source)
        self.cancel_button.setEnabled(busy and self._busy_kind == "generate")
        self.regen_level_button.setEnabled(not busy and has_source)
        self.verify_button.setEnabled(not busy and has_source)
        self.export_button.setEnabled(has_source)
        self.copy_selection_button.setEnabled(has_source)

    # ------------------------------------------------------------------
    # generation
    # ------------------------------------------------------------------
    def generate_missing(self) -> None:
        if self.manager is None:
            return
        statuses = self.manager.statuses()
        levels = [
            status.index
            for status in statuses
            if status.state is not LevelState.COMPLETE
        ]
        if not levels:
            self._log("所有层级均已完整。")
            return
        self._start_generation(levels, force=False)

    def regenerate_current(self) -> None:
        if self.manager is None or self.viewer.level < 0:
            return
        self._start_generation([self.viewer.level], force=True)

    def regenerate_selected_level(self) -> None:
        row = self._selected_level_row()
        if row is None or self.manager is None:
            QMessageBox.information(self, "选择层级", "请先在层级表中选择一层。")
            return
        self._start_generation([row], force=True)

    def rebuild_all(self) -> None:
        if self.manager is None:
            return
        answer = QMessageBox.question(
            self,
            "强制重建",
            "将删除当前设置下的全部预览块并重新生成，是否继续？",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        self._start_generation(
            list(range(self.manager.info.level_count)), force=True
        )

    def _start_generation(self, levels: list[int], force: bool) -> None:
        if self.manager is None or self._thread is not None:
            return
        self._log(
            "开始生成 "
            + ", ".join(f"L{index:02d}" for index in levels)
            + ("（强制重建）" if force else "")
        )
        worker = GenerationWorker(self.manager, levels, force)
        self._start_worker(worker, "generate")

    def cancel_generation(self) -> None:
        if self._worker is not None and self._busy_kind == "generate":
            self._log("已请求取消；已完成的块会保留，下次可继续。")
            self._worker.cancel()
            self.cancel_button.setEnabled(False)
            self.action_cancel.setEnabled(False)

    def _start_worker(self, worker, kind: str) -> None:
        thread = QThread(self)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.done.connect(thread.quit)
        worker.done.connect(worker.deleteLater)
        thread.finished.connect(thread.deleteLater)
        thread.finished.connect(self._on_worker_thread_finished)

        if kind == "generate":
            worker.progress.connect(self._on_generation_progress)
            worker.finished.connect(self._on_generation_finished)
            worker.failed.connect(self._on_worker_failed)
        else:
            worker.levelCompared.connect(self._on_level_compared)
            worker.finished.connect(self._on_verification_finished)
            worker.failed.connect(self._on_worker_failed)

        self._thread = thread
        self._worker = worker
        self._busy_kind = kind
        self.progress.setRange(0, 0 if kind == "verify" else 100)
        self.progress.setValue(0)
        self._update_action_states()
        thread.start()

    def _on_generation_progress(self, done: int, total: int, message: str) -> None:
        if total > 0:
            self.progress.setRange(0, total)
            self.progress.setValue(done)
            self.status_label.setText(f"生成中 {done}/{total}  {message}")
        else:
            self.status_label.setText(message)

    def _on_generation_finished(self, cancelled: bool, summary: str) -> None:
        self._log(("生成已取消：" if cancelled else "生成完成：") + summary)

    def _on_verification_finished(self, summary: str) -> None:
        self._log("校验：" + summary)
        self.status_label.setText(summary)

    def _on_worker_failed(self, message: str) -> None:
        self._log(f"错误：{message}")
        QMessageBox.critical(self, "任务失败", message)

    def _on_level_compared(self, comparison) -> None:
        self._log(comparison.describe())
        if not comparison.equal:
            self._log(
                "提示：块内容与直接从原图生成的分层参考不一致，"
                "可能是缓存被修改或生成中断。"
            )

    def _on_worker_thread_finished(self) -> None:
        kind = self._busy_kind
        self._thread = None
        self._worker = None
        self._busy_kind = None
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        if kind == "generate" and self.manager is not None:
            # Tiles on disk may have been rewritten; drop any bitmap of them
            # that was loaded before/during generation.
            self.viewer.invalidate_levels(range(self.manager.info.level_count))
        self._refresh_statuses()
        self._update_action_states()

    # ------------------------------------------------------------------
    # verification
    # ------------------------------------------------------------------
    def verify_current_level(self) -> None:
        if self.manager is None or self.viewer.level < 0:
            return
        self._verify([self.viewer.level])

    def verify_selected_level(self) -> None:
        row = self._selected_level_row()
        if row is None:
            QMessageBox.information(self, "选择层级", "请先在层级表中选择一层。")
            return
        self._verify([row])

    def verify_all_levels(self) -> None:
        if self.manager is None:
            return
        levels = [
            status.index
            for status in self.manager.statuses()
            if status.state is LevelState.COMPLETE
        ]
        if not levels:
            self._log("没有完整的层级可校验。")
            return
        self._verify(levels)

    def _verify(self, levels: list[int]) -> None:
        if self.manager is None or self._thread is not None:
            return
        worker = VerificationWorker(self.manager, levels)
        self._start_worker(worker, "verify")
        self.status_label.setText("正在校验拼接结果…")

    # ------------------------------------------------------------------
    # cache maintenance
    # ------------------------------------------------------------------
    def _open_cache_dir(self) -> None:
        target = self.manager.directory if self.manager else self.cache_root
        target.mkdir(parents=True, exist_ok=True)
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(target)))

    def clear_current_cache(self) -> None:
        if self.manager is None or self._thread is not None:
            return
        answer = QMessageBox.question(
            self,
            "清空缓存",
            f"删除当前图像、当前分块设置下的全部预览块？\n{self.manager.directory}",
            QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
            QMessageBox.StandardButton.No,
        )
        if answer != QMessageBox.StandardButton.Yes:
            return
        self.manager.clear_all()
        self.viewer.clear_tile_cache()
        self._log("已清空当前图像的缓存。")
        self._refresh_statuses()

    # ------------------------------------------------------------------
    # view
    # ------------------------------------------------------------------
    def _fit_view(self) -> None:
        self.viewer.fit_to_view()
        self._sync_zoom_widgets()

    def _zoom_actual(self) -> None:
        self.viewer.zoom_to(1.0)
        self._sync_zoom_widgets()

    def _sync_zoom_widgets(self) -> None:
        self.zoom_spin.blockSignals(True)
        self.zoom_spin.setValue(self.viewer.zoom * 100.0)
        self.zoom_spin.blockSignals(False)
        self.zoom_slider.blockSignals(True)
        self.zoom_slider.setValue(self._zoom_to_slider(self.viewer.zoom))
        self.zoom_slider.blockSignals(False)

    @staticmethod
    def _zoom_to_slider(zoom: float) -> int:
        low, high = math.log(MIN_ZOOM), math.log(MAX_ZOOM)
        ratio = (math.log(max(MIN_ZOOM, min(MAX_ZOOM, zoom))) - low) / (
            high - low
        )
        return int(round(ratio * 1000))

    @staticmethod
    def _slider_to_zoom(value: int) -> float:
        low, high = math.log(MIN_ZOOM), math.log(MAX_ZOOM)
        return math.exp(low + (high - low) * value / 1000.0)

    def _on_zoom_slider(self, value: int) -> None:
        self.viewer.zoom_to(self._slider_to_zoom(value))
        self.zoom_spin.blockSignals(True)
        self.zoom_spin.setValue(self.viewer.zoom * 100.0)
        self.zoom_spin.blockSignals(False)

    def _on_zoom_spin(self, value: float) -> None:
        self.viewer.zoom_to(value / 100.0)
        self.zoom_slider.blockSignals(True)
        self.zoom_slider.setValue(self._zoom_to_slider(self.viewer.zoom))
        self.zoom_slider.blockSignals(False)

    def _on_auto_level_toggled(self, checked: bool) -> None:
        self.viewer.set_auto_level(checked)
        self._sync_level_widgets()

    def _on_level_spin(self, value: int) -> None:
        if self.manager is None:
            return
        if self.auto_level_check.isChecked():
            self.auto_level_check.setChecked(False)
        self.viewer.set_level(value)

    def _on_grid_toggled(self, checked: bool) -> None:
        self.viewer.set_show_grid(checked)

    def _on_margin_toggled(self, checked: bool) -> None:
        self.viewer.set_show_margins(checked)

    def _on_view_changed(self, level: int, zoom: float) -> None:
        self._sync_level_widgets()
        self._update_probe_label()
        if level < 0:
            return
        self.zoom_spin.blockSignals(True)
        self.zoom_spin.setValue(zoom * 100.0)
        self.zoom_spin.blockSignals(False)
        self.zoom_slider.blockSignals(True)
        self.zoom_slider.setValue(self._zoom_to_slider(zoom))
        self.zoom_slider.blockSignals(False)
        geom = self.manager.geometry(level) if self.manager else None
        if geom is not None:
            self.status_label.setText(
                f"{self.source.path.name}  {self.source.width}x{self.source.height}  "
                f"L{level:02d} {geom.width}x{geom.height}  "
                f"{self.viewer.zoom * 100:.2f}%"
            )

    def _sync_level_widgets(self) -> None:
        self.level_spin.blockSignals(True)
        self.level_spin.setValue(max(0, self.viewer.level))
        self.level_spin.blockSignals(False)
        self.auto_level_check.blockSignals(True)
        self.auto_level_check.setChecked(self.viewer.auto_level)
        self.auto_level_check.blockSignals(False)
        row = self.viewer.level
        if 0 <= row < self.level_table.rowCount():
            self.level_table.blockSignals(True)
            self.level_table.selectRow(row)
            self.level_table.blockSignals(False)

    def _jump_to_coordinate(self) -> None:
        if self.manager is None:
            return
        self.viewer.center = (float(self.jump_x.value()), float(self.jump_y.value()))
        self.viewer.viewChanged.emit(self.viewer.level, self.viewer.zoom)
        self.viewer.update()

    def _set_probe_at_cursor(self) -> None:
        if self.manager is None:
            return
        point = self.viewer.cursor_original
        if point is None:
            QMessageBox.information(
                self, "没有光标位置", "请先把鼠标移到预览图上，再锁定参照点。"
            )
            return
        x, y = point
        self.viewer.set_probe(x, y)
        self.jump_x.setValue(int(max(0, min(x, self.source.width - 1))))
        self.jump_y.setValue(int(max(0, min(y, self.source.height - 1))))
        self._update_probe_label()
        self._log(
            f"参照点锁定在原图 ({x:.2f}, {y:.2f})；"
            "切换层级/缩放时它应停在原图同一处特征上。"
        )

    def _clear_probe(self) -> None:
        self.viewer.clear_probe()
        self._update_probe_label()

    def _update_probe_label(self) -> None:
        probe = self.viewer.probe
        if probe is None or self.manager is None:
            self.probe_label.setText("参照点：未设置")
            return
        if self.viewer.level < 0:
            self.probe_label.setText(f"参照点：原图 ({probe[0]:.1f}, {probe[1]:.1f})")
            return
        geom = self.manager.geometry(self.viewer.level)
        lx, ly = map_original_to_level(
            probe[0],
            probe[1],
            self.manager.source.width,
            self.manager.source.height,
            geom.width,
            geom.height,
        )
        self.probe_label.setText(
            f"参照点：原图 ({probe[0]:.1f}, {probe[1]:.1f})\n"
            f"        L{self.viewer.level:02d} ({lx:.1f}, {ly:.1f})  "
            f"比例 {geom.width / self.manager.source.width:.4f}"
        )

    # ------------------------------------------------------------------
    # cursor / selection
    # ------------------------------------------------------------------
    def _on_cursor_moved(self, x: float, y: float) -> None:
        if self.manager is None:
            return
        width, height = self.manager.source.width, self.manager.source.height
        inside = 0 <= x < width and 0 <= y < height
        text = f"原图 x={x:.2f} y={y:.2f}"
        if not inside:
            text += "  (图外)"
        self.coord_label.setText(text)
        if self.viewer.level >= 0:
            geom = self.manager.geometry(self.viewer.level)
            sx = geom.width / width
            sy = geom.height / height
            lx, ly = x * sx, y * sy
            tile = (
                geom.tile_index_at(math.floor(lx), math.floor(ly))
                if inside
                else None
            )
            tile_text = (
                f"L{self.viewer.level:02d} 层内 x={lx:.2f} y={ly:.2f}"
                + (f"  块 c{tile[0]} r{tile[1]}" if tile else "")
            )
            self.cursor_label.setText(text + "\n" + tile_text)
        else:
            self.cursor_label.setText(text + "\n无可用层级")

    def _on_hovered_tile(self, tile) -> None:
        if tile is None:
            self.tile_label.setText("-")
            return
        level, core, full = tile
        left = core.x - full.x
        top = core.y - full.y
        right = full.x2 - core.x2
        bottom = full.y2 - core.y2
        self.tile_label.setText(
            f"L{level:02d} 块核心 [{core.x},{core.y} {core.w}×{core.h}]\n"
            f"含边全块 [{full.x},{full.y} {full.w}×{full.h}]\n"
            f"邻边 左{left} 上{top} 右{right} 下{bottom}"
        )

    def _on_selection_changed(self, rect) -> None:
        self._update_selection_panel(rect)

    def _update_selection_panel(self, rect: Rect | None = None) -> None:
        if rect is None and self.viewer.selection_pixel_rect() is not None:
            rect = self.viewer.selection_pixel_rect()
        if rect is None:
            self.selection_label.setText("尚未选择（左键拖动划选，Esc 清除）")
            return
        if self.source is None:
            return
        inside = rect.clipped_to(self.source.bounds)
        outside = rect.w * rect.h - inside.w * inside.h
        lines = [
            f"原图选区 x={rect.x} y={rect.y}  {rect.w}×{rect.h}",
            f"图内部分 {inside.w}×{inside.h}  图外像素 {outside}",
        ]
        if outside:
            mode = self.size_mode_combo.currentData()
            if mode == "exact":
                lines.append("导出将保持选区尺寸，图外按填充色补齐")
            else:
                lines.append("导出将裁剪到图内交集")
        self.selection_label.setText("\n".join(lines))

    def copy_selection_coords(self) -> None:
        rect = self.viewer.selection_pixel_rect()
        if rect is None:
            return
        text = f"{rect.x},{rect.y},{rect.w},{rect.h}"
        QApplication.clipboard().setText(text)
        self._log(f"已复制选区坐标：{text}")

    def export_selection_dialog(self) -> None:
        rect = self.viewer.selection_pixel_rect()
        if rect is None:
            QMessageBox.information(
                self, "没有选区", "请在预览上用左键拖动划出要导出的矩形。"
            )
            return
        if self.source is None:
            return
        fill = str(self.fill_combo.currentData())
        size_mode = str(self.size_mode_combo.currentData())
        if size_mode == "clip" and rect.clipped_to(self.source.bounds).is_empty:
            QMessageBox.warning(
                self, "选区在图外", "裁剪模式下选区未覆盖任何图像像素。"
            )
            return

        default_dir = (
            str(self.source.path.parent) if self.source else str(Path.home())
        )
        stem = self.source.path.stem
        suggested = (
            Path(default_dir)
            / f"{stem}_x{rect.x}_y{rect.y}_{rect.w}x{rect.h}.png"
        )
        path, selected_filter = QFileDialog.getSaveFileName(
            self,
            "导出原图区域",
            str(suggested),
            "PNG (*.png);;TIFF (*.tif *.tiff);;JPEG (*.jpg *.jpeg)",
        )
        if not path:
            return
        target = Path(path)
        if target.suffix == "":
            # Follow the chosen filter rather than silently defaulting to PNG.
            suffix = {
                "TIFF (*.tif *.tiff)": ".tif",
                "JPEG (*.jpg *.jpeg)": ".jpg",
            }.get(selected_filter, ".png")
            target = target.with_suffix(suffix)
        if fill == "transparent" and target.suffix.lower() in {".jpg", ".jpeg"}:
            QMessageBox.warning(
                self,
                "格式不支持透明",
                "JPEG 不能保存透明补边，请选择 PNG/TIFF，或把图外区域改为黑色/白色。",
            )
            return

        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            result = export_region(
                self.source.array,
                rect,
                fill=fill,
                size_mode=size_mode,
            )
            save_export(result, target)
        except Exception as exc:  # noqa: BLE001 - reported to the user
            QApplication.restoreOverrideCursor()
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        QApplication.restoreOverrideCursor()
        self._log(
            f"已导出 {target}  尺寸 {result.size[0]}×{result.size[1]}  "
            f"图外像素 {result.outside_pixels}  "
            f"(选区 x={rect.x} y={rect.y} {rect.w}×{rect.h})"
        )
        self.status_label.setText(
            f"已导出 {target.name}  {result.size[0]}×{result.size[1]}"
        )

    # ------------------------------------------------------------------
    def show_about(self) -> None:
        QMessageBox.information(
            self,
            "关于 / 快捷键",
            "影像分块预览器\n\n"
            "层级为从原图直接缩放得到的无损预览金字塔；每层再按固定边长分块，"
            "每块可带邻边；拼接只使用块的核心区域。\n\n"
            "鼠标滚轮：以光标为参照缩放\n"
            "左键拖动：划选原图矩形（Shift 保持正方形）\n"
            "中键拖动 / 空格+左键：平移\n"
            "方向键：平移；Esc：清除选区\n"
            "F：适应窗口；1：原始像素 1:1\n"
            "G：生成缺失层级；Ctrl+.：取消生成\n"
            "Ctrl+E：导出选区；Ctrl+R：重新读取文件\n"
            "双击层级表：切换到该层（关闭自动选层）\n\n"
            f"缓存目录：{self.cache_root}",
        )

    def _log(self, message: str) -> None:
        self.log.appendPlainText(message)
        self.status_label.setText(message.splitlines()[0][:200])
