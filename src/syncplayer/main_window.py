"""主窗口: 载入文件、控制偏移/播放/循环/音频, 按同一主时钟刷新两边画面。"""
from __future__ import annotations

import os

from PySide6.QtCore import Qt, QTimer
from PySide6.QtGui import QPixmap
from PySide6.QtWidgets import (
    QButtonGroup,
    QCheckBox,
    QDoubleSpinBox,
    QFileDialog,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QRadioButton,
    QSlider,
    QStackedWidget,
    QVBoxLayout,
    QWidget,
)

from .audio import AudioController
from .media import (
    AudioBuffer,
    DecoderService,
    MediaError,
    decode_audio,
    file_identity,
    probe_video,
)
from .player import (
    PlayerEngine,
    build_settings,
    default_settings_path,
    load_settings,
    save_settings,
    verify_identity,
)
from .timings import choose_frame, format_time, validate
from .widgets import OverlayView, VideoView

REASON_TEXT = {
    "before": "请求时间早于 B 首帧(t+offset<0)",
    "after": "B 内容已结束(t+offset≥时长)",
    "no-frames": "B 没有可解码帧",
}


class MainWindow(QMainWindow):
    def __init__(self, path_a: str | None = None, path_b: str | None = None,
                 settings_path: str | None = None):
        super().__init__()
        self.setWindowTitle("本地双视频同步对比播放器")
        self.resize(1280, 860)

        self.info_a = None
        self.info_b = None
        self.audio_a: AudioBuffer | None = None
        self.audio_b: AudioBuffer | None = None
        self.dec_a: DecoderService | None = None
        self.dec_b: DecoderService | None = None
        self.engine: PlayerEngine | None = None
        self.audio_ctrl: AudioController | None = None
        self._last_a_index: int | None = None
        self._last_b_index: int | None = None
        self._pix_a: QPixmap | None = None
        self._pix_b: QPixmap | None = None
        self._b_blank = "尚未载入"
        self._settings_path: str | None = settings_path
        self._id_a: dict | None = None
        self._id_b: dict | None = None

        self._build_ui()
        self._set_controls_enabled(False)

        if path_a and path_b:
            QTimer.singleShot(0, lambda: self.load_pair(path_a, path_b,
                                                        settings_path))

    # ---------------- UI 搭建 ----------------
    def _build_ui(self) -> None:
        central = QWidget()
        root = QVBoxLayout(central)

        # 顶部文件行
        file_row = QHBoxLayout()
        self.btn_open_a = QPushButton("选择 A(主)…")
        self.btn_open_b = QPushButton("选择 B…")
        self.btn_open_pair = QPushButton("打开一对…")
        self.lbl_files = QLabel("未载入文件")
        self.lbl_files.setStyleSheet("color:#9aa4b2;")
        self.btn_open_a.clicked.connect(lambda: self._pick_one("A"))
        self.btn_open_b.clicked.connect(lambda: self._pick_one("B"))
        self.btn_open_pair.clicked.connect(self._pick_pair)
        file_row.addWidget(self.btn_open_a)
        file_row.addWidget(self.btn_open_b)
        file_row.addWidget(self.btn_open_pair)
        file_row.addWidget(self.lbl_files, 1)
        root.addLayout(file_row)

        # 画面区: 并排 / 叠合 共用同一组状态
        self.view_a = VideoView("A(主时间)")
        self.view_b = VideoView("B(偏移后)")
        side = QWidget()
        side_lay = QHBoxLayout(side)
        side_lay.setContentsMargins(0, 0, 0, 0)
        side_lay.addWidget(self.view_a)
        side_lay.addWidget(self.view_b)
        self.overlay = OverlayView()
        self.overlay.dividerChanged.connect(self._on_divider)
        self.stack = QStackedWidget()
        self.stack.addWidget(side)
        self.stack.addWidget(self.overlay)
        root.addWidget(self.stack, 1)

        # 信息行
        info_box = QGroupBox("时间与帧(证据来自实际选中的帧)")
        grid = QGridLayout(info_box)
        self.lbl_meta_a = QLabel("A: -")
        self.lbl_meta_b = QLabel("B: -")
        self.lbl_request = QLabel("请求: 主 t=- | B 请求 t+offset=-")
        self.lbl_picked = QLabel("选中: A 帧#- @- | B 帧#- @-")
        self.lbl_lag = QLabel("选帧滞后: A - | B -(各 < 一个帧间隔)")
        self.lbl_overlap = QLabel("重叠区间(主时间): -")
        for lbl in (self.lbl_meta_a, self.lbl_meta_b, self.lbl_request,
                    self.lbl_picked, self.lbl_lag, self.lbl_overlap):
            lbl.setStyleSheet("font-family: Menlo, monospace;")
        grid.addWidget(self.lbl_meta_a, 0, 0, 1, 2)
        grid.addWidget(self.lbl_meta_b, 0, 2, 1, 2)
        grid.addWidget(self.lbl_request, 1, 0, 1, 2)
        grid.addWidget(self.lbl_picked, 1, 2, 1, 2)
        grid.addWidget(self.lbl_lag, 2, 0, 1, 2)
        grid.addWidget(self.lbl_overlap, 2, 2, 1, 2)
        root.addWidget(info_box)

        # 控制区
        ctrl = QHBoxLayout()

        # 偏移
        off_box = QGroupBox("B 偏移(约定: B内容时间 = 主时间 + 偏移)")
        off_lay = QHBoxLayout(off_box)
        self.spin_offset = QDoubleSpinBox()
        self.spin_offset.setRange(-60.0, 60.0)
        self.spin_offset.setDecimals(4)
        self.spin_offset.setSingleStep(0.1)
        self.spin_offset.setSuffix(" s")
        self.spin_offset.valueChanged.connect(self._on_offset_edited)
        self.btn_off_minus = QPushButton("-1帧(B)")
        self.btn_off_plus = QPushButton("+1帧(B)")
        self.btn_off_minus.clicked.connect(lambda: self._nudge_offset(-1))
        self.btn_off_plus.clicked.connect(lambda: self._nudge_offset(1))
        self.btn_zero = QPushButton("归零")
        self.btn_zero.clicked.connect(lambda: self.spin_offset.setValue(0.0))
        off_lay.addWidget(self.spin_offset)
        off_lay.addWidget(self.btn_off_minus)
        off_lay.addWidget(self.btn_off_plus)
        off_lay.addWidget(self.btn_zero)
        ctrl.addWidget(off_box)

        # 播放
        play_box = QGroupBox("共用控制(同一主时钟)")
        play_lay = QHBoxLayout(play_box)
        self.btn_play = QPushButton("播放")
        self.btn_pause = QPushButton("暂停")
        self.btn_step_back = QPushButton("-1帧(A)")
        self.btn_step_fwd = QPushButton("+1帧(A)")
        self.btn_play.clicked.connect(self._play)
        self.btn_pause.clicked.connect(self._pause)
        self.btn_step_back.clicked.connect(lambda: self._step(-1))
        self.btn_step_fwd.clicked.connect(lambda: self._step(1))
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(0, 100_000)
        self.slider.sliderMoved.connect(self._on_slider_moved)
        play_lay.addWidget(self.btn_play)
        play_lay.addWidget(self.btn_pause)
        play_lay.addWidget(self.btn_step_back)
        play_lay.addWidget(self.btn_step_fwd)
        play_lay.addWidget(self.slider, 1)
        ctrl.addWidget(play_box, 1)

        # 视图 / 循环 / 音频
        right_box = QGroupBox("视图 / 循环 / 声音")
        right_lay = QGridLayout(right_box)
        self.rb_side = QRadioButton("并排")
        self.rb_overlay = QRadioButton("叠合")
        self.rb_side.setChecked(True)
        view_group = QButtonGroup(self)
        view_group.addButton(self.rb_side, 0)
        view_group.addButton(self.rb_overlay, 1)
        view_group.idClicked.connect(self.stack.setCurrentIndex)
        self.chk_loop = QCheckBox("仅循环重叠区")
        self.chk_loop.clicked.connect(self._on_loop_toggled)
        self.rb_mute = QRadioButton("静音")
        self.rb_audio_a = QRadioButton("听 A")
        self.rb_audio_b = QRadioButton("听 B")
        self.rb_mute.setChecked(True)
        audio_group = QButtonGroup(self)
        audio_group.addButton(self.rb_mute, 0)
        audio_group.addButton(self.rb_audio_a, 1)
        audio_group.addButton(self.rb_audio_b, 2)
        audio_group.idClicked.connect(self._on_audio_mode)
        right_lay.addWidget(self.rb_side, 0, 0)
        right_lay.addWidget(self.rb_overlay, 0, 1)
        right_lay.addWidget(self.chk_loop, 1, 0, 1, 2)
        right_lay.addWidget(self.rb_mute, 2, 0)
        right_lay.addWidget(self.rb_audio_a, 2, 1)
        right_lay.addWidget(self.rb_audio_b, 3, 0)
        right_lay.addWidget(self.rb_audio_b, 3, 1)
        ctrl.addWidget(right_box)
        root.addLayout(ctrl)

        # 保存/载入 + 状态
        bottom = QHBoxLayout()
        self.btn_save = QPushButton("保存偏移设置")
        self.btn_load = QPushButton("重新载入设置")
        self.btn_save.clicked.connect(self._save_settings)
        self.btn_load.clicked.connect(self._load_settings_clicked)
        self.lbl_status = QLabel("")
        self.lbl_status.setStyleSheet("color:#ffd166;")
        bottom.addWidget(self.btn_save)
        bottom.addWidget(self.btn_load)
        bottom.addWidget(self.lbl_status, 1)
        root.addLayout(bottom)

        self.setCentralWidget(central)

    # ---------------- 文件载入 ----------------
    def _pick_one(self, which: str) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, f"选择视频 {which}", "", "MP4 视频 (*.mp4);;所有文件 (*)"
        )
        if not path:
            return
        if which == "A":
            self.load_pair(path, self.info_b.path if self.info_b else None)
        else:
            self.load_pair(self.info_a.path if self.info_a else None, path)

    def _pick_pair(self) -> None:
        path_a, _ = QFileDialog.getOpenFileName(
            self, "选择 A(主视频)", "", "MP4 视频 (*.mp4);;所有文件 (*)"
        )
        if not path_a:
            return
        path_b, _ = QFileDialog.getOpenFileName(
            self, "选择 B(对照视频)", os.path.dirname(path_a),
            "MP4 视频 (*.mp4);;所有文件 (*)",
        )
        if not path_b:
            return
        self.load_pair(path_a, path_b)

    def load_pair(self, path_a: str | None, path_b: str | None,
                  settings_path: str | None = None) -> bool:
        if not path_a or not path_b:
            self._flash("需要先分别指定 A、B 两个文件")
            return False
        if os.path.abspath(path_a) == os.path.abspath(path_b):
            self._flash("A 和 B 不能是同一个文件")
            return False
        try:
            info_a = probe_video(path_a)
            info_b = probe_video(path_b)
        except MediaError as exc:
            QMessageBox.critical(self, "探测失败", str(exc))
            return False

        problems = [f"A: {p}" for p in validate(info_a)]
        problems += [f"B: {p}" for p in validate(info_b)]
        if problems:
            QMessageBox.warning(self, "文件超出约定限制", "\n".join(problems))

        self._teardown_media()
        self.info_a, self.info_b = info_a, info_b
        self._id_a = file_identity(info_a.path)
        self._id_b = file_identity(info_b.path)

        # 音频整段解码(失败不阻塞画面)
        try:
            self.audio_a = decode_audio(info_a.path)
        except MediaError:
            self.audio_a = None
        try:
            self.audio_b = decode_audio(info_b.path)
        except MediaError:
            self.audio_b = None

        self.dec_a = DecoderService(info_a)
        self.dec_b = DecoderService(info_b)
        self.dec_a.frameReady.connect(self._frame_a_ready)
        self.dec_b.frameReady.connect(self._frame_b_ready)

        self.engine = PlayerEngine(info_a, info_b, self)
        self.engine.timeChanged.connect(self._refresh)
        self.engine.stateChanged.connect(lambda _playing: None)
        self.audio_ctrl = AudioController(
            self.audio_a, self.audio_b,
            clock=lambda: self.engine.current_time(),
            loop_bounds=lambda: (
                self.engine.overlap()
                if self.engine.loop_enabled else None
            ),
            parent=self,
        )
        self._settings_path = settings_path or default_settings_path(
            info_a.path, info_b.path
        )

        self.lbl_files.setText(
            f"A: {os.path.basename(info_a.path)}    "
            f"B: {os.path.basename(info_b.path)}"
        )
        self.lbl_meta_a.setText(
            f"A: {info_a.width}x{info_a.height} "
            f"{info_a.frame_count}帧 时长{info_a.duration:.3f}s "
            f"标称{info_a.frame_rate_nominal or 0:.3f}fps "
            f"实测{1 / info_a.avg_interval:.3f}fps"
            + (" [音频]" if info_a.has_audio else "")
        )
        self.lbl_meta_b.setText(
            f"B: {info_b.width}x{info_b.height} "
            f"{info_b.frame_count}帧 时长{info_b.duration:.3f}s "
            f"标称{info_b.frame_rate_nominal or 0:.3f}fps "
            f"实测{1 / info_b.avg_interval:.3f}fps"
            + (" [音频]" if info_b.has_audio else "")
        )
        self._set_controls_enabled(True)
        self.slider.blockSignals(True)
        self.slider.setValue(0)
        self.slider.blockSignals(False)
        self.spin_offset.blockSignals(True)
        self.spin_offset.setValue(0.0)
        self.spin_offset.blockSignals(False)
        self._last_a_index = None
        self._last_b_index = None
        self._pix_a = None
        self._pix_b = None

        # 若有对应设置文件, 尝试还原; 文件失效只提示、不替换
        if os.path.isfile(self._settings_path):
            self._apply_saved_settings(self._settings_path, warn=False)
        self._refresh(0.0)
        self._flash("载入完成")
        return True

    def _teardown_media(self) -> None:
        if self.audio_ctrl is not None:
            self.audio_ctrl.shutdown()
            self.audio_ctrl = None
        # 先停解码线程, 再停引擎信号, 避免线程晚于宿主被销毁
        for dec in (self.dec_a, self.dec_b):
            if dec is not None:
                dec.shutdown()
        self.dec_a = None
        self.dec_b = None
        if self.engine is not None:
            self.engine.shutdown()
            self.engine = None

    # ---------------- 偏移 ----------------
    def _on_offset_edited(self, value: float) -> None:
        if self.engine is None:
            return
        self.engine.set_offset(value)
        if self.audio_ctrl is not None:
            self.audio_ctrl.set_offset(value)
        self._last_b_index = None  # 偏移变化后强制重新选 B 帧
        self._refresh(self.engine.current_time())

    def _nudge_offset(self, frames_b: int) -> None:
        if self.engine is None:
            return
        step = self.info_b.avg_interval
        self.spin_offset.setValue(self.spin_offset.value() + frames_b * step)

    # ---------------- 播放/定位 ----------------
    def _play(self) -> None:
        if self.engine is None:
            return
        # 循环只允许在有正长度重叠时启动
        if self.engine.loop_enabled and self.engine.overlap() is None:
            self._flash("当前偏移没有重叠区间, 不启动无效循环")
            self.chk_loop.setChecked(False)
            return
        self.engine.play()
        if self.audio_ctrl is not None:
            self.audio_ctrl.start()

    def _pause(self) -> None:
        if self.engine is None:
            return
        self.engine.pause()
        if self.audio_ctrl is not None:
            # 暂停即停 sink, 缓冲内残余声音一并丢弃
            self.audio_ctrl.stop()

    def _step(self, frames_a: int) -> None:
        if self.engine is None:
            return
        self.engine.step_a(frames_a)
        if self.audio_ctrl is not None:
            self.audio_ctrl.reset_position()
            if self.engine.is_playing:
                self.audio_ctrl.start()

    def _on_slider_moved(self, pos: int) -> None:
        if self.engine is None:
            return
        t = pos / 100_000 * self.info_a.duration
        self.engine.seek(t)
        if self.audio_ctrl is not None:
            self.audio_ctrl.reset_position()
        self._refresh(t)

    def _on_loop_toggled(self) -> None:
        if self.engine is None:
            return
        if self.chk_loop.isChecked() and self.engine.overlap() is None:
            self.chk_loop.setChecked(False)
            self._flash("偏移导致没有重叠区间, 无法循环; 仍可调整偏移")
            return
        self.engine.loop_enabled = self.chk_loop.isChecked()
        if self.engine.loop_enabled:
            ov = self.engine.overlap()
            if ov is not None and not (ov[0] <= self.engine.base_time < ov[1]):
                self.engine.seek(ov[0])
                if self.audio_ctrl is not None:
                    self.audio_ctrl.reset_position()

    def _on_audio_mode(self, btn_id: int) -> None:
        if self.audio_ctrl is None:
            return
        mode = {0: "mute", 1: "A", 2: "B"}[btn_id]
        self.audio_ctrl.set_mode(mode)
        # 切换瞬间 flush, 保证不残留上一路声音
        self.audio_ctrl.reset_position()
        if self.engine is not None and self.engine.is_playing:
            self.audio_ctrl.start()

    def _on_divider(self, ratio: float) -> None:
        # 叠合分隔线比例仅影响叠合视图; 位置/偏移状态本就全局共用
        self.overlay.set_divider(ratio)

    # ---------------- 每 tick 刷新 ----------------
    def _refresh(self, t: float) -> None:
        if self.engine is None:
            return
        offset = self.engine.offset
        req_b = t + offset

        choice_a = choose_frame(self.info_a, t)
        choice_b = choose_frame(self.info_b, req_b)

        if choice_a.within and choice_a.index != self._last_a_index:
            self._last_a_index = choice_a.index
            self.dec_a.request(choice_a.index)
        elif not choice_a.within:
            # 到 duration 即清空, 不停在末帧伪装仍在播放
            self._last_a_index = None
            self._pix_a = None
            self.view_a.show_frame(None, "A 内容已结束")
            self.overlay.set_pixmaps(None, self._pix_b, self._b_blank)

        if choice_b.within and choice_b.index != self._last_b_index:
            self._last_b_index = choice_b.index
            self.dec_b.request(choice_b.index)
        elif not choice_b.within:
            self._last_b_index = None
            self._pix_b = None
            self._b_blank = REASON_TEXT.get(
                choice_b.reason or "", "B 内容范围外"
            )
            self.view_b.show_frame(None, self._b_blank)
            self.overlay.set_pixmaps(self._pix_a, None, self._b_blank)

        # 信息行: 请求时间 vs 实际帧时间
        self.lbl_request.setText(
            f"请求: 主 t={format_time(t)} | "
            f"B 请求 t+offset={format_time(req_b)} (offset={offset:+.4f}s)"
        )
        a_txt = (
            f"A 帧#{choice_a.index} @{format_time(choice_a.pts)}"
            if choice_a.within else "A 无帧(范围外)"
        )
        b_txt = (
            f"B 帧#{choice_b.index} @{format_time(choice_b.pts)}"
            if choice_b.within else "B 无帧(范围外)"
        )
        self.lbl_picked.setText(f"选中: {a_txt} | {b_txt}")
        lag_a = choice_a.lag
        lag_b = choice_b.lag
        self.lbl_lag.setText(
            f"选帧滞后: A {lag_a * 1000:.1f}ms | B {lag_b * 1000:.1f}ms"
            if lag_a is not None and lag_b is not None
            else "选帧滞后: 一侧或双侧在内容范围外"
        )
        ov = self.engine.overlap()
        if ov is None:
            self.lbl_overlap.setText(
                "重叠区间(主时间): 无 — 不会启动循环, 请调整偏移"
            )
            self.lbl_overlap.setStyleSheet(
                "font-family: Menlo, monospace; color:#e06c6c;"
            )
        else:
            self.lbl_overlap.setText(
                f"重叠区间(主时间): [{format_time(ov[0])}, {format_time(ov[1])})"
                f" 长 {ov[1] - ov[0]:.3f}s"
            )
            self.lbl_overlap.setStyleSheet(
                "font-family: Menlo, monospace; color:#7bd88f;"
            )

        if not self.slider.isSliderDown():
            self.slider.blockSignals(True)
            self.slider.setValue(
                int(t / self.info_a.duration * 100_000)
                if self.info_a.duration > 0 else 0
            )
            self.slider.blockSignals(False)

    def _frame_a_ready(self, index: int, image) -> None:
        if image is None:
            return
        self._pix_a = QPixmap.fromImage(image)
        self.view_a.show_frame(self._pix_a, None)
        self.overlay.set_pixmaps(self._pix_a, self._pix_b, self._b_blank)

    def _frame_b_ready(self, index: int, image) -> None:
        if image is None:
            return
        self._pix_b = QPixmap.fromImage(image)
        self.view_b.show_frame(self._pix_b, None)
        self._b_blank = None
        self.overlay.set_pixmaps(self._pix_a, self._pix_b, None)

    # ---------------- 设置保存/载入 ----------------
    def _save_settings(self) -> None:
        if self.engine is None:
            self._flash("没有可保存的视频对")
            return
        payload = build_settings(
            self.info_a.path, self.info_b.path,
            self._id_a, self._id_b, self.engine.offset,
        )
        save_settings(self._settings_path, payload)
        self._flash(f"已保存: {self._settings_path}")

    def _load_settings_clicked(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择偏移设置文件", os.path.dirname(self._settings_path or ""),
            "JSON (*.json)",
        )
        if path:
            self._apply_saved_settings(path, warn=True)

    def _apply_saved_settings(self, path: str, warn: bool) -> None:
        try:
            data = load_settings(path)
        except (OSError, ValueError) as exc:
            if warn:
                QMessageBox.warning(self, "载入失败", f"设置文件无效: {exc}")
            return
        ok_a = verify_identity(data["video_a"])
        ok_b = verify_identity(data["video_b"])
        if not (ok_a and ok_b):
            missing = []
            if not ok_a:
                missing.append(f"A: {data['video_a'].get('path')}")
            if not ok_b:
                missing.append(f"B: {data['video_b'].get('path')}")
            QMessageBox.warning(
                self, "原文件失效, 待重新选择",
                "保存时的文件已不存在或被修改, 不会误用其他文件:\n"
                + "\n".join(missing),
            )
            self._flash("原文件失效, 请重新选择 A/B")
            return
        # 身份一致才应用偏移, 还原实际位置关系
        self.spin_offset.blockSignals(True)
        self.spin_offset.setValue(float(data["offset_seconds"]))
        self.spin_offset.blockSignals(False)
        self._on_offset_edited(float(data["offset_seconds"]))
        self._settings_path = path
        self._flash(f"已还原偏移 {float(data['offset_seconds']):+.4f}s")

    # ---------------- 杂项 ----------------
    def _set_controls_enabled(self, on: bool) -> None:
        for w in (
            self.btn_save, self.btn_load, self.spin_offset,
            self.btn_off_minus, self.btn_off_plus, self.btn_zero,
            self.btn_play, self.btn_pause, self.btn_step_back,
            self.btn_step_fwd, self.slider, self.chk_loop,
            self.rb_mute, self.rb_audio_a, self.rb_audio_b,
        ):
            w.setEnabled(on)

    def _flash(self, text: str) -> None:
        self.lbl_status.setText(text)

    def closeEvent(self, event) -> None:  # noqa: N802
        self._teardown_media()
        super().closeEvent(event)
