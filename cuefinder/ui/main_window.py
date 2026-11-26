"""主窗口：参考音管理 + 查询检索 + 对照/试听。"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PySide6.QtCore import QSettings, Qt
from PySide6.QtGui import QAction, QKeySequence
from PySide6.QtWidgets import (QApplication, QCheckBox, QComboBox, QFileDialog,
                               QHBoxLayout, QLabel, QMainWindow, QMessageBox,
                               QPushButton, QSlider, QSplitter, QTabWidget,
                               QVBoxLayout, QWidget)

from .. import __version__
from ..audio import TARGET_SR, AudioLoadError, load_audio, write_wav
from ..demo import (builtin_query_path, builtin_reference_paths,
                    default_sample_dir, generate, query_case_labels)
from ..player import AudioClip
from ..reference import ReferenceIndex
from ..search import (STATUS_AMBIGUOUS, STATUS_EMPTY, STATUS_LABELS,
                      STATUS_MATCH, STATUS_NO_FEATURE, STATUS_NO_MATCH,
                      STATUS_TOO_SHORT, STATUS_WEAK, SearchOutcome, align, search)
from .candidate_list import CandidateList
from .reference_table import ReferenceTable
from .spectrogram import FeatureCompare
from .waveform import WaveformCompare

DEFAULT_THRESHOLD = 0.55
APP_ORG = "CueFinder"
APP_NAME = "CueFinder"

STATUS_STYLE = {
    STATUS_MATCH: ("#1f7a3d", "#eaf6ee"),
    STATUS_WEAK: ("#b7791f", "#fdf6e3"),
    STATUS_AMBIGUOUS: ("#6b46c1", "#f2eef8"),
    STATUS_TOO_SHORT: ("#b7791f", "#fdf6e3"),
    STATUS_NO_FEATURE: ("#b7791f", "#fdf6e3"),
    STATUS_NO_MATCH: ("#5b6270", "#f1f2f4"),
    STATUS_EMPTY: ("#c0392b", "#fdecea"),
}


class MainWindow(QMainWindow):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle(f"短提示音检索 · CueFinder {__version__}")
        self.resize(1200, 880)
        self.index = ReferenceIndex()
        self.outcome: SearchOutcome | None = None
        self.threshold = DEFAULT_THRESHOLD
        self.query_samples: np.ndarray | None = None
        self.query_path = ""
        self._ref_clip: AudioClip | None = None
        self._ref_path: str | None = None
        self._query_clip: AudioClip | None = None
        self._pending_query_play = False
        self._detail_candidate = None
        self._detail_alignment = None
        self._settings = QSettings(APP_ORG, APP_NAME)
        self._build_ui()
        self._build_actions()
        self._refresh_buttons()
        self._refresh_index_label()

    # ---------------- 构建界面 ----------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root = QVBoxLayout(central)
        root.setContentsMargins(10, 8, 10, 8)
        root.setSpacing(8)

        bar = QHBoxLayout()
        self.btn_builtin = QPushButton("载入内置样例")
        self.btn_add_refs = QPushButton("打开参考音…")
        self.btn_remove_ref = QPushButton("移除选中")
        self.btn_reload_ref = QPushButton("重新分析选中")
        self.btn_open_query = QPushButton("打开查询音…")
        self.btn_search = QPushButton("检索")
        self.btn_search.setDefault(True)
        for b in (self.btn_builtin, self.btn_add_refs, self.btn_remove_ref,
                  self.btn_reload_ref, self.btn_open_query, self.btn_search):
            bar.addWidget(b)
        bar.addStretch(1)
        self.lbl_index_state = QLabel("索引：空")
        self.lbl_index_state.setTextFormat(Qt.TextFormat.RichText)
        bar.addWidget(self.lbl_index_state)
        root.addLayout(bar)

        split = QSplitter(Qt.Orientation.Horizontal)
        root.addWidget(split, 1)

        left = QWidget()
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(0, 0, 6, 0)
        left_layout.addWidget(self._section("参考音（检索范围就固定在这组里）"))
        self.ref_table = ReferenceTable()
        left_layout.addWidget(self.ref_table, 2)
        self.lbl_ref_hint = QLabel("打开一组本地 WAV；移除或替换某条后，索引版本会立即跟着变。")
        self.lbl_ref_hint.setWordWrap(True)
        self.lbl_ref_hint.setStyleSheet("color:#6b7280")
        left_layout.addWidget(self.lbl_ref_hint)

        left_layout.addWidget(self._section("查询音"))
        self.lbl_query = QLabel("尚未打开查询音")
        self.lbl_query.setWordWrap(True)
        left_layout.addWidget(self.lbl_query)
        row_play = QHBoxLayout()
        self.btn_play_query = QPushButton("试听查询")
        self.btn_stop = QPushButton("停止播放")
        row_play.addWidget(self.btn_play_query)
        row_play.addWidget(self.btn_stop)
        left_layout.addLayout(row_play)
        row = QHBoxLayout()
        row.addWidget(QLabel("内置查询"))
        self.combo_builtin_query = QComboBox()
        self.combo_builtin_query.addItem("选择一条内置查询…", "")
        for name, desc in query_case_labels():
            self.combo_builtin_query.addItem(name, name)
            self.combo_builtin_query.setItemData(
                self.combo_builtin_query.count() - 1, desc, Qt.ItemDataRole.ToolTipRole)
        row.addWidget(self.combo_builtin_query, 1)
        left_layout.addLayout(row)
        left_layout.addStretch(1)
        split.addWidget(left)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(6, 0, 0, 0)
        self.lbl_status = QLabel("等待检索")
        self.lbl_status.setWordWrap(True)
        self.lbl_status.setTextFormat(Qt.TextFormat.RichText)
        self.lbl_status.setStyleSheet("padding:8px;border-radius:6px;background:#f1f2f4;color:#3a3f47")
        right_layout.addWidget(self.lbl_status)

        right_layout.addWidget(self._section("候选（得分最高的几条参考）"))
        self.candidate_list = CandidateList()
        right_layout.addWidget(self.candidate_list, 1)

        self.detail = QTabWidget()
        self.wave_view = WaveformCompare()
        self.feat_view = FeatureCompare()
        self.detail.addTab(self.wave_view, "波形对照")
        self.detail.addTab(self.feat_view, "特征对照")
        right_layout.addWidget(self.detail, 2)

        self.lbl_detail = QLabel("选中候选后，这里显示重合区间与缺少支持的段")
        self.lbl_detail.setWordWrap(True)
        self.lbl_detail.setTextFormat(Qt.TextFormat.RichText)
        self.lbl_detail.setStyleSheet("color:#4b5563")
        right_layout.addWidget(self.lbl_detail)

        thr_row = QHBoxLayout()
        thr_row.addWidget(QLabel("门槛"))
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setRange(20, 98)
        self.slider.setValue(int(self.threshold * 100))
        self.slider.setTickInterval(5)
        self.slider.setTickPosition(QSlider.TickPosition.TicksBelow)
        thr_row.addWidget(self.slider, 1)
        self.lbl_threshold = QLabel(f"{self.threshold:.2f}")
        self.lbl_threshold.setMinimumWidth(42)
        thr_row.addWidget(self.lbl_threshold)
        self.chk_live = QCheckBox("拖动即重算")
        self.chk_live.setChecked(True)
        thr_row.addWidget(self.chk_live)
        right_layout.addLayout(thr_row)

        btn_row = QHBoxLayout()
        self.btn_play_both = QPushButton("同位置试听（查询 + 参考）")
        self.btn_play_seq = QPushButton("依次试听")
        self.btn_export = QPushButton("导出命中区间…")
        self.btn_copy = QPushButton("复制起点")
        for b in (self.btn_play_both, self.btn_play_seq, self.btn_export, self.btn_copy):
            btn_row.addWidget(b)
        btn_row.addStretch(1)
        right_layout.addLayout(btn_row)

        self._suggestion = QLabel("")
        self._suggestion.setWordWrap(True)
        self._suggestion.setTextFormat(Qt.TextFormat.RichText)
        self._suggestion.setStyleSheet("color:#6b7280")
        right_layout.addWidget(self._suggestion)

        split.addWidget(right)
        split.setSizes([440, 760])

        self.statusBar().showMessage("就绪")

        self.btn_builtin.clicked.connect(self.load_builtin)
        self.combo_builtin_query.activated.connect(self.load_builtin_query)
        self.btn_add_refs.clicked.connect(self.add_references)
        self.btn_remove_ref.clicked.connect(self.remove_selected_reference)
        self.btn_reload_ref.clicked.connect(self.reload_selected_reference)
        self.btn_open_query.clicked.connect(self.open_query)
        self.btn_search.clicked.connect(self.run_search)
        self.btn_play_query.clicked.connect(self.play_query)
        self.btn_stop.clicked.connect(self.stop_playback)
        self.btn_play_both.clicked.connect(lambda: self.play_aligned(sequential=False))
        self.btn_play_seq.clicked.connect(lambda: self.play_aligned(sequential=True))
        self.btn_export.clicked.connect(self.export_window)
        self.btn_copy.clicked.connect(self.copy_start)
        self.candidate_list.candidateSelected.connect(self.show_candidate)
        self.slider.valueChanged.connect(self.on_threshold_changed)
        self.slider.sliderReleased.connect(self.on_slider_released)
        self.ref_table.itemSelectionChanged.connect(self._refresh_buttons)
        self.ref_table.itemDoubleClicked.connect(lambda _item: self.reload_selected_reference())

    def _section(self, title: str) -> QLabel:
        label = QLabel(title)
        label.setStyleSheet("font-weight:600;color:#111827;margin-top:4px")
        return label

    def _build_actions(self) -> None:
        act_open_q = QAction("打开查询音", self)
        act_open_q.setShortcut(QKeySequence("Ctrl+O"))
        act_open_q.triggered.connect(self.open_query)
        act_search = QAction("检索", self)
        act_search.setShortcut(QKeySequence("Ctrl+Return"))
        act_search.triggered.connect(self.run_search)
        act_close = QAction("关闭", self)
        act_close.setShortcut(QKeySequence("Ctrl+W"))
        act_close.triggered.connect(self.close)
        for a in (act_open_q, act_search, act_close):
            self.addAction(a)

    # ---------------- 内置样例 ----------------
    def load_builtin(self) -> None:
        base = default_sample_dir()
        if not (base / "references").is_dir():
            generate(base)
        refs = builtin_reference_paths(base)
        for p in refs:
            if self.index.get(str(p)) is not None:
                self.index.remove(str(p))
            self.index.add(str(p))
        self.ref_table.populate(self.index.all())
        self._refresh_index_label()
        self.statusBar().showMessage(
            f"已载入内置样例 {len(refs)} 条（位于 {base}）；可在“内置查询”里挑一条试查", 8000)
        self._invalidate_results("参考集合已变化")

    def load_builtin_query(self, index: int) -> None:
        name = self.combo_builtin_query.itemData(index)
        if not name:
            return
        path = builtin_query_path(name)
        if path is None:
            self.statusBar().showMessage("内置查询生成失败", 6000)
            return
        self._open_query_path(str(path))
        if self.query_samples is not None:
            self.run_search()

    # ---------------- 参考音 ----------------
    def add_references(self) -> None:
        files, _ = QFileDialog.getOpenFileNames(
            self, "打开参考音", self._settings.value("last_ref_dir", ""),
            "WAV 音频 (*.wav *.wave);;所有文件 (*)")
        if not files:
            return
        self._settings.setValue("last_ref_dir", str(Path(files[0]).parent))
        failed = []
        for f in files:
            if self.index.get(f) is not None:
                self.index.remove(f)
            ref = self.index.add(f)
            if not ref.ready:
                failed.append(f"{Path(f).name}: {ref.error}")
        self.ref_table.populate(self.index.all())
        self._refresh_index_label()
        if failed:
            self.statusBar().showMessage("部分参考无法使用：" + "；".join(failed), 8000)
            self._set_status(f"{len(failed)} 条参考不可用，其余 {len(self.index.ready())} 条正常。",
                             STATUS_WEAK)
        else:
            self.statusBar().showMessage(f"已载入 {len(self.index.ready())} 条参考", 4000)
        self._invalidate_results("参考集合已变化")

    def remove_selected_reference(self) -> None:
        path = self.ref_table.selected_path()
        if not path:
            return
        label = (self.index.get(path).label if self.index.get(path) else path)
        self.index.remove(path)
        self.ref_table.populate(self.index.all())
        self._refresh_index_label()
        self.statusBar().showMessage(f"已移除 {label}", 3000)
        self._invalidate_results("参考集合已变化")

    def reload_selected_reference(self) -> None:
        path = self.ref_table.selected_path()
        if not path:
            return
        ref = self.index.reload(path)
        self.ref_table.populate(self.index.all())
        self._refresh_index_label()
        if ref is not None and not ref.ready:
            self.statusBar().showMessage(f"重新分析失败：{ref.error}", 8000)
        else:
            self.statusBar().showMessage("已重新分析选中参考", 3000)
        self._invalidate_results("参考已重新分析")

    def _refresh_index_label(self) -> None:
        ready = len(self.index.ready())
        failed = len(self.index.failed())
        color = "#1f7a3d" if ready else "#b7791f"
        text = f"索引：<b style='color:{color}'>{ready} 条就绪</b>"
        if failed:
            text += f" · <span style='color:#b7791f'>{failed} 条不可用</span>"
        text += f" · 版本 {self.index.generation} · {self.index.signature()}"
        self.lbl_index_state.setText(text)
        self.lbl_index_state.setToolTip(
            "版本与指纹随参考增删/重算而变；结果页会带上同样的版本号，便于核对一致性")

    # ---------------- 查询 ----------------
    def open_query(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开查询音", self._settings.value("last_query_dir", ""),
            "WAV 音频 (*.wav *.wave);;所有文件 (*)")
        if not path:
            return
        self._settings.setValue("last_query_dir", str(Path(path).parent))
        self._open_query_path(path)

    def _open_query_path(self, path: str) -> None:
        try:
            audio = load_audio(path)
        except AudioLoadError as exc:
            self.lbl_query.setText(f"<span style='color:#c0392b'>无法载入查询：{exc}</span>")
            self.statusBar().showMessage(f"查询载入失败：{exc}", 8000)
            return
        self.query_path = str(Path(path).resolve())
        self.query_samples = audio.samples
        self._query_clip = None
        self.lbl_query.setText(
            f"{Path(path).name} · {audio.duration*1000:.0f} ms · "
            f"{audio.sample_rate} Hz / {audio.channels} 声道（已重采样到 {TARGET_SR} Hz）")
        self.statusBar().showMessage("查询已载入，可以直接检索", 4000)
        self._refresh_buttons()

    def _sync_replaced_files(self) -> list[str]:
        """查询前检查磁盘上的参考是否被替换过；替换过就重新分析。"""
        changed = []
        for ref in self.index.all():
            old = ref.revision
            refreshed = self.index.refresh_if_changed(ref.path)
            if refreshed is not None and refreshed.revision != old:
                changed.append(refreshed.label)
        if changed:
            self.ref_table.populate(self.index.all())
            self._refresh_index_label()
        return changed

    def run_search(self) -> None:
        if self.query_samples is None or self.query_samples.size == 0:
            QMessageBox.information(self, "缺少查询", "请先打开一段查询音。")
            return
        changed = self._sync_replaced_files()
        if changed:
            self.statusBar().showMessage(
                "检测到文件变化，已重新分析：" + "、".join(changed), 6000)
        outcome = search(self.index, self.query_samples, self.threshold,
                         query_path=self.query_path)
        self._apply_outcome(outcome)

    # ---------------- 结果 ----------------
    def _apply_outcome(self, outcome: SearchOutcome) -> None:
        self.outcome = outcome
        self._refresh_index_label()
        self.candidate_list.populate(outcome.candidates)
        self._set_status(outcome.message, outcome.status)
        hint = f"结果基于索引版本 {outcome.generation}（{outcome.index_signature}）。"
        if outcome.notes:
            hint = " ".join(outcome.notes) + " " + hint
        self.lbl_ref_hint.setText(hint)
        self._suggestion.setText(self._suggestion_text(outcome))
        if outcome.candidates:
            self._show_candidate(0)
        else:
            self.wave_view.clear()
            self.feat_view.clear()
            self._detail_candidate = None
            self._detail_alignment = None
            self.lbl_detail.setText(outcome.message)
        self._refresh_buttons()

    def _suggestion_text(self, outcome: SearchOutcome) -> str:
        if outcome.status == STATUS_TOO_SHORT:
            return ("建议：往前后各多截 0.3–0.5 s 再查；查询至少要有 0.15 s 的有效声音。")
        if outcome.status == STATUS_NO_FEATURE:
            return "建议：换一段有明显音高变化的片段；不要用纯噪声或全静音。"
        if outcome.status == STATUS_AMBIGUOUS:
            return "建议：把查询的截取位置往这段共同部分之前或之后再延伸，让后半段的不同之处进入对比。"
        if outcome.status == STATUS_NO_MATCH:
            return ("建议：降低门槛看候选如何变化；若把门槛拉到 0.2 仍然没有像样的峰，"
                    "多半是这段声音不在这组参考里。")
        if outcome.status == STATUS_WEAK:
            return "建议：把查询缩短到参考末尾之前，或换一段完全落在参考内部的声音。"
        if outcome.status == STATUS_MATCH and outcome.best is not None:
            return ("建议：点开候选查看逐帧一致度；拖动门槛观察次优候选是否紧随其后，"
                    "差距越小越说明证据不充分。")
        return ""

    def _show_candidate(self, idx: int) -> None:
        if not self.outcome or self.outcome.query is None:
            return
        cands = self.outcome.candidates
        if not cands:
            return
        cand = cands[max(0, min(idx, len(cands) - 1))]
        out = self.outcome
        al = align(out, cand)
        rf = cand.reference.features
        assert rf is not None
        r_samples = rf.samples[al.start_sample:al.end_sample]
        self.wave_view.set_data(
            out.query.samples, r_samples, al.good, al.unsupported,
            evidence=al.evidence,
            hop_sec=al.hop_sec, overrun_sec=cand.overrun,
            fs_query=al.fs_query, fs_ref=al.fs_ref)
        self.feat_view.set_data(al.query_feats, al.ref_feats, al.frame_cos, al.good)
        self.lbl_detail.setText(self._detail_text(cand, al))
        self._detail_candidate = cand
        self._detail_alignment = al
        self._refresh_buttons()

    def show_candidate(self, idx: int) -> None:
        self._show_candidate(idx)

    def _detail_text(self, cand, al) -> str:
        others = [p for p in cand.peaks
                  if p.start_frame != cand.start_frame and p.score >= 0.25][:3]
        parts = [
            f"<b>{cand.label}</b> · 起点 <b>{cand.start_sec:.3f} s</b>"
            f"（第 {al.start_sample} 个样本）· 查询终点对应参考 {cand.end_sec:.3f} s",
            f"得分 {cand.score:.2f} · 覆盖 {cand.coverage:.0%} · "
            f"一致帧占查询有效帧的 {al.support_ratio*100:.0f}%",
        ]
        if cand.end_overrun:
            parts.append(f"<span style='color:#c0392b'>越过参考有效末端 "
                         f"{cand.overrun*1000:.0f} ms，末尾以外没有依据</span>")
        if al.unsupported:
            spans = "、".join(f"{a*al.hop_sec:.2f}–{b*al.hop_sec:.2f}s"
                             for a, b in al.unsupported[:4])
            parts.append(f"缺少支持的段（相对查询）：{spans}")
        else:
            parts.append("逐帧都能对上")
        parts.append("<span style='color:#6b7280'>蓝色=一致、红色=缺支持、无底色=查询此处静音</span>")
        if others:
            rf = cand.reference.features
            alt = "、".join(
                f"{(rf.t0 + p.start_frame * rf.cfg.hop) / rf.cfg.fs:.2f}s" for p in others)
            parts.append(f"这条参考上的其他候选起点：{alt}")
        return "<br>".join(parts)

    def _invalidate_results(self, why: str) -> None:
        if self.outcome is None:
            self._refresh_buttons()
            return
        if self.outcome.generation != self.index.generation:
            self.candidate_list.populate([])
            self.wave_view.clear()
            self.feat_view.clear()
            self.outcome = None
            self._detail_candidate = None
            self._detail_alignment = None
            self._set_status(f"{why}，之前的候选已作废，请重新检索。", STATUS_NO_MATCH)
            self.lbl_detail.setText("索引已变化；重新检索后再查看对照。")
            self._suggestion.setText("")
        self._refresh_buttons()

    def _set_status(self, message: str, status: str) -> None:
        fg, bg = STATUS_STYLE.get(status, ("#3a3f47", "#f1f2f4"))
        label = STATUS_LABELS.get(status, status)
        self.lbl_status.setText(
            f"<span style='color:{fg};font-weight:600'>{label}</span> · {message}")
        self.lbl_status.setStyleSheet(
            f"padding:8px;border-radius:6px;background:{bg};color:#3a3f47")

    def _refresh_buttons(self) -> None:
        has_sel_ref = self.ref_table.selected_path() is not None
        self.btn_remove_ref.setEnabled(has_sel_ref)
        self.btn_reload_ref.setEnabled(has_sel_ref)
        has_query = self.query_samples is not None and self.query_samples.size > 0
        self.btn_search.setEnabled(has_query)
        self.btn_play_query.setEnabled(has_query)
        has_cand = bool(self.outcome and self.outcome.candidates)
        self.btn_play_both.setEnabled(has_cand)
        self.btn_play_seq.setEnabled(has_cand)
        self.btn_export.setEnabled(has_cand)
        self.btn_copy.setEnabled(has_cand)

    # ---------------- 阈值 ----------------
    def on_threshold_changed(self, value: int) -> None:
        self.threshold = value / 100.0
        self.lbl_threshold.setText(f"{self.threshold:.2f}")
        if self.chk_live.isChecked() and self.query_samples is not None:
            self._recompute()

    def on_slider_released(self) -> None:
        if self.query_samples is not None:
            self._recompute()

    def _recompute(self) -> None:
        if self.outcome is None:
            return
        new = search(self.index, self.query_samples, self.threshold,
                     query_path=self.query_path)
        self._apply_outcome(new)
        self.statusBar().showMessage(
            f"门槛 {self.threshold:.2f}：{len(new.candidates)} 个候选", 3000)

    # ---------------- 试听 ----------------
    def _ensure_query_clip(self) -> AudioClip:
        if self._query_clip is None:
            self._query_clip = AudioClip(self.query_samples)
        return self._query_clip

    def play_query(self) -> None:
        if self.query_samples is None:
            return
        self._pending_query_play = False
        clip = self._ensure_query_clip()
        clip.play_window(0.0, clip.duration)

    def stop_playback(self) -> None:
        self._pending_query_play = False
        for clip in (self._ref_clip, self._query_clip):
            if clip is not None:
                clip.stop()
        self.wave_view.set_playhead(None)
        self.feat_view.set_playhead(None)
        self.statusBar().showMessage("已停止播放", 3000)

    def _prepare_clips(self, cand, al):
        rf = cand.reference.features
        if self._ref_clip is None or self._ref_path != cand.path:
            self._ref_clip = AudioClip(rf.samples)
            self._ref_path = cand.path
            self._ref_clip.finished.connect(self._play_query_after_ref)
            self._ref_clip.positionChanged.connect(self._on_play_position)
        if self._query_clip is None:
            self._query_clip = AudioClip(self.query_samples)
            self._query_clip.positionChanged.connect(self._on_play_position)
        start = al.start_sample / al.fs_ref
        ref_dur = max(0.0, (al.end_sample - al.start_sample) / al.fs_ref)
        q_dur = (self.query_samples.size / float(al.fs_query)) if self.query_samples is not None else 0.0
        return start, ref_dur, q_dur

    def play_aligned(self, sequential: bool = False) -> None:
        cand = self._detail_candidate
        al = self._detail_alignment
        if cand is None or al is None or cand.reference.features is None or self.query_samples is None:
            return
        start, ref_dur, q_dur = self._prepare_clips(cand, al)
        end = start + min(ref_dur, q_dur) if ref_dur > 0 else start
        if sequential:
            self._pending_query_play = True
            self.statusBar().showMessage(
                f"先放参考 {cand.label} 的 {start:.2f}–{end:.3f}s，随后放查询", 6000)
            self._ref_clip.play_window(start, end, pad_sec=0.0)
            return
        # 同一时刻起播：参考的命中区间与查询从头对齐
        self._pending_query_play = False
        self.statusBar().showMessage(
            f"同时播放：参考 {cand.label} {start:.2f}–{end:.3f}s ↔ 查询 0–{min(ref_dur, q_dur):.3f}s",
            6000)
        self._ref_clip.play(start, end, volume=0.9)
        self._query_clip.play(0.0, min(ref_dur, q_dur) if ref_dur else None, volume=0.9)

    def _on_play_position(self, sec: float) -> None:
        """把播放进度同步到两个视图（按查询时间轴）。"""
        self.wave_view.set_playhead(max(0.0, sec))
        al = self._detail_alignment
        if al is not None and al.hop_sec > 0:
            self.feat_view.set_playhead(max(0.0, sec) / al.hop_sec)

    def _play_query_after_ref(self) -> None:
        if not self._pending_query_play:
            return
        self._pending_query_play = False
        clip = self._ensure_query_clip()
        clip.play_window(0.0, clip.duration)

    def export_window(self) -> None:
        cand = self._detail_candidate
        al = self._detail_alignment
        if cand is None or al is None or cand.reference.features is None:
            return
        default = f"{cand.label}_{cand.start_sec:.2f}s.wav"
        path, _ = QFileDialog.getSaveFileName(self, "导出参考命中区间", default,
                                              "WAV (*.wav)")
        if not path:
            return
        rf = cand.reference.features
        write_wav(path, rf.samples[al.start_sample:al.end_sample], rf.cfg.fs)
        self.statusBar().showMessage(f"已导出 {path}", 4000)

    def copy_start(self) -> None:
        cand = self._detail_candidate
        if cand is None:
            return
        QApplication.clipboard().setText(f"{cand.start_sec:.3f}")
        self.statusBar().showMessage(f"已复制起点 {cand.start_sec:.3f}s", 3000)
