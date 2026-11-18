"""去隔行对比主窗口。

三个视图 (原始合帧 / 单倍去隔行 / 双倍去隔行) 按内容时间对齐:
  - 全局用「场序号 field_index」做时间游标, 每个视图把场序号映射到覆盖该
    场时间的输出帧, 因此双倍视图天然比单倍视图多一倍步进位置;
  - 所有显示时间来自 TimingModel (基于真实 pts), 不用帧率乘时间;
  - 切换场序只重建 single/double, raw 帧不变, 标签同步刷新。
"""
from __future__ import annotations

from PySide6.QtCore import QTimer
from PySide6.QtWidgets import (
    QApplication,
    QComboBox,
    QFileDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QSpinBox,
    QVBoxLayout,
    QWidget,
)

from .ffmpeg_tools import FFmpegError, export_deinterlaced, probe_media
from .frame_cache import FrameProvider, PrerenderWorker
from .sample_maker import SampleSpec, generate_sample
from .timing import TimingModel
from .view_panel import ViewPanel

MAX_DURATION = 8.0
MAX_HEIGHT = 720
MODES = ("raw", "single", "double")
MODE_TITLES = {
    "raw": "① 原始合帧 (保留梳齿)",
    "single": "② 单倍去隔行 yadif (每输入帧 1 帧)",
    "double": "③ 双倍去隔行 yadif (每场 1 帧)",
}


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地去隔行对比台 — 场序 / 输出节奏")
        self.resize(1480, 900)

        self.media = None
        self.timing: TimingModel | None = None
        self.provider: FrameProvider | None = None
        self.parity = "tff"
        self.field_index = 0
        self.workers: dict[str, PrerenderWorker] = {}
        self.threads = []
        self.ready_modes: set[str] = set()
        self.render_generation = 0

        self.play_timer = QTimer(self)
        self.play_timer.setInterval(40)
        self.play_timer.timeout.connect(self._tick_playback)
        self._last_tick_ms = 0

        self._build_ui()

    def closeEvent(self, event):  # noqa: N802
        """退出前停止所有预渲染线程并清理帧缓存。"""
        self.play_timer.stop()
        for worker in self.workers.values():
            worker.cancel()
        for thread in self.threads:
            try:
                if thread.isRunning():
                    thread.quit()
                    thread.wait(3000)
            except RuntimeError:
                # 线程已随 finished -> deleteLater 被 C++ 回收。
                pass
        if self.provider:
            self.provider.cleanup()
        super().closeEvent(event)

    # ---------------- UI 构建 ----------------
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)

        # 顶部控制条
        top = QHBoxLayout()
        self.btn_open = QPushButton("打开交错视频…")
        self.btn_open.clicked.connect(self.open_file)
        self.btn_sample = QPushButton("生成样例…")
        self.btn_sample.clicked.connect(self.make_samples)
        top.addWidget(self.btn_open)
        top.addWidget(self.btn_sample)

        top.addWidget(QLabel("场序(手动):"))
        self.combo_parity = QComboBox()
        self.combo_parity.addItems(["tff 上场优先", "bff 下场优先"])
        self.combo_parity.currentIndexChanged.connect(self.on_parity_changed)
        self.combo_parity.setEnabled(False)
        top.addWidget(self.combo_parity)

        top.addWidget(QLabel("放大倍数:"))
        self.spin_zoom = QSpinBox()
        self.spin_zoom.setRange(1, 12)
        self.spin_zoom.setValue(3)
        self.spin_zoom.valueChanged.connect(self.on_zoom_changed)
        top.addWidget(self.spin_zoom)
        top.addStretch(1)

        self.btn_export_single = QPushButton("导出单倍成品…")
        self.btn_export_double = QPushButton("导出双倍成品…")
        self.btn_export_single.clicked.connect(lambda: self.export("single"))
        self.btn_export_double.clicked.connect(lambda: self.export("double"))
        self.btn_export_single.setEnabled(False)
        self.btn_export_double.setEnabled(False)
        top.addWidget(self.btn_export_single)
        top.addWidget(self.btn_export_double)
        root.addLayout(top)

        # 素材信息
        self.info_label = QLabel("尚未打开素材")
        self.info_label.setStyleSheet(
            "background:#1d1f2b; color:#cfe; padding:8px; border-radius:4px;"
            "font-family:monospace;"
        )
        self.info_label.setWordWrap(True)
        root.addWidget(self.info_label)

        # 三个视图
        views_box = QGroupBox("对照视图 (按内容时间对齐; 在任一视图框选固定区域放大, 双击清除)")
        grid = QGridLayout(views_box)
        self.views: dict[str, ViewPanel] = {}
        for col, mode in enumerate(MODES):
            panel = ViewPanel(MODE_TITLES[mode])
            panel.roiChanged.connect(self.on_roi_changed)
            self.views[mode] = panel
            grid.addWidget(panel, 0, col)
            # 三列等宽, 保证三个视图以相同缩放显示同尺寸画面。
            grid.setColumnStretch(col, 1)
        grid.setRowStretch(0, 1)
        root.addWidget(views_box, 1)

        # 进度条
        self.progress = QProgressBar()
        self.progress.setRange(0, 100)
        self.progress.setValue(0)
        self.progress.setFormat("预渲染 %p%")
        root.addWidget(self.progress)

        # 播放/步进控制
        transport = QHBoxLayout()
        self.btn_play = QPushButton("▶ 播放/暂停")
        self.btn_play.clicked.connect(self.toggle_play)
        self.btn_prev_field = QPushButton("◀ 上一个场")
        self.btn_next_field = QPushButton("下一个场 ▶")
        self.btn_prev_frame = QPushButton("◀◀ 上一输出帧(当前视图)")
        self.btn_next_frame = QPushButton("下一输出帧(当前视图) ▶▶")
        self.btn_prev_field.clicked.connect(lambda: self.step_field(-1))
        self.btn_next_field.clicked.connect(lambda: self.step_field(1))
        self.btn_prev_frame.clicked.connect(lambda: self.step_output_frame(-1))
        self.btn_next_frame.clicked.connect(lambda: self.step_output_frame(1))
        for b in (self.btn_play, self.btn_prev_field, self.btn_next_field,
                  self.btn_prev_frame, self.btn_next_frame):
            transport.addWidget(b)

        transport.addWidget(QLabel("定位到场时间(s):"))
        self.spin_time = QSpinBox()
        self.spin_time.setMaximum(8000)
        self.spin_time.setSuffix(" ms")
        self.spin_time.valueChanged.connect(self.on_time_jump)
        transport.addWidget(self.spin_time)
        transport.addStretch(1)
        self.cursor_label = QLabel("—")
        self.cursor_label.setStyleSheet("font-family:monospace;")
        transport.addWidget(self.cursor_label)
        root.addLayout(transport)

        self.setCentralWidget(central)
        self._set_controls_enabled(False)

    def _set_controls_enabled(self, on: bool) -> None:
        for w in (self.combo_parity, self.btn_export_single,
                  self.btn_export_double, self.btn_play):
            w.setEnabled(on)

    # ---------------- 打开/校验素材 ----------------
    def open_file(self, path: str | None = None) -> None:
        if path is None:
            path, _ = QFileDialog.getOpenFileName(
                self, "选择交错视频", "",
                "视频文件 (*.mp4 *.mov *.mkv *.avi *.m2ts *.ts);;所有文件 (*)",
            )
        if not path:
            return
        try:
            media = probe_media(path)
            self._validate(media)
        except FFmpegError as exc:
            QMessageBox.critical(self, "无法打开", str(exc))
            return
        self._load_media(media)

    def _validate(self, media) -> None:
        if media.duration > MAX_DURATION + 1e-6:
            raise FFmpegError(
                f"素材时长 {media.duration:.2f}s 超过 {MAX_DURATION:.0f}s 上限"
            )
        if media.height > MAX_HEIGHT:
            raise FFmpegError(
                f"画面高度 {media.height} 超过 {MAX_HEIGHT}p 上限"
            )
        # CFR 校验: 相邻 pts 间隔必须恒定 (容差 5%)。
        if len(media.frame_pts) >= 3:
            diffs = [media.frame_pts[i + 1] - media.frame_pts[i]
                     for i in range(len(media.frame_pts) - 1)]
            avg = sum(diffs) / len(diffs)
            if any(abs(d - avg) > 0.05 * avg for d in diffs):
                raise FFmpegError("检测到可变帧率/非恒定帧间隔, 本工具只支持恒定帧率素材")

    def _load_media(self, media) -> None:
        self.play_timer.stop()
        # 场序初值来自文件标记, 但用户可改。
        if media.field_order in ("tt", "tb"):
            self.parity = "tff"
        elif media.field_order in ("bb", "bt"):
            self.parity = "bff"
        else:
            self.parity = "tff"
        self.combo_parity.blockSignals(True)
        self.combo_parity.setCurrentIndex(0 if self.parity == "tff" else 1)
        self.combo_parity.blockSignals(False)

        self.media = media
        self.timing = TimingModel(media.frame_pts, self.parity)
        if self.provider:
            self.provider.cleanup()
        self.provider = FrameProvider(media.path, media.width, media.height)
        for mode in MODES:
            self.provider.set_total(mode, self.timing.output_count(mode))
        self.field_index = 0
        self.ready_modes.clear()
        self.spin_time.blockSignals(True)
        self.spin_time.setMaximum(int(media.duration * 1000))
        self.spin_time.setValue(0)
        self.spin_time.blockSignals(False)

        self._show_media_info()
        self._set_controls_enabled(True)
        self._start_prerenders()

    def _show_media_info(self) -> None:
        m = self.media
        fr = m.frame_rate
        fr_txt = f"{fr.numerator}/{fr.denominator} = {float(fr):.3f} fps"
        self.info_label.setText(
            f"文件: {m.path.name}\n"
            f"实际尺寸: {m.width}×{m.height}   帧率: {fr_txt}   "
            f"视频编码: {m.video_codec}\n"
            f"帧数: {m.nb_frames}   时长: {m.duration:.3f}s   "
            f"场标记: {m.field_order_label}   检测到交错帧: {'是' if m.interlaced else '否'}\n"
            f"音频: {'有 (' + m.audio_codec + ')' if m.has_audio else '无'}   "
            f"当前手动场序: {self.parity.upper()} (文件标记仅作初值)"
        )

    # ---------------- 预渲染 ----------------
    def _start_prerenders(self, modes=MODES) -> None:
        self.progress.setValue(0)
        for mode in modes:
            if mode in self.workers:
                continue
            worker = PrerenderWorker(self.provider, mode, self.parity)
            worker.progress.connect(self._on_prerender_progress)
            worker.finished.connect(self._on_prerender_finished)
            worker.failed.connect(self._on_prerender_failed)
            self.workers[mode] = worker
            from .frame_cache import start_prerender
            thread = start_prerender(worker)
            # 线程结束后从列表移除, 避免反复切场序时对象堆积。
            thread.finished.connect(lambda t=thread: self._reap_thread(t))
            self.threads.append(thread)

    def _reap_thread(self, thread) -> None:
        try:
            self.threads.remove(thread)
        except ValueError:
            pass

    def _on_prerender_progress(self, mode: str, p: float) -> None:
        # 三种模式平均进度; 已完成的按 1.0 计。
        done = sum(
            (1.0 if m in self.ready_modes else self.provider.progress_of(m))
            for m in MODES
        )
        self.progress.setValue(int(done / len(MODES) * 100))

    def _is_current_worker(self, mode: str) -> bool:
        """信号发送者必须是当前代次注册的 worker, 否则视为迟到的旧结果。"""
        return self.workers.get(mode) is self.sender()

    def _on_prerender_finished(self, mode: str, count: int) -> None:
        # 只接受当前代次 worker 的 finished; 旧场序迟到的结果一律忽略,
        # 否则会把尚未渲染的新模式误标为 ready, 视图永久卡在空白。
        if not self._is_current_worker(mode):
            return
        self.workers.pop(mode, None)
        self.ready_modes.add(mode)
        if len(self.ready_modes) == len(MODES):
            self.progress.setValue(100)
        self.refresh_views()

    def _on_prerender_failed(self, mode: str, msg: str) -> None:
        if not self._is_current_worker(mode):
            return
        self.workers.pop(mode, None)
        QMessageBox.critical(self, f"预渲染失败 ({mode})", msg)

    # ---------------- 场序切换 ----------------
    def on_parity_changed(self, idx: int) -> None:
        new_parity = "tff" if idx == 0 else "bff"
        if not self.media or new_parity == self.parity:
            return
        self.parity = new_parity
        self.timing = TimingModel(self.media.frame_pts, new_parity)
        self._show_media_info()
        # 启用新一代缓存目录: 旧场序的解码线程只写旧目录, 不会污染新结果。
        self.play_timer.stop()
        self.render_generation += 1
        self.provider.invalidate(MODES)
        self.ready_modes.clear()
        for w in list(self.workers.values()):
            w.cancel()
        self.workers.clear()
        self._start_prerenders(MODES)
        self.refresh_views()

    # ---------------- 视图刷新 / 时间对齐 ----------------
    def refresh_views(self) -> None:
        if not self.timing or not self.provider:
            return
        n_fields_total = 2 * len(self.media.frame_pts)
        self.field_index = max(0, min(self.field_index, n_fields_total - 1))
        for mode, panel in self.views.items():
            if mode not in self.ready_modes:
                panel.set_frame(None)
                panel.set_info("预渲染中…")
                continue
            out_idx = self.timing.output_index_at_field(mode, self.field_index)
            img = self.provider.get_frame(mode, out_idx)
            panel.set_frame(img)
            panel.set_info(self.timing.label_for(mode, out_idx))
            panel.set_zoom(self.spin_zoom.value())
        t = self.timing.all_fields()[self.field_index].time
        self.cursor_label.setText(
            f"场游标 {self.field_index + 1}/{n_fields_total}  内容时间 {t:.3f}s"
        )
        self.spin_time.blockSignals(True)
        self.spin_time.setValue(int(round(t * 1000)))
        self.spin_time.blockSignals(False)

    # ---------------- 播放 / 步进 / 定位 ----------------
    def toggle_play(self) -> None:
        if self.play_timer.isActive():
            self.play_timer.stop()
        else:
            from PySide6.QtCore import QElapsedTimer
            self._elapsed = QElapsedTimer()
            self._elapsed.start()
            self._last_tick_ms = 0
            self.play_timer.start()

    def _tick_playback(self) -> None:
        # 按真实墙钟推进内容时间, 速度跟随源帧率 (双倍视图帧更密但同一时间轴)。
        now = self._elapsed.elapsed()
        dt = (now - self._last_tick_ms) / 1000.0
        self._last_tick_ms = now
        cur_time = self.timing.all_fields()[self.field_index].time
        target = cur_time + dt
        if target >= self.media.duration:
            self.field_index = 0
            self._elapsed.restart()
            self._last_tick_ms = 0
        else:
            self.field_index = self.timing.nearest_output_index("double", target)
        self.refresh_views()

    def step_field(self, delta: int) -> None:
        self.play_timer.stop()
        n_fields = 2 * len(self.media.frame_pts)
        self.field_index = max(0, min(self.field_index + delta, n_fields - 1))
        self.refresh_views()

    def step_output_frame(self, delta: int) -> None:
        """在当前关注视图 (取焦点面板) 内按它自己的输出帧步进。"""
        self.play_timer.stop()
        mode = self._focused_mode()
        cur_out = self.timing.output_index_at_field(mode, self.field_index)
        new_out = max(0, min(cur_out + delta, self.timing.output_count(mode) - 1))
        self.field_index = self.timing.field_index_for_output(mode, new_out)
        self.refresh_views()

    def _focused_mode(self) -> str:
        # 用户最近点击/聚焦的视图; 默认双倍 (场级最细)。
        for mode, panel in self.views.items():
            if panel.hasFocus():
                return mode
        return "double"

    def on_time_jump(self, ms: int) -> None:
        self.play_timer.stop()
        self.field_index = self.timing.nearest_output_index(
            "double", ms / 1000.0
        )
        self.refresh_views()

    # ---------------- ROI / 放大 ----------------
    def on_roi_changed(self) -> None:
        # 三个视图共用同一个源像素 ROI。
        source = self.sender()
        if not isinstance(source, ViewPanel):
            return
        roi = source.roi()
        for panel in self.views.values():
            if panel is not source:
                panel.set_roi(roi)

    def on_zoom_changed(self, factor: int) -> None:
        for panel in self.views.values():
            panel.set_zoom(factor)

    # ---------------- 导出 ----------------
    def export(self, mode: str) -> None:
        if not self.media:
            return
        suffix = {"single": "single", "double": "double"}[mode]
        dst, _ = QFileDialog.getSaveFileName(
            self, f"导出{suffix}去隔行成品",
            str(self.media.path.with_name(self.media.path.stem + f"_{suffix}.mp4")),
            "MP4 (*.mp4)",
        )
        if not dst:
            return
        self.progress.setRange(0, 0)  # 忙碌指示
        QApplication.processEvents()
        try:
            export_deinterlaced(self.media.path, dst, mode, self.parity)
        except FFmpegError as exc:
            self.progress.setRange(0, 100)
            QMessageBox.critical(self, "导出失败", str(exc))
            return
        self.progress.setRange(0, 100)
        self.progress.setValue(100)
        QMessageBox.information(self, "导出完成", f"已写出: {dst}")

    # ---------------- 样例生成 ----------------
    def make_samples(self) -> None:
        out_dir = QFileDialog.getExistingDirectory(self, "选择样例输出目录")
        if not out_dir:
            return
        try:
            spec = SampleSpec()
            paths = generate_sample(out_dir, spec)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "样例生成失败", str(exc))
            return
        QMessageBox.information(
            self, "样例已生成",
            "\n".join(f"{k}: {v}" for k, v in paths.items())
            + "\n\n建议打开 TFF 样例, 再切换 BFF 场序观察运动边缘差异。",
        )
        # 默认直接载入 TFF 样例。
        self.open_file(str(paths["tff"]))
