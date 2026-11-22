"""PySide6 窗口:MIDI 踏板时机试听与检查。

- 事件明细表:tick / 拍 / 秒 三栏对照,速度变化后秒数仍对得上
- 音符时间线表:按下、松键、被踏板保留到、实际消音,同音重复截断有标注
- 踏板事件可直接在表里改 tick 或值,改完可分别试听 "原版 / 当前版"
- 进度条可跳到任意位置(含踏板踩下的中间),状态栏显示该处应恢复的延音音
- 导出当前版 WAV;内置样例 + 回读核对
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile

from PySide6.QtCore import QByteArray, QBuffer, QIODevice, Qt, QTimer
from PySide6.QtMultimedia import QAudioFormat, QAudioSink
from PySide6.QtWidgets import (QApplication, QFileDialog, QHBoxLayout, QLabel,
                               QMainWindow, QMessageBox, QPushButton, QSlider,
                               QSplitter, QTableWidget, QTableWidgetItem,
                               QVBoxLayout, QWidget)

from . import model, synth, verify
from .model import Event, pitch_name
from .sample import build_sample

KIND_CN = {"note_on": "按下", "note_off": "松键", "pedal": "踏板", "tempo": "速度"}
RULES_TEXT = ("同 tick 顺序规则:按 (tick, 轨道号, 轨内先后) 稳定排序;"
              "同音重复:旧音 8ms 短淡出,新音重新起音;"
              "松键时踏板踩着则保留到踏板抬起,再经 0.25s 释音消音。")


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("MIDI 踏板时机校对")
        self.resize(1080, 720)

        self.path = None
        self.ppq = model.PPQ_DEFAULT
        self.tmap = None
        self.original: list[Event] = []   # 原版事件
        self.events: list[Event] = []     # 当前(可编辑)事件
        self.voices = []
        self.pcm = {"orig": None, "cur": None}   # 缓存的渲染结果(bytes)
        self.duration = 0.0
        self._loading_table = False

        # ---- 播放 ----
        fmt = QAudioFormat()
        fmt.setSampleRate(synth.SR)
        fmt.setChannelCount(1)
        fmt.setSampleFormat(QAudioFormat.SampleFormat.Int16)
        self.audio = QAudioSink(fmt, self)
        self.buf = QBuffer(self)
        self.play_offset = 0.0
        self.playing = False

        self.timer = QTimer(self)
        self.timer.setInterval(30)
        self.timer.timeout.connect(self._tick)

        self._build_ui()
        self._load_sample()

    # ---------------- UI ----------------
    def _build_ui(self):
        root = QWidget(self)
        lay = QVBoxLayout(root)

        bar = QHBoxLayout()
        for text, fn in [("打开 MIDI…", self._open),
                         ("内置样例", self._load_sample),
                         ("▶ 播放原版", lambda: self._play("orig")),
                         ("▶ 播放当前版", lambda: self._play("cur")),
                         ("■ 停止", self._stop),
                         ("导出当前版 WAV…", self._export),
                         ("核对回读音频", self._verify)]:
            b = QPushButton(text)
            b.clicked.connect(fn)
            bar.addWidget(b)
        bar.addStretch(1)
        lay.addLayout(bar)

        seek = QHBoxLayout()
        self.slider = QSlider(Qt.Horizontal)
        self.slider.setRange(0, 10000)
        self.slider.sliderPressed.connect(self._seek_start)
        self.slider.sliderReleased.connect(self._seek_end)
        seek.addWidget(self.slider, 1)
        self.time_label = QLabel("0.000s / 拍 0.000")
        self.time_label.setMinimumWidth(190)
        seek.addWidget(self.time_label)
        lay.addLayout(seek)

        self.state_label = QLabel("踏板: — | 按住中: — | 延音保持中: —")
        self.state_label.setStyleSheet("color:#a50; font-weight:bold")
        lay.addWidget(self.state_label)

        split = QSplitter(Qt.Vertical)

        self.ev_table = QTableWidget(0, 6)
        self.ev_table.setHorizontalHeaderLabels(
            ["顺序#", "tick", "拍", "秒", "类型", "内容(踏板行可双击改 tick/值)"])
        self.ev_table.itemChanged.connect(self._on_edit)
        split.addWidget(self.ev_table)

        self.sp_table = QTableWidget(0, 8)
        self.sp_table.setHorizontalHeaderLabels(
            ["音", "力度", "按下(拍)", "按下(秒)", "松键(秒)",
             "踏板保留至(秒)", "实际消音(秒)", "备注"])
        self.sp_table.setEditTriggers(QTableWidget.NoEditTriggers)
        split.addWidget(self.sp_table)

        split.setSizes([420, 280])
        lay.addWidget(split, 1)

        self.status = QLabel("")
        self.status.setWordWrap(True)
        lay.addWidget(self.status)
        rules = QLabel(RULES_TEXT)
        rules.setWordWrap(True)
        rules.setStyleSheet("color:#666")
        lay.addWidget(rules)
        self.setCentralWidget(root)

    # ---------------- 载入 ----------------
    def _open(self):
        path, _ = QFileDialog.getOpenFileName(self, "打开 MIDI", "", "MIDI (*.mid *.midi)")
        if path:
            self._load(path)

    def _load_sample(self):
        path = os.path.join(tempfile.gettempdir(), "pedal_inspector_sample.mid")
        build_sample(path)
        self._load(path)

    def _load(self, path):
        self._stop()
        self.path = path
        self.events, self.ppq, self.tmap = model.load_midi(path)
        self.original = copy.deepcopy(self.events)
        self.pcm = {"orig": None, "cur": None}
        self._recompute()
        self.status.setText(f"已载入 {os.path.basename(path)}")

    def _recompute(self):
        self.voices = model.schedule(self.events)
        self.duration = max((v.stop for v in self.voices), default=0.0) + 0.2
        self.pcm["cur"] = None
        self._fill_tables()
        self._update_cursor(self.slider.value() / 10000 * self.duration)

    # ---------------- 表格 ----------------
    def _fill_tables(self):
        self._loading_table = True
        t = self.ev_table
        t.setRowCount(len(self.events))
        edited_ticks = {(e.kind, e.tick, e.value) for e in self.original}
        for row, ev in enumerate(self.events):
            vals = [str(ev.order), str(ev.tick), f"{ev.beat:.3f}",
                    f"{ev.seconds:.3f}", KIND_CN.get(ev.kind, ev.kind), ev.describe()]
            for col, s in enumerate(vals):
                item = QTableWidgetItem(s)
                # 踏板行的 tick / 值 可编辑;值通过 "内容" 列改数字
                editable = ev.kind == "pedal" and col in (1, 5)
                item.setFlags(item.flags() | Qt.ItemIsEditable if editable
                              else item.flags() & ~Qt.ItemIsEditable)
                if ev.kind == "pedal" and editable:
                    item.setBackground(Qt.GlobalColor.yellow)
                if (ev.kind, ev.tick, ev.value) not in edited_ticks:
                    item.setForeground(Qt.GlobalColor.red)  # 与原版不同
                t.setItem(row, col, item)
        t.resizeColumnsToContents()

        s = self.sp_table
        s.setRowCount(len(self.voices))
        for row, v in enumerate(self.voices):
            note = ""
            if v.cut:
                note = "被同音重复截断(8ms 淡出)"
            elif v.sustained:
                note = "松键后由踏板保留"
            vals = [v.name(), str(v.velocity), f"{v.on_tick / self.ppq:.3f}",
                    f"{v.start:.3f}",
                    f"{v.keyup:.3f}" if v.keyup is not None else "—",
                    f"{v.release:.3f}" if v.sustained else "—",
                    f"{v.stop:.3f}", note]
            for col, x in enumerate(vals):
                s.setItem(row, col, QTableWidgetItem(str(x)))
        s.resizeColumnsToContents()
        self._loading_table = False

    def _on_edit(self, item):
        if self._loading_table:
            return
        row = item.row()
        ev = self.events[row]
        if ev.kind != "pedal":
            return
        col = item.column()
        try:
            if col == 1:  # tick
                new_tick = max(0, int(item.text()))
                if new_tick == ev.tick:
                    return
                ev.tick = new_tick
            elif col == 5:  # 内容里的 CC 值
                txt = item.text()
                val = int(txt.split("CC64=")[1].rstrip(")")) if "CC64=" in txt else int(txt)
                ev.value = max(0, min(127, val))
            else:
                return
        except (ValueError, IndexError):
            QMessageBox.warning(self, "无效输入", "tick 请输入整数,踏板值 0-127")
            self._fill_tables()
            return
        model.refresh_times(self.events, self.tmap)
        self._recompute()
        self.status.setText(
            f"已修改踏板事件(顺序# {ev.order}),当前版已重算;"
            f"可分别点「播放原版」/「播放当前版」对比。")

    # ---------------- 播放 ----------------
    def _render(self, which: str) -> bytes:
        if self.pcm[which] is None:
            evs = self.original if which == "orig" else self.events
            buf = synth.render(model.schedule(evs))
            self.pcm[which] = synth.to_pcm16(buf)
        return self.pcm[which]

    def _play(self, which: str, offset: float | None = None):
        pcm = self._render(which)
        self._stop()
        self.play_offset = self.slider.value() / 10000 * self.duration if offset is None else offset
        byte_pos = int(self.play_offset * synth.SR) * 2
        byte_pos -= byte_pos % 2
        self.buf = QBuffer(self)
        self.buf.setData(QByteArray(pcm[byte_pos:]))
        self.buf.open(QIODevice.OpenModeFlag.ReadOnly)
        self.audio.start(self.buf)
        self.playing = which
        self.timer.start()
        self.status.setText(f"正在播放{'原版' if which == 'orig' else '当前版'}"
                            f"(从 {self.play_offset:.3f}s 起)")

    def _stop(self):
        if self.playing:
            self.audio.stop()
            self.playing = False
        self.timer.stop()

    def _tick(self):
        if not self.playing:
            return
        pos_sec = self.play_offset + self.buf.pos() / 2 / synth.SR
        if self.buf.atEnd() or pos_sec >= self.duration + 0.3:
            self._stop()
            pos_sec = self.duration
        self._update_cursor(pos_sec, move_slider=True)

    def _seek_start(self):
        self._was_playing = self.playing
        self._stop()

    def _seek_end(self):
        sec = self.slider.value() / 10000 * self.duration
        self._update_cursor(sec)
        if getattr(self, "_was_playing", False):
            self._play(self._was_playing, offset=sec)

    def _update_cursor(self, sec: float, move_slider=False):
        sec = max(0.0, min(sec, self.duration))
        if move_slider:
            self.slider.setValue(int(sec / max(self.duration, 1e-9) * 10000))
        if not self.tmap:
            return
        tick = self.tmap.tick_at(sec)
        beat = tick / self.ppq
        self.time_label.setText(f"{sec:.3f}s / 拍 {beat:.3f}")
        pedal, held, sus = model.state_at(self.events, tick)
        names = lambda ps: " ".join(pitch_name(p) for p in ps) or "—"
        self.state_label.setText(
            f"踏板: {'踩下' if pedal else '抬起'} | 按住中: {names(held)} | "
            f"延音保持中: {names(sus)}  (跳到此处时这些音应恢复)")

    # ---------------- 导出 / 核对 ----------------
    def _export(self):
        path, _ = QFileDialog.getSaveFileName(self, "导出当前版 WAV", "current.wav", "WAV (*.wav)")
        if not path:
            return
        buf = synth.render(self.voices)
        synth.export_wav(path, buf)
        self.status.setText(f"已导出 {path}")

    def _verify(self):
        tmp = os.path.join(tempfile.gettempdir(), "pedal_inspector_check.wav")
        synth.export_wav(tmp, synth.render(self.voices))
        report = verify.check_wav(tmp, self.voices)
        QMessageBox.information(self, "回读核对结果", report)

    def closeEvent(self, e):
        self._stop()
        super().closeEvent(e)


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
