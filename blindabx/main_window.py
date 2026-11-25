"""盲听台主窗口。"""
from __future__ import annotations

import json
from datetime import datetime

from PySide6.QtCore import Qt
from PySide6.QtGui import QKeySequence, QShortcut
from PySide6.QtWidgets import (
    QCheckBox, QComboBox, QDoubleSpinBox, QFileDialog, QFormLayout, QGroupBox,
    QHBoxLayout, QLabel, QMainWindow, QMessageBox, QPlainTextEdit, QPushButton,
    QRadioButton, QStatusBar, QVBoxLayout, QWidget,
)

from .audio import DEFAULT_PAIR, PRESET_BY_KEY, PRESETS, ProcessedBundle
from .player import GaplessPlayer
from .session import Round, Session, SessionSettings
from .waveform import WaveformView
from .workers import ProcessWorker


def _fmt_db(v: float) -> str:
    return "−∞ dBFS" if v == float("-inf") else f"{v:6.1f} dB"


def _fmt_lufs(v: float) -> str:
    return "−∞ LUFS" if v == float("-inf") else f"{v:6.1f} LUFS"


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("本地盲听台 · A/B/X 有损编码对比")
        self.resize(1060, 860)

        self._bundle: ProcessedBundle | None = None
        self._worker: ProcessWorker | None = None
        self._workers: list[ProcessWorker] = []  # 保活, 防止 QThread 被 GC
        self._session: Session | None = None
        self._past_sessions: list[Session] = []
        self._revealed: Round | None = None
        self._active_slot: str | None = None  # 当前听的槽位 A/B/X
        self._player = GaplessPlayer(self)
        self._player.positionChanged.connect(self._on_position)
        self._player.playbackEnded.connect(self._on_ended)
        self._player.activeChanged.connect(lambda _k: self._update_source_buttons())

        self._build_ui()
        self._build_shortcuts()
        self._set_controls_locked(False)

    def closeEvent(self, event) -> None:  # noqa: N802
        for worker in list(self._workers):
            if worker.isRunning():
                worker.requestInterruption()
                worker.quit()
                worker.wait(3000)
        self._player.stop()
        super().closeEvent(event)

    # ================================================================== #
    # UI 构建
    # ================================================================== #
    def _build_ui(self) -> None:
        root = QWidget()
        layout = QVBoxLayout(root)

        layout.addWidget(self._build_source_box())
        layout.addWidget(self._build_metrics_box())
        layout.addWidget(self._build_play_box())
        layout.addWidget(self._build_round_box())
        self.setCentralWidget(root)
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("就绪: 选择素材与两组编码设置后点击「处理素材」")

    def _build_source_box(self) -> QGroupBox:
        box = QGroupBox("1. 素材与编码设置 (同一入口)")
        form = QFormLayout(box)

        self._source_kind = QComboBox()
        self._source_kind.addItem("内置: 敲击样例 (瞬态)", ("builtin", "sample_transients"))
        self._source_kind.addItem("内置: 安静尾音样例 (长衰减)", ("builtin", "sample_quiet_tail"))
        self._source_kind.addItem("外部 WAV 文件…", ("file", ""))
        self._source_kind.currentIndexChanged.connect(self._on_source_kind)
        form.addRow("来源", self._source_kind)

        file_row = QWidget()
        row = QHBoxLayout(file_row)
        row.setContentsMargins(0, 0, 0, 0)
        self._file_path = QLabel("(未选择)")
        btn_pick = QPushButton("选择 WAV…")
        btn_pick.clicked.connect(self._pick_wav)
        row.addWidget(self._file_path, 1)
        row.addWidget(btn_pick)
        form.addRow("WAV", file_row)

        self._combo_a = QComboBox()
        self._combo_b = QComboBox()
        for preset in PRESETS:
            self._combo_a.addItem(preset.label, preset.key)
            self._combo_b.addItem(preset.label, preset.key)
        self._combo_a.setCurrentIndex(self._combo_a.findData(DEFAULT_PAIR[0]))
        self._combo_b.setCurrentIndex(self._combo_b.findData(DEFAULT_PAIR[1]))
        form.addRow("编码 A", self._combo_a)
        form.addRow("编码 B", self._combo_b)

        opt_row = QWidget()
        opt = QHBoxLayout(opt_row)
        opt.setContentsMargins(0, 0, 0, 0)
        self._chk_blind = QCheckBox("盲听模式 (隐藏 A/B 对应设置)")
        self._chk_align = QCheckBox("补静音并对齐共同有效范围")
        self._chk_loud = QCheckBox("响度匹配")
        self._chk_blind.setChecked(True)
        self._chk_align.setChecked(True)
        # 盲听只影响标签展示, 不改动音频; 对齐/响度才需要重建播放缓冲
        self._chk_blind.stateChanged.connect(self._blind_toggled)
        self._chk_align.stateChanged.connect(self._option_changed)
        self._chk_loud.stateChanged.connect(self._option_changed)
        opt.addWidget(self._chk_blind)
        opt.addWidget(self._chk_align)
        opt.addWidget(self._chk_loud)
        opt.addStretch(1)
        form.addRow("开关", opt_row)

        run_row = QWidget()
        rr = QHBoxLayout(run_row)
        rr.setContentsMargins(0, 0, 0, 0)
        self._btn_process = QPushButton("处理素材")
        self._btn_process.clicked.connect(self._start_full_process)
        rr.addWidget(self._btn_process)
        rr.addStretch(1)
        form.addRow(run_row)
        return box

    def _build_metrics_box(self) -> QGroupBox:
        box = QGroupBox("2. 处理结果: 时长 / 响度 / 静音 (试听前可先确认对齐与音量变化)")
        v = QVBoxLayout(box)
        self._metrics_view = QPlainTextEdit()
        self._metrics_view.setReadOnly(True)
        self._metrics_view.setMaximumBlockCount(0)
        self._metrics_view.setMinimumHeight(150)
        v.addWidget(self._metrics_view)
        return box

    def _build_play_box(self) -> QGroupBox:
        box = QGroupBox("3. 试听 (同位置切换, 无额外跳停; 循环边界对所有音源同步)")
        v = QVBoxLayout(box)

        self._wave = WaveformView()
        self._wave.seekRequested.connect(self._seek)
        self._wave.loopChanged.connect(self._on_loop_dragged)
        v.addWidget(self._wave)

        row1 = QWidget()
        h1 = QHBoxLayout(row1)
        self._btn_play = QPushButton("播放/暂停 (空格)")
        self._btn_play.clicked.connect(self._player.toggle)
        self._btn_a = QPushButton("听 A (1)")
        self._btn_b = QPushButton("听 B (2)")
        self._btn_x = QPushButton("听未知 X (3)")
        for b in (self._btn_a, self._btn_b, self._btn_x):
            b.setCheckable(True)
            b.setMinimumHeight(46)
        self._btn_a.clicked.connect(lambda: self._switch("A"))
        self._btn_b.clicked.connect(lambda: self._switch("B"))
        self._btn_x.clicked.connect(lambda: self._switch("X"))
        h1.addWidget(self._btn_play)
        h1.addWidget(self._btn_a, 1)
        h1.addWidget(self._btn_b, 1)
        h1.addWidget(self._btn_x, 1)
        v.addWidget(row1)

        row2 = QWidget()
        h2 = QHBoxLayout(row2)
        self._chk_loop = QCheckBox("片段循环")
        self._chk_loop.stateChanged.connect(self._toggle_loop)
        self._lbl_pos = QLabel("0.00 / 0.00 s")
        h2.addWidget(self._chk_loop)
        h2.addWidget(QLabel("循环起(s)"))
        self._spn_loop_s = QDoubleSpinBox()
        self._spn_loop_s.setDecimals(3)
        self._spn_loop_s.setSingleStep(0.05)
        self._spn_loop_s.setMaximum(10 ** 6)
        h2.addWidget(self._spn_loop_s)
        h2.addWidget(QLabel("循环止(s)"))
        self._spn_loop_e = QDoubleSpinBox()
        self._spn_loop_e.setDecimals(3)
        self._spn_loop_e.setSingleStep(0.05)
        self._spn_loop_e.setMaximum(10 ** 6)
        h2.addWidget(self._spn_loop_e)
        self._btn_apply_loop = QPushButton("应用边界")
        self._btn_apply_loop.clicked.connect(self._apply_loop_spins)
        h2.addWidget(self._btn_apply_loop)
        h2.addStretch(1)
        h2.addWidget(self._lbl_pos)
        v.addWidget(row2)

        self._lbl_source_info = QLabel("尚未载入素材")
        self._lbl_source_info.setWordWrap(True)
        v.addWidget(self._lbl_source_info)
        return box

    def _build_round_box(self) -> QGroupBox:
        box = QGroupBox("4. 盲听轮次 (正式轮次中设置锁定; 只能取消整轮换参数, 旧结果保留)")
        v = QVBoxLayout(box)

        row = QWidget()
        h = QHBoxLayout(row)
        self._btn_start = QPushButton("开始新轮次 (N)")
        self._btn_start.clicked.connect(self._start_round)
        self._btn_cancel = QPushButton("取消整轮")
        self._btn_cancel.clicked.connect(self._cancel_round)
        self._rad_guess_a = QRadioButton("我认为 X = A")
        self._rad_guess_b = QRadioButton("我认为 X = B")
        self._btn_submit = QPushButton("提交并揭示 (Enter)")
        self._btn_submit.clicked.connect(self._submit_round)
        self._btn_export = QPushButton("导出本地记录…")
        self._btn_export.clicked.connect(self._export)
        h.addWidget(self._btn_start)
        h.addWidget(self._btn_cancel)
        h.addWidget(self._rad_guess_a)
        h.addWidget(self._rad_guess_b)
        h.addWidget(self._btn_submit)
        h.addStretch(1)
        h.addWidget(self._btn_export)
        v.addWidget(row)

        self._round_view = QPlainTextEdit()
        self._round_view.setReadOnly(True)
        self._round_view.setMaximumHeight(170)
        v.addWidget(self._round_view)
        return box

    def _build_shortcuts(self) -> None:
        QShortcut(QKeySequence("Space"), self, self._player.toggle)
        QShortcut(QKeySequence("1"), self, lambda: self._switch("A"))
        QShortcut(QKeySequence("2"), self, lambda: self._switch("B"))
        QShortcut(QKeySequence("3"), self, lambda: self._switch("X"))
        QShortcut(QKeySequence("N"), self, self._start_round)
        QShortcut(QKeySequence(Qt.Key.Key_Return), self, self._submit_round)
        QShortcut(QKeySequence(Qt.Key.Key_Enter), self, self._submit_round)

    # ================================================================== #
    # 素材处理
    # ================================================================== #
    def _on_source_kind(self) -> None:
        kind, _key = self._source_kind.currentData()
        self._file_path.setEnabled(kind == "file")

    def _pick_wav(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "选择参考 WAV", "", "WAV 音频 (*.wav *.wave);;所有文件 (*)",
        )
        if path:
            self._file_path.setText(path)
            self._source_kind.setCurrentIndex(2)

    def _current_settings(self) -> SessionSettings:
        bundle = self._bundle
        return SessionSettings(
            setting_a=(bundle.setting_a.describe() if bundle
                       else PRESET_BY_KEY[self._combo_a.currentData()].describe()),
            setting_b=(bundle.setting_b.describe() if bundle
                       else PRESET_BY_KEY[self._combo_b.currentData()].describe()),
            source_name=(bundle.source.name if bundle
                         else self._source_kind.currentText()),
            alignment=self._chk_align.isChecked(),
            loudness_match=self._chk_loud.isChecked(),
            blind=self._chk_blind.isChecked(),
        )

    def _start_full_process(self) -> None:
        kind, key = self._source_kind.currentData()
        if kind == "file":
            path = self._file_path.text()
            if path == "(未选择)":
                QMessageBox.warning(self, "缺少素材", "请先选择一个 WAV 文件。")
                return
            payload = {"source_kind": "file", "source_path": path}
        else:
            payload = {"source_kind": "builtin", "source_key": key}
        if self._combo_a.currentData() == self._combo_b.currentData():
            QMessageBox.warning(self, "设置冲突", "A 和 B 必须是不同的有损编码设置。")
            return
        payload.update(
            setting_a=PRESET_BY_KEY[self._combo_a.currentData()],
            setting_b=PRESET_BY_KEY[self._combo_b.currentData()],
            alignment=self._chk_align.isChecked(),
            loudness_match=self._chk_loud.isChecked(),
        )
        self._run_worker("full", payload)

    def _option_changed(self) -> None:
        # 轮次进行中: 禁止改开关, 恢复勾选态并提示
        if self._session is not None and self._session.in_round:
            QMessageBox.information(
                self, "轮次进行中",
                "正式轮次进行中不能修改盲听/对齐/响度开关。\n"
                "请先「取消整轮」再换参数; 已完成轮次保留原设置。",
            )
            self._restore_option_checks()
            return
        if self._bundle is None:
            return
        payload = {
            "bundle": self._bundle,
            "alignment": self._chk_align.isChecked(),
            "loudness_match": self._chk_loud.isChecked(),
        }
        self._run_worker("rebuild", payload)

    def _blind_toggled(self) -> None:
        # 盲听只切换标签可见性, 不动音频; 轮次中同样锁定
        if self._session is not None and self._session.in_round:
            QMessageBox.information(
                self, "轮次进行中",
                "正式轮次进行中不能修改盲听开关。\n"
                "请先「取消整轮」再换参数; 已完成轮次保留原设置。",
            )
            self._restore_option_checks()
            return
        self._update_source_buttons()
        self._render_metrics()

    def _restore_option_checks(self) -> None:
        if self._bundle is None:
            return
        for chk, val in (
            (self._chk_align, self._bundle.alignment),
            (self._chk_loud, self._bundle.loudness_match),
        ):
            chk.blockSignals(True)
            chk.setChecked(val)
            chk.blockSignals(False)
        if self._session is not None:
            chk = self._chk_blind
            chk.blockSignals(True)
            chk.setChecked(self._session.settings.blind)
            chk.blockSignals(False)

    def _run_worker(self, mode: str, payload: dict) -> None:
        self._btn_process.setEnabled(False)
        self.statusBar().showMessage("处理中…")
        worker = ProcessWorker(mode, payload, self)
        worker.progress.connect(lambda m: self.statusBar().showMessage(m))
        worker.failed.connect(self._on_failed)
        worker.finishedBundle.connect(self._on_bundle)
        worker.finished.connect(lambda w=worker: self._drop_worker(w))
        self._workers.append(worker)
        self._worker = worker
        worker.start()

    def _drop_worker(self, worker: ProcessWorker) -> None:
        if worker in self._workers:
            self._workers.remove(worker)
        worker.deleteLater()

    def _on_failed(self, msg: str) -> None:
        self._btn_process.setEnabled(True)
        self.statusBar().showMessage("处理失败")
        QMessageBox.critical(self, "音频处理失败", msg)

    def _on_bundle(self, bundle: ProcessedBundle) -> None:
        self._btn_process.setEnabled(True)
        self._bundle = bundle
        # 开关以实际 bundle 为准(重建后保持 UI 一致)
        self._restore_option_checks()
        self._player.load(bundle.final, bundle.sr, bundle.ch)
        self._wave.set_waveform(bundle.final["ref"], bundle.sr)
        dur = self._player.duration()
        self._spn_loop_s.setMaximum(dur)
        self._spn_loop_e.setMaximum(dur)
        self._spn_loop_s.setValue(0.0)
        self._spn_loop_e.setValue(round(dur, 3))
        self._player.set_loop_bounds(0, dur)
        self._wave.set_loop(0, dur)
        self._switch("A")
        self._render_metrics()
        self._update_source_buttons()
        self.statusBar().showMessage(
            f"就绪: 共同有效时长 {dur:.3f}s · 偏移(样点) {bundle.offsets}"
        )

    # ================================================================== #
    # 指标展示
    # ================================================================== #
    def _render_metrics(self) -> None:
        b = self._bundle
        assert b is not None
        lines: list[str] = []
        lines.append(f"素材: {b.source.name}  ({b.sr} Hz, {b.ch} ch)")
        lines.append(
            f"编码 A: {b.setting_a.label}    编码 B: {b.setting_b.label}"
        )
        lines.append(
            f"开关: 盲听={'开' if self._chk_blind.isChecked() else '关'}  "
            f"对齐共同范围={'开' if b.alignment else '关'}  "
            f"响度匹配={'开' if b.loudness_match else '关'}"
        )
        lines.append("")
        header = f"{'音源':<6}{'时长(s)':>10}{'集成响度':>14}{'采样峰值':>12}{'头静音(ms)':>12}{'尾静音(ms)':>12}"
        lines.append(header)
        for key in ("ref", "A", "B"):
            m = b.final_metrics[key]
            lines.append(
                f"{key:<6}{m['duration_s']:>10.3f}"
                f"{_fmt_lufs(m['lufs']):>14}{_fmt_db(m['peak_db']):>12}"
                f"{m['silence_head_ms']:>12.1f}{m['silence_tail_ms']:>12.1f}"
            )
        lines.append("")
        lines.append("原始解码(未对齐前)与参考的差异:")
        ref = b.raw_metrics["ref"]
        for key in ("A", "B"):
            m = b.raw_metrics[key]
            lines.append(
                f"  {key}: Δ时长 {m['duration_s'] - ref['duration_s']:+.4f}s, "
                f"Δ响度 {m['lufs'] - ref['lufs']:+.2f} LUFS, "
                f"头静音 {m['silence_head_ms']:.1f}ms, "
                f"估计偏移 {b.offsets.get(key, 0)} 样点"
            )
        if b.gains:
            lines.append("响度匹配增益:")
            for key, g in b.gains.items():
                tag = " (峰值回填限制)" if g["peak_limited"] else ""
                lines.append(f"  {key}: {g['gain_db']:+.2f} dB{tag}")
        self._metrics_view.setPlainText("\n".join(lines))

    # ================================================================== #
    # 播放控制
    # ================================================================== #
    def _switch(self, key: str) -> None:
        if self._bundle is None:
            return
        if key == "X" and not (self._session and self._session.in_round):
            self.statusBar().showMessage("X 仅在正式轮次中可用, 请先「开始新轮次」")
            return
        actual = key
        if key == "X":
            assert self._session is not None and self._session.current is not None
            actual = self._session.current.x_is
        self._player.switch_source(actual)
        self._update_source_buttons()

    def _update_source_buttons(self) -> None:
        active = self._player.active_source if self._bundle else None
        in_round = bool(self._session and self._session.in_round)
        mapping = {"A": self._btn_a, "B": self._btn_b, "X": self._btn_x}
        for key, btn in mapping.items():
            btn.setChecked(False)
        if in_round:
            # 盲听: 只知道当前是 A/B/X 哪个槽位, 不知道 X 的真实来源
            cur = self._session.current
            self._active_slot = (
                "X" if cur is not None and active == cur.x_is else active)
            slot = self._active_slot
            if slot in mapping:
                mapping[slot].setChecked(True)
        elif active in mapping:
            mapping[active].setChecked(True)
        self._btn_x.setEnabled(in_round)
        self._lbl_source_info.setText(self._source_line(in_round))

    def _source_line(self, in_round: bool) -> str:
        if self._bundle is None:
            return "尚未载入素材"
        b = self._bundle
        if self._chk_blind.isChecked():
            if in_round:
                return "盲听中: A / B 标签与编码设置已隐藏; X 来源本轮固定, 提交后揭示。"
            if self._revealed is not None:
                r = self._revealed
                return (
                    f"上一轮已揭示: X 实际来自 {r.x_is} "
                    f"(A={b.setting_a.label}, B={b.setting_b.label})。"
                    "试听区 A/B 仍不贴标签, 可开始下一轮。"
                )
            return "盲听模式(试听区): 可在 A、B 间切换, 设置已隐藏; 开始轮次后出现 X。"
        return (
            f"A = {b.setting_a.label}    |    B = {b.setting_b.label}    |    "
            f"当前: {self._player.active_source}"
        )

    def _seek(self, seconds: float) -> None:
        self._player.seek(seconds)

    def _on_position(self, seconds: float) -> None:
        self._wave.set_position(seconds)
        self._lbl_pos.setText(f"{seconds:0.2f} / {self._player.duration():0.2f} s")

    def _on_ended(self) -> None:
        self.statusBar().showMessage("播放结束", 2000)

    def _toggle_loop(self) -> None:
        on = self._chk_loop.isChecked()
        self._player.set_loop_mode(on)

    def _on_loop_dragged(self, s: float, e: float) -> None:
        self._player.set_loop_bounds(s, e)
        self._spn_loop_s.setValue(round(s, 3))
        self._spn_loop_e.setValue(round(e, 3))

    def _apply_loop_spins(self) -> None:
        s, e = self._spn_loop_s.value(), self._spn_loop_e.value()
        if e <= s:
            QMessageBox.warning(self, "循环边界", "循环止必须大于循环起。")
            return
        self._player.set_loop_bounds(float(s), float(e))
        self._wave.set_loop(float(s), float(e))

    # ================================================================== #
    # 轮次流程
    # ================================================================== #
    def _start_round(self) -> None:
        if self._bundle is None:
            QMessageBox.warning(self, "未处理素材", "请先处理素材再开始轮次。")
            return
        if self._session and self._session.in_round:
            return
        # 以当前 bundle 的实际状态冻结设置
        settings = SessionSettings(
            setting_a=self._bundle.setting_a.describe(),
            setting_b=self._bundle.setting_b.describe(),
            source_name=self._bundle.source.name,
            alignment=self._bundle.alignment,
            loudness_match=self._bundle.loudness_match,
            blind=self._chk_blind.isChecked(),
        )
        if self._session is None or self._session.settings != settings:
            # 设置变过 -> 新会话; 旧会话记录仍可在窗口里查看, 导出时合并
            if self._session is not None:
                self._past_sessions.append(self._session)
            self._session = Session(settings)
        rnd = self._session.start_round(datetime.now().isoformat(timespec="seconds"))
        self._revealed = None
        self._rad_guess_a.setChecked(False)
        self._rad_guess_b.setChecked(False)
        self._set_controls_locked(True)
        self._switch("X")
        self._render_rounds()
        self.statusBar().showMessage(
            f"第 {rnd.index} 轮开始: X 已随机选定并在本轮保持不变"
        )

    def _submit_round(self) -> None:
        if not (self._session and self._session.in_round):
            return
        guess = "A" if self._rad_guess_a.isChecked() else (
            "B" if self._rad_guess_b.isChecked() else None)
        if guess is None:
            QMessageBox.information(self, "请先作答", "选择「X = A」或「X = B」后再提交。")
            return
        rnd = self._session.submit(guess, datetime.now().isoformat(timespec="seconds"))
        self._revealed = rnd
        self._active_slot = rnd.x_is  # 揭示后高亮 X 实际对应的 A/B 按钮
        self._set_controls_locked(False)
        self._update_source_buttons()
        self._render_rounds()
        self.statusBar().showMessage(
            f"第 {rnd.index} 轮揭示: X 来自 {rnd.x_is}, 你的判断 {guess} — "
            f"{'正确' if rnd.correct else '错误'}"
        )

    def _cancel_round(self) -> None:
        if not (self._session and self._session.in_round):
            return
        rnd = self._session.cancel()
        self._set_controls_locked(False)
        self._update_source_buttons()
        self._render_rounds()
        self.statusBar().showMessage(f"第 {rnd.index} 轮已取消 (不计分, 不进导出), 现在可以修改参数")

    def _set_controls_locked(self, locked: bool) -> None:
        for w in (
            self._source_kind, self._combo_a, self._combo_b,
            self._chk_blind, self._chk_align, self._chk_loud,
            self._btn_process,
        ):
            w.setEnabled(not locked)
        self._btn_start.setEnabled(not locked)
        self._btn_cancel.setEnabled(locked)
        self._rad_guess_a.setEnabled(locked)
        self._rad_guess_b.setEnabled(locked)
        self._btn_submit.setEnabled(locked)

    def _render_rounds(self) -> None:
        if self._session is None:
            self._round_view.setPlainText("尚无轮次。")
            return
        lines: list[str] = []
        sessions = self._past_sessions + [self._session]
        total_hits = total_done = 0
        for si, sess in enumerate(sessions):
            hits, done = sess.score()
            total_hits += hits
            total_done += done
            s = sess.settings
            lines.append(
                f"会话{si + 1} | {s.source_name} | A={s.setting_a['label']} "
                f"B={s.setting_b['label']} | 盲听={'是' if s.blind else '否'} "
                f"对齐={'是' if s.alignment else '否'} 响度匹配={'是' if s.loudness_match else '否'}"
            )
            for r in sess.rounds:
                if r.status == "listening":
                    lines.append(f"  第{r.index}轮: 进行中… (X 来源保密)")
                elif r.status == "canceled":
                    lines.append(f"  第{r.index}轮: 已取消 (不计分)")
                else:
                    mark = "✓" if r.correct else "✗"
                    reveal = f"X={r.x_is}, 作答={r.guess}"
                    if not s.blind:
                        reveal = reveal
                    lines.append(f"  第{r.index}轮: {mark} 正确  {reveal}")
            lines.append(f"  小计: {hits}/{done} 正确")
            lines.append("")
        lines.append(f"总分: {total_hits}/{total_done}"
                     + (f"  (正确率 {total_hits / total_done:.0%})" if total_done else ""))
        if self._revealed is not None:
            r = self._revealed
            lines.append(
                f"\n上一轮揭示: 第{r.index}轮 X 实际来自 {r.x_is} — "
                f"{'判断正确' if r.correct else '判断错误'}"
            )
        self._round_view.setPlainText("\n".join(lines))

    # ================================================================== #
    # 导出
    # ================================================================== #
    def _all_sessions(self) -> list[Session]:
        return self._past_sessions + (
            [self._session] if self._session is not None else [])

    def _export(self) -> None:
        records = [s.export_record() for s in self._all_sessions()]
        answered = sum(r["summary"]["answered_rounds"] for r in records)
        if answered == 0:
            QMessageBox.information(self, "没有可导出的记录", "还没有已作答的轮次; 未开始/已取消的轮次不会导出。")
            return
        default_name = f"blindabx_record_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        path, _ = QFileDialog.getSaveFileName(self, "导出本地记录", default_name, "JSON (*.json)")
        if not path:
            return
        payload = {
            "schema": "blindabx-export/v1",
            "exported_at": datetime.now().isoformat(timespec="seconds"),
            "tool": "blindabx (python/pyside6/ffmpeg)",
            "sessions": records,
        }
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False, indent=2)
        self.statusBar().showMessage(f"已导出 {answered} 个已答轮次 → {path}", 8000)
