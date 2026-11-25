from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QFileDialog,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from ..engine import (
    LockRegion,
    StackParams,
    roi_contributors,
    source_overlay,
    stack_sequence,
)
from ..export import export_frame_list
from ..imaging import load_rgb, save_rgb
from ..sequence import (
    FrameItem,
    detect_missing_gaps,
    make_frame_items,
    scan_folder,
)
from ..synth import write_sample_sequence
from .params_form import ParameterForm
from .state import VersionState
from .version_panel import VersionPanel


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("光迹堆叠台 · PySide6 + NumPy")
        self.resize(1520, 940)

        self.items: list[FrameItem] = []
        self.arrays_by_index: dict[int, np.ndarray] = {}
        self.gaps = []
        self.locks: list[LockRegion] = []
        self.row_by_original: dict[int, int] = {}
        self.contributor_key = "A"
        self._populating = False

        self.versions: dict[str, VersionState] = {
            "A": VersionState("A", StackParams(method="brighten", min_occurrences=1)),
            "B": VersionState("B", StackParams(method="count", min_occurrences=2)),
        }
        self.forms: dict[str, ParameterForm] = {}
        self.panels: dict[str, VersionPanel] = {}

        self._dirty: set[str] = set()
        self._timer = QTimer(self)
        self._timer.setSingleShot(True)
        self._timer.setInterval(220)
        self._timer.timeout.connect(self._flush_dirty)

        self._build_toolbar()
        self._build_central()
        self._connect_signals()
        self.statusBar().showMessage("就绪：可导入固定视角、同尺寸图片序列，或生成内置样例。")

    # ------------------------------------------------------------------ UI
    def _build_toolbar(self) -> None:
        toolbar = self.addToolBar("主操作")
        toolbar.setMovable(False)
        toolbar.addAction("导入图片…", self.choose_files)
        toolbar.addAction("导入文件夹…", self.choose_folder)
        toolbar.addSeparator()
        toolbar.addAction("生成内置样例", self.generate_sample)
        toolbar.addSeparator()
        toolbar.addAction("全部计算", self.run_all_now)

    def _build_central(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.addWidget(self._build_frame_panel())
        splitter.addWidget(self._build_center_panel())
        splitter.addWidget(self._build_parameter_tabs())
        splitter.setSizes([430, 760, 350])
        self.setCentralWidget(splitter)

    def _build_frame_panel(self) -> QWidget:
        scroll_content = QWidget()
        layout = QVBoxLayout(scroll_content)

        io_box = QGroupBox("1. 导入顺序 / 缺号")
        io_layout = QVBoxLayout(io_box)
        row = QHBoxLayout()
        files_button = QPushButton("导入图片")
        files_button.clicked.connect(self.choose_files)
        folder_button = QPushButton("导入文件夹")
        folder_button.clicked.connect(self.choose_folder)
        sample_button = QPushButton("生成样例")
        sample_button.clicked.connect(self.generate_sample)
        row.addWidget(files_button)
        row.addWidget(folder_button)
        row.addWidget(sample_button)
        io_layout.addLayout(row)

        self.folder_label = QLabel("尚未导入。文件名按自然排序（img2 在 img10 前）。")
        self.folder_label.setWordWrap(True)
        self.folder_label.setStyleSheet("color: #aeb9c4;")
        io_layout.addWidget(self.folder_label)

        self.missing_label = QLabel("缺号检测：等待导入。")
        self.missing_label.setWordWrap(True)
        self.missing_label.setStyleSheet("padding: 6px; background: #2a2024; border-radius: 4px; color: #ffd7dc;")
        io_layout.addWidget(self.missing_label)
        locate_row = QHBoxLayout()
        self.locate_gap_button = QPushButton("定位中间缺号")
        self.locate_gap_button.clicked.connect(self.locate_first_gap)
        locate_row.addWidget(self.locate_gap_button)
        locate_row.addStretch(1)
        io_layout.addLayout(locate_row)
        layout.addWidget(io_box)

        range_box = QGroupBox("2. 帧范围与原序号查询")
        range_layout = QVBoxLayout(range_box)
        range_row = QHBoxLayout()
        range_row.addWidget(QLabel("起"))
        self.start_spin = QSpinBox()
        self.start_spin.setRange(1, 1)
        range_row.addWidget(self.start_spin)
        range_row.addWidget(QLabel("止"))
        self.end_spin = QSpinBox()
        self.end_spin.setRange(1, 1)
        range_row.addWidget(self.end_spin)
        self.all_range_button = QPushButton("全部")
        self.all_range_button.clicked.connect(self.set_full_range)
        range_row.addWidget(self.all_range_button)
        range_layout.addLayout(range_row)

        select_row = QHBoxLayout()
        self.start_from_row = QPushButton("选中行设起点")
        self.start_from_row.clicked.connect(lambda: self.set_bound_from_selected("start"))
        self.end_from_row = QPushButton("选中行设终点")
        self.end_from_row.clicked.connect(lambda: self.set_bound_from_selected("end"))
        select_row.addWidget(self.start_from_row)
        select_row.addWidget(self.end_from_row)
        range_layout.addLayout(select_row)

        search_row = QHBoxLayout()
        self.search_edit = QLineEdit()
        self.search_edit.setPlaceholderText("文件原序号；#30 查导入序号")
        self.search_edit.returnPressed.connect(self.search_original)
        self.search_button = QPushButton("查原序号")
        self.search_button.clicked.connect(self.search_original)
        search_row.addWidget(self.search_edit, 1)
        search_row.addWidget(self.search_button)
        range_layout.addLayout(search_row)
        layout.addWidget(range_box)

        self.table = QTableWidget(0, 6)
        self.table.setHorizontalHeaderLabels(["参与", "导入序号", "文件原序号", "文件名", "尺寸", "状态 / A·B 贡献像素"])
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.verticalHeader().setVisible(False)
        header = self.table.horizontalHeader()
        header.setSectionResizeMode(3, header.ResizeMode.Stretch)
        self.table.setColumnWidth(0, 40)
        self.table.setColumnWidth(1, 64)
        self.table.setColumnWidth(2, 72)
        self.table.setColumnWidth(4, 88)
        self.table.setColumnWidth(5, 170)
        self.table.itemChanged.connect(self.on_table_item_changed)
        layout.addWidget(self.table, 2)

        lock_box = QGroupBox("3. 锁住要保留的片段（像素坐标与源帧一致）")
        lock_layout = QVBoxLayout(lock_box)
        self.lock_list = QListWidget()
        self.lock_list.setMaximumHeight(92)
        lock_layout.addWidget(self.lock_list)
        lock_buttons = QHBoxLayout()
        self.delete_lock_button = QPushButton("删除选中锁")
        self.delete_lock_button.clicked.connect(self.delete_selected_lock)
        self.clear_locks_button = QPushButton("清空锁")
        self.clear_locks_button.clicked.connect(self.clear_locks)
        lock_buttons.addWidget(self.delete_lock_button)
        lock_buttons.addWidget(self.clear_locks_button)
        lock_layout.addLayout(lock_buttons)
        layout.addWidget(lock_box)

        # A plain widget is enough inside the main splitter; add a scroll area
        # wrapper so small screens can reach every control.
        from PySide6.QtWidgets import QScrollArea

        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setWidget(scroll_content)
        scroll.setMinimumWidth(390)
        scroll.setMaximumWidth(520)
        return scroll

    def _build_center_panel(self) -> QWidget:
        container = QWidget()
        layout = QVBoxLayout(container)
        layout.setContentsMargins(2, 2, 2, 2)

        self.compare_splitter = QSplitter(Qt.Orientation.Horizontal)
        for key in ("A", "B"):
            panel = VersionPanel(key)
            self.panels[key] = panel
            self.compare_splitter.addWidget(panel)
        self.compare_splitter.setSizes([720, 720])
        layout.addWidget(self.compare_splitter, 3)

        contribution_box = QGroupBox("选区来源帧：在 A/B 叠图上拖框，查看该光迹片段由哪些画面贡献")
        contribution_layout = QVBoxLayout(contribution_box)
        filter_row = QHBoxLayout()
        self.only_contributors_check = QCheckBox("只看有亮部/保留像素的帧")
        self.only_contributors_check.setChecked(True)
        self.only_contributors_check.toggled.connect(self.populate_contributor_table)
        filter_row.addWidget(self.only_contributors_check)
        filter_row.addStretch(1)
        self.contributor_summary = QLabel("尚未查询选区")
        filter_row.addWidget(self.contributor_summary)
        contribution_layout.addLayout(filter_row)

        self.contributor_table = QTableWidget(0, 7)
        self.contributor_table.setHorizontalHeaderLabels(
            ["导入序号", "文件原序号", "文件名", "保留像素", "亮部像素", "最大超出", "状态"]
        )
        self.contributor_table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.contributor_table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.contributor_table.verticalHeader().setVisible(False)
        self.contributor_table.itemSelectionChanged.connect(self.on_contributor_selected)
        contribution_layout.addWidget(self.contributor_table)
        contribution_box.setMaximumHeight(245)
        layout.addWidget(contribution_box, 1)
        return container

    def _build_parameter_tabs(self) -> QTabWidget:
        tabs = QTabWidget()
        for key in ("A", "B"):
            form = ParameterForm(key)
            form.set_params(self.versions[key].params)
            self.forms[key] = form
            tabs.addTab(form, f"参数 {key}")
        tabs.setMinimumWidth(330)
        tabs.setMaximumWidth(430)
        return tabs

    def _connect_signals(self) -> None:
        self.start_spin.valueChanged.connect(lambda _v: self.on_range_spin_changed("start"))
        self.end_spin.valueChanged.connect(lambda _v: self.on_range_spin_changed("end"))

        for key, form in self.forms.items():
            form.paramsChanged.connect(self.schedule_version)
            form.runRequested.connect(self.run_version_now)
            form.copyRequested.connect(self.copy_parameters)

        for key, panel in self.panels.items():
            panel.canvas.roiSelected.connect(self.on_roi_selected)
            panel.lockRoiRequested.connect(self.lock_current_roi)
            panel.clearRoiRequested.connect(self.clear_roi)
            panel.exportImageRequested.connect(self.export_image)
            panel.exportListRequested.connect(self.export_frame_list_for_version)
            panel.sourceOverlayToggled.connect(self.toggle_source_overlay)

    # ------------------------------------------------------------ import/data
    def choose_files(self) -> None:
        paths, _ = QFileDialog.getOpenFileNames(
            self,
            "选择固定视角图片序列（可多选，将按文件名自然排序）",
            "",
            "Images (*.jpg *.jpeg *.png *.bmp *.tif *.tiff *.webp)",
        )
        if paths:
            self.import_paths(paths)

    def choose_folder(self) -> None:
        folder = QFileDialog.getExistingDirectory(self, "选择图片序列文件夹")
        if folder:
            try:
                paths = scan_folder(folder)
            except Exception as exc:
                QMessageBox.warning(self, "无法读取文件夹", str(exc))
                return
            if not paths:
                QMessageBox.information(self, "没有图片", "该文件夹中没有支持的图片。")
                return
            self.import_paths(paths)

    def generate_sample(self) -> None:
        sample_dir = Path.cwd() / "generated_samples" / "uniform_point_flash_pause"
        try:
            sample_dir.mkdir(parents=True, exist_ok=True)
            test_file = sample_dir / ".write_test"
            test_file.write_bytes(b"ok")
            test_file.unlink()
        except OSError:
            sample_dir = Path.home() / "LightTrailStacker" / "uniform_point_flash_pause"
        try:
            info = write_sample_sequence(sample_dir)
            paths = scan_folder(sample_dir)
            self.import_paths(paths)
            self.statusBar().showMessage(
                f"样例已生成：{info.folder}；含匀速光点、第 10 号临时闪光、16–18 短暂停顿，并故意缺第 24 号。",
                12000,
            )
            QMessageBox.information(
                self,
                "内置样例已生成",
                f"目录：\n{info.folder}\n\n"
                "样例包含：匀速光点、第 10 帧临时强反光、第 16–18 帧短暂停顿，"
                "并故意缺少正中间的第 24 号文件。\n已自动按文件名顺序导入。",
            )
        except Exception as exc:
            QMessageBox.critical(self, "样例生成失败", repr(exc))

    def import_paths(self, paths) -> None:
        items = make_frame_items(paths)
        if not items:
            return
        self.items = items
        self.arrays_by_index.clear()
        self.locks.clear()
        for state in self.versions.values():
            state.result = None
            state.error = None
            state.roi = None
            state.contributors = []

        loaded: dict[int, np.ndarray] = {}
        first_shape: tuple[int, ...] | None = None
        for item in self.items:
            try:
                array = load_rgb(item.path)
                if first_shape is None:
                    first_shape = array.shape
                if array.shape != first_shape:
                    item.load_error = f"尺寸 {array.shape[1]}×{array.shape[0]} 与首帧不一致"
                    continue
                loaded[item.original_index] = array
                item.height, item.width = array.shape[:2]
            except Exception as exc:  # surface bad files in the table
                item.load_error = str(exc)

        for index, array in loaded.items():
            item = self._item_by_index(index)
            if item is not None and item.load_error is None:
                self.arrays_by_index[index] = array

        valid_count = len(self.arrays_by_index)
        if valid_count == 0:
            QMessageBox.warning(self, "没有可用图片", "所有图片均无法读取，或尺寸不一致。")

        max_index = len(self.items)
        for spin in (self.start_spin, self.end_spin):
            spin.blockSignals(True)
            spin.setRange(1, max(1, max_index))
        self.start_spin.setValue(1)
        self.end_spin.setValue(max_index)
        for spin in (self.start_spin, self.end_spin):
            spin.blockSignals(False)

        self.folder_label.setText(f"已导入 {len(items)} 个文件，其中 {valid_count} 张尺寸一致、可参与叠图。")
        self.gaps = detect_missing_gaps(self.items)
        self.populate_frame_table()
        self.update_missing_banner()
        self.refresh_lock_list()
        for panel in self.panels.values():
            panel.canvas.clear_roi()
            panel.canvas.set_lock_regions([])
        self.contributor_table.setRowCount(0)
        self.contributor_summary.setText("尚未查询选区")
        self.run_all_now()

    def _item_by_index(self, original_index: int) -> FrameItem | None:
        for item in self.items:
            if item.original_index == original_index:
                return item
        return None

    def usable_data(self) -> tuple[list[np.ndarray], list[int], dict[int, int], dict[int, str]]:
        usable = [item for item in self.items if item.usable and item.original_index in self.arrays_by_index]
        frames = [self.arrays_by_index[item.original_index] for item in usable]
        indices = [item.original_index for item in usable]
        numbers = {item.original_index: item.source_number for item in usable if item.source_number is not None}
        names = {item.original_index: item.file_name for item in usable}
        return frames, indices, numbers, names

    # ------------------------------------------------------------ frame table
    def populate_frame_table(self) -> None:
        self._populating = True
        self.table.blockSignals(True)
        try:
            self.table.setRowCount(0)
            self.row_by_original.clear()
            gaps_after: dict[int, list] = {}
            for gap in self.gaps:
                if gap.left_index is not None:
                    gaps_after.setdefault(gap.left_index, []).append(gap)

            for item in self.items:
                row = self.table.rowCount()
                self.table.insertRow(row)
                self.row_by_original[item.original_index] = row

                check = QTableWidgetItem()
                check.setFlags(Qt.ItemFlag.ItemIsEnabled | Qt.ItemFlag.ItemIsSelectable | Qt.ItemFlag.ItemIsUserCheckable)
                check.setCheckState(Qt.CheckState.Unchecked if item.excluded else Qt.CheckState.Checked)
                check.setData(Qt.ItemDataRole.UserRole, item.original_index)
                check.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                self.table.setItem(row, 0, check)

                values = [
                    str(item.original_index),
                    item.display_number(),
                    item.file_name,
                    f"{item.width}×{item.height}" if item.usable else "—",
                    item.load_error or "等待计算",
                ]
                for col, value in enumerate(values, start=1):
                    cell = QTableWidgetItem(value)
                    if col != 3:
                        cell.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                    cell.setData(Qt.ItemDataRole.UserRole, item.original_index)
                    self.table.setItem(row, col, cell)

                if item.load_error:
                    for col in range(self.table.columnCount()):
                        cell = self.table.item(row, col)
                        if cell:
                            cell.setBackground(Qt.GlobalColor.darkRed)

                for gap in gaps_after.get(item.original_index, []):
                    gap_row = self.table.rowCount()
                    self.table.insertRow(gap_row)
                    placeholder = QTableWidgetItem("缺")
                    placeholder.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                    placeholder.setBackground(Qt.GlobalColor.darkYellow)
                    self.table.setItem(gap_row, 0, placeholder)
                    self.table.setItem(gap_row, 1, QTableWidgetItem("—"))
                    number_item = QTableWidgetItem(str(gap.missing_number))
                    number_item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                    self.table.setItem(gap_row, 2, number_item)
                    desc = QTableWidgetItem("⚠ " + gap.describe())
                    desc.setBackground(Qt.GlobalColor.darkYellow)
                    self.table.setItem(gap_row, 3, desc)
                    self.table.setItem(gap_row, 4, QTableWidgetItem("缺帧"))
                    self.table.setItem(gap_row, 5, QTableWidgetItem("缺失位置标记"))
                    for col in range(1, 6):
                        cell = self.table.item(gap_row, col)
                        if cell and col != 3:
                            cell.setBackground(Qt.GlobalColor.darkYellow)
        finally:
            self.table.blockSignals(False)
            self._populating = False
        self.refresh_table_stats()

    def update_missing_banner(self) -> None:
        single = [gap for gap in self.gaps if gap.single]
        if single:
            text = "检测到正中间缺一张：\n" + "\n".join(gap.describe() for gap in single[:3])
            if len(single) > 3:
                text += f"\n…另有 {len(single) - 3} 个单张缺号"
            self.missing_label.setText(text)
        elif self.gaps:
            self.missing_label.setText("检测到多张开洞：\n" + "\n".join(g.describe() for g in self.gaps[:2]))
        else:
            self.missing_label.setText("缺号检测：未发现数字序号中间洞；手工排除不会改变原序号。")

    def locate_first_gap(self) -> None:
        if not self.gaps:
            self.statusBar().showMessage("当前没有检测到数字缺号。", 4000)
            return
        gap = self.gaps[0]
        if gap.left_index is not None:
            self.select_original(gap.left_index)
        QMessageBox.information(self, "缺帧位置", gap.describe())

    def select_original(self, original_index: int) -> bool:
        row = self.row_by_original.get(original_index)
        if row is None:
            return False
        self.table.selectRow(row)
        item = self.table.item(row, 1)
        if item:
            self.table.scrollToItem(item, QAbstractItemView.ScrollHint.PositionAtCenter)
        return True

    def search_original(self) -> None:
        text = self.search_edit.text().strip()
        if not text:
            return

        import_index_mode = text.startswith(("#", "＃"))
        if import_index_mode:
            text = text[1:].strip()

        if text.isdigit():
            value = int(text)

            if import_index_mode:
                item = self._item_by_index(value)
                if item is not None:
                    self.select_original(item.original_index)
                    state = "已排除，仍可查询" if item.excluded else "已定位导入序号"
                    self.statusBar().showMessage(
                        f"{state}：导入序号 {item.original_index}，文件序号 {item.display_number()}，{item.file_name}",
                        8000,
                    )
                else:
                    self.statusBar().showMessage(f"找不到导入序号 #{value}。", 5000)
                return

            source_item = next((i for i in self.items if i.source_number == value), None)
            gap = next((g for g in self.gaps if g.missing_number == value), None)
            import_item = self._item_by_index(value)

            if source_item is not None:
                self.select_original(source_item.original_index)
                extra = ""
                if import_item is not None and import_item.original_index != source_item.original_index:
                    extra = f"；注意导入序号 #{value} 是 {import_item.file_name}，如需按导入序号查请输入 #{value}"
                state = "已排除，仍可查询" if source_item.excluded else "已定位文件原序号"
                self.statusBar().showMessage(
                    f"{state}：文件序号 {source_item.display_number()}，导入序号 {source_item.original_index}，"
                    f"{source_item.file_name}{extra}",
                    10000,
                )
                return

            if gap is not None:
                if gap.left_index is not None:
                    self.select_original(gap.left_index)
                hint = gap.describe()
                if import_item is not None:
                    hint += f"；导入序号 #{value} 当前是 {import_item.file_name}"
                self.statusBar().showMessage(hint, 12000)
                return

            if import_item is not None:
                self.select_original(import_item.original_index)
                self.statusBar().showMessage(
                    f"没有匹配的文件原序号，已按导入序号定位：#{value}，{import_item.file_name}",
                    7000,
                )
                return

            self.statusBar().showMessage(f"找不到原序号 {value}（也可能是未检测到的缺号）。", 6000)
            return

        needle = text.lower().lstrip("#")
        item = next((i for i in self.items if needle in i.file_name.lower()), None)
        if item:
            self.select_original(item.original_index)
            self.statusBar().showMessage(f"已按文件名定位：{item.file_name}", 6000)
        else:
            self.statusBar().showMessage(f"没有文件名包含 {text!r}", 5000)

    def on_table_item_changed(self, item: QTableWidgetItem) -> None:
        if self._populating or item.column() != 0:
            return
        original = item.data(Qt.ItemDataRole.UserRole)
        if original is None:
            return
        frame = self._item_by_index(int(original))
        if frame is None:
            return
        frame.excluded = item.checkState() != Qt.CheckState.Checked
        self.refresh_table_stats()
        self.schedule_both(force=True)
        self.statusBar().showMessage(
            f"{'已排除' if frame.excluded else '已恢复'} {frame.file_name}；原序号 {frame.display_number()} 保持不变。",
            5000,
        )

    def selected_original(self) -> int | None:
        row = self.table.currentRow()
        if row < 0:
            return None
        item = self.table.item(row, 0)
        if item is None:
            return None
        value = item.data(Qt.ItemDataRole.UserRole)
        return int(value) if value is not None else None

    def set_bound_from_selected(self, bound: str) -> None:
        value = self.selected_original()
        if value is None:
            self.statusBar().showMessage("请先在帧表中选择一行。", 4000)
            return
        if bound == "start":
            self.start_spin.setValue(value)
        else:
            self.end_spin.setValue(value)

    def set_full_range(self) -> None:
        if not self.items:
            return
        self.start_spin.setValue(1)
        self.end_spin.setValue(len(self.items))

    def on_range_spin_changed(self, which: str) -> None:
        start = self.start_spin.value()
        end = self.end_spin.value()
        if start > end:
            if which == "start":
                self.end_spin.blockSignals(True)
                self.end_spin.setValue(start)
                self.end_spin.blockSignals(False)
            else:
                self.start_spin.blockSignals(True)
                self.start_spin.setValue(end)
                self.start_spin.blockSignals(False)
        self.refresh_table_stats()
        self.schedule_both(force=True)

    # --------------------------------------------------------------- locks
    def lock_current_roi(self, key: str) -> None:
        roi = self.versions[key].roi
        if not roi:
            self.statusBar().showMessage(f"请先在版本 {key} 图上拖出要锁住的选区。", 5000)
            return
        x, y, w, h = roi
        self.locks.append(LockRegion(x, y, w, h, note=f"from {key}"))
        self.refresh_lock_list()
        for panel in self.panels.values():
            panel.canvas.set_lock_regions(self.locks)
        self.schedule_both(force=True)
        self.statusBar().showMessage(f"已锁定区域 x={x}, y={y}, {w}×{h}；两个版本都会保护其中的亮迹。", 6000)

    def refresh_lock_list(self) -> None:
        self.lock_list.clear()
        for idx, lock in enumerate(self.locks):
            x, y, w, h = lock.as_rect()
            self.lock_list.addItem(f"#{idx + 1}  x={x}, y={y}, {w}×{h}")
        for panel in getattr(self, "panels", {}).values():
            panel.canvas.set_lock_regions(self.locks)

    def delete_selected_lock(self) -> None:
        row = self.lock_list.currentRow()
        if 0 <= row < len(self.locks):
            del self.locks[row]
            self.refresh_lock_list()
            self.schedule_both(force=True)

    def clear_locks(self) -> None:
        if not self.locks:
            return
        self.locks.clear()
        self.refresh_lock_list()
        self.schedule_both(force=True)

    # ------------------------------------------------------------ compute
    def schedule_version(self, key: str) -> None:
        form = self.forms[key]
        if form.auto_update.isChecked():
            self._dirty.add(key)
            self._timer.start()

    def schedule_both(self, force: bool = False) -> None:
        for key in ("A", "B"):
            if force or self.forms[key].auto_update.isChecked():
                self._dirty.add(key)
        if self._dirty:
            self._timer.start()

    def run_all_now(self) -> None:
        self._dirty.update(("A", "B"))
        self._flush_dirty()

    def run_version_now(self, key: str) -> None:
        self._dirty.add(key)
        self._flush_dirty()

    def _flush_dirty(self) -> None:
        keys = sorted(self._dirty)
        self._dirty.clear()
        for key in keys:
            self.run_version(key)

    def _params_with_selection(self, key: str) -> StackParams:
        params = self.forms[key].params()
        max_index = len(self.items)
        end = self.end_spin.value() if max_index else None
        excluded = {item.original_index for item in self.items if item.excluded}
        return replace(params, start=self.start_spin.value() if max_index else 1, end=end, excluded=excluded)

    def run_version(self, key: str) -> None:
        state = self.versions[key]
        panel = self.panels[key]
        if not self.items or not self.arrays_by_index:
            state.result = None
            panel.canvas.clear_image()
            panel.info.setText("请先导入同尺寸图片序列，或点击“生成样例”。")
            return

        frames, indices, numbers, names = self.usable_data()
        if not frames:
            state.result = None
            state.error = "no usable frames"
            state.contributors = []
            panel.canvas.clear_image()
            panel.info.setText("没有尺寸一致且可读取的帧。")
            self.refresh_table_stats()
            return

        params = self._params_with_selection(key)
        state.params = params
        try:
            result = stack_sequence(frames, params, original_indices=indices, locks=self.locks)
        except Exception as exc:
            state.result = None
            state.error = repr(exc)
            state.contributors = []
            panel.canvas.clear_image()
            panel.info.setText(f"当前范围/排除设置无法计算：{exc}。请恢复至少一帧。")
            self.statusBar().showMessage(f"版本 {key} 计算失败：{exc}", 8000)
            if self.contributor_key == key:
                self.contributor_table.setRowCount(0)
                self.contributor_summary.setText("当前设置没有可分析的参与帧")
            self.refresh_table_stats()
            return

        state.result = result
        state.error = None
        array = source_overlay(result) if state.source_overlay else result.image
        panel.canvas.set_array(array)
        retained = int(result.retained_mask.sum())
        active = len(result.active_indices)
        method_name = "取亮部" if params.method == "brighten" else "按出现次数"
        flash = f"；反光帧 {result.flash_indices}" if result.flash_indices else ""
        warning = "；".join(result.warnings)
        panel.info.setText(
            f"{method_name}｜参与 {active} 帧｜{result.width}×{result.height}｜保留像素 {retained:,}{flash}\n{warning}"
        )
        self.refresh_table_stats()

        if state.roi is not None:
            self.query_roi(key, update_table=(self.contributor_key == key))

    def copy_parameters(self, from_key: str) -> None:
        to_key = "B" if from_key == "A" else "A"
        params = self.forms[from_key].params()
        self.forms[to_key].set_params(params)
        self.schedule_version(to_key)
        self.statusBar().showMessage(f"已把参数 {from_key} 复制到 {to_key}（帧范围和锁为共享设置）。", 5000)

    def refresh_table_stats(self, result=None) -> None:
        """Refresh the shared marker column from both retained versions."""
        if not hasattr(self, "table"):
            return
        for item in self.items:
            row = self.row_by_original.get(item.original_index)
            if row is None:
                continue
            status_item = self.table.item(row, 5)
            check_item = self.table.item(row, 0)
            if check_item is not None:
                self.table.blockSignals(True)
                check_item.setCheckState(Qt.CheckState.Unchecked if item.excluded else Qt.CheckState.Checked)
                self.table.blockSignals(False)
            if status_item is None:
                continue

            if item.load_error:
                status_item.setText("尺寸/读取异常")
                status_item.setToolTip(item.load_error)
                continue

            start = self.start_spin.value()
            end = self.end_spin.value()
            if item.excluded:
                text = "已手工排除，原序号保留"
                status_item.setToolTip(text)
            elif not (start <= item.original_index <= end):
                text = "范围外"
                status_item.setToolTip(text)
            else:
                labels: list[str] = []
                tooltip_lines: list[str] = []
                for key in ("A", "B"):
                    version_result = self.versions[key].result
                    if version_result is None:
                        labels.append(f"{key}:—")
                        continue
                    stat = version_result.stat_for(item.original_index)
                    if stat is None or not stat.included:
                        labels.append(f"{key}:–")
                        continue
                    if stat.flash_detected:
                        labels.append(f"{key}:反光")
                    else:
                        labels.append(f"{key}:{stat.contributed_pixels:,}")
                    tooltip_lines.append(
                        f"版本 {key}: 候选 {stat.candidate_pixels:,} px，"
                        f"保留贡献 {stat.contributed_pixels:,} px，"
                        f"反光分数 {stat.flash_score:.1f}"
                        + ("（判定反光）" if stat.flash_detected else "")
                    )
                text = "  ".join(labels)
                status_item.setToolTip("\n".join(tooltip_lines))
            status_item.setText(text)

    # ------------------------------------------------------------- ROI query
    def on_roi_selected(self, key: str, rect) -> None:
        state = self.versions[key]
        if rect is None or rect.isEmpty() or rect.width() < 3 or rect.height() < 3:
            state.roi = None
            state.contributors = []
            self.panels[key].canvas.clear_roi()
            if self.contributor_key == key:
                self.contributor_table.setRowCount(0)
                self.contributor_summary.setText("选区已清除")
            return
        state.roi = (rect.x(), rect.y(), rect.width(), rect.height())
        self.contributor_key = key
        self.query_roi(key, update_table=True)

    def clear_roi(self, key: str) -> None:
        state = self.versions[key]
        state.roi = None
        state.contributors = []
        self.panels[key].canvas.clear_roi()
        if self.contributor_key == key:
            self.contributor_table.setRowCount(0)
            self.contributor_summary.setText("选区已清除")

    def query_roi(self, key: str, update_table: bool = True) -> None:
        state = self.versions[key]
        if state.roi is None or not self.usable_data()[0]:
            return
        frames, indices, numbers, names = self.usable_data()
        try:
            contributions = roi_contributors(
                frames,
                state.params,
                state.roi,
                original_indices=indices,
                locks=self.locks,
                source_numbers=numbers,
                file_names=names,
            )
        except Exception as exc:
            self.statusBar().showMessage(f"选区来源分析失败：{exc}", 6000)
            return
        state.contributors = contributions
        if update_table:
            self.contributor_key = key
            self.populate_contributor_table()

    def populate_contributor_table(self) -> None:
        key = self.contributor_key
        state = self.versions.get(key)
        if state is None:
            return
        contributions = state.contributors
        only_active = self.only_contributors_check.isChecked()
        rows = []
        for contrib in contributions:
            if only_active and contrib.retained_pixels == 0 and contrib.candidate_pixels == 0:
                continue
            rows.append(contrib)

        self.contributor_table.setRowCount(0)
        for contrib in rows:
            row = self.contributor_table.rowCount()
            self.contributor_table.insertRow(row)
            status = "参与" if contrib.included else "未参与"
            if contrib.flash_detected:
                status = "反光抑制"
            elif contrib.retained_pixels:
                status = "贡献保留像素"
            values = [
                str(contrib.original_index),
                str(contrib.source_number if contrib.source_number is not None else "—"),
                contrib.file_name,
                f"{contrib.retained_pixels:,}",
                f"{contrib.candidate_pixels:,}",
                f"{contrib.max_excess:.1f}",
                status,
            ]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                if col != 2:
                    item.setTextAlignment(Qt.AlignmentFlag.AlignCenter)
                item.setData(Qt.ItemDataRole.UserRole, contrib.original_index)
                self.contributor_table.setItem(row, col, item)

        retained_frames = sum(1 for c in contributions if c.retained_pixels > 0)
        bright_frames = sum(1 for c in contributions if c.candidate_pixels > 0)
        x, y, w, h = state.roi or (0, 0, 0, 0)
        self.contributor_summary.setText(
            f"版本 {key}｜选区 ({x},{y}) {w}×{h}｜保留来源 {retained_frames} 帧，见亮部 {bright_frames} 帧，表中 {len(rows)} 行"
        )
        self.contributor_table.resizeColumnsToContents()
        self.contributor_table.horizontalHeader().setSectionResizeMode(2, self.contributor_table.horizontalHeader().ResizeMode.Stretch)

    def on_contributor_selected(self) -> None:
        row = self.contributor_table.currentRow()
        if row < 0:
            return
        item = self.contributor_table.item(row, 0)
        if item is None:
            return
        original = item.data(Qt.ItemDataRole.UserRole)
        if original is not None:
            self.select_original(int(original))

    # ------------------------------------------------------------- overlays
    def toggle_source_overlay(self, key: str, checked: bool) -> None:
        state = self.versions[key]
        state.source_overlay = checked
        if state.result is not None:
            array = source_overlay(state.result) if checked else state.result.image
            self.panels[key].canvas.set_array(array)

    # --------------------------------------------------------------- export
    def export_image(self, key: str) -> None:
        state = self.versions[key]
        if state.result is None:
            QMessageBox.information(self, "暂无叠图", f"版本 {key} 还没有可导出的结果。")
            return
        default = str(Path.cwd() / f"light_trail_stack_{key}.png")
        path, selected_filter = QFileDialog.getSaveFileName(
            self, f"导出版本 {key} 叠图", default, "PNG 图片 (*.png);;JPEG 图片 (*.jpg *.jpeg);;BMP (*.bmp)"
        )
        if not path:
            return
        target = Path(path)
        if target.suffix == "":
            target = target.with_suffix(".png" if "PNG" in selected_filter else ".jpg")
        try:
            save_rgb(target, state.result.image)
            self.statusBar().showMessage(f"叠图已导出：{target}", 10000)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", repr(exc))

    def export_frame_list_for_version(self, key: str) -> None:
        if not self.items:
            QMessageBox.information(self, "暂无帧", "请先导入图片序列。")
            return
        state = self.versions[key]
        default = str(Path.cwd() / f"participating_frames_{key}.csv")
        path, selected_filter = QFileDialog.getSaveFileName(
            self, f"导出版本 {key} 参与帧列表", default, "CSV 表格 (*.csv);;文本列表 (*.txt)"
        )
        if not path:
            return
        target = Path(path)
        if target.suffix == "":
            target = target.with_suffix(".txt" if "文本" in selected_filter else ".csv")
        roi_contribs = state.contributors if self.contributor_key == key else None
        try:
            export_frame_list(target, self.items, state.params, state.result, roi_contribs)
            self.statusBar().showMessage(f"参与帧列表已导出：{target}", 10000)
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", repr(exc))


def main() -> int:
    import sys

    app = QApplication(sys.argv)
    app.setApplicationName("Light Trail Stacker")
    window = MainWindow()
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
