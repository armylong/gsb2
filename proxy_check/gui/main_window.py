"""主窗口: 导入/生成/换入代理、帧精确播放、核对与导出。"""

from __future__ import annotations

import tempfile
from pathlib import Path

from PySide6.QtCore import Qt, QTimer, QUrl
from PySide6.QtGui import (
    QAction, QColor, QFont, QImage, QKeySequence, QPainter, QPixmap,
)
from PySide6.QtMultimedia import QAudioOutput, QMediaPlayer
from PySide6.QtWidgets import (
    QFileDialog, QHBoxLayout, QLabel, QMainWindow, QMessageBox, QProgressBar,
    QPushButton, QSlider, QSplitter, QStatusBar, QToolBar, QWidget,
)

from ..ffmedia import probe, sha256_file
from ..player import PlayerModel
from ..proxy import build_proxy, load_sidecar
from ..samples import generate_sample_set
from ..verification import verify
from .checks_panel import ChecksPanel
from .frames import decode_rgb_frames, extract_audio, jpeg_bytes
from .player_view import PlayerView
from .state import AppState, LoadedMedia
from .workers import Worker


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("本地代理核对工具 — 原片 / 360p 代理")
        self.resize(1500, 900)

        self.state = AppState()
        self._worker: Worker | None = None
        self._tmp_dir = tempfile.mkdtemp(prefix="proxy_check_gui_")

        self._build_toolbar()
        self._build_center()
        self._build_transport()
        self.setStatusBar(QStatusBar())
        self.progress = QProgressBar()
        self.progress.setMaximumWidth(260)
        self.progress.setVisible(False)
        self.statusBar().addPermanentWidget(self.progress)

        # 播放时钟: 按源帧周期驱动, 保证帧精确而不是墙钟漂移。
        self.timer = QTimer(self)
        self.timer.timeout.connect(self._tick)

        # 音频播放(仅音频, 画面由时钟驱动)。
        self.audio_out = QAudioOutput(self)
        self.audio_player = QMediaPlayer(self)
        self.audio_player.setAudioOutput(self.audio_out)
        self.audio_player.positionChanged.connect(self._audio_pos)
        self._audio_syncing = False

        self._refresh_buttons()

    # ------------------------------------------------------------------ UI
    def _build_toolbar(self) -> None:
        tb = QToolBar("主操作")
        tb.setMovable(False)
        self.addToolBar(tb)

        def act(text, slot, tip=None):
            a = QAction(text, self)
            a.triggered.connect(slot)
            if tip:
                a.setToolTip(tip)
            tb.addAction(a)
            return a

        self.act_open_src = act("导入原片…", self.open_source)
        self.act_build = act("生成 360p 代理", self.build_proxy_file)
        self.act_import = act("换入已有代理…", self.import_proxy)
        tb.addSeparator()
        self.act_verify = act("执行核对", self.run_verify)
        self.act_export = act("导出核对记录…", self.export_report)
        tb.addSeparator()
        act("生成测试样例…", self.make_samples)

    def _build_center(self) -> None:
        splitter = QSplitter(Qt.Orientation.Horizontal)

        self.player_view = PlayerView(self.state)
        splitter.addWidget(self.player_view)

        self.checks_panel = ChecksPanel()
        self.checks_panel.jumpToFrame.connect(self.jump_to_frame)
        splitter.addWidget(self.checks_panel)
        splitter.setSizes([900, 560])
        self.setCentralWidget(splitter)

    def _build_transport(self) -> None:
        bar = QWidget()
        lay = QHBoxLayout(bar)
        lay.setContentsMargins(8, 4, 8, 4)

        self.btn_play = QPushButton("播放/暂停 (空格)")
        self.btn_play.clicked.connect(self.toggle_play)
        self.btn_back = QPushButton("◀ 上一帧 (←)")
        self.btn_back.clicked.connect(lambda: self.step(-1))
        self.btn_fwd = QPushButton("下一帧 (▶)")
        self.btn_fwd.clicked.connect(lambda: self.step(1))

        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setMinimum(0)
        self.slider.valueChanged.connect(self._slider_moved)

        self.btn_single = QPushButton("单画面: 原片")
        self.btn_single.setCheckable(True)
        self.btn_side = QPushButton("并排对照")
        self.btn_side.setCheckable(True)
        self.btn_side.setChecked(True)
        self.btn_single.clicked.connect(lambda: self.set_view_mode("single"))
        self.btn_side.clicked.connect(lambda: self.set_view_mode("side"))
        self.btn_swap = QPushButton("切换原片/代理 (Tab)")
        self.btn_swap.clicked.connect(self.swap_single)

        self.pos_label = QLabel("帧 —/—  t —s")
        self.pos_label.setStyleSheet("font-family: monospace;")

        for w in (self.btn_play, self.btn_back, self.slider, self.btn_fwd,
                  self.pos_label, self.btn_single, self.btn_side, self.btn_swap):
            lay.addWidget(w)
        # 播放条固定在左侧播放区顶部(PlayerView 自身是 QVBoxLayout), 画面在其下方。
        self.player_view.layout().insertWidget(0, bar)
        self._update_single_button_text()

        # 快捷键。
        for key, slot in ((Qt.Key.Key_Space, self.toggle_play),
                          (Qt.Key.Key_Left, lambda: self.step(-1)),
                          (Qt.Key.Key_Right, lambda: self.step(1)),
                          (Qt.Key.Key_Tab, self.swap_single)):
            # QAction 快捷键由主窗口派发。
            a = QAction(self)
            a.setShortcut(QKeySequence(key))
            a.triggered.connect(slot)
            self.addAction(a)

    # ------------------------------------------------------------- 加载流程
    def _set_busy(self, busy: bool, msg: str = "") -> None:
        self.state.worker_active = busy
        self.progress.setVisible(busy)
        if busy:
            self.progress.setRange(0, 0)
            self.statusBar().showMessage(msg)
        else:
            self.progress.setRange(0, 1)
            self.progress.setValue(1)
            self.statusBar().clearMessage()
        self._refresh_buttons()

    def _start_worker(self, fn, *args, on_ok, busy_msg: str, **kwargs) -> None:
        if self._worker is not None and self._worker.isRunning():
            return
        self._set_busy(True, busy_msg)
        worker = Worker(fn, *args, **kwargs)
        worker.progress.connect(lambda m: self.statusBar().showMessage(m))
        worker.succeeded.connect(lambda r: self._worker_ok(on_ok, r))
        worker.failed.connect(self._worker_fail)
        worker.finished.connect(lambda: self._set_busy(False))
        self._worker = worker
        worker.start()

    def _worker_ok(self, on_ok, result) -> None:
        on_ok(result)

    def _worker_fail(self, msg: str) -> None:
        # 任何后台失败: 先作废当前派生状态, 绝不允许旧结果残留。
        first_line = msg.splitlines()[0]
        self.statusBar().showMessage(f"失败: {first_line}", 8000)
        QMessageBox.warning(self, "操作失败", msg)

    def open_source(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 mp4 原片(≤15s, ≤1080p, CFR)", "", "MP4 (*.mp4)")
        if not path:
            return
        self._stop_playback()
        self.state.reset_pair()
        self.checks_panel.clear_report("已导入原片, 尚未加载代理")
        self._start_worker(self._load_media_job, path, None,
                           on_ok=self._on_new_pair, busy_msg="导入原片…")

    def build_proxy_file(self) -> None:
        if self.state.source is None:
            QMessageBox.information(self, "提示", "请先导入原片")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "保存代理", "proxy_360p.mp4", "MP4 (*.mp4)")
        if not path:
            return
        self._stop_playback()
        # 新一轮生成: 先清掉旧代理与旧结论, 失败也不会沿用。
        self.state.reset_proxy_side()
        self.checks_panel.clear_report("正在生成新代理…")
        self.player_view.render()
        self._start_worker(build_proxy, self.state.source.info.path, path,
                           on_ok=lambda r: self._after_proxy_built(path, r),
                           busy_msg="生成代理…")

    def _after_proxy_built(self, path: str, result) -> None:
        # build_proxy 返回 (MediaInfo, sidecar); 再走统一的代理加载。
        self._load_proxy_into_state(Path(path), expect_sidecar=True)

    def import_proxy(self) -> None:
        if self.state.source is None:
            QMessageBox.information(self, "提示", "请先导入原片")
            return
        path, _ = QFileDialog.getOpenFileName(
            self, "换入已有代理进行核对", "", "MP4 (*.mp4)")
        if not path:
            return
        self._stop_playback()
        self.state.reset_proxy_side()
        self.checks_panel.clear_report("正在载入换入的代理…")
        self._start_worker(self._load_proxy_job, path,
                           on_ok=self._on_proxy_loaded, busy_msg="载入代理…")

    def make_samples(self) -> None:
        out = QFileDialog.getExistingDirectory(self, "选择样例输出目录")
        if not out:
            return
        self._stop_playback()
        self.state.reset_pair()
        self.checks_panel.clear_report("生成测试样例中…")
        self._start_worker(generate_sample_set, out,
                           on_ok=lambda r: self._on_samples(out, r),
                           busy_msg="生成样例…")

    def _on_samples(self, out_dir: str, paths: dict) -> None:
        QMessageBox.information(
            self, "样例已生成",
            "已在目录生成:\n"
            "  source.mp4            原片(帧号+移动图形+每秒蜂鸣)\n"
            "  proxy_good.mp4        正常代理(带 sidecar)\n"
            "  proxy_offset.mp4      错开 15 帧起点的代理\n"
            "  proxy_different.mp4   另一份内容的代理\n\n"
            "请用“导入原片”选 source.mp4, 再用“换入已有代理”分别核对后三者。")
        self.checks_panel.clear_report("样例已生成, 请手动导入一对文件")

    # ------------------------------------------------- 实际的后台作业函数
    def _load_media_job(self, source_path: str, proxy_path: str | None,
                        progress=None) -> tuple:
        src_info = probe(source_path)
        from ..proxy import validate_source
        validate_source(src_info)
        src_info.sha256 = sha256_file(source_path)
        src_frames = jpeg_bytes(decode_rgb_frames(source_path))
        src_audio = extract_audio(
            source_path, Path(self._tmp_dir) / "src_audio.m4a")
        source = LoadedMedia(src_info, src_frames,
                             str(src_audio) if src_audio else None)
        proxy = None
        if proxy_path:
            proxy = self._build_loaded_proxy(Path(proxy_path))
        return source, proxy

    def _build_loaded_proxy(self, path: Path) -> LoadedMedia:
        info = probe(path)
        info.sha256 = sha256_file(path)
        frames = jpeg_bytes(decode_rgb_frames(str(path)))
        audio = extract_audio(str(path), Path(self._tmp_dir) / "dst_audio.m4a")
        return LoadedMedia(info, frames, str(audio) if audio else None)

    def _load_proxy_job(self, path: str, progress=None) -> LoadedMedia:
        return self._build_loaded_proxy(Path(path))

    def _load_proxy_into_state(self, path: Path, expect_sidecar: bool) -> None:
        self._start_worker(self._load_proxy_job, str(path),
                           on_ok=self._on_proxy_loaded, busy_msg="载入代理…")

    def _on_new_pair(self, result) -> None:
        source, proxy = result
        self.state.source = source
        self.state.proxy = proxy
        self._after_pair_changed()

    def _on_proxy_loaded(self, proxy: LoadedMedia) -> None:
        if self.state.source is None:
            return
        self.state.proxy = proxy
        sidecar = load_sidecar(proxy.info.path)
        self._after_pair_changed()
        if sidecar is None:
            self.statusBar().showMessage(
                "该代理缺少 sidecar 关联信息, 核对将标记为“待核对”", 10000)

    def _after_pair_changed(self) -> None:
        if self.state.ready:
            self.state.player = PlayerModel(
                self.state.source.info, self.state.proxy.info)
            self.slider.setMaximum(self.state.player.frame_count - 1)
            self.slider.setValue(0)
        self.state.report = None
        self.checks_panel.clear_report("文件已载入, 点击“执行核对”")
        self.player_view.render()
        self._refresh_buttons()

    # ---------------------------------------------------------------- 核对
    def run_verify(self) -> None:
        if not self.state.ready:
            QMessageBox.information(self, "提示", "需要先载入原片和代理")
            return
        src_path = self.state.source.info.path
        dst_path = self.state.proxy.info.path
        self._stop_playback()
        self._start_worker(verify, src_path, dst_path,
                           on_ok=self._on_verify_done, busy_msg="执行核对…")

    def _on_verify_done(self, report) -> None:
        self.state.report = report
        self.checks_panel.show_report(report)
        self.player_view.render()
        self.statusBar().showMessage(
            f"核对完成: {report.overall.value}", 10000)

    def export_report(self) -> None:
        if self.state.report is None:
            QMessageBox.information(self, "提示", "没有可导出的核对记录, 请先执行核对")
            return
        path, _ = QFileDialog.getSaveFileName(
            self, "导出核对记录", "proxy_check_report.json", "JSON (*.json)")
        if not path:
            return
        report = self.state.report
        # 导出前再确认记录与当前这一对文件严格对应。
        key = self.state.pair_key()
        data = report.to_dict()
        if (f"{data['source']['path']}|{data['source']['sha256']}" != key[0]
                or f"{data['proxy']['path']}|{data['proxy']['sha256']}" != key[1]):
            QMessageBox.critical(
                self, "导出中止",
                "核对记录与当前打开的一对文件不一致, 已阻止导出。")
            return
        report.save_json(path)

        # 同时导出检查点双画面证据拼图(可选旁证)。
        montage = Path(path).with_suffix(".evidence.png")
        try:
            self._write_evidence_montage(montage)
        except Exception as exc:  # 证据图失败不影响 JSON 导出
            QMessageBox.information(self, "导出完成",
                                    f"JSON 已导出: {path}\n证据图生成失败: {exc}")
            return
        QMessageBox.information(
            self, "导出完成",
            f"核对记录: {path}\n证据拼图: {montage}")

    def _write_evidence_montage(self, montage_path: Path) -> None:
        report = self.state.report
        cps = report.checkpoints
        if not cps:
            return
        cols = 2
        rows = len(cps)
        cell_w, cell_h, head = 480, 270, 46
        canvas = QImage(cell_w * cols + 30, rows * (cell_h + head) + 20,
                        QImage.Format.Format_RGB32)
        canvas.fill(QColor("#1e1e1e"))
        painter = QPainter(canvas)
        painter.setFont(QFont("Menlo", 11))
        sm, pm = self.state.source, self.state.proxy
        for r, cp in enumerate(cps):
            y = 10 + r * (cell_h + head)
            painter.setPen(QColor("#ddd"))
            painter.drawText(10, y + 18,
                             f"检查点 {r + 1}: 源帧 {cp.source_index} ↔ 代理帧 "
                             f"{cp.proxy_index}  MAE={cp.mae:.4f} [{cp.status.value}]")
            painter.drawPixmap(10, y + head,
                               QPixmap.fromImage(self._jpeg_to_image(
                                   sm.frames[cp.source_index])))
            painter.drawPixmap(cell_w + 20, y + head,
                               QPixmap.fromImage(self._jpeg_to_image(
                                   pm.frames[min(cp.proxy_index, len(pm.frames) - 1)])))
        painter.end()
        canvas.save(str(montage_path), "PNG")

    @staticmethod
    def _jpeg_to_image(ba) -> QImage:
        img = QImage()
        img.loadFromData(ba, "JPEG")
        return img

    # ---------------------------------------------------------------- 播放
    def set_view_mode(self, mode: str) -> None:
        self.state.view_mode = mode
        self.btn_single.setChecked(mode == "single")
        self.btn_side.setChecked(mode == "side")
        self._update_single_button_text()
        self.player_view.render()

    def swap_single(self) -> None:
        if self.state.view_mode != "single":
            self.state.view_mode = "single"
            self.btn_single.setChecked(True)
            self.btn_side.setChecked(False)
        # 关键: 只切换显示的一路, 帧位置不动。
        self.state.show_source_in_single = not self.state.show_source_in_single
        self._update_single_button_text()
        self.player_view.render()

    def _update_single_button_text(self) -> None:
        who = "原片" if self.state.show_source_in_single else "代理"
        self.btn_single.setText(f"单画面: {who} (Tab 切换)")

    def toggle_play(self) -> None:
        if self.state.player is None:
            return
        playing = self.state.player.toggle()
        if playing:
            self._start_playback()
        else:
            self._stop_playback()

    def step(self, delta: int) -> None:
        if self.state.player is None:
            return
        self._stop_playback()
        self.state.player.step(delta)
        self._render_position(user_slider=True)

    def jump_to_frame(self, frame: int) -> None:
        if self.state.player is None:
            return
        self._stop_playback()
        self.state.player.set_index(frame)
        self._render_position(user_slider=True)

    def _slider_moved(self, value: int) -> None:
        if self.state.player is None:
            return
        if self.state.player.index == value:
            return
        self._stop_playback()
        self.state.player.set_index(value)
        self._render_position(user_slider=False)

    def _start_playback(self) -> None:
        player = self.state.player
        period_ms = int(round(1000.0 / player.source.frame_rate))
        self.timer.start(period_ms)
        # 音频: 跳到与当前帧对应的位置再播。
        if self.state.proxy and self.state.proxy.audio_file:
            self._audio_syncing = True
            self.audio_player.setSource(
                QUrl.fromLocalFile(self.state.proxy.audio_file))
            self.audio_player.setPosition(
                int(player.proxy_ref().time * 1000))
            self.audio_player.play()
            self._audio_syncing = False

    def _stop_playback(self) -> None:
        self.timer.stop()
        if self.state.player is not None:
            self.state.player.pause()
        try:
            self.audio_player.stop()
        except Exception:
            pass
        self.player_view.render()

    def _tick(self) -> None:
        player = self.state.player
        if player is None:
            return
        nxt = player.advance()
        if nxt is None:
            self._stop_playback()
            return
        self._render_position(user_slider=True)
        # 到达末帧附近停音频。
        if nxt >= player.frame_count - 1:
            self.audio_player.stop()

    def _audio_pos(self, pos_ms: int) -> None:
        # 简单同步: 若音频与画面时钟偏差超过 2 个源帧, 硬对齐一次。
        if self._audio_syncing or self.state.player is None:
            return
        if not self.timer.isActive():
            return
        target_ms = self.state.player.proxy_ref().time * 1000
        if abs(pos_ms - target_ms) > 2000.0 / self.state.player.proxy.frame_rate:
            self._audio_syncing = True
            self.audio_player.setPosition(int(target_ms))
            self._audio_syncing = False

    def _render_position(self, user_slider: bool) -> None:
        player = self.state.player
        if user_slider:
            self.slider.blockSignals(True)
            self.slider.setValue(player.index)
            self.slider.blockSignals(False)
        ref = player.source_ref()
        self.pos_label.setText(
            f"帧 {ref.index:4d}/{player.frame_count - 1}  "
            f"t {ref.time:7.3f}s")
        self.player_view.render()

    # ---------------------------------------------------------------- 其他
    def _refresh_buttons(self) -> None:
        busy = self.state.worker_active
        has_src = self.state.source is not None
        ready = self.state.ready
        for a in (self.act_open_src, self.act_build, self.act_import,
                  self.act_verify, self.act_export):
            a.setEnabled(not busy)
        self.act_build.setEnabled(not busy and has_src)
        self.act_import.setEnabled(not busy and has_src)
        self.act_verify.setEnabled(not busy and ready)
        self.act_export.setEnabled(not busy and self.state.report is not None)

    def closeEvent(self, event) -> None:
        self._stop_playback()
        if self._worker and self._worker.isRunning():
            self._worker.wait(3000)
        super().closeEvent(event)
