"""PySide6 主窗口：打开素材、标禁放区、审查候选位并导出成片。"""

from __future__ import annotations

import math
from dataclasses import asdict
from pathlib import Path

from PySide6.QtCore import Qt
from PySide6.QtWidgets import (
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMessageBox,
    QPlainTextEdit,
    QProgressDialog,
    QPushButton,
    QSlider,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTabWidget,
    QVBoxLayout,
    QWidget,
)

from .exporter import export_video
from .media import probe_video
from .model import Cue, Obstacle, Project, Rect
from .planner import PlacementStore
from .sample_video import generate_sample, sample_obstacles
from .srt import read_srt, write_srt
from .video_view import VideoView


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("短片字幕避让窗口")
        self.resize(1440, 900)

        self.project = Project()
        self.cues = []
        self.store: PlacementStore | None = None
        self.project_path: Path | None = None
        self.moments = []
        self.current_moment_index = -1
        self._loading_obstacle = False

        self.view = VideoView()
        self.view.timeChanged.connect(self.on_time_changed)
        self.view.rectangleDrawn.connect(self.add_drawn_obstacle)
        self.view.obstacleSelected.connect(self.on_obstacle_selected)
        self.view.obstacleGeometryChanged.connect(self.on_obstacle_geometry_changed)
        self.view.manualPositionCommitted.connect(self.commit_manual_position)

        self._build_toolbar()
        self._build_central()
        self._refresh_all_views()

    # ---------- UI 构建 ----------
    def _build_toolbar(self) -> None:
        toolbar = self.addToolBar("文件")
        toolbar.setMovable(False)
        for text, slot in (
            ("打开视频", self.choose_video),
            ("打开 SRT", self.choose_srt),
            ("另存编辑后 SRT", self.save_srt_dialog),
            ("保存工程", self.save_project_dialog),
            ("打开工程", self.open_project_dialog),
            ("生成内置短片", self.generate_builtin),
            ("导出带字成片", self.export_dialog),
        ):
            btn = QPushButton(text)
            btn.clicked.connect(slot)
            toolbar.addWidget(btn)
            toolbar.addSeparator()

    def _build_central(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)
        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(8, 8, 8, 8)
        left_layout.addWidget(self.view, 1)
        left_layout.addLayout(self._build_transport())

        right = QTabWidget()
        right.addTab(self._build_cue_tab(), "字幕与增量结果")
        right.addTab(self._build_obstacle_tab(), "禁放矩形")
        right.addTab(self._build_issue_tab(), "冲突与步进")
        right.setMinimumWidth(470)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 3)
        splitter.setStretchFactor(1, 1)
        self.setCentralWidget(splitter)

        self.statusBar().showMessage("先打开短片和 SRT，或点击“生成内置短片”。")

    def _build_transport(self) -> QHBoxLayout:
        layout = QHBoxLayout()
        self.play_button = QPushButton("播放/暂停")
        self.play_button.clicked.connect(self.view.toggle_play)
        self.time_label = QLabel("0.000 / 0.000 s")
        self.time_label.setMinimumWidth(150)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 1000)
        # valueChanged 同时覆盖拖拽、键盘方向键和点击 groove；程序化 setValue
        # 在 on_time_changed 中会 blockSignals，不会形成回环。
        self.slider.valueChanged.connect(self._on_slider_moved)

        self.prev_moment_btn = QPushButton("← 上一变化点")
        self.next_moment_btn = QPushButton("下一变化点 →")
        self.prev_moment_btn.clicked.connect(self.previous_moment)
        self.next_moment_btn.clicked.connect(self.next_moment)
        self.moment_combo = QComboBox()
        self.moment_combo.setMinimumWidth(260)
        self.moment_combo.currentIndexChanged.connect(self._on_moment_chosen)

        layout.addWidget(self.play_button)
        layout.addWidget(self.time_label)
        layout.addWidget(self.slider, 2)
        layout.addWidget(self.prev_moment_btn)
        layout.addWidget(self.moment_combo, 1)
        layout.addWidget(self.next_moment_btn)
        return layout

    def _build_cue_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        self.cue_table = QTableWidget(0, 5)
        self.cue_table.setHorizontalHeaderLabels(["#", "开始", "结束", "位置", "状态"])
        self.cue_table.setSelectionBehavior(QTableWidget.SelectionBehavior.SelectRows)
        self.cue_table.setSelectionMode(QTableWidget.SelectionMode.SingleSelection)
        self.cue_table.cellClicked.connect(self.on_cue_selected)
        self.cue_table.doubleClicked.connect(self.inspect_selected_cue_at_start)
        layout.addWidget(self.cue_table, 2)

        editor_box = QGroupBox("选中字幕（实际换行由当前视频分辨率和字体度量计算）")
        form = QFormLayout(editor_box)
        self.cue_start_spin = self._time_spin()
        self.cue_end_spin = self._time_spin()
        self.cue_text_edit = QPlainTextEdit()
        self.cue_text_edit.setMinimumHeight(90)
        form.addRow("开始(s)", self.cue_start_spin)
        form.addRow("结束(s)", self.cue_end_spin)
        form.addRow("文本", self.cue_text_edit)

        row = QHBoxLayout()
        apply_btn = QPushButton("应用修改并增量重排")
        apply_btn.clicked.connect(self.apply_cue_edit)
        clear_manual_btn = QPushButton("清除人工位置")
        clear_manual_btn.clicked.connect(self.clear_selected_manual)
        row.addWidget(apply_btn)
        row.addWidget(clear_manual_btn)
        form.addRow(row)
        layout.addWidget(editor_box, 1)

        self.update_label = QLabel("增量更新：尚未修改")
        self.update_label.setWordWrap(True)
        layout.addWidget(self.update_label)
        return widget

    def _build_obstacle_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)

        mode_row = QHBoxLayout()
        self.mode_combo = QComboBox()
        self.mode_combo.addItem("拖拽绘制/移动禁放矩形", "obstacle")
        self.mode_combo.addItem("拖拽当前字幕框进行人工指定", "manual")
        self.mode_combo.currentIndexChanged.connect(self._on_mode_changed)
        self.show_candidates_check = QCheckBox("显示当前时刻候选框")
        self.show_candidates_check.toggled.connect(self._on_show_candidates)
        mode_row.addWidget(QLabel("鼠标模式"))
        mode_row.addWidget(self.mode_combo, 1)
        mode_row.addWidget(self.show_candidates_check)
        layout.addLayout(mode_row)

        self.obstacle_list = QListWidget()
        self.obstacle_list.currentRowChanged.connect(self.on_obstacle_row_changed)
        layout.addWidget(self.obstacle_list, 1)

        form_box = QGroupBox("矩形使用原视频坐标；缩放窗口只改变显示映射")
        form = QFormLayout(form_box)
        self.obs_name = QLabel("-")
        self.obs_x = self._coord_spin()
        self.obs_y = self._coord_spin()
        self.obs_w = self._coord_spin(1, 100000)
        self.obs_h = self._coord_spin(1, 100000)
        self.obs_start = self._time_spin()
        self.obs_end = self._time_spin()
        for spin in (self.obs_x, self.obs_y, self.obs_w, self.obs_h, self.obs_start, self.obs_end):
            spin.valueChanged.connect(self.on_obstacle_form_changed)
        form.addRow("名称", self.obs_name)
        form.addRow("x", self.obs_x)
        form.addRow("y", self.obs_y)
        form.addRow("宽", self.obs_w)
        form.addRow("高", self.obs_h)
        form.addRow("开始(s)", self.obs_start)
        form.addRow("结束(s)", self.obs_end)

        btn_row = QHBoxLayout()
        set_start_now = QPushButton("开始=当前时间")
        set_end_now = QPushButton("结束=当前时间")
        delete_btn = QPushButton("删除矩形")
        set_start_now.clicked.connect(lambda: self.set_selected_obstacle_time("start", self.view.time))
        set_end_now.clicked.connect(lambda: self.set_selected_obstacle_time("end", self.view.time))
        delete_btn.clicked.connect(self.delete_selected_obstacle)
        btn_row.addWidget(set_start_now)
        btn_row.addWidget(set_end_now)
        btn_row.addWidget(delete_btn)
        form.addRow(btn_row)
        layout.addWidget(form_box, 1)

        demo_row = QHBoxLayout()
        fill_demo_btn = QPushButton("填入内置短片的四个标区")
        fill_demo_btn.clicked.connect(self.fill_demo_obstacles)
        demo_row.addWidget(fill_demo_btn)
        layout.addLayout(demo_row)
        return widget

    def _build_issue_tab(self) -> QWidget:
        widget = QWidget()
        layout = QVBoxLayout(widget)
        layout.addWidget(QLabel("所有候选都无法避开整条字幕时间窗时，会在这里和时间轴变化点中标出。"))
        self.issue_list = QListWidget()
        self.issue_list.itemActivated.connect(self.jump_to_issue)
        self.issue_list.itemClicked.connect(self.jump_to_issue)
        layout.addWidget(self.issue_list, 1)
        self.collision_label = QLabel("当前帧碰撞检查：-")
        self.collision_label.setWordWrap(True)
        layout.addWidget(self.collision_label)
        return widget

    def _coord_spin(self, minimum: float = -100000, maximum: float = 100000) -> QDoubleSpinBox:
        spin = QDoubleSpinBox()
        spin.setDecimals(1)
        spin.setRange(minimum, maximum)
        spin.setSingleStep(2.0)
        return spin

    def _time_spin(self) -> QDoubleSpinBox:
        spin = QDoubleSpinBox()
        spin.setDecimals(3)
        spin.setRange(0.0, 100000.0)
        spin.setSingleStep(0.1)
        return spin

    # ---------- 文件 ----------
    def choose_video(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开短片", "", "视频 (*.mp4 *.mov *.mkv *.m4v)")
        if path:
            self.open_video(path)

    def open_video(self, path: str | Path) -> None:
        info = probe_video(path)
        self.project.video_path = str(Path(path).resolve())
        self.project.width = info.width
        self.project.height = info.height
        self.project.fps = info.fps
        self.project.duration = info.duration
        self.view.set_video_size(info.width, info.height)
        self.view.load_media(path)
        if info.duration > 0:
            self.view.duration = info.duration
            self.slider.setMaximum(max(1, int(info.duration * 1000)))
        self.statusBar().showMessage(f"视频：{info.width}×{info.height} {info.fps:.2f}fps")
        self.rebuild_store()

    def choose_srt(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开 SRT", "", "SRT (*.srt)")
        if path:
            self.open_srt(path)

    def open_srt(self, path: str | Path) -> None:
        self.cues = read_srt(path)
        self.project.srt_path = str(Path(path).resolve())
        self.project.cues = [asdict(c) for c in self.cues]
        self.rebuild_store()
        self.statusBar().showMessage(f"已读取 {len(self.cues)} 条字幕")

    def save_srt_dialog(self) -> None:
        if not self.cues:
            QMessageBox.warning(self, "无法保存", "还没有字幕。")
            return
        default = "subtitles_edited.srt"
        if self.project.srt_path:
            p = Path(self.project.srt_path)
            default = str(p.with_name(p.stem + "_edited.srt"))
        path, _ = QFileDialog.getSaveFileName(self, "另存 SRT", default, "SRT (*.srt)")
        if path:
            write_srt(path, self.cues)
            self.statusBar().showMessage(f"编辑后 SRT 已保存：{path}")

    def save_project_dialog(self) -> None:
        path, _ = QFileDialog.getSaveFileName(self, "保存工程", "subtitle_project.json", "JSON (*.json)")
        if path:
            self.save_project(path)

    def save_project(self, path: str | Path) -> Path:
        self.project_path = Path(path)
        self.project.cues = [asdict(c) for c in self.cues]
        self.project.save(self.project_path)
        self.statusBar().showMessage(f"工程已保存：{self.project_path}")
        return self.project_path

    def open_project_dialog(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开工程", "", "JSON (*.json)")
        if path:
            self.load_project(path)

    def load_project(self, path: str | Path) -> None:
        project = Project.load(path)
        self.project = project
        self.project_path = Path(path)
        if project.cues:
            self.cues = [Cue(**item) for item in project.cues]
        elif project.srt_path and Path(project.srt_path).exists():
            self.cues = read_srt(project.srt_path)
        else:
            self.cues = []
        self.view.set_video_size(project.width, project.height)
        if project.video_path and Path(project.video_path).exists():
            info = probe_video(project.video_path)
            # 以实际视频流为准，避免手工改 JSON 后预览/导出坐标系不一致。
            project.width = info.width
            project.height = info.height
            project.fps = info.fps
            project.duration = info.duration or project.duration
            self.view.set_video_size(info.width, info.height)
            self.view.load_media(project.video_path)
            self.view.duration = info.duration or project.duration
            self.slider.setMaximum(max(1, int((info.duration or project.duration) * 1000)))
        self.rebuild_store()

    def generate_builtin(self) -> None:
        out_dir = QFileDialog.getExistingDirectory(self, "选择内置短片输出目录", str(Path.cwd()))
        if not out_dir:
            return
        assets = generate_sample(Path(out_dir) / "builtin_demo")
        self.project = Project()
        self.cues = assets.cues
        self.project.video_path = str(assets.video_path.resolve())
        self.project.srt_path = str(assets.srt_path.resolve())
        self.project.width = 1280
        self.project.height = 720
        self.project.fps = 24
        self.project.duration = 12.0
        self.project.obstacles = []
        self.project.manual_positions = {}
        self.view.set_video_size(1280, 720)
        self.view.load_media(assets.video_path)
        self.view.duration = 12.0
        self.slider.setMaximum(12000)
        self.rebuild_store()
        self.statusBar().showMessage("内置短片已生成；可在禁放矩形页填入演示标区或自行拖拽标注。")

    def fill_demo_obstacles(self) -> None:
        existing = {o.id for o in self.project.obstacles}
        for o in sample_obstacles():
            if o.id not in existing:
                self.project.obstacles.append(o)
        self.rebuild_store()
        self._refresh_obstacle_list()
        self.statusBar().showMessage("已按内置短片的题板和滑入图填入标区。")

    def export_dialog(self) -> None:
        if not self.project.video_path or self.store is None:
            QMessageBox.warning(self, "无法导出", "请先打开视频和 SRT。")
            return
        default = str(Path(self.project.video_path).with_name("subtitled_output.mp4"))
        path, _ = QFileDialog.getSaveFileName(self, "导出带字成片", default, "MP4 (*.mp4)")
        if not path:
            return
        try:
            self.export_to(path)
        except RuntimeError as exc:
            QMessageBox.warning(self, "暂时不能导出", str(exc))

    def export_to(self, path: str | Path) -> Path:
        if self.store is None:
            raise RuntimeError("尚未建立放置结果")
        issues = self.store.issues()
        if issues:
            self.tabs_set_issue_tab()
            raise RuntimeError(
                "仍有字幕没有安全候选位；请在冲突页选择字幕并把字幕框拖到人工位置。"
            )
        progress = QProgressDialog("正在导出...", None, 0, 100, self)
        self.view.still_timer.stop()
        progress.setWindowModality(Qt.WindowModality.WindowModal)
        progress.show()

        def cb(stage: str, i: int, n: int) -> None:
            if stage == "render" and n:
                progress.setMaximum(n + 1)
                progress.setValue(i)
            else:
                progress.setMaximum(1)
                progress.setValue(1)
            QApplication_process_events()

        try:
            result = export_video(
                self.project.video_path,
                path,
                self.project.width,
                self.project.height,
                self.cues,
                self.store.placements,
                style=self.project.style or None,
                strict=True,
                progress=cb,
            )
        finally:
            progress.close()
        self.statusBar().showMessage(f"导出完成：{result}")
        return result

    def tabs_set_issue_tab(self) -> None:
        tabs = self.centralWidget().findChild(QTabWidget)
        if tabs:
            tabs.setCurrentIndex(2)

    # ---------- 状态与视图刷新 ----------
    def rebuild_store(self) -> None:
        self.store = PlacementStore(
            self.project.width,
            self.project.height,
            self.cues,
            self.project.obstacles,
            self.project.manual_positions,
            self.project.style or None,
        )
        self.store.rebuild()
        self.view.set_scene(self.store)
        self.view.duration = self.project.duration or max((c.end for c in self.cues), default=0.0)
        if self.view.duration:
            self.slider.setMaximum(max(1, int(self.view.duration * 1000)))
        self.rebuild_moments()
        self._refresh_all_views()

    def _refresh_all_views(self) -> None:
        self._refresh_cue_table()
        self._refresh_obstacle_list()
        self._refresh_issue_list()
        self._refresh_moment_combo()
        self.update_time_ui()
        self.view.update()

    def _refresh_cue_table(self) -> None:
        selected_id = self.selected_cue_id()
        self.cue_table.blockSignals(True)
        self.cue_table.setRowCount(len(self.cues))
        select_row = -1
        for row, cue in enumerate(self.cues):
            placement = self.store.placements.get(cue.id) if self.store else None
            pos = placement.slot_id if placement else "-"
            if placement and placement.manual:
                pos = "manual"
            status = "安全" if placement and placement.safe else "冲突/待指定"
            values = [str(cue.index), f"{cue.start:.3f}", f"{cue.end:.3f}", pos, status]
            for col, value in enumerate(values):
                item = QTableWidgetItem(value)
                item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
                if col == 4 and status != "安全":
                    item.setForeground(Qt.GlobalColor.red)
                self.cue_table.setItem(row, col, item)
            if cue.id == selected_id:
                select_row = row
        if select_row >= 0:
            self.cue_table.selectRow(select_row)
        self.cue_table.blockSignals(False)
        if select_row < 0 and self.cues:
            self.cue_table.selectRow(0)
        self._load_selected_cue_in_editor()

    def selected_cue_id(self) -> str | None:
        row = self.cue_table.currentRow()
        if 0 <= row < len(self.cues):
            return self.cues[row].id
        return None

    def on_cue_selected(self, *_args) -> None:
        cue = self.selected_cue()
        if cue:
            self.view.current_cue_id = cue.id
            self._load_selected_cue_in_editor()
            self.view.update()

    def inspect_selected_cue_at_start(self, *_args) -> None:
        cue = self.selected_cue()
        if cue:
            self.view.current_cue_id = cue.id
            self.view.seek(cue.start + 0.001)

    def selected_cue(self):
        cue_id = self.selected_cue_id()
        return next((c for c in self.cues if c.id == cue_id), None)

    def _load_selected_cue_in_editor(self) -> None:
        cue = self.selected_cue()
        if cue is None:
            self.cue_text_edit.setPlainText("")
            return
        self.cue_start_spin.blockSignals(True)
        self.cue_end_spin.blockSignals(True)
        self.cue_start_spin.setValue(cue.start)
        self.cue_end_spin.setValue(cue.end)
        self.cue_text_edit.setPlainText(cue.text)
        self.cue_start_spin.blockSignals(False)
        self.cue_end_spin.blockSignals(False)

    def apply_cue_edit(self) -> None:
        if self.store is None:
            return
        cue = self.selected_cue()
        if cue is None:
            return
        new_start = float(self.cue_start_spin.value())
        requested_end = float(self.cue_end_spin.value())
        new_end = max(new_start + 0.05, requested_end)
        new_text = self.cue_text_edit.toPlainText()
        time_changed = cue.start != new_start or cue.end != new_end
        text_changed = cue.text != new_text
        cue.start, cue.end, cue.text = new_start, new_end, new_text

        if not time_changed and text_changed:
            outcome = self.store.cue_text_edited(cue.id)
            msg = (
                f"字幕 {cue.index} 已增量更新：重算 {len(outcome.recomputed_ids)} 条，"
                f"实际改变 {len(outcome.changed_ids)} 条 {outcome.changed_ids}"
            )
        elif time_changed:
            self.cues.sort(key=lambda c: c.start)
            for i, ordered_cue in enumerate(self.cues, 1):
                ordered_cue.index = i
            changed = self.store.refresh_all()
            msg = f"时间/顺序变化，已核对全部字幕；实际改变 {len(changed)} 条"
        else:
            msg = "字幕内容和时间均未变化"
        self.update_label.setText(msg)
        self.statusBar().showMessage(msg)
        self.rebuild_moments()
        self._refresh_cue_table()
        self._refresh_issue_list()
        self._refresh_moment_combo()
        self.view.update()

    def clear_selected_manual(self) -> None:
        cue = self.selected_cue()
        if cue:
            self.project.manual_positions.pop(cue.id, None)
            if self.store:
                outcome = self.store.cue_text_edited(cue.id)
                self.update_label.setText(f"已清除人工位置，实际改变 {outcome.changed_ids}")
            self._refresh_all_views()

    # ---------- 禁放矩形 ----------
    def _refresh_obstacle_list(self, reload_form: bool = True) -> None:
        current = self.view.selected_obstacle_id
        self.obstacle_list.blockSignals(True)
        self.obstacle_list.clear()
        select_row = -1
        for i, o in enumerate(self.project.obstacles):
            item = QListWidgetItem(f"{o.name}  [{o.start:.2f}-{o.end:.2f}s]  ({o.rect.x:.0f},{o.rect.y:.0f},{o.rect.w:.0f}×{o.rect.h:.0f})")
            item.setData(Qt.ItemDataRole.UserRole, o.id)
            self.obstacle_list.addItem(item)
            if o.id == current:
                select_row = i
        if select_row >= 0:
            self.obstacle_list.setCurrentRow(select_row)
        self.obstacle_list.blockSignals(False)
        if reload_form:
            self._load_obstacle_form()

    def on_obstacle_row_changed(self, row: int) -> None:
        if row < 0 or row >= len(self.project.obstacles):
            return
        o = self.project.obstacles[row]
        self.view.selected_obstacle_id = o.id
        self._load_obstacle_form()
        self.view.update()

    def on_obstacle_selected(self, obstacle_id: str) -> None:
        row = next((i for i, o in enumerate(self.project.obstacles) if o.id == obstacle_id), -1)
        if row >= 0:
            self.obstacle_list.setCurrentRow(row)
        self._load_obstacle_form()

    def _selected_obstacle(self) -> Obstacle | None:
        oid = self.view.selected_obstacle_id
        return next((o for o in self.project.obstacles if o.id == oid), None)

    def _load_obstacle_form(self) -> None:
        o = self._selected_obstacle()
        self._loading_obstacle = True
        try:
            if o is None:
                self.obs_name.setText("-")
                return
            self.obs_name.setText(f"{o.id} / {o.name}")
            self.obs_x.setValue(o.rect.x)
            self.obs_y.setValue(o.rect.y)
            self.obs_w.setValue(o.rect.w)
            self.obs_h.setValue(o.rect.h)
            self.obs_start.setValue(o.start)
            self.obs_end.setValue(o.end)
        finally:
            self._loading_obstacle = False

    def on_obstacle_form_changed(self, *_args) -> None:
        if self._loading_obstacle:
            return
        o = self._selected_obstacle()
        if o is None:
            return
        o.rect = Rect(
            float(self.obs_x.value()),
            float(self.obs_y.value()),
            max(1.0, float(self.obs_w.value())),
            max(1.0, float(self.obs_h.value())),
        )
        o.start = float(self.obs_start.value())
        o.end = max(o.start + 0.05, float(self.obs_end.value()))
        if abs(o.end - float(self.obs_end.value())) > 1e-9:
            self.obs_end.blockSignals(True)
            self.obs_end.setValue(o.end)
            self.obs_end.blockSignals(False)
        self.on_obstacle_geometry_changed(o.id, o.rect, refresh_form=False)

    def on_obstacle_geometry_changed(self, obstacle_id: str, rect: Rect, refresh_form: bool = True) -> None:
        if self.store is None:
            return
        changed = self.store.refresh_all()
        self._refresh_obstacle_list(reload_form=refresh_form)
        self._refresh_cue_table()
        self._refresh_issue_list()
        self.rebuild_moments()
        self._refresh_moment_combo()
        self.view.update()
        self.statusBar().showMessage(f"禁区 {obstacle_id} 已更新；{len(changed)} 条字幕放置结果改变")

    def set_selected_obstacle_time(self, which: str, t: float) -> None:
        o = self._selected_obstacle()
        if not o:
            return
        if which == "start":
            self.obs_start.setValue(t)
        else:
            self.obs_end.setValue(t)

    def delete_selected_obstacle(self) -> None:
        oid = self.view.selected_obstacle_id
        self.project.obstacles = [o for o in self.project.obstacles if o.id != oid]
        if self.store:
            self.store.obstacles = self.project.obstacles
        # VideoView 在 set_scene 时取的是列表引用；删除时重新赋值列表后必须同步，
        # 否则画面和鼠标命中测试会继续遍历已删除的“幽灵”矩形。
        self.view.obstacles = self.project.obstacles
        if self.store:
            self.store.refresh_all()
        self.view.selected_obstacle_id = None
        self._refresh_all_views()

    def add_drawn_obstacle(self, rect: Rect) -> None:
        idx = len(self.project.obstacles) + 1
        oid = f"obs_{idx}"
        while any(o.id == oid for o in self.project.obstacles):
            idx += 1
            oid = f"obs_{idx}"
        start = float(self.view.time)
        duration = self.view.duration or self.project.duration or start + 3.0
        end = min(duration, start + 3.0)
        if end <= start:
            end = start + 1.0
        obstacle = Obstacle(
            id=oid,
            name=f"禁放矩形 {idx}",
            rect=rect,
            start=start,
            end=end,
        )
        self.project.obstacles.append(obstacle)
        self.view.selected_obstacle_id = oid
        if self.store:
            self.store.refresh_all()
        self._refresh_obstacle_list()
        self._refresh_cue_table()
        self._refresh_issue_list()
        self.rebuild_moments()
        self._refresh_moment_combo()
        self.view.update()

    def _on_mode_changed(self, _idx: int) -> None:
        self.view.interaction_mode = self.mode_combo.currentData()

    def _on_show_candidates(self, checked: bool) -> None:
        self.view.show_candidates = checked
        self.view.update()

    # ---------- 人工位置 ----------
    def commit_manual_position(self, cue_id: str, x: float, y: float) -> None:
        if not math.isfinite(x) or not math.isfinite(y):
            self.project.manual_positions.pop(cue_id, None)
        else:
            self.project.manual_positions[cue_id] = {"x": float(x), "y": float(y)}
        if self.store:
            outcome = self.store.cue_text_edited(cue_id)
            self.update_label.setText(
                f"人工位置已提交：重算 {len(outcome.recomputed_ids)} 条，实际改变 {len(outcome.changed_ids)} 条"
            )
        self._refresh_cue_table()
        self._refresh_issue_list()
        self.view.update()

    # ---------- 时间、变化点、冲突 ----------
    def _on_slider_moved(self, value_ms: int) -> None:
        t = value_ms / 1000.0
        self.view.current_cue_id = None
        self.view.seek(t)

    def on_time_changed(self, t: float) -> None:
        if self.view.duration <= 0 and self.project.duration > 0:
            self.view.duration = self.project.duration
        self.slider.blockSignals(True)
        self.slider.setValue(int(t * 1000))
        self.slider.blockSignals(False)
        total = self.view.duration or self.project.duration or max((c.end for c in self.cues), default=0)
        self.time_label.setText(f"{t:06.3f} / {total:06.3f} s")
        self.update_collision_label(t)

    def update_time_ui(self) -> None:
        self.on_time_changed(self.view.time)

    def update_collision_label(self, t: float) -> None:
        if not self.store:
            return
        # 选中字幕/变化点后 view 会 pin 住该字幕；否则按播放时间找当前字幕。
        cue = self.view._current_cue()
        if cue is None:
            cue = next((c for c in self.cues if c.contains(t)), None)
        if cue is None:
            self.collision_label.setText("当前帧无字幕。")
            return
        pinned_prefix = "" if cue.contains(t) else "正在审查选中字幕（当前时间不在其区间）；"
        placement = self.store.placements.get(cue.id)
        if placement is None:
            return
        from .model import obstacles_at

        hits = self.store.planner.collisions_for_box(
            placement.box, obstacles_at(self.project.obstacles, t + 1e-7)
        )
        if hits:
            names = ", ".join(o.name for o in hits)
            self.collision_label.setText(
                pinned_prefix + f"字幕 {cue.index} 使用 {placement.slot_id}；当前帧与 {names} 相碰。"
            )
            self.collision_label.setStyleSheet("color:#dc2626; font-weight:bold;")
        elif placement.collisions:
            ids = ", ".join(placement.collisions)
            self.collision_label.setText(
                pinned_prefix
                + f"字幕 {cue.index} 当前帧未碰，但整条字幕时间窗仍与 {ids} 相碰；需要人工指定。"
            )
            self.collision_label.setStyleSheet("color:#d97706; font-weight:bold;")
        else:
            self.collision_label.setText(
                pinned_prefix
                + f"字幕 {cue.index} 使用 {placement.slot_id}；当前帧和整条时间窗检查均未碰禁区。"
            )
            self.collision_label.setStyleSheet("color:#16a34a; font-weight:bold;")

    def rebuild_moments(self) -> None:
        if not self.store:
            self.moments = []
            return
        duration = self.project.duration or self.view.duration or max(
            (c.end for c in self.cues), default=1.0
        )
        self.moments = self.store.planner.candidate_change_moments(
            self.cues, self.project.obstacles, duration
        )

    def _refresh_moment_combo(self) -> None:
        self.moment_combo.blockSignals(True)
        self.moment_combo.clear()
        for m in self.moments:
            cue = next((c for c in self.cues if c.id == m.cue_id), None)
            prefix = f"字幕{cue.index} " if cue else ""
            safe = "/".join(m.safe_slot_ids[:3]) if m.safe_slot_ids else "无安全候选"
            self.moment_combo.addItem(
                f"{m.time:06.2f}s {prefix}{m.reason}（安全: {safe}）", m.time
            )
        self.moment_combo.blockSignals(False)
        self.current_moment_index = -1

    def _on_moment_chosen(self, index: int) -> None:
        if 0 <= index < len(self.moments):
            self.jump_to_moment(index)

    def previous_moment(self) -> None:
        if not self.moments:
            return
        idx = max(0, self.current_moment_index - 1) if self.current_moment_index > 0 else 0
        self.jump_to_moment(idx)

    def next_moment(self) -> None:
        if not self.moments:
            return
        idx = min(len(self.moments) - 1, self.current_moment_index + 1)
        if self.current_moment_index < 0:
            t = self.view.time
            idx = next((i for i, m in enumerate(self.moments) if m.time > t + 1e-4), 0)
        self.jump_to_moment(idx)

    def jump_to_moment(self, index: int) -> None:
        if not (0 <= index < len(self.moments)):
            return
        self.current_moment_index = index
        moment = self.moments[index]
        self.moment_combo.blockSignals(True)
        self.moment_combo.setCurrentIndex(index)
        self.moment_combo.blockSignals(False)
        if moment.cue_id:
            self.view.current_cue_id = moment.cue_id
            row = next((i for i, c in enumerate(self.cues) if c.id == moment.cue_id), -1)
            if row >= 0:
                self.cue_table.selectRow(row)
        self.view.seek(moment.time + 0.001)
        self.statusBar().showMessage(
            f"变化点 {moment.time:.3f}s：{moment.reason}；安全候选 {moment.safe_slot_ids}"
        )

    def _refresh_issue_list(self) -> None:
        self.issue_list.clear()
        if not self.store:
            return
        for issue in self.store.issues():
            cue = next((c for c in self.cues if c.id == issue.cue_id), None)
            idx = cue.index if cue else "?"
            item = QListWidgetItem(
                f"字幕 {idx}：{issue.message}；标记时间 {['%.2f' % t for t in issue.marker_times]}"
            )
            item.setData(Qt.ItemDataRole.UserRole, issue.cue_id)
            item.setData(Qt.ItemDataRole.UserRole + 1, issue.marker_times[0])
            item.setForeground(Qt.GlobalColor.red)
            self.issue_list.addItem(item)

    def jump_to_issue(self, item: QListWidgetItem) -> None:
        cue_id = item.data(Qt.ItemDataRole.UserRole)
        t = float(item.data(Qt.ItemDataRole.UserRole + 1) or 0.0)
        row = next((i for i, c in enumerate(self.cues) if c.id == cue_id), -1)
        if row >= 0:
            self.cue_table.selectRow(row)
            self.view.current_cue_id = cue_id
        self.view.interaction_mode = "manual"
        self.mode_combo.setCurrentIndex(1)
        self.view.seek(t + 0.001)


def QApplication_process_events() -> None:
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    if app:
        app.processEvents()
