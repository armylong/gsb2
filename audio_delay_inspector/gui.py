"""PySide6 界面层。

只负责展示 core 层的 FileAnalysis 事实与触发任务, 不在界面里做任何判定。
耗时操作 (ffmpeg/ffprobe) 全部放在 QThread 工作线程, 界面不卡顿。
"""

from __future__ import annotations

import sys
from pathlib import Path

from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QVBoxLayout, QHBoxLayout, QPushButton,
    QFileDialog, QLabel, QTabWidget, QTableWidget, QTableWidgetItem,
    QPlainTextEdit, QHeaderView, QMessageBox, QGroupBox, QRadioButton,
    QStatusBar,
)

from .core import (
    ENCODERS, SAMPLE_RATE, PULSE_THRESHOLD, SILENCE_THRESHOLD,
    ToolDependencyError, ensure_ffmpeg, generate_reference_wav,
    encode_compressed, analyze_file, write_report, write_decodings,
)


# ---------------------------------------------------------------------------
# 工作线程
# ---------------------------------------------------------------------------

class Worker(QThread):
    succeeded = Signal(list, Path)   # analyses, export_dir
    failed = Signal(str)

    def __init__(self, mode: str, payload: dict):
        super().__init__()
        self.mode = mode       # "demo" 生成样例 | "external" 外部文件
        self.payload = payload

    def run(self) -> None:
        try:
            if self.mode == "demo":
                self._run_demo()
            else:
                self._run_external()
        except Exception as e:  # 界面统一弹窗, 线程内不吞异常细节
            self.failed.emit(f"{type(e).__name__}: {e}")

    def _run_demo(self) -> None:
        out_root = Path(self.payload["out_root"])
        work = out_root / "work"
        export_dir = out_root / "exports"
        ref_wav = generate_reference_wav(out_root / "reference.wav")
        analyses = []
        for key, spec in ENCODERS.items():
            compressed = encode_compressed(
                ref_wav, out_root / f"sample{spec['ext']}", key)
            analyses.append(
                analyze_file(compressed, work / key, reference_wav=ref_wav))
        write_report(analyses, export_dir / "report.md")
        for ana in analyses:
            write_decodings(ana, export_dir)
        self.succeeded.emit(analyses, export_dir)

    def _run_external(self) -> None:
        src = Path(self.payload["src"])
        ref = self.payload.get("reference")
        out_root = Path(self.payload["out_root"])
        ref_path = Path(ref) if ref else None
        ana = analyze_file(src, out_root / "work", ref_path)
        export_dir = out_root / "exports"
        write_report([ana], export_dir / "report.md")
        write_decodings(ana, export_dir)
        self.succeeded.emit([ana], export_dir)


# ---------------------------------------------------------------------------
# 主窗口
# ---------------------------------------------------------------------------

