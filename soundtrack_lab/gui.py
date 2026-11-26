from __future__ import annotations

import base64
import copy
import sys
from pathlib import Path

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDoubleSpinBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QListWidget,
    QMainWindow,
    QMessageBox,
    QPushButton,
    QScrollArea,
    QSlider,
    QSpinBox,
    QSplitter,
    QTableWidget,
    QTableWidgetItem,
    QTextEdit,
    QVBoxLayout,
    QWidget,
)

from .core import (
    AUDIO_RATE,
    DEFAULT_CAL_MM,
    ROW_RATE,
    Segment,
    add_defects,
    calibration_summary,
    decode_image,
    encode_samples,
    load_wav,
    metrics_rows,
    wav_bytes,
    window_description,
    write_wav,
)
from .qt_support import AudioPlayer, load_track_png, save_track_png
from .sample import generate_bundle
from .widgets import ProfileView, TrackView, WaveView


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("老胶片声轨课堂实验室 · PySide6 + NumPy")
        self.resize(1480, 940)

        self.audio, self.segments = self._build_initial_audio()
        self.track = encode_samples(self.audio, self.segments)
        self.meta = copy.deepcopy(self.track.meta)
        self.clean_gray = self.track.gray.copy()
        self.gray = self.clean_gray.copy()
        self.baseline = decode_image(self.clean_gray, self._ideal_params(), self.meta)
        self.trial = decode_image(self.gray, self._read_params_from_controls_default(), self.meta)

        self.current_time = 0.0
        self.cal_mm = DEFAULT_CAL_MM
        self.player = AudioPlayer(self)
        self.player.positionChanged.connect(self._on_play_position)
        self._playing_kind: str | None = None

        self._build_ui()
        self._refresh_all()

    # ------------------------------------------------------------------ UI
    def _build_initial_audio(self):
        from .core import build_demo

        return build_demo()

    def _ideal_params(self):
        from .core import ReadParams

        return ReadParams(window_rows=1, offset_px=0.0, exposure_ev=0.0, dc_remove=True)

    def _read_params_from_controls_default(self):
        from .core import ReadParams

        return ReadParams()

    def _build_ui(self) -> None:
        root = QSplitter(Qt.Orientation.Horizontal)

        control_scroll = QScrollArea()
        control_scroll.setWidgetResizable(True)
        control_scroll.setMinimumWidth(350)
        control_scroll.setMaximumWidth(430)
        controls = QWidget()
        lay = QVBoxLayout(controls)
        lay.setSpacing(10)

        lay.addWidget(self._build_source_group())
        lay.addWidget(self._build_calibration_group())
        lay.addWidget(self._build_read_group())
        lay.addWidget(self._build_defect_group())
        lay.addWidget(self._build_export_group())
        lay.addWidget(self._build_metrics_group())
        lay.addStretch(1)

        control_scroll.setWidget(controls)
        root.addWidget(control_scroll)

        right = QSplitter(Qt.Orientation.Vertical)

        top = QSplitter(Qt.Orientation.Horizontal)
        self.track_view = TrackView()
        track_scroll = QScrollArea()
        track_scroll.setWidgetResizable(True)
        track_scroll.setWidget(self.track_view)
        track_scroll.setMinimumWidth(720)
        self.track_view.seekRequested.connect(self.seek_to)
        top.addWidget(track_scroll)

        side = QWidget()
        side_lay = QVBoxLayout(side)
        side_lay.setContentsMargins(4, 4, 4, 4)
        self.row_title = QLabel("当前时刻 / 行 / 暗线")
        self.row_title.setStyleSheet("font-weight:700;font-size:14px;")
        side_lay.addWidget(self.row_title)
        self.row_readout = QLabel()
        self.row_readout.setWordWrap(True)
        self.row_readout.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        self.row_readout.setStyleSheet("font-family: Menlo, Consolas, monospace; font-size:12px;")
        side_lay.addWidget(self.row_readout)
        self.profile = ProfileView()
        profile_box = QGroupBox("该行灰度剖面与边缘判读")
        pv = QVBoxLayout(profile_box)
        pv.addWidget(self.profile)
        side_lay.addWidget(profile_box)

        side_lay.addWidget(QLabel("检测/标记的受影响区间："))
        self.defect_list = QListWidget()
        self.defect_list.setMaximumHeight(132)
        self.defect_list.currentRowChanged.connect(self._on_defect_selected)
        side_lay.addWidget(self.defect_list)
        defect_btns = QHBoxLayout()
        self.play_interval_btn = QPushButton("试听选中区间")
        self.play_interval_btn.clicked.connect(self._play_selected_interval)
        self.source_interval_btn = QPushButton("对照源音区间")
        self.source_interval_btn.clicked.connect(self._play_source_interval)
        defect_btns.addWidget(self.play_interval_btn)
        defect_btns.addWidget(self.source_interval_btn)
        side_lay.addLayout(defect_btns)

        self.message_view = QTextEdit()
        self.message_view.setReadOnly(True)
        self.message_view.setMaximumHeight(92)
        self.message_view.setPlaceholderText("判读提示 / 待查信息")
        side_lay.addWidget(self.message_view)
        side_lay.addStretch(1)
        top.addWidget(side)
        top.setSizes([820, 430])
        right.addWidget(top)

        bottom = QWidget()
        bottom_lay = QVBoxLayout(bottom)
        bottom_lay.setContentsMargins(6, 2, 6, 6)
        self.wave_view = WaveView()
        self.wave_view.seekRequested.connect(self.seek_to)
        bottom_lay.addWidget(self.wave_view)
        bottom_lay.addLayout(self._build_playback_bar())
        right.addWidget(bottom)
        right.setSizes([690, 280])

        root.addWidget(right)
        root.setStretchFactor(0, 0)
        root.setStretchFactor(1, 1)
        self.setCentralWidget(root)
        self.statusBar().showMessage("就绪：已载入可重新生成的课堂样例")

    def _build_source_group(self) -> QGroupBox:
        box = QGroupBox("1. 音源")
        layout = QVBoxLayout(box)
        row = QHBoxLayout()
        demo_btn = QPushButton("生成固定样例")
        demo_btn.clicked.connect(self.load_demo)
        open_btn = QPushButton("打开短 WAV")
        open_btn.clicked.connect(self.open_wav)
        row.addWidget(demo_btn)
        row.addWidget(open_btn)
        layout.addLayout(row)
        self.source_info = QLabel()
        self.source_info.setWordWrap(True)
        layout.addWidget(self.source_info)
        return box

    def _build_calibration_group(self) -> QGroupBox:
        box = QGroupBox("2. 标定 / 走片")
        form = QFormLayout(box)
        self.cal_spin = QDoubleSpinBox()
        self.cal_spin.setRange(1.0, 80.0)
        self.cal_spin.setValue(DEFAULT_CAL_MM)
        self.cal_spin.setSuffix(" mm")
        self.cal_spin.valueChanged.connect(self._on_cal_changed)
        form.addRow("标定距离", self.cal_spin)
        self.cal_label = QLabel(calibration_summary(DEFAULT_CAL_MM))
        self.cal_label.setWordWrap(True)
        form.addRow(self.cal_label)

        zoom_row = QHBoxLayout()
        zoom_out = QPushButton("－")
        zoom_in = QPushButton("＋")
        zoom_fit = QPushButton("整段")
        zoom_out.setFixedWidth(38)
        zoom_in.setFixedWidth(38)
        zoom_out.clicked.connect(lambda: self.track_view.set_zoom(self.track_view.zoom() / 1.35))
        zoom_in.clicked.connect(lambda: self.track_view.set_zoom(self.track_view.zoom() * 1.35))
        zoom_fit.clicked.connect(lambda: self.track_view.set_zoom(260))
        zoom_row.addWidget(QLabel("纵向放大"))
        zoom_row.addWidget(zoom_out)
        zoom_row.addWidget(zoom_in)
        zoom_row.addWidget(zoom_fit)
        zoom_row.addStretch(1)
        form.addRow(zoom_row)
        return box

    def _build_read_group(self) -> QGroupBox:
        box = QGroupBox("3. 回读试改（基准组始终保留）")
        form = QFormLayout(box)

        self.window_spin = QSpinBox()
        self.window_spin.setRange(1, 201)
        self.window_spin.setValue(1)
        self.window_spin.valueChanged.connect(self._on_window_spin)
        self.window_slider = QSlider(Qt.Orientation.Horizontal)
        self.window_slider.setRange(1, 121)
        self.window_slider.setValue(1)
        self.window_slider.valueChanged.connect(self._on_window_slider)
        form.addRow("扫描窗宽(行)", self.window_spin)
        form.addRow("", self.window_slider)
        self.window_desc = QLabel(window_description(1))
        self.window_desc.setWordWrap(True)
        form.addRow(self.window_desc)

        self.offset_spin = QSpinBox()
        self.offset_spin.setRange(-90, 90)
        self.offset_spin.setValue(0)
        self.offset_spin.setSuffix(" px")
        self.offset_spin.valueChanged.connect(self._on_param_changed)
        form.addRow("横向偏移", self.offset_spin)

        self.exposure_spin = QDoubleSpinBox()
        self.exposure_spin.setRange(-1.5, 1.5)
        self.exposure_spin.setSingleStep(0.1)
        self.exposure_spin.setValue(0.0)
        self.exposure_spin.setSuffix(" EV")
        self.exposure_spin.valueChanged.connect(self._on_param_changed)
        form.addRow("曝光", self.exposure_spin)

        self.dc_check = QCheckBox("试听/导出前稳健去直流")
        self.dc_check.setChecked(True)
        self.dc_check.toggled.connect(self._on_param_changed)
        form.addRow(self.dc_check)

        preset_row = QHBoxLayout()
        narrow = QPushButton("窄窗 1")
        mid = QPushButton("高频损失 7")
        wide = QPushButton("过宽 31")
        reset = QPushButton("重置试改")
        narrow.clicked.connect(lambda: self.window_spin.setValue(1))
        mid.clicked.connect(lambda: self.window_spin.setValue(7))
        wide.clicked.connect(lambda: self.window_spin.setValue(31))
        reset.clicked.connect(self.reset_trial_params)
        for b in (narrow, mid, wide, reset):
            preset_row.addWidget(b)
        form.addRow(preset_row)
        return box

    def _build_defect_group(self) -> QGroupBox:
        box = QGroupBox("4. 脏点 / 断线示例")
        layout = QVBoxLayout(box)
        row = QHBoxLayout()
        row.addWidget(QLabel("示例类型"))
        self.defect_combo = QComboBox()
        self.defect_combo.addItem("无", "none")
        self.defect_combo.addItem("脏点", "dirty")
        self.defect_combo.addItem("短断线", "break")
        self.defect_combo.addItem("脏点 + 断线", "both")
        self.defect_combo.currentIndexChanged.connect(self._on_defect_kind_changed)
        row.addWidget(self.defect_combo)
        layout.addLayout(row)
        self.redetect_btn = QPushButton("重新检测并标记当前图")
        self.redetect_btn.clicked.connect(self._rerun_decode)
        layout.addWidget(self.redetect_btn)
        note = QLabel("红色=核心异常；黄色=边界待查。所有区间均保留原始时间长度，不裁剪。")
        note.setWordWrap(True)
        note.setStyleSheet("color:#7a4f00;")
        layout.addWidget(note)
        return box

    def _build_export_group(self) -> QGroupBox:
        box = QGroupBox("5. PNG / WAV / 样例")
        layout = QVBoxLayout(box)
        png_btn = QPushButton("导出当前声轨 PNG（含标定/源音元数据）")
        png_btn.clicked.connect(self.export_png)
        open_png_btn = QPushButton("重开导出的 PNG 解回声音")
        open_png_btn.clicked.connect(self.open_png)
        wav_trial_btn = QPushButton("导出试改回读 WAV")
        wav_trial_btn.clicked.connect(lambda: self.export_wav("trial"))
        wav_base_btn = QPushButton("导出无改动基准 WAV")
        wav_base_btn.clicked.connect(lambda: self.export_wav("baseline"))
        sample_btn = QPushButton("重新生成整套图声对照样例")
        sample_btn.setStyleSheet("font-weight:700;")
        sample_btn.clicked.connect(self.generate_sample_bundle)
        for b in (png_btn, open_png_btn, wav_trial_btn, wav_base_btn, sample_btn):
            layout.addWidget(b)
        return box

    def _build_metrics_group(self) -> QGroupBox:
        box = QGroupBox("6. 低/高频、静音底与脉冲比较")
        layout = QVBoxLayout(box)
        self.metrics_table = QTableWidget(0, 4)
        self.metrics_table.setHorizontalHeaderLabels(["指标", "源音", "无改动", "试改"])
        self.metrics_table.verticalHeader().setVisible(False)
        self.metrics_table.setEditTriggers(QTableWidget.EditTrigger.NoEditTriggers)
        self.metrics_table.setMinimumHeight(178)
        header = self.metrics_table.horizontalHeader()
        header.setStretchLastSection(True)
        layout.addWidget(self.metrics_table)
        return box

    def _build_playback_bar(self) -> QHBoxLayout:
        bar = QHBoxLayout()
        self.play_source_btn = QPushButton("▶ 试听源音")
        self.play_base_btn = QPushButton("▶ 试听无改动")
        self.play_trial_btn = QPushButton("▶ 试听试改")
        stop_btn = QPushButton("■ 停止")
        self.play_source_btn.clicked.connect(lambda: self._play_kind("source"))
        self.play_base_btn.clicked.connect(lambda: self._play_kind("baseline"))
        self.play_trial_btn.clicked.connect(lambda: self._play_kind("trial"))
        stop_btn.clicked.connect(self.player.stop)
        for b in (self.play_source_btn, self.play_base_btn, self.play_trial_btn, stop_btn):
            bar.addWidget(b)
        self.time_label = QLabel("0.000 / 3.200 s")
        self.time_label.setMinimumWidth(150)
        bar.addWidget(self.time_label)
        bar.addStretch(1)
        return bar

    # ------------------------------------------------------------- state ops
    def _params(self):
        from .core import ReadParams

        return ReadParams(
            window_rows=self.window_spin.value(),
            offset_px=float(self.offset_spin.value()),
            exposure_ev=float(self.exposure_spin.value()),
            dc_remove=self.dc_check.isChecked(),
        )

    def reset_trial_params(self) -> None:
        self.window_spin.blockSignals(True)
        self.window_slider.blockSignals(True)
        self.offset_spin.blockSignals(True)
        self.exposure_spin.blockSignals(True)
        self.dc_check.blockSignals(True)
        self.window_spin.setValue(1)
        self.window_slider.setValue(1)
        self.offset_spin.setValue(0)
        self.exposure_spin.setValue(0.0)
        self.dc_check.setChecked(True)
        for w in (self.window_spin, self.window_slider, self.offset_spin, self.exposure_spin, self.dc_check):
            w.blockSignals(False)
        self._on_param_changed()

    def _apply_param_dict(self, values: dict) -> None:
        try:
            self.window_spin.setValue(int(values.get("window_rows", 1)))
            self.window_slider.setValue(min(self.window_slider.maximum(), self.window_spin.value()))
            self.offset_spin.setValue(int(round(float(values.get("offset_px", 0.0)))))
            self.exposure_spin.setValue(float(values.get("exposure_ev", 0.0)))
            self.dc_check.setChecked(bool(values.get("dc_remove", True)))
        except (TypeError, ValueError):
            return
        self._on_param_changed()

    def _on_window_spin(self, value: int) -> None:
        self.window_slider.blockSignals(True)
        self.window_slider.setValue(min(value, self.window_slider.maximum()))
        self.window_slider.blockSignals(False)
        self._on_param_changed()

    def _on_window_slider(self, value: int) -> None:
        self.window_spin.blockSignals(True)
        self.window_spin.setValue(value)
        self.window_spin.blockSignals(False)
        self._on_param_changed()

    def _on_cal_changed(self, value: float) -> None:
        self.cal_mm = float(value)
        self.cal_label.setText(calibration_summary(value))
        self.track_view.set_data(self.gray, self.meta, self.segments, self.trial, self._params(), self.current_time, self.cal_mm)

    def _on_param_changed(self, *_args) -> None:
        self.window_desc.setText(window_description(self.window_spin.value()))
        self._rerun_decode()

    def _rerun_decode(self) -> None:
        self.trial = decode_image(self.gray, self._params(), self.meta)
        # Damage marking should not move merely because the classroom read
        # sliders are moved; run detection once with nominal optics.
        detection = decode_image(self.gray, self._ideal_params(), self.meta)
        self.trial.defects = detection.defects
        self._refresh_views()

    def _on_defect_kind_changed(self) -> None:
        kind = self.defect_combo.currentData()
        if kind == "none":
            # Clean generator state.  After opening a PNG, clean_gray is the
            # just-opened image, so "none" means that file without new defects.
            self.gray = self.clean_gray.copy()
        else:
            self.gray, planned = add_defects(self.clean_gray, kind)
            # The deterministic plan is retained as metadata/context, while
            # decode_image also independently proposes intervals.
            self.meta["planned_defects"] = [d.to_dict() for d in planned]
        self._rerun_decode()

    def load_demo(self) -> None:
        self.audio, self.segments = self._build_initial_audio()
        self.track = encode_samples(self.audio, self.segments)
        self.meta = copy.deepcopy(self.track.meta)
        self.clean_gray = self.track.gray.copy()
        self.gray = self.clean_gray.copy()
        self.baseline = decode_image(self.clean_gray, self._ideal_params(), self.meta)
        self.defect_combo.blockSignals(True)
        self.defect_combo.setCurrentIndex(0)
        self.defect_combo.blockSignals(False)
        self.reset_trial_params()
        self.current_time = 0.0
        self.statusBar().showMessage("已生成固定频率、静音底和短脉冲样例")

    def open_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "打开短单声道 WAV", "", "WAV 文件 (*.wav)")
        if not path:
            return
        try:
            audio, sr = load_wav(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "读取 WAV 失败", str(exc))
            return
        self.audio = audio
        self.segments = []
        self.track = encode_samples(self.audio, self.segments, sr)
        self.meta = copy.deepcopy(self.track.meta)
        self.clean_gray = self.track.gray.copy()
        self.gray = self.clean_gray.copy()
        self.baseline = decode_image(self.clean_gray, self._ideal_params(), self.meta)
        self.defect_combo.blockSignals(True)
        self.defect_combo.setCurrentIndex(0)
        self.defect_combo.blockSignals(False)
        self.reset_trial_params()
        self.current_time = 0.0
        self.statusBar().showMessage(f"已读入并编码：{Path(path).name}")

    def export_png(self) -> None:
        path, selected_filter = QFileDialog.getSaveFileName(
            self, "导出声轨 PNG", "examples/soundtrack_export.png", "PNG 图片 (*.png)"
        )
        if not path:
            return
        if not path.lower().endswith(".png"):
            path += ".png"
        try:
            meta = copy.deepcopy(self.meta)
            meta["exported_read_params"] = self._params().__dict__
            if self.audio is not None:
                meta["source_wav_b64"] = base64.b64encode(wav_bytes(self.audio)).decode("ascii")
            save_track_png(path, self.gray, meta)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "导出 PNG 失败", str(exc))
            return
        self.statusBar().showMessage(f"已导出可回读 PNG：{path}")
        QMessageBox.information(self, "导出成功", f"PNG 已保存：\n{path}\n\n可直接用“重开导出的 PNG”验证。")

    def open_png(self) -> None:
        path, _ = QFileDialog.getOpenFileName(self, "重开声轨 PNG", "", "PNG 图片 (*.png)")
        if not path:
            return
        try:
            gray, meta, segments = load_track_png(path)
            source_b64 = meta.get("source_wav_b64")
            if source_b64:
                self.audio, _ = load_wav(base64.b64decode(source_b64.encode("ascii")))
            else:
                self.audio = None
            self.meta = meta
            self.segments = segments
            self.clean_gray = gray
            self.gray = gray.copy()
            self.baseline = decode_image(gray, self._ideal_params(), meta)
            self.defect_combo.blockSignals(True)
            self.defect_combo.setCurrentIndex(0)
            self.defect_combo.blockSignals(False)
            self.reset_trial_params()
            exported = meta.get("exported_read_params")
            if isinstance(exported, dict):
                self._apply_param_dict(exported)
            self.current_time = 0.0
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "PNG 回读失败", str(exc))
            return
        self.statusBar().showMessage(f"已重开并解码 PNG：{Path(path).name}")

    def export_wav(self, which: str) -> None:
        result = self.baseline if which == "baseline" else self.trial
        default = "readback_baseline.wav" if which == "baseline" else "readback_trial.wav"
        path, _ = QFileDialog.getSaveFileName(self, "导出回读 WAV", f"examples/{default}", "WAV (*.wav)")
        if not path:
            return
        if not path.lower().endswith(".wav"):
            path += ".wav"
        write_wav(path, result.samples_audio, AUDIO_RATE)
        self.statusBar().showMessage(f"已导出：{path}")

    def generate_sample_bundle(self) -> None:
        try:
            out = generate_bundle(Path.cwd() / "examples" / "sample_bundle")
        except Exception as exc:  # noqa: BLE001
            QMessageBox.warning(self, "生成样例失败", repr(exc))
            raise
        QMessageBox.information(
            self,
            "样例已生成",
            f"图声对照样例目录：\n{out}\n\n包含正常、过宽、短断线 PNG/WAV 和 comparison.png。",
        )
        self.statusBar().showMessage(f"样例已生成：{out}")

    # ------------------------------------------------------------- playback
    def seek_to(self, t: float) -> None:
        self.current_time = float(t)
        self.track_view.set_selected_time(t)
        self.wave_view.set_time(t)
        self._update_row_readout()
        self._update_time_label()
        if self._playing_kind in {"source", "baseline", "trial"}:
            self._play_kind(self._playing_kind, restart_seek=True)

    def _play_kind(self, kind: str, restart_seek: bool = False) -> None:
        if restart_seek and self._playing_kind == kind:
            pass
        self._playing_kind = kind
        if kind == "source":
            if self.audio is None:
                QMessageBox.information(self, "没有源音", "这个 PNG 未内嵌源音；可试听基准回读。")
                return
            self.player.play(self.audio, AUDIO_RATE, self.current_time)
        elif kind == "baseline":
            self.player.play(self.baseline.samples_audio, AUDIO_RATE, self.current_time)
        else:
            self.player.play(self.trial.samples_audio, AUDIO_RATE, self.current_time)

    def _on_play_position(self, pos: float, duration: float) -> None:
        self.current_time = pos
        self.track_view.set_selected_time(pos)
        self.wave_view.set_time(pos)
        self._update_row_readout()
        self.time_label.setText(f"{pos:0.3f} / {duration:0.3f} s")

    def _selected_defect(self):
        row = self.defect_list.currentRow()
        if row < 0 or row >= len(self.trial.defects):
            return None
        return self.trial.defects[row]

    def _on_defect_selected(self, _row: int) -> None:
        d = self._selected_defect()
        if d is not None:
            self.seek_to(d.start_time)

    def _play_selected_interval(self) -> None:
        d = self._selected_defect()
        if d is None:
            QMessageBox.information(self, "未选择区间", "请先在列表中选择一个检测区间。")
            return
        self._playing_kind = "interval"
        self.player.play(self.trial.samples_audio, AUDIO_RATE, d.start_time, d.end_time)

    def _play_source_interval(self) -> None:
        d = self._selected_defect()
        if d is None:
            return
        if self.audio is None:
            QMessageBox.information(self, "没有源音", "当前 PNG 未内嵌源音。")
            return
        self._playing_kind = "source-interval"
        self.player.play(self.audio, AUDIO_RATE, d.start_time, d.end_time)

    # -------------------------------------------------------------- refresh
    def _refresh_all(self) -> None:
        self._refresh_views()

    def _refresh_views(self) -> None:
        self.source_info.setText(
            f"采样率 {AUDIO_RATE} Hz；声轨行率 {ROW_RATE} 行/s；"
            f"时长 {len(self.audio) / AUDIO_RATE:.2f} s"
            if self.audio is not None
            else f"PNG 回读音：{self.trial.duration:.2f} s（未内嵌源音）"
        )
        self.track_view.set_data(
            self.gray, self.meta, self.segments, self.trial, self._params(), self.current_time, self.cal_mm
        )
        source_for_metrics = self.audio if self.audio is not None else self.baseline.samples_audio
        self.wave_view.set_data(
            source_for_metrics, self.baseline, self.trial, self.segments, self.current_time, AUDIO_RATE
        )
        self._refresh_metrics(source_for_metrics)
        self._refresh_defect_list()
        self._update_row_readout()
        self._update_time_label()
        self.message_view.setPlainText("\n".join(self.trial.messages))

    def _refresh_metrics(self, source: np.ndarray) -> None:
        rows = metrics_rows(source, self.baseline, self.trial, self.segments)
        self.metrics_table.setRowCount(len(rows))
        for i, row in enumerate(rows):
            values = [
                row["metric"],
                row["source"],
                f"{row['baseline']} ({row['baseline_ratio']})" if row.get("baseline_ratio") else row["baseline"],
                f"{row['trial']} ({row['trial_ratio']})" if row.get("trial_ratio") else row["trial"],
            ]
            for j, value in enumerate(values):
                item = QTableWidgetItem(str(value))
                if j == 0:
                    f = item.font()
                    f.setBold(True)
                    item.setFont(f)
                self.metrics_table.setItem(i, j, item)
        self.metrics_table.resizeColumnsToContents()

    def _refresh_defect_list(self) -> None:
        current = self.defect_list.currentRow()
        self.defect_list.blockSignals(True)
        self.defect_list.clear()
        for d in self.trial.defects:
            tag = "待查" if d.status == "review" else "已标记"
            kind = "断线" if d.kind == "break" else "脏点/异常"
            self.defect_list.addItem(
                f"[{tag}] {kind} {d.start_time:0.3f}–{d.end_time:0.3f}s "
                f"(保留 {d.duration * 1000:.1f} ms)"
            )
        if self.trial.defects:
            self.defect_list.setCurrentRow(max(0, current if current >= 0 else 0))
        self.defect_list.blockSignals(False)

    def _update_row_readout(self) -> None:
        if self.gray is None or self.trial is None:
            return
        n = self.gray.shape[0]
        row = int(np.clip(math_floor(self.current_time * ROW_RATE), 0, n - 1))
        params = self._params()
        lx = self.trial.left_x[row]
        rx = self.trial.right_x[row]
        l_text = f"{lx:.1f} px" if np.isfinite(lx) else "未找到"
        r_text = f"{rx:.1f} px" if np.isfinite(rx) else "未找到"
        width = self.trial.smooth_width[row]
        conf = float(self.trial.confidence[row])
        defect_here = "无"
        for d in self.trial.defects:
            if d.review_start_row <= row < d.review_end_row:
                defect_here = ("待查 " if d.status == "review" else "核心 ") + d.kind
                break
        self.row_readout.setText(
            f"时刻 t = {self.current_time:0.4f} s\n"
            f"对应第 {row:,} 行（共 {n:,} 行）\n"
            f"左暗线 x = {l_text}\n"
            f"右暗线 x = {r_text}\n"
            f"判读宽度 = {width:0.2f} px；置信度 {conf:0.2f}\n"
            f"扫描窗：{window_description(params.window_rows)}\n"
            f"横向偏移 {params.offset_px:+.0f} px；曝光 {params.exposure_ev:+.1f} EV\n"
            f"本行缺陷：{defect_here}"
        )
        self.profile.set_data(self.gray, self.trial, row, self.meta, params)

    def _update_time_label(self) -> None:
        duration = len(self.audio) / AUDIO_RATE if self.audio is not None else self.trial.duration
        self.time_label.setText(f"{self.current_time:0.3f} / {duration:0.3f} s")


def math_floor(x: float) -> int:
    import math

    return math.floor(x)


def main() -> int:
    app = QApplication(sys.argv)
    app.setApplicationName("Soundtrack Lab")
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
