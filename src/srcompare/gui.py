# -*- coding: utf-8 -*-
"""PySide6 主窗口: 采样率转换三路对比工具。"""
from __future__ import annotations

import os
import sys

import numpy as np
from PySide6.QtCore import Qt, QTimer
from PySide6.QtWidgets import (
    QApplication, QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout,
    QGroupBox, QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPlainTextEdit,
    QPushButton, QRadioButton, QSlider, QTabWidget, QVBoxLayout, QWidget,
    QCheckBox,
)

from . import ALLOWED_INPUT_RATES, TARGET_RATES
from .audioio import Track, load_wav, save_wav
from .measure import ConversionReport, evaluate_conversion, verify_export
from .playback import AudioPlayer
from .plotting import CompareCanvas
from .resample import convert
from .testtone import TONE_PRESETS, make_test_tone

PLAYBACK_KEYS = ("original", "linear", "high_quality")
PLAYBACK_LABELS = {
    "original": "① 原声",
    "linear": "② 线性插值",
    "high_quality": "③ 高质量(抗混叠)",
}


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("采样率转换对比工具 — 线性插值 vs 抗混叠高质量")
        self.resize(1320, 940)

        self.tracks: dict[str, Track] = {}
        self.reports: dict[str, ConversionReport] = {}
        self.target_sr = 16000
        self.channel = 0
        self.export_dir = os.path.abspath(
            os.path.join(os.path.dirname(__file__), "..", "..", "exports")
        )

        self.player = AudioPlayer(self)
        self.player.positionChanged.connect(self._on_position)
        self._playing_key = ""
        self._slider_guard = False

        self._build_ui()
        self._refresh_timer = QTimer(self)
        self._refresh_timer.setInterval(50)
        self._refresh_timer.timeout.connect(self._sync_position_slider)

    # ================================================================== #
    # UI 构建
    # ================================================================== #
    def _build_ui(self):
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        # ---------------- 顶部控制区 ----------------
        top = QHBoxLayout()

        grp_file = QGroupBox("输入 (原始文件不修改)")
        lay_file = QVBoxLayout(grp_file)
        self.btn_open = QPushButton("打开 WAV… (单/立体声, ≤10s, 44.1/48kHz)")
        self.btn_open.clicked.connect(self.open_file)
        lay_file.addWidget(self.btn_open)
        top.addWidget(grp_file)

        grp_tone = QGroupBox("或生成测试音 (无需录音)")
        lay_tone = QFormLayout(grp_tone)
        self.combo_preset = QComboBox()
        for key, p in TONE_PRESETS.items():
            self.combo_preset.addItem(p["title"], key)
        self.combo_tone_sr = QComboBox()
        for sr in ALLOWED_INPUT_RATES:
            self.combo_tone_sr.addItem(f"{sr/1000:.1f} kHz", sr)
        self.combo_tone_sr.setCurrentIndex(1)  # 默认 48k
        self.spin_dur = QDoubleSpinBox()
        self.spin_dur.setRange(0.5, 10.0)
        self.spin_dur.setValue(2.0)
        self.spin_dur.setSingleStep(0.5)
        self.spin_dur.setSuffix(" s")
        self.btn_gen = QPushButton("生成并分析")
        self.btn_gen.clicked.connect(self.generate_tone)
        lay_tone.addRow("预设", self.combo_preset)
        lay_tone.addRow("采样率", self.combo_tone_sr)
        lay_tone.addRow("时长", self.spin_dur)
        lay_tone.addRow(self.btn_gen)
        top.addWidget(grp_tone)

        grp_target = QGroupBox("目标采样率 / 声道")
        lay_target = QFormLayout(grp_target)
        self.combo_target = QComboBox()
        for sr in TARGET_RATES:
            self.combo_target.addItem(f"{sr/1000:.1f} kHz", sr)
        self.combo_target.currentIndexChanged.connect(self._on_target_changed)
        self.combo_channel = QComboBox()
        self.combo_channel.addItem("左声道 / 单声道", 0)
        self.combo_channel.addItem("右声道", 1)
        self.combo_channel.currentIndexChanged.connect(self._on_channel_changed)
        lay_target.addRow("目标", self.combo_target)
        lay_target.addRow("显示声道", self.combo_channel)
        top.addWidget(grp_target)

        grp_action = QGroupBox("导出 / 回读校验")
        lay_action = QVBoxLayout(grp_action)
        self.btn_export = QPushButton("导出两路 WAV 并回读校验")
        self.btn_export.clicked.connect(self.export_and_verify)
        self.btn_export.setEnabled(False)
        lay_action.addWidget(self.btn_export)
        top.addWidget(grp_action)
        top.addStretch(1)
        root.addLayout(top)

        # ---------------- 元信息 ----------------
        self.lbl_meta = QLabel("尚未载入音频。")
        self.lbl_meta.setStyleSheet("font-family: monospace; padding: 4px;")
        self.lbl_meta.setWordWrap(True)
        root.addWidget(self.lbl_meta)

        # ---------------- Tab: 图 / 试听 / 测量 ----------------
        self.tabs = QTabWidget()
        root.addWidget(self.tabs, 1)

        self.canvas = CompareCanvas()
        self.tabs.addTab(self.canvas, "波形与频谱")

        self._build_playback_tab()
        self.tabs.addTab(self.play_tab, "三路试听 (同时间区间)")

        self.txt_report = QPlainTextEdit()
        self.txt_report.setReadOnly(True)
        self.txt_report.setStyleSheet("font-family: monospace; font-size: 12px;")
        self.tabs.addTab(self.txt_report, "测量与回读结果")

        self.statusBar().showMessage(
            "提示: 回放经系统音频设备, 设备内部可能再做采样率转换; "
            "质量判定以测量与导出回读为准。"
        )

    def _build_playback_tab(self):
        self.play_tab = QWidget()
        lay = QVBoxLayout(self.play_tab)

        hint = QLabel(
            "每路按自身采样率原生播放(不预重采样), 三路共用同一时间位置与循环区间;\n"
            "切换版本不会播错。音高与速度保持不变。设备内部的转换不计入导出质量。"
        )
        hint.setStyleSheet("color: #374151;")
        lay.addWidget(hint)

        grp_sel = QGroupBox("选择试听版本")
        lay_sel = QHBoxLayout(grp_sel)
        self.radio_track = {}
        for key in PLAYBACK_KEYS:
            rb = QRadioButton(PLAYBACK_LABELS[key])
            rb.toggled.connect(lambda checked, k=key: checked and self._switch_track(k))
            rb.setEnabled(False)
            self.radio_track[key] = rb
            lay_sel.addWidget(rb)
        lay_sel.addStretch(1)
        lay.addWidget(grp_sel)

        grp_ctrl = QGroupBox("播放控制 (统一时间轴, 秒)")
        lay_ctrl = QVBoxLayout(grp_ctrl)
        row = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_pause = QPushButton("暂停")
        self.btn_stop = QPushButton("停止")
        self.btn_play.clicked.connect(self._play_clicked)
        self.btn_pause.clicked.connect(self.player.pause)
        self.btn_stop.clicked.connect(self._stop_clicked)
        self.lbl_pos = QLabel("0.000 / 0.000 s")
        row.addWidget(self.btn_play)
        row.addWidget(self.btn_pause)
        row.addWidget(self.btn_stop)
        row.addWidget(self.lbl_pos)
        row.addStretch(1)
        lay_ctrl.addLayout(row)

        self.slider_pos = QSlider(Qt.Horizontal)
        self.slider_pos.setRange(0, 1000)
        self.slider_pos.sliderReleased.connect(self._seek_from_slider)
        self.slider_pos.sliderMoved.connect(self._preview_slider)
        lay_ctrl.addWidget(self.slider_pos)

        loop_row = QHBoxLayout()
        self.chk_loop = QCheckBox("循环区间")
        self.spin_loop_a = QDoubleSpinBox()
        self.spin_loop_b = QDoubleSpinBox()
        for sp in (self.spin_loop_a, self.spin_loop_b):
            sp.setRange(0.0, 10.0)
            sp.setDecimals(3)
            sp.setSingleStep(0.1)
            sp.setSuffix(" s")
        self.spin_loop_a.setValue(0.0)
        self.spin_loop_b.setValue(2.0)
        self.chk_loop.toggled.connect(self._apply_loop)
        self.spin_loop_a.valueChanged.connect(self._apply_loop)
        self.spin_loop_b.valueChanged.connect(self._apply_loop)
        loop_row.addWidget(self.chk_loop)
        loop_row.addWidget(QLabel("起"))
        loop_row.addWidget(self.spin_loop_a)
        loop_row.addWidget(QLabel("止"))
        loop_row.addWidget(self.spin_loop_b)
        loop_row.addStretch(1)
        lay_ctrl.addLayout(loop_row)
        lay.addWidget(grp_sel)
        lay.addWidget(grp_ctrl)
        lay.addStretch(1)

    # ================================================================== #
    # 数据载入与转换
    # ================================================================== #
    def open_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "选择 WAV 文件", os.path.expanduser("~"), "WAV (*.wav)"
        )
        if not path:
            return
        try:
            track = load_wav(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "无法读取", str(exc))
            return
        self._set_source(track)

    def generate_tone(self):
        key = self.combo_preset.currentData()
        sr = int(self.combo_tone_sr.currentData())
        dur = float(self.spin_dur.value())
        track = make_test_tone(key, sr, dur)
        self._set_source(track)

    def _set_source(self, source: Track):
        self.player.stop()
        self._playing_key = ""
        self.target_sr = int(self.combo_target.currentData())
        self.tracks = {
            "original": source,
            "linear": convert(source, self.target_sr, "linear"),
            "high_quality": convert(source, self.target_sr, "high_quality"),
        }
        self.reports = {
            "linear": evaluate_conversion(source, self.tracks["linear"], self.channel),
            "high_quality": evaluate_conversion(
                source, self.tracks["high_quality"], self.channel
            ),
        }
        self.btn_export.setEnabled(True)
        for rb in self.radio_track.values():
            rb.setEnabled(True)
        self.radio_track["original"].setChecked(True)
        self._update_meta()
        self.canvas.update_plots(self.tracks, self.channel)
        self._update_report()
        self._reset_playback_ui()
        self.tabs.setCurrentIndex(0)

    def _on_target_changed(self):
        if "original" not in self.tracks:
            return
        self.target_sr = int(self.combo_target.currentData())
        src = self.tracks["original"]
        self.player.stop()
        self.tracks["linear"] = convert(src, self.target_sr, "linear")
        self.tracks["high_quality"] = convert(src, self.target_sr, "high_quality")
        self.reports = {
            "linear": evaluate_conversion(src, self.tracks["linear"], self.channel),
            "high_quality": evaluate_conversion(
                src, self.tracks["high_quality"], self.channel
            ),
        }
        self._update_meta()
        self.canvas.update_plots(self.tracks, self.channel)
        self._update_report()
        self._reset_playback_ui()

    def _on_channel_changed(self):
        self.channel = int(self.combo_channel.currentData())
        if "original" not in self.tracks:
            return
        src = self.tracks["original"]
        self.reports = {
            "linear": evaluate_conversion(src, self.tracks["linear"], self.channel),
            "high_quality": evaluate_conversion(
                src, self.tracks["high_quality"], self.channel
            ),
        }
        self.canvas.update_plots(self.tracks, self.channel)
        self._update_report()

    # ================================================================== #
    # 信息与测量文本
    # ================================================================== #
    def _update_meta(self):
        lines = ["实际采样率 / 点数 / 时长 (原始文件不会被修改):"]
        for key in PLAYBACK_KEYS:
            tr = self.tracks[key]
            lines.append(
                f"  {PLAYBACK_LABELS[key]:<16} {tr.sr:>6} Hz | "
                f"{tr.num_frames:>7} 点 | "
                f"{tr.duration:7.4f} s | {tr.channels}ch | {tr.note}"
            )
        src = self.tracks["original"]
        lin = self.tracks["linear"]
        hq = self.tracks["high_quality"]
        equal_len = lin.num_frames == hq.num_frames
        lines.append(
            f"  两路输出点数{'相同' if equal_len else '不同!'}: "
            f"{lin.num_frames} vs {hq.num_frames}; "
            f"目标点数 round({src.duration:.4f}s × {self.target_sr}) = "
            f"{round(src.duration * self.target_sr)}"
        )
        self.lbl_meta.setText("\n".join(lines))

    def _update_report(self):
        if "original" not in self.tracks:
            return
        out = ["=" * 72, "频谱测量 (程序测试音; 通用 WAV 时若无单音定义则为空)"]
        for key in ("linear", "high_quality"):
            rep = self.reports[key]
            out.append("-" * 72)
            out.append(f"[{PLAYBACK_LABELS[key]}]")
            out.extend(rep.summary_lines())
        out.append("=" * 72)
        self.txt_report.setPlainText("\n".join(out))

    # ================================================================== #
    # 试听
    # ================================================================== #
    def _reset_playback_ui(self):
        self.player.stop()
        self._playing_key = ""
        dur = self.tracks["original"].duration if self.tracks else 0.0
        self.spin_loop_a.setMaximum(dur)
        self.spin_loop_b.setMaximum(dur)
        self.spin_loop_b.setValue(dur)
        self._apply_loop()
        self.lbl_pos.setText(f"0.000 / {dur:.3f} s")
        self.slider_pos.setValue(0)

    def _switch_track(self, key: str):
        if key not in self.tracks:
            return
        self._playing_key = key
        self.player.set_track(self.tracks[key])
        self._apply_loop()

    def _play_clicked(self):
        if not self._playing_key:
            self.radio_track["original"].setChecked(True)
            self._switch_track("original")
        self.player.play()
        self._refresh_timer.start()

    def _stop_clicked(self):
        self.player.stop()
        self._refresh_timer.stop()
        self.player.set_position(0.0)
        self.slider_pos.setValue(0)
        dur = self.tracks[self._playing_key].duration if self._playing_key else 0.0
        self.lbl_pos.setText(f"0.000 / {dur:.3f} s")

    def _on_position(self, sec: float):
        if self._playing_key:
            dur = self.tracks[self._playing_key].duration
            self.lbl_pos.setText(f"{sec:.3f} / {dur:.3f} s")

    def _sync_position_slider(self):
        if self._slider_guard or not self._playing_key:
            return
        dur = self.tracks[self._playing_key].duration
        if dur <= 0:
            return
        self.slider_pos.setValue(
            int(round(self.player.position() / dur * 1000))
        )

    def _preview_slider(self, val: int):
        if not self._playing_key:
            return
        dur = self.tracks[self._playing_key].duration
        self.lbl_pos.setText(f"{val/1000*dur:.3f} / {dur:.3f} s")

    def _seek_from_slider(self):
        if not self._playing_key:
            return
        dur = self.tracks[self._playing_key].duration
        self.player.set_position(self.slider_pos.value() / 1000.0 * dur)

    def _apply_loop(self):
        if not self.tracks:
            return
        if self.chk_loop.isChecked():
            a = float(self.spin_loop_a.value())
            b = float(self.spin_loop_b.value())
            if b <= a:
                b = a + 0.05
            self.player.set_loop(a, b)
        else:
            self.player.set_loop(None, None)

    # ================================================================== #
    # 导出 + 回读
    # ================================================================== #
    def export_and_verify(self):
        if "original" not in self.tracks:
            return
        os.makedirs(self.export_dir, exist_ok=True)
        base = os.path.splitext(
            os.path.basename(self.tracks["original"].source_name)
        )[0] or "tone"
        base = "".join(c if c.isalnum() or c in "-_." else "_" for c in base)
        paths = {}
        for key, tag in (("linear", "linear"), ("high_quality", "soxr_hq")):
            tr = self.tracks[key]
            path = os.path.join(
                self.export_dir,
                f"{base}_{tr.sr}Hz_{tag}.wav",
            )
            save_wav(path, tr.samples, tr.sr)
            paths[key] = path

        out = ["=" * 72, "导出与回读校验 (16bit PCM, 两路等长, 不做响度处理)"]
        all_ok = True
        src = self.tracks["original"]
        for key in ("linear", "high_quality"):
            rep = self.reports[key]
            rb = verify_export(paths[key], self.tracks[key], src, rep)
            all_ok &= rb.ok
            out.append("-" * 72)
            out.append(f"[{PLAYBACK_LABELS[key]}] 导出: {paths[key]}")
            out.extend(rb.lines())
        out.append("=" * 72)
        out.append("回读总体结论: " + ("全部通过" if all_ok else "存在不通过项"))
        self.txt_report.setPlainText("\n".join(out))
        self.tabs.setCurrentWidget(self.txt_report)
        self.statusBar().showMessage(
            f"已导出到 {self.export_dir} — {'全部通过' if all_ok else '存在不通过项'}"
        )


def main():
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