class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("短音频片头片尾空白排查工具")
        self.resize(1080, 760)
        self.analyses: list = []
        self.export_dir: Path | None = None
        self.worker: Worker | None = None

        self._build_ui()
        self._check_dependency()

    # ---- UI 搭建 -----------------------------------------------------------

    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)

        # 顶部操作区
        action_box = QGroupBox("任务")
        act_layout = QVBoxLayout(action_box)

        row1 = QHBoxLayout()
        self.btn_demo = QPushButton("生成样例并分析 (AAC + MP3)")
        self.btn_demo.clicked.connect(self.on_demo)
        self.btn_external = QPushButton("分析外部压缩音频…")
        self.btn_external.clicked.connect(self.on_external)
        row1.addWidget(self.btn_demo)
        row1.addWidget(self.btn_external)
        row1.addStretch(1)
        act_layout.addLayout(row1)

        row2 = QHBoxLayout()
        row2.addWidget(QLabel("外部文件参考 WAV:"))
        self.rb_ref_auto = QRadioButton("有参考时随文件选择 (默认无参考, 只报可确认事实)")
        self.rb_ref_auto.setChecked(True)
        row2.addWidget(self.rb_ref_auto)
        row2.addStretch(1)
        act_layout.addLayout(row2)

        root.addWidget(action_box)

        # 导出区
        exp_box = QGroupBox("导出")
        exp_layout = QHBoxLayout(exp_box)
        self.btn_open_dir = QPushButton("打开导出目录")
        self.btn_open_dir.clicked.connect(self.on_open_dir)
        self.btn_reexport = QPushButton("重新导出报告与解码音频")
        self.btn_reexport.clicked.connect(self.on_reexport)
        self.export_label = QLabel("尚未导出")
        exp_layout.addWidget(self.btn_open_dir)
        exp_layout.addWidget(self.btn_reexport)
        exp_layout.addWidget(self.export_label, 1)
        root.addWidget(exp_box)

        # 结果区: 标签页
        self.tabs = QTabWidget()
        self.tab_duration = QTableWidget()
        self.tab_markers = QTableWidget()
        self.tab_align = QTableWidget()
        self.tab_split = QTableWidget()
        self.tab_facts = QPlainTextEdit()
        self.tab_facts.setReadOnly(True)
        for w, name in (
            (self.tab_duration, "时长对照 (源/解码/封装)"),
            (self.tab_markers, "延迟标记与恒等式"),
            (self.tab_align, "脉冲对齐 (忽略 vs 应用)"),
            (self.tab_split, "空白分解 (补齐 vs 原始静音)"),
            (self.tab_facts, "事实清单与无法确认事项"),
        ):
            self.tabs.addTab(w, name)
        root.addWidget(self.tabs, 1)

        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage(
            f"门限: 脉冲 |样本|>={PULSE_THRESHOLD:.0f}, "
            f"静音 |样本|<{SILENCE_THRESHOLD:.0f} (满幅32767); 采样率 {SAMPLE_RATE} Hz")

    def _check_dependency(self) -> None:
        try:
            ffmpeg, ffprobe = ensure_ffmpeg()
        except ToolDependencyError as e:
            QMessageBox.critical(self, "依赖缺失", str(e))
            self.btn_demo.setEnabled(False)
            self.btn_external.setEnabled(False)
            return
        self.statusBar().showMessage(
            self.statusBar().currentMessage() + f" | {Path(ffmpeg).name} 就绪")

    # ---- 任务触发 -----------------------------------------------------------

    def on_demo(self) -> None:
        out = QFileDialog.getExistingDirectory(
            self, "选择样例输出目录", str(Path.cwd()))
        if not out:
            return
        self._start(Worker("demo", {"out_root": Path(out) / "audio_delay_demo"}))

    def on_external(self) -> None:
        src, _ = QFileDialog.getOpenFileName(
            self, "选择压缩音频", str(Path.cwd()),
            "音频文件 (*.m4a *.mp4 *.mp3 *.aac *.wav *.ogg *.opus *.flac);;所有文件 (*)")
        if not src:
            return
        ref = None
        if self.rb_ref_auto.isChecked():
            ref, _ = QFileDialog.getOpenFileName(
                self, "选择编码前参考 WAV (可取消, 取消则按无参考分析)",
                str(Path(src).parent), "WAV (*.wav)")
        out = QFileDialog.getExistingDirectory(
            self, "选择分析输出目录", str(Path(src).parent))
        if not out:
            return
        self._start(Worker("external", {
            "src": src, "reference": ref or None,
            "out_root": Path(out) / f"analysis_{Path(src).stem}"}))

    def _start(self, worker: Worker) -> None:
        self.worker = worker
        self._set_busy(True)
        worker.succeeded.connect(self.on_done)
        worker.failed.connect(self.on_fail)
        worker.start()

    def _set_busy(self, busy: bool) -> None:
        for b in (self.btn_demo, self.btn_external, self.btn_reexport):
            b.setEnabled(not busy)
        self.statusBar().showMessage("分析中, ffmpeg 运行于后台线程…" if busy
                                     else "就绪")

    def on_done(self, analyses: list, export_dir: Path) -> None:
        self.analyses = analyses
        self.export_dir = export_dir
        self.export_label.setText(f"已导出: {export_dir}")
        self._render(analyses)
        self._set_busy(False)
        self.statusBar().showMessage(
            f"完成: {len(analyses)} 个文件, 报告与解码音频在 {export_dir}")

    def on_fail(self, msg: str) -> None:
        self._set_busy(False)
        QMessageBox.critical(self, "分析失败", msg)

    def on_open_dir(self) -> None:
        if not self.export_dir or not self.export_dir.exists():
            QMessageBox.information(self, "提示", "还没有导出目录, 请先跑一次分析")
            return
        from PySide6.QtGui import QDesktopServices
        from PySide6.QtCore import QUrl
        QDesktopServices.openUrl(QUrl.fromLocalFile(str(self.export_dir)))

    def on_reexport(self) -> None:
        if not self.analyses:
            QMessageBox.information(self, "提示", "还没有分析结果")
            return
        out = QFileDialog.getExistingDirectory(self, "选择导出目录",
                                               str(Path.cwd()))
        if not out:
            return
        export_dir = Path(out)
        write_report(self.analyses, export_dir / "report.md")
        for ana in self.analyses:
            write_decodings(ana, export_dir)
        self.export_dir = export_dir
        self.export_label.setText(f"已导出: {export_dir}")
        QMessageBox.information(self, "完成", f"报告与解码音频已写入:\n{export_dir}")

    # ---- 渲染: 全部数据直接来自 core 的事实结构 ------------------------------

    def _fill(self, table: QTableWidget, headers: list[str],
              rows: list[list[str]]) -> None:
        table.clear()
        table.setColumnCount(len(headers))
        table.setRowCount(len(rows))
        table.setHorizontalHeaderLabels(headers)
        for r, row in enumerate(rows):
            for c, val in enumerate(row):
                item = QTableWidgetItem(val)
                item.setToolTip(val)
                table.setItem(r, c, item)
        table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeToContents)
        table.horizontalHeader().setStretchLastSection(True)
        table.verticalHeader().setVisible(False)

    def _render(self, analyses: list) -> None:
        dur_rows, mk_rows, al_rows, sp_rows = [], [], [], []
        fact_lines: list[str] = []

        for ana in analyses:
            name = ana.file_path.name
            m = ana.markers

            # 1. 三类时长
            if ana.ref_sample_count is not None:
                dur_rows.append([name, "源 PCM (参考)",
                                 str(ana.ref_sample_count),
                                 f"{ana.ref_sample_count / SAMPLE_RATE:.6f} s",
                                 ana.ref_path.name + " 直接计数"])
            else:
                dur_rows.append([name, "源 PCM (参考)", "N/A", "N/A",
                                 "未提供参考 WAV, 无法确认"])
            dur_rows.append([name, "解码 PCM·应用标记",
                             str(ana.applied.sample_count),
                             f"{ana.applied.duration_s:.6f} s",
                             "ffmpeg 默认解码字节计数"])
            dur_rows.append([name, "解码 PCM·忽略标记",
                             str(ana.ignored.sample_count),
                             f"{ana.ignored.duration_s:.6f} s",
                             "-flags2 +skip_manual 解码字节计数"])
            dur_rows.append([name, "封装·stream.duration", "—",
                             f"{m.stream_duration_s:.6f} s"
                             if m.stream_duration_s is not None else "字段缺失",
                             "ffprobe stream"])
            dur_rows.append([name, "封装·format.duration", "—",
                             f"{m.format_duration_s:.6f} s"
                             if m.format_duration_s is not None else "字段缺失",
                             "ffprobe format"])

            # 2. 标记与恒等式
            if m.present:
                mk_rows.append([name, "头部 skip_samples",
                                str(m.head_skip_samples),
                                self._ms(m.head_skip_samples),
                                "首包 side_data: Skip Samples"])
                mk_rows.append([name, "尾部 discard_padding",
                                str(m.tail_padding_samples),
                                self._ms(m.tail_padding_samples),
                                "末包 side_data: Skip Samples"])
                if m.initial_padding is not None:
                    mk_rows.append([name, "initial_padding (旁证)",
                                    str(m.initial_padding),
                                    self._ms(m.initial_padding),
                                    "ffprobe stream 字段"])
                mk_rows.append([name, "标记恒等式",
                                "成立" if ana.identity_ok else "不成立",
                                "—", ana.identity_detail])
            else:
                mk_rows.append([name, "延迟标记", "未发现", "—",
                                "无法通过标记确认编码补齐"])

            # 3. 脉冲对齐
            for dr, label in ((ana.applied, "应用标记"),
                              (ana.ignored, "忽略标记")):
                if ana.ref_head_pulse is None:
                    al_rows.append([name, label, str(dr.head_pulse_index),
                                    "无参考, 无法确认",
                                    str(dr.tail_pulse_index),
                                    "无参考, 无法确认"])
                    continue
                dh = (dr.head_pulse_index - ana.ref_head_pulse
                      if dr.head_pulse_index is not None else None)
                dt = (dr.tail_pulse_index - ana.ref_tail_pulse
                      if dr.tail_pulse_index is not None
                      and ana.ref_tail_pulse is not None else None)
                al_rows.append([
                    name, label, str(dr.head_pulse_index),
                    f"{dh:+d} 样本 ({self._ms(abs(dh))})" if dh is not None else "未检出",
                    str(dr.tail_pulse_index),
                    f"{dt:+d} 样本 ({self._ms(abs(dt))})" if dt is not None else "未检出",
                ])

            # 4. 空白分解
            if ana.head_encoder_pad_samples is not None:
                sp_rows.append([name, "片头",
                                f"{ana.head_encoder_pad_samples} / {self._ms(ana.head_encoder_pad_samples)}",
                                f"{ana.head_original_silence_samples} / {self._ms(ana.head_original_silence_samples)}"])
                sp_rows.append([name, "片尾",
                                f"{ana.tail_encoder_pad_samples} / {self._ms(ana.tail_encoder_pad_samples)}",
                                f"{ana.tail_original_silence_samples} / {self._ms(ana.tail_original_silence_samples)}"])
            else:
                sp_rows.append([name, "片头/片尾", "无法确认", "无法确认 (缺参考或标记)"])

            # 5. 事实 / 未知
            fact_lines.append(f"===== {name} ({ana.codec}) =====")
            fact_lines.append("[可确认事实]")
            fact_lines += [f"  - {x}" for x in ana.facts]
            fact_lines.append("[无法确认事项 — 证据不足, 不做推测]")
            fact_lines += [f"  - {x}" for x in ana.unknowns]
            fact_lines.append("")

        self._fill(self.tab_duration,
                   ["文件", "项目", "样本数", "时长", "依据"], dur_rows)
        self._fill(self.tab_markers,
                   ["文件", "标记/核对", "样本数", "毫秒", "出处/详情"], mk_rows)
        self._fill(self.tab_align,
                   ["文件", "解码模式", "片头脉冲下标", "片头偏差",
                    "片尾脉冲下标", "片尾偏差"], al_rows)
        self._fill(self.tab_split,
                   ["文件", "位置", "编码补齐 (样本/ms)",
                    "原始静音 (样本/ms)"], sp_rows)
        self.tab_facts.setPlainText("\n".join(fact_lines))

    @staticmethod
    def _ms(n) -> str:
        if n is None:
            return "N/A"
        return f"{n / SAMPLE_RATE * 1000:.3f} ms"


def main() -> int:
    app = QApplication(sys.argv)
    win = MainWindow()
    win.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
