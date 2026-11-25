"""SyncMark 主窗口."""

from __future__ import annotations

import base64
import json
import os
from typing import Any

import numpy as np
from PySide6.QtCore import (
    QBuffer, QIODevice, QPoint, QThread, QTimer, Qt, QUrl, Signal, Slot,
)
from PySide6.QtGui import (
    QAction, QColor, QDesktopServices, QFont, QImage, QKeySequence, QPainter,
    QPen, QPixmap,
)
from PySide6.QtWidgets import (
    QAbstractItemView, QCheckBox, QComboBox, QDialog,
    QFileDialog, QFrame, QGridLayout, QGroupBox, QHBoxLayout, QHeaderView, QLabel,
    QLineEdit, QMainWindow, QMessageBox, QPlainTextEdit, QProgressBar, QPushButton,
    QSizePolicy, QSlider, QSpinBox, QSplitter, QTableWidget, QTableWidgetItem,
    QTabWidget, QTextBrowser, QToolBar, QToolButton, QVBoxLayout, QWidget,
)

from . import __version__, export, generator, model
from .audio_player import AudioPlayer
from .player import FilmPlayer
from .workers import AnalyzeWorker, GenerateWorker

STATUS_STYLE = {
    "matched": ("已匹配", "#1f9d55"),
    "matched_with_issue": ("匹配(有问题)", "#c77700"),
    "video_only": ("仅画面", "#2563c9"),
    "audio_only": ("仅声音", "#7a3fb8"),
    "missing": ("未找到", "#c62b33"),
    "unplanned": ("计划外", "#c62b33"),
}

ISSUE_FILTERS = [
    ("全部", None),
    ("有问题/未匹配", ("issue",)),
    ("已匹配", ("matched",)),
    ("未找到", ("missing",)),
    ("只检出一半", ("partial",)),
    ("计划外", ("extra",)),
]


def _fmt_t(t: float | None, digits: int = 3) -> str:
    if t is None:
        return "—"
    return f"{t:.{digits}f}s"


def _fmt_ms(v: float | None) -> str:
    if v is None:
        return "—"
    return f"{v * 1000.0:+.1f} ms"


def _rgb_to_pixmap(rgb: np.ndarray) -> QPixmap:
    h, w = rgb.shape[:2]
    img = np.ascontiguousarray(rgb)
    qimg = QImage(img.data, w, h, w * 3, QImage.Format_RGB888)
    return QPixmap.fromImage(qimg.copy())


class FramePairWidget(QWidget):
    """前后两帧并排 + 对应声音小段的波形."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._analysis = None
        self._report = None
        self._event = None
        self._center_frame = 0
        self._waveform = None
        self._waveform_lo = 0.0
        self._waveform_hi = 1.0

        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        self._title = QLabel("在右侧选一个标记, 这里显示前后两帧与该段声音")
        self._title.setWordWrap(True)
        f = self._title.font()
        f.setPointSizeF(f.pointSizeF() + 0.5)
        f.setBold(True)
        self._title.setFont(f)
        layout.addWidget(self._title)

        self._meta = QLabel("")
        self._meta.setWordWrap(True)
        self._meta.setStyleSheet("color:#55555c; font-size:12px;")
        layout.addWidget(self._meta)

        frame_row = QHBoxLayout()
        self._prev_box, self._prev_img = self._make_frame_box("前一帧")
        self._next_box, self._next_img = self._make_frame_box("后一帧")
        frame_row.addWidget(self._prev_box)
        frame_row.addWidget(self._next_box)
        layout.addLayout(frame_row)

        self._waveform = QLabel("")
        self._waveform.setMinimumHeight(64)
        self._waveform.setStyleSheet(
            "background:#16161a; border-radius:6px; border:1px solid #2c2c33;")
        self._waveform.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
        layout.addWidget(self._waveform)

        btn_row = QHBoxLayout()
        self._btn_play = QPushButton("▶ 听该段")
        self._btn_play.setToolTip("播放异常标记前后的声音小段")
        self._btn_play.clicked.connect(self.play_segment)
        self._btn_prev = QPushButton("◀ 退一帧")
        self._btn_prev.clicked.connect(lambda: self.step(-1))
        self._btn_prev.setShortcut(QKeySequence(Qt.Key_Left))
        self._btn_next = QPushButton("进一帧 ▶")
        self._btn_next.clicked.connect(lambda: self.step(1))
        self._btn_next.setShortcut(QKeySequence(Qt.Key_Right))
        btn_row.addWidget(self._btn_play)
        btn_row.addWidget(self._btn_prev)
        btn_row.addWidget(self._btn_next)
        btn_row.addStretch(1)
        layout.addLayout(btn_row)
        layout.addStretch(1)

        self._player = AudioPlayer(self)

    def _make_frame_box(self, caption: str) -> tuple[QGroupBox, QLabel]:
        box = QGroupBox(caption)
        v = QVBoxLayout(box)
        img = QLabel("")
        img.setAlignment(Qt.AlignCenter)
        img.setMinimumSize(260, 146)
        img.setStyleSheet("background:#111114; border-radius:4px; color:#7a7a82; font-size:12px;")
        img.setText("—")
        v.addWidget(img)
        return box, img

    # -- 状态 ---------------------------------------------------------------
    def set_context(self, analysis, report) -> None:
        self._analysis = analysis
        self._report = report
        if analysis is None:
            self._title.setText("在右侧选一个标记, 这里显示前后两帧与该段声音")
            self._meta.setText("")
            self._prev_img.setText("—")
            self._next_img.setText("—")
            self._prev_img.setPixmap(QPixmap())
            self._next_img.setPixmap(QPixmap())
            self._waveform.clear()

    def show_event(self, event: dict[str, Any] | None) -> None:
        self._event = event
        if event is None or self._analysis is None:
            return
        vdet = event.get("video")
        adet = event.get("audio")
        center = None
        if vdet is not None:
            center = int(vdet["start_frame"])
        elif adet is not None:
            # 只有声音时, 用离声音起点最近的画面帧做对照
            ft = self._analysis.video_times
            if ft:
                center = int(np.searchsorted(ft, adet["start_time"]))
                center = max(0, min(len(ft) - 1, center))
        else:
            # 完全缺失: 用计划时刻定位
            pt = event.get("plan_time")
            ft = self._analysis.video_times
            if pt is not None and ft:
                center = int(np.searchsorted(ft, pt))
                center = max(0, min(len(ft) - 1, center))
        if center is None:
            self._title.setText("这段片子里没有可对照的画面帧")
            return
        self._center_frame = center
        self._render(event)

    def step(self, delta: int) -> None:
        if self._analysis is None or self._event is None:
            return
        new_center = self._center_frame + delta
        n = self._analysis.video_frame_count()
        if n and 0 <= new_center < n:
            self._center_frame = new_center
            self._render(self._event)

    def _render(self, event: dict[str, Any]) -> None:
        a = self._analysis
        if a is None or event is None:
            return
        n = a.video_frame_count()
        if n == 0:
            return
        idx = self._center_frame
        # 若 idx 本身是闪光帧, 前一帧取它自己, 后一帧取闪光之后的第一帧
        vdet = event.get("video")
        if vdet is not None and vdet["start_frame"] <= idx <= vdet["end_frame"]:
            prev_idx = idx
            next_idx = min(n - 1, int(vdet["end_frame"]) + 1)
        else:
            prev_idx = idx
            next_idx = min(n - 1, idx + 1)

        for lbl, fi in ((self._prev_img, prev_idx), (self._next_img, next_idx)):
            rgb = a.frame_rgb(fi)
            if rgb is None:
                lbl.setText("帧不可用")
                lbl.setPixmap(QPixmap())
            else:
                pm = _rgb_to_pixmap(rgb)
                lbl.setPixmap(pm.scaled(lbl.width(), lbl.height(),
                                        Qt.KeepAspectRatio, Qt.SmoothTransformation))
                lbl.setText("")
        self._prev_box.setTitle(f"前一帧 · #{prev_idx} · t={a.frame_time(prev_idx):.3f}s")
        self._next_box.setTitle(f"后一帧 · #{next_idx} · t={a.frame_time(next_idx):.3f}s")

        # 元信息: 实际帧时间 / 采样时间 / 判定
        vdet = event.get("video")
        adet = event.get("audio")
        plan_t = event.get("plan_time")
        bits = [f"<b>#{event.get('id') if event.get('id') is not None else '?'}</b>"]
        if plan_t is not None:
            bits.append(f"计划 t={plan_t:.3f}s (帧 {event.get('plan_frame')})")
        if vdet:
            bits.append(f"画面: 帧 {vdet['start_frame']}–{vdet['end_frame']}, "
                        f"实际 t={vdet['start_time']:.3f}–{vdet['end_time']:.3f}s, "
                        f"残差 {_fmt_ms(event.get('video_residual'))}")
        else:
            bits.append("<span style='color:#c62b33'>画面: 未检出</span>")
        if adet:
            bits.append(f"声音: 采样 {adet['start_sample']}–{adet['end_sample']}, "
                        f"实际 t={adet['start_time']:.3f}–{adet['end_time']:.3f}s, "
                        f"{adet['freq_hz']:.0f} Hz, 残差 {_fmt_ms(event.get('audio_residual'))}")
        else:
            bits.append("<span style='color:#c62b33'>声音: 未检出</span>")
        if event.get("sync_tags"):
            bits.append("判定: " + " / ".join(event["sync_tags"]))
        elif event.get("local_issue"):
            bits.append("<span style='color:#a1582f'>判定: 个别事件问题</span>")
        self._meta.setText("<br>".join(bits))
        self._title.setText(self._headline(event))
        self._draw_waveform(event)

    def _headline(self, event: dict[str, Any]) -> str:
        rep = self._report or {}
        sync = rep.get("sync") or {}
        tags = event.get("sync_tags") or []
        if event.get("local_issue"):
            return "个别事件问题: 这一处与计划不符, 但其它地方正常"
        for key, name in (("audio", "声音"), ("video", "画面")):
            d = sync.get(key) or {}
            if d.get("applicable") and abs(event.get(f"{key}_residual") or 0) < \
                    abs(d.get("seconds") or 0) + 0.05:
                if not tags:
                    return f"{name}整体偏移 {_fmt_ms(d.get('seconds'))}: 全片一起平移, 不是个别事件"
                return f"{name}整体偏移 {_fmt_ms(d.get('seconds'))} 之上的个别事件偏差"
        return "该标记与计划一致" if not tags else "该标记存在个别偏差"

    def _draw_waveform(self, event: dict[str, Any]) -> None:
        a = self._analysis
        if a is None or a.audio_samples is None or len(a.audio_samples) == 0:
            self._waveform.setText("  无音频")
            return
        adet = event.get("audio")
        if adet is not None:
            t0 = max(0.0, adet["start_time"] - 0.12)
            t1 = min(a.audio_start + len(a.audio_samples) / a.audio_sample_rate,
                     adet["end_time"] + 0.18)
        else:
            pt = event.get("plan_time")
            if pt is None:
                self._waveform.setText("  这段没有对应的声音")
                return
            t0, t1 = max(0.0, pt - 0.10), pt + 0.30
        seg = a.audio_slice(t0, t1)
        self._waveform_lo, self._waveform_hi = t0, t1
        if len(seg) == 0:
            self._waveform.setText("  无音频")
            return
        W = max(200, self._waveform.width() - 16)
        H = max(52, self._waveform.height() - 12)
        pix = QPixmap(W, H)
        pix.fill(QColor("#16161a"))
        p = _Painter(pix)
        paint = p.get()
        paint.setRenderHint(QPainter.Antialiasing, True)
        paint.setPen(QColor("#3a3a44"))
        paint.drawLine(8, H // 2, W - 8, H // 2)
        # 每列取 min/max 画成竖线
        cols = W - 16
        n = len(seg)
        idxs = np.linspace(0, n, cols + 1).astype(int)
        peak = float(np.max(np.abs(seg))) or 1.0
        paint.setPen(QColor("#6fd3a5"))
        for c in range(cols):
            lo, hi = idxs[c], max(idxs[c] + 1, idxs[c + 1])
            chunk = seg[lo:hi]
            mn, mx = float(chunk.min()), float(chunk.max())
            y0 = int(H // 2 - (mx / peak) * (H // 2 - 6))
            y1 = int(H // 2 - (mn / peak) * (H // 2 - 6))
            paint.drawLine(8 + c, y0, 8 + c, y1)
        # 标出检出的提示声范围
        if adet is not None:
            x0 = 8 + int(cols * (adet["start_time"] - t0) / max(1e-9, t1 - t0))
            x1 = 8 + int(cols * (adet["end_time"] - t0) / max(1e-9, t1 - t0))
            paint.setPen(QColor("#e8b34a"))
            paint.drawLine(x0, 4, x0, H - 4)
            paint.drawLine(x1, 4, x1, H - 4)
        paint.setPen(QColor("#9a9aa4"))
        paint.drawText(10, 14, f"{t0:.3f}s")
        paint.drawText(W - 64, H - 6, f"{t1:.3f}s")
        p.finish()
        self._waveform.setPixmap(pix)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        if self._analysis is None or self._event is None:
            return
        self._draw_waveform(self._event)
        self._render(self._event)

    def play_segment(self) -> None:
        if self._analysis is None or self._event is None:
            return
        a = self._analysis
        adet = self._event.get("audio")
        if adet is not None:
            t0 = max(0.0, adet["start_time"] - 0.10)
            t1 = adet["end_time"] + 0.15
        else:
            pt = self._event.get("plan_time")
            if pt is None:
                return
            t0, t1 = max(0.0, pt - 0.10), pt + 0.25
        seg = a.audio_slice(t0, t1)
        if len(seg) == 0:
            QMessageBox.information(self, "没有音频", "这段片子在该时段没有音频样本.")
            return
        ok = self._player.play_samples(seg, a.audio_sample_rate)
        if not ok:
            QMessageBox.warning(self, "播放失败", "当前系统没有可用的音频输出.")
        self._btn_play.setText("▶ 听该段")


class _Painter:
    """把 QPainter 的生命周期收进一个小包装, 避免忘记 finish."""

    def __init__(self, pix: QPixmap):
        self._p = QPainter(pix)

    def get(self):
        return self._p

    def finish(self) -> None:
        self._p.end()


class MainWindow(QMainWindow):
    APP_TITLE = f"SyncMark · 声画标记打点与回读 v{__version__}"

    def __init__(self):
        super().__init__()
        self.setWindowTitle(self.APP_TITLE)
        self.resize(1360, 880)

        self._plan: dict[str, Any] | None = None
        self._plan_path: str | None = None
        self._report: dict[str, Any] | None = None
        self._analysis = None
        self._events: list[dict[str, Any]] = []
        self._selected_event: dict[str, Any] | None = None
        self._film_path: str | None = None
        self._thread: QThread | None = None
        self._worker = None
        self._busy = False
        self._last_export_dir: str | None = None

        self._player = FilmPlayer(self)
        self._player.positionChanged.connect(self._on_player_position)
        self._player.errorOccurred.connect(self._on_player_error)
        self._timeline_timer = QTimer(self)
        self._timeline_timer.setInterval(33)
        self._timeline_timer.timeout.connect(self._sync_timeline_from_player)

        self._build_actions()
        self._build_ui()
        self._refresh_actions()

    # ------------------------------------------------------------------ UI
    def _build_actions(self) -> None:
        self.act_open_film = QAction("打开短片…", self)
        self.act_open_film.setShortcut(QKeySequence.Open)
        self.act_open_film.triggered.connect(self.open_film)

        self.act_open_report = QAction("打开对照报告…", self)
        self.act_open_report.setShortcut(QKeySequence("Ctrl+Shift+O"))
        self.act_open_report.triggered.connect(self.open_report)

        self.act_export = QAction("导出对照报告…", self)
        self.act_export.setShortcut(QKeySequence.Save)
        self.act_export.triggered.connect(self.export_report)

        self.act_generate = QAction("生成测试片…", self)
        self.act_generate.setShortcut(QKeySequence("Ctrl+G"))
        self.act_generate.triggered.connect(self.show_generate_dialog)

        tb = QToolBar("主工具栏")
        tb.setMovable(False)
        tb.setIconSize(tb.iconSize())
        self.addToolBar(tb)
        tb.addAction(self.act_open_film)
        tb.addAction(self.act_open_report)
        tb.addAction(self.act_export)
        tb.addSeparator()
        tb.addAction(self.act_generate)
        self._toolbar = tb

    def _build_ui(self) -> None:
        central = QWidget()
        v = QVBoxLayout(central)
        v.setContentsMargins(10, 8, 10, 8)
        v.setSpacing(8)

        # -- 顶部信息条 --
        self._headline = QLabel("打开一段短片, 或先生成一段带编号标记的测试片")
        f = self._headline.font()
        f.setPointSizeF(f.pointSizeF() + 1.5)
        f.setBold(True)
        self._headline.setFont(f)
        self._headline.setWordWrap(True)
        v.addWidget(self._headline)

        self._subhead = QLabel("识别阶段只读取解码后的画面和声音, 不读取计划文件.")
        self._subhead.setStyleSheet("color:#6a6a72;")
        v.addWidget(self._subhead)

        # -- 主区域: 左表右详情 --
        split = QSplitter(Qt.Horizontal)
        split.addWidget(self._build_left())
        split.addWidget(self._build_right())
        split.setStretchFactor(0, 5)
        split.setStretchFactor(1, 6)
        split.setSizes([680, 660])
        v.addWidget(split, 1)

        # -- 播放条 --
        v.addWidget(self._build_transport())
        self.setCentralWidget(central)

        self._status = self.statusBar()
        self._status.showMessage("就绪")
        self._progress = QProgressBar()
        self._progress.setRange(0, 0)
        self._progress.setFixedWidth(120)
        self._progress.hide()
        self._status.addPermanentWidget(self._progress)

    def _build_left(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(6)

        bar = QHBoxLayout()
        bar.addWidget(QLabel("筛选"))
        self._filter = QComboBox()
        for label, _key in ISSUE_FILTERS:
            self._filter.addItem(label)
        self._filter.currentIndexChanged.connect(self._apply_filter)
        bar.addWidget(self._filter)
        bar.addStretch(1)
        self._chk_frames = QCheckBox("显示帧号")
        self._chk_frames.setChecked(True)
        self._chk_frames.stateChanged.connect(lambda _s: self._fill_table())
        bar.addWidget(self._chk_frames)
        v.addLayout(bar)

        self._summary = QLabel("尚无报告")
        self._summary.setWordWrap(True)
        self._summary.setStyleSheet(
            "background:#f4f4f7; border:1px solid #e2e2e8; border-radius:8px;"
            "padding:8px 10px; color:#3a3a42;")
        v.addWidget(self._summary)

        self._table = QTableWidget(0, 8)
        self._table.setHorizontalHeaderLabels(
            ["#", "状态", "编号", "计划", "画面(帧/时刻)", "声音(采样/时刻)", "残差", "说明"])
        self._table.verticalHeader().setVisible(False)
        self._table.setSelectionBehavior(QAbstractItemView.SelectRows)
        self._table.setSelectionMode(QAbstractItemView.SingleSelection)
        self._table.setEditTriggers(QAbstractItemView.NoEditTriggers)
        self._table.setAlternatingRowColors(True)
        self._table.itemSelectionChanged.connect(self._on_row_selected)
        self._table.itemDoubleClicked.connect(self._on_row_activated)
        hh = self._table.horizontalHeader()
        hh.setSectionResizeMode(0, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(1, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(2, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(3, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(4, QHeaderView.Stretch)
        hh.setSectionResizeMode(5, QHeaderView.Stretch)
        hh.setSectionResizeMode(6, QHeaderView.ResizeToContents)
        hh.setSectionResizeMode(7, QHeaderView.Stretch)
        v.addWidget(self._table, 1)

        legend = QLabel(
            "状态: <span style='color:#1f9d55'>■ 已匹配</span> "
            "<span style='color:#c77700'>■ 有偏差</span> "
            "<span style='color:#2563c9'>■ 仅画面</span> "
            "<span style='color:#7a3fb8'>■ 仅声音</span> "
            "<span style='color:#c62b33'>■ 未找到 / 计划外</span>")
        legend.setStyleSheet("font-size:11.5px; color:#55555d;")
        v.addWidget(legend)
        return w

    def _build_right(self) -> QWidget:
        w = QWidget()
        v = QVBoxLayout(w)
        v.setContentsMargins(0, 0, 0, 0)
        v.setSpacing(6)

        self._sync_panel = QLabel("")
        self._sync_panel.setWordWrap(True)
        self._sync_panel.setStyleSheet(
            "background:#fbfbfd; border:1px solid #e2e2e8; border-radius:8px;"
            "padding:9px 11px; color:#33333b;")
        v.addWidget(self._sync_panel)

        self._tab = QTabWidget()
        self._detail = FramePairWidget()
        self._tab.addTab(self._detail, "异常定位 (前后两帧 + 声音)")
        self._json_view = QPlainTextEdit()
        self._json_view.setReadOnly(True)
        self._json_view.setLineWrapMode(QPlainTextEdit.NoWrap)
        font = QFont("Menlo")
        font.setStyleHint(QFont.Monospace)
        font.setPointSizeF(10.5)
        self._json_view.setFont(font)
        self._tab.addTab(self._json_view, "报告 JSON")
        self._boundary_view = QTextBrowser()
        self._boundary_view.setOpenExternalLinks(True)
        self._tab.addTab(self._boundary_view, "首尾边界")
        self._tab.currentChanged.connect(self._on_tab_changed)
        v.addWidget(self._tab, 1)
        return w

    def _build_transport(self) -> QWidget:
        box = QFrame()
        box.setStyleSheet("QFrame { background:#f7f7fa; border:1px solid #e2e2e8;"
                          " border-radius:8px; }")
        outer = QVBoxLayout(box)
        outer.setContentsMargins(10, 8, 10, 8)
        outer.setSpacing(4)

        row = QHBoxLayout()
        self._btn_play = QToolButton()
        self._btn_play.setText("▶")
        self._btn_play.setToolTip("播放/暂停整片 (空格)")
        self._btn_play.clicked.connect(self.toggle_play)
        # 空格只在按钮本身有焦点时触发, 避免和表格里的方向键/空格冲突
        self._btn_play.setShortcut(QKeySequence(Qt.Key_Space))
        row.addWidget(self._btn_play)

        self._btn_to_event = QPushButton("跳到选中标记")
        self._btn_to_event.setToolTip("把播放头放到当前选中标记的计划时刻")
        self._btn_to_event.clicked.connect(self.jump_to_event)
        row.addWidget(self._btn_to_event)

        self._slider = QSlider(Qt.Horizontal)
        self._slider.setRange(0, 1000)
        self._slider.setTracking(True)
        self._slider.sliderMoved.connect(self._on_slider_moved)
        row.addWidget(self._slider, 1)

        self._time_label = QLabel("00:00.000 / 00:00.000")
        self._time_label.setStyleSheet("font-family:Menlo; font-size:12px; color:#4a4a52;")
        row.addWidget(self._time_label)

        self._chk_film_audio = QCheckBox("整片出声")
        self._chk_film_audio.setToolTip("打开后整片播放会出声; 关闭时整片静音, 用右侧按钮单独试听小段")
        self._chk_film_audio.stateChanged.connect(self._on_film_audio_toggled)
        row.addWidget(self._chk_film_audio)
        outer.addLayout(row)

        self._timeline = TimelineWidget()
        self._timeline.setMinimumHeight(46)
        self._timeline.seekRequested.connect(self._seek_fraction)
        self._timeline.eventClicked.connect(self._on_timeline_event_clicked)
        outer.addWidget(self._timeline)
        return box

    # --------------------------------------------------------------- 状态
    def _set_busy(self, busy: bool, text: str = "") -> None:
        self._busy = busy
        self._progress.setVisible(busy)
        for a in (self.act_open_film, self.act_open_report, self.act_export,
                  self.act_generate):
            a.setEnabled(not busy)
        if busy:
            self._status.showMessage(text or "处理中…")
        else:
            self._status.showMessage(text or "就绪")
        self._refresh_actions()

    def _refresh_actions(self) -> None:
        has_report = self._report is not None
        self.act_export.setEnabled(has_report and not self._busy)
        self._btn_to_event.setEnabled(self._selected_event is not None and not self._busy)
        self._timeline.setEnabled(self._report is not None)

    # -------------------------------------------------------------- 打开
    @Slot()
    def open_film(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开要回读的短片", self._last_dir(),
            "视频文件 (*.mp4 *.mov *.m4v *.mkv *.avi *.webm *.ts);;所有文件 (*)")
        if not path:
            return
        self._load_film(path, analyze=True)

    def _load_film(self, path: str, *, analyze: bool, plan_path: str | None = None) -> None:
        plan = None
        if plan_path is None:
            found = model.find_plan_sidecar(path)
            if found:
                plan_path = found
        if plan_path:
            try:
                plan = model.read_json(plan_path)
                if plan.get("schema") != model.SCHEMA_PLAN:
                    raise ValueError(f"不是 SyncMark 计划文件: {plan_path}")
                plan["plan_path"] = plan_path
            except Exception as exc:  # noqa: BLE001
                QMessageBox.warning(self, "计划文件读不了",
                                    f"{exc}\n\n将只做独立识别, 不做匹配.")
                plan = None
                plan_path = None
        self._film_path = path
        self._plan = plan
        self._plan_path = plan_path
        self._player.load(path)
        self._timeline_timer.start()
        if analyze:
            self._start_analyze(path, plan)

    def _start_analyze(self, path: str, plan: dict[str, Any] | None, *,
                       attach_only: bool = False) -> None:
        if self._thread is not None:
            return
        self._set_busy(True, "正在解码与识别…")
        self._thread = QThread(self)
        worker = AnalyzeWorker(path, plan, match=not attach_only)
        worker.moveToThread(self._thread)
        self._thread.started.connect(worker.run)
        worker.progress.connect(lambda s: self._status.showMessage(s))
        worker.finished.connect(self._on_analyze_done)
        worker.failed.connect(self._on_analyze_failed)
        worker.finished.connect(self._thread.quit)
        worker.failed.connect(self._thread.quit)
        self._thread.finished.connect(self._thread.deleteLater)
        self._worker = worker
        self._thread.start()

    @Slot(object, object)
    def _on_analyze_done(self, analysis, report) -> None:
        if self._analysis is not None:
            self._analysis.release()
        self._analysis = analysis
        self._thread = None
        self._set_busy(False)
        if report is None:
            # 只是为已保存的报告重新解码, 保留原报告内容, 只补上帧/声音数据
            if self._report is not None:
                self._render_report()
                self._detail.set_context(analysis, self._report)
                self._detail.show_event(self._selected_event or
                                        (self._events[0] if self._events else None))
                self._subhead.setText(
                    "报告已重新载入; 短片已重新解码, 帧图与试听可用.")
                self._status.showMessage("报告重新载入完成", 4000)
            return
        self._report = report
        self._events = list(report.get("events") or [])
        self._render_report()
        self._detail.set_context(analysis, report)
        self._detail.show_event(self._events[0] if self._events else None)
        title = os.path.basename(self._film_path or "")
        self._headline.setText(f"已回读: {title}")
        base = "独立识别完成, 未读取计划文件" if not self._plan else "独立识别后与计划对齐"
        self._subhead.setText(
            f"{base} · 画面 {len(analysis.video_detections)} 个 · 声音 "
            f"{len(analysis.audio_detections)} 个"
            + (f" · 计划 {self._plan_path}" if self._plan_path else " · 未找到计划文件"))
        self._status.showMessage("识别与匹配完成", 4000)

    @Slot(str)
    def _on_analyze_failed(self, message: str) -> None:
        self._thread = None
        self._set_busy(False)
        QMessageBox.critical(self, "识别失败", message)
        self._status.showMessage("识别失败")

    def open_report(self) -> None:
        path, _ = QFileDialog.getOpenFileName(
            self, "打开对照报告", self._last_dir(),
            "对照报告 (*.syncreport.json *report*.json;*.json);;HTML 报告 (*.html);;所有文件 (*)")
        if not path:
            return
        try:
            if path.lower().endswith((".html", ".htm")):
                QDesktopServices.openUrl(QUrl.fromLocalFile(path))
                return
            data = model.read_json(path)
        except Exception as exc:  # noqa: BLE001
            QMessageBox.critical(self, "报告读不了", str(exc))
            return
        if not self._adopt_report(data, path):
            QMessageBox.warning(self, "不是有效的对照报告",
                                "文件里没有 SyncMark 的 schema 或 events 字段.")

    def _adopt_report(self, report: dict[str, Any], path: str) -> bool:
        if report.get("schema") != model.SCHEMA_REPORT or "events" not in report:
            return False
        film = (report.get("film") or {}).get("path")
        if not film or not os.path.isfile(film):
            QMessageBox.information(
                self, "片子不在本机",
                f"报告里记录的短片路径是:\n{film}\n\n该文件不存在, 因此只能查看表格与边界信息,"
                "\n帧图与试听将不可用.")
            film = None
        if film:
            if self._analysis is not None:
                self._analysis.release()
            self._analysis = None
            self._report = report
            self._events = list(report.get("events") or [])
            self._film_path = film
            self._plan = None
            self._plan_path = report.get("plan_ref")
            self._player.load(film)
            self._render_report()
            self._detail.set_context(None, report)
            self._headline.setText(f"已打开报告: {os.path.basename(path)}")
            self._subhead.setText(f"报告来自 {path} · 正在重新解码短片以便回读帧与声音…")
            self._start_analyze(film, None, attach_only=True)
            return True
        self._analysis = None
        self._report = report
        self._events = list(report.get("events") or [])
        self._player.release()
        self._render_report()
        self._detail.set_context(None, report)
        self._headline.setText(f"已打开报告: {os.path.basename(path)}")
        self._subhead.setText("报告中的短片不在本机, 仅显示表格与边界信息.")
        return True

    def _last_dir(self) -> str:
        return self._last_export_dir or os.getcwd()

    # -------------------------------------------------------------- 渲染
    def _render_report(self) -> None:
        self._fill_table()
        self._render_summary()
        self._render_sync_panel()
        self._render_boundary()
        self._json_view.setPlainText(json.dumps(
            {k: v for k, v in (self._report or {}).items() if k != "analysis_tmpdir"},
            ensure_ascii=False, indent=2))
        self._timeline.set_report(self._report)
        self._refresh_actions()

    def _render_summary(self) -> None:
        rep = self._report
        if not rep:
            self._summary.setText("尚无报告")
            return
        s = rep.get("summary") or {}
        b = rep.get("boundary") or {}
        parts = [
            f"计划 <b>{s.get('planned_markers', 0)}</b>",
            f"<span style='color:#1f9d55'>已匹配 <b>{s.get('matched', 0)}</b></span>",
            f"<span style='color:#c62b33'>未找到 <b>{s.get('missing', 0)}</b></span>",
            f"<span style='color:#2563c9'>仅一半 <b>{s.get('partial', 0)}</b></span>",
            f"<span style='color:#c62b33'>计划外 <b>{s.get('extra', 0)}</b></span>",
        ]
        if s.get("has_global_offset"):
            parts.append("<span style='color:#c77700'><b>存在整体偏移</b></span>")
        if s.get("has_local_issue"):
            parts.append("<span style='color:#a1582f'><b>存在个别事件问题</b></span>")
        if b.get("ends_with_missing_segment"):
            parts.append("<span style='color:#c77700'>末尾缺一段</span>")
        self._summary.setText(" · ".join(parts))

    def _render_sync_panel(self) -> None:
        rep = self._report
        if not rep:
            self._sync_panel.setText("")
            return
        sync = rep.get("sync") or {}
        tol = int(round((sync.get("event_tolerance_s") or 0.045) * 1000))
        rows = []
        for key, name in (("audio", "声音"), ("video", "画面")):
            d = sync.get(key) or {}
            if d.get("applicable"):
                rows.append(
                    f"<span style='color:#c77700; font-weight:600'>{name}整体偏移 "
                    f"{_fmt_ms(d.get('seconds'))}</span> "
                    f"<span style='color:#77777f'>({d.get('support')} 个样本, 离散 "
                    f"{_fmt_ms(d.get('mad'))})</span>")
            else:
                rows.append(
                    f"<span style='color:#1f9d55; font-weight:600'>{name}无整体偏移</span> "
                    f"<span style='color:#77777f'>({d.get('reason', '')})</span>")
        local = (rep.get("summary") or {}).get("has_local_issue")
        rows.append(
            "<span style='color:#a1582f; font-weight:600'>"
            + ("存在个别事件问题" if local else "无个别事件问题")
            + "</span> <span style='color:#77777f'>"
            + f"(扣除整体偏移后逐事件阈值 ±{tol} ms)</span>")
        self._sync_panel.setText("<br>".join(rows))

    def _render_boundary(self) -> None:
        rep = self._report
        if not rep:
            self._boundary_view.setHtml("<p style='color:#777'>尚无报告</p>")
            return
        b = rep.get("boundary") or {}
        items = b.get("items") or []
        html_parts = [
            "<style>td,p{font-size:12.5px} th{text-align:left;color:#555}</style>",
            "<h3 style='margin:4px 0 8px'>首尾边界自检</h3>",
            "<table cellspacing='0' cellpadding='6' width='100%'>",
            "<tr><th>检查项</th><th>结果</th><th>形态</th><th>实际</th></tr>",
        ]
        for it in items:
            ok = it.get("passed")
            color = "#1f9d55" if ok else "#c62b33"
            html_parts.append(
                f"<tr><td>{it.get('name')}</td>"
                f"<td style='color:{color};font-weight:600'>{'通过' if ok else '异常'}</td>"
                f"<td>{it.get('mode', '')}</td><td>{it.get('detail', '')}</td></tr>")
        html_parts.append("</table>")
        if b.get("ends_with_missing_segment"):
            html_parts.append(
                "<p style='color:#c77700;margin-top:10px'>"
                "此片末尾刚好少了一段: 计划里最后一个标记在片子里完全找不到, "
                "片子的最后一帧之后几乎没有余量. 这属于预期中的边界情况.</p>")
        self._boundary_view.setHtml("".join(html_parts))

    def _event_matches_filter(self, e: dict[str, Any]) -> bool:
        mode = ISSUE_FILTERS[self._filter.currentIndex()][1]
        if mode is None:
            return True
        keys = set(mode)
        st = e.get("status")
        if "issue" in keys:
            return bool(e.get("local_issue"))
        if "matched" in keys:
            return st in ("matched", "matched_with_issue") and e.get("source") == "plan"
        if "missing" in keys:
            return st == "missing"
        if "partial" in keys:
            return st in ("video_only", "audio_only")
        if "extra" in keys:
            return e.get("source") == "extra"
        return True

    def _apply_filter(self) -> None:
        self._fill_table()
        self._render_summary()

    def _fill_table(self) -> None:
        self._table.blockSignals(True)
        self._table.setRowCount(0)
        shown = [e for e in self._events if self._event_matches_filter(e)]
        self._table.setRowCount(len(shown))
        show_frames = self._chk_frames.isChecked()
        for r, e in enumerate(shown):
            st, color = STATUS_STYLE.get(e.get("status"), (str(e.get("status")), "#555"))
            if e.get("source") == "extra":
                st, color = "计划外", "#c62b33"
            vals = [
                str(r + 1),
                st,
                str(e.get("id") if e.get("id") is not None else "?"),
                ("—" if e.get("plan_time") is None
                 else (f"{_fmt_t(e['plan_time'])}\n帧 {e.get('plan_frame')}"
                       if show_frames else _fmt_t(e["plan_time"]))),
                self._fmt_video(e),
                self._fmt_audio(e),
                self._fmt_residual(e),
                " ".join([*e.get("problems", []), *e.get("sync_tags", [])]),
            ]
            for c, text in enumerate(vals):
                item = QTableWidgetItem(text)
                item.setData(Qt.UserRole, id(e))
                if c == 1:
                    item.setForeground(QColor(color))
                    f = item.font()
                    f.setBold(True)
                    item.setFont(f)
                if c in (0, 2, 3, 4, 5, 6):
                    item.setTextAlignment(Qt.AlignLeft | Qt.AlignVCenter)
                self._table.setItem(r, c, item)
        self._table.blockSignals(False)
        if self._selected_event is not None:
            self._reselect_event(self._selected_event)
        elif shown:
            self._table.selectRow(0)
            self._selected_event = shown[0]
            self._detail.show_event(shown[0])

    def _fmt_video(self, e: dict[str, Any]) -> str:
        v = e.get("video")
        if not v:
            return "未检出"
        s = f"帧 {v['start_frame']}·t={_fmt_t(v['start_time'])}"
        if v.get("duplicate_frames"):
            s += f" (含{v['duplicate_frames']}重复帧)"
        return s

    def _fmt_audio(self, e: dict[str, Any]) -> str:
        a = e.get("audio")
        if not a:
            return "未检出"
        return f"采样 {a['start_sample']}·t={_fmt_t(a['start_time'])}"

    def _fmt_residual(self, e: dict[str, Any]) -> str:
        bits = []
        vr, ar = e.get("video_residual"), e.get("audio_residual")
        if vr is not None:
            adj = e.get("video_adjusted")
            bits.append("画面 " + _fmt_ms(vr) + (f" → {_fmt_ms(adj)}" if adj is not None and abs(adj - vr) > 1e-6 else ""))
        if ar is not None:
            adj = e.get("audio_adjusted")
            bits.append("声音 " + _fmt_ms(ar) + (f" → {_fmt_ms(adj)}" if adj is not None and abs(adj - ar) > 1e-6 else ""))
        return "\n".join(bits) or "—"

    def _reselect_event(self, event: dict[str, Any]) -> None:
        for r in range(self._table.rowCount()):
            item = self._table.item(r, 0)
            if item and item.data(Qt.UserRole) == id(event):
                self._table.blockSignals(True)
                self._table.selectRow(r)
                self._table.blockSignals(False)
                return

    def _selected_event_from_row(self) -> dict[str, Any] | None:
        rows = self._table.selectionModel().selectedRows() if self._table.selectionModel() else []
        if not rows:
            return None
        r = rows[0].row()
        shown = [e for e in self._events if self._event_matches_filter(e)]
        if 0 <= r < len(shown):
            return shown[r]
        return None

    def _on_row_selected(self) -> None:
        e = self._selected_event_from_row()
        if e is None:
            return
        self._selected_event = e
        self._detail.show_event(e)
        self._refresh_actions()

    def _on_row_activated(self) -> None:
        self.jump_to_event()
        self._tab.setCurrentWidget(self._detail)

    def _on_timeline_event_clicked(self, event_key: str) -> None:
        for e in self._events:
            if e.get("key") == event_key:
                self._selected_event = e
                self._reselect_event(e)
                self._detail.show_event(e)
                self._tab.setCurrentWidget(self._detail)
                self._refresh_actions()
                break

    def _on_tab_changed(self, index: int) -> None:
        if self._tab.widget(index) is self._detail and self._selected_event is not None:
            self._detail.show_event(self._selected_event)

    # -------------------------------------------------------------- 生成
    def show_generate_dialog(self) -> None:
        dlg = GenerateDialog(self._plan_dir_hint(), self)
        if dlg.exec() != QDialog.Accepted:
            return
        options = dlg.options()
        path = options.pop("out_path")
        self._start_generate(path, options)

    def _plan_dir_hint(self) -> str:
        if self._film_path:
            return os.path.dirname(self._film_path)
        return self._last_dir()

    def _start_generate(self, path: str, options: dict[str, Any]) -> None:
        if self._thread is not None:
            return
        self._set_busy(True, "正在生成测试片…")
        self._thread = QThread(self)
        worker = GenerateWorker(path, options)
        worker.moveToThread(self._thread)
        self._thread.started.connect(worker.run)
        worker.progress.connect(lambda s: self._status.showMessage(s))
        worker.finished.connect(self._on_generate_done)
        worker.failed.connect(self._on_generate_failed)
        worker.finished.connect(self._thread.quit)
        worker.failed.connect(self._thread.quit)
        self._thread.finished.connect(self._thread.deleteLater)
        self._worker = worker
        self._thread.start()

    @Slot(object, str)
    def _on_generate_done(self, plan, path) -> None:
        self._thread = None
        self._set_busy(False)
        self._plan = plan
        self._plan_path = model.plan_default_path(path)
        self._last_export_dir = os.path.dirname(path)
        self._status.showMessage(f"已生成 {os.path.basename(path)}", 5000)
        self._load_film(path, analyze=True, plan_path=self._plan_path)

    @Slot(str)
    def _on_generate_failed(self, message: str) -> None:
        self._thread = None
        self._set_busy(False)
        QMessageBox.critical(self, "生成失败", message)

    # -------------------------------------------------------------- 导出
    def export_report(self) -> None:
        if not self._report:
            return
        default_dir = self._last_dir()
        base = os.path.splitext(os.path.basename(self._film_path or "report"))[0]
        default = os.path.join(default_dir, f"{base}.syncreport.html")
        path, selected = QFileDialog.getSaveFileName(
            self, "导出对照报告", default,
            "HTML 报告 (*.html);;SyncMark 报告 JSON (*.syncreport.json);;Markdown (*.md)")
        if not path:
            return
        if path.lower().endswith(".json"):
            data = {k: v for k, v in self._report.items() if k != "analysis_tmpdir"}
            data["readme"] = {
                "schema": model.SCHEMA_REPORT,
                "how_to_open": "用 SyncMark 的『打开对照报告…』即可重新载入;"
                               " 若片子仍在原路径, 会自动重新解码以支持帧图与试听.",
            }
            model.write_json_atomic(path, data)
            out = path
        elif path.lower().endswith(".md"):
            out = export.export_markdown(self._report, path)
        else:
            if not path.lower().endswith((".html", ".htm")):
                path += ".html"
            thumbs = self._make_thumbnails()
            out = export.export_html(self._report, path, thumbnails=thumbs)
        self._last_export_dir = os.path.dirname(out)
        self._status.showMessage(f"已导出 {out}", 6000)
        QMessageBox.information(
            self, "导出完成",
            f"报告已保存到:\n{out}\n\n可以直接双击重新打开(HTML 自包含);"
            "\n也可以在 SyncMark 里用『打开对照报告…』载入.")

    def _make_thumbnails(self) -> dict[str, str]:
        """给每个异常事件生成"前后两帧"缩略图, 内嵌到 HTML."""
        thumbs: dict[str, str] = {}
        if self._analysis is None:
            return thumbs
        a = self._analysis
        n = a.video_frame_count()
        if n == 0:
            return thumbs
        for i, e in enumerate(self._events, 1):
            if not e.get("local_issue"):
                continue
            v = e.get("video")
            idx = int(v["start_frame"]) if v else (
                int(np.searchsorted(a.video_times, e["plan_time"]))
                if e.get("plan_time") is not None else 0)
            idx = max(0, min(n - 1, idx))
            prev = idx
            nxt = min(n - 1, idx + 1) if v is None else min(n - 1, int(v["end_frame"]))
            frames = [a.frame_rgb(prev), a.frame_rgb(nxt)]
            if any(f is None for f in frames):
                continue
            small = []
            for f in frames:
                pm = _rgb_to_pixmap(f).scaledToWidth(150, Qt.SmoothTransformation)
                small.append(pm)
            total_w = sum(p.width() for p in small) + 8
            total_h = max(p.height() for p in small)
            combo = QPixmap(total_w, total_h)
            combo.fill(QColor("#20202a"))
            painter = QPainter(combo)
            x = 0
            for p in small:
                painter.drawPixmap(x, 0, p)
                x += p.width() + 8
            painter.end()
            buf = QBuffer()
            buf.open(QIODevice.WriteOnly)
            combo.save(buf, "PNG")
            buf.close()
            b64 = base64.b64encode(bytes(buf.data())).decode("ascii")
            thumbs[f"e{i}"] = f"data:image/png;base64,{b64}"
        return thumbs

    # -------------------------------------------------------------- 播放
    def toggle_play(self) -> None:
        if not self._film_path:
            return
        if self._player.is_playing():
            self._player.pause()
            self._btn_play.setText("▶")
        else:
            self._player.play()
            self._btn_play.setText("❚❚")

    def jump_to_event(self) -> None:
        e = self._selected_event
        if e is None or not self._film_path:
            return
        t = None
        if e.get("video"):
            t = e["video"]["start_time"]
        elif e.get("audio"):
            t = e["audio"]["start_time"]
        elif e.get("plan_time") is not None:
            t = e["plan_time"]
        if t is None:
            return
        # 往前留 0.4s, 便于看清前后两帧
        self._player.seek_ms(int(max(0.0, t - 0.4) * 1000))
        self._player.play()
        self._btn_play.setText("❚❚")

    def _seek_fraction(self, frac: float) -> None:
        d = self._player.duration_ms()
        if d > 0:
            self._player.seek_ms(int(max(0.0, min(1.0, frac)) * d))

    def _on_slider_moved(self, value: int) -> None:
        if self._timeline_timer.isActive() and self._player.is_playing():
            return
        d = self._player.duration_ms()
        if d > 0:
            self._player.seek_ms(int(value / 1000.0 * d))

    def _on_film_audio_toggled(self, state: int) -> None:
        self._player.set_volume(1.0 if state == Qt.Checked else 0.0)

    def _on_player_position(self, pos_ms: int) -> None:
        self._update_time_label(pos_ms)
        self._timeline.set_position(pos_ms / 1000.0)
        if not self._slider.isSliderDown():
            d = self._player.duration_ms()
            self._slider.setValue(int(pos_ms / max(1, d) * 1000))

    def _sync_timeline_from_player(self) -> None:
        if self._player.is_playing():
            self._on_player_position(self._player.position_ms())

    def _update_time_label(self, pos_ms: int) -> None:
        d = self._player.duration_ms()
        self._time_label.setText(
            f"{self._mmss(pos_ms)} / {self._mmss(d)}")

    @staticmethod
    def _mmss(ms: int) -> str:
        s, ms2 = divmod(max(0, int(ms)), 1000)
        m, s = divmod(s, 60)
        return f"{m:02d}:{s:02d}.{ms2:03d}"

    def _on_player_error(self, text: str) -> None:
        self._status.showMessage(f"播放器: {text}", 6000)

    # -------------------------------------------------------------- 关闭
    def closeEvent(self, event) -> None:  # noqa: N802
        self._timeline_timer.stop()
        if self._thread is not None:
            self._thread.quit()
            self._thread.wait(3000)
        self._player.release()
        if self._analysis is not None:
            self._analysis.release()
        super().closeEvent(event)



class TimelineWidget(QWidget):
    """一条把计划标记、检出的画面/声音、整体偏移画在一起的时间轴."""

    seekRequested = Signal(float)
    eventClicked = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self._report: dict[str, Any] | None = None
        self._pos = 0.0
        self._duration = 1.0
        self._hit: list[tuple[float, float, str]] = []
        self.setMouseTracking(True)
        self.setCursor(Qt.PointingHandCursor)
        self.setToolTip("点击时间轴跳到该时刻; 小三角是标记, 可点选")

    def set_report(self, report: dict[str, Any] | None) -> None:
        self._report = report
        self._update_duration()
        self.update()

    def set_position(self, seconds: float) -> None:
        self._pos = seconds
        self.update()

    def _update_duration(self) -> None:
        rep = self._report
        if not rep:
            self._duration = 1.0
            return
        d = 0.0
        for e in rep.get("events") or []:
            for ch in ("video", "audio"):
                v = e.get(ch)
                if v:
                    d = max(d, v.get("end_time", 0.0))
            if e.get("plan_time") is not None:
                d = max(d, e["plan_time"])
        stats = (rep.get("stats") or {}).get("video") or {}
        d = max(d, stats.get("last_frame_time") or 0.0)
        self._duration = max(d * 1.02, 0.5)

    def paintEvent(self, event) -> None:  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing, True)
        W, H = self.width(), self.height()
        p.setPen(Qt.NoPen)
        p.setBrush(QColor("#14141a"))
        p.drawRoundedRect(0, 0, W, H, 6, 6)

        x0, x1 = 12, max(13, W - 12)
        lane_h = 14
        y_lane1 = 18
        y_lane2 = 34
        p.setPen(QPen(QColor("#2a2a34"), 1))
        p.drawLine(x0, y_lane1 + lane_h // 2, x1, y_lane1 + lane_h // 2)
        p.drawLine(x0, y_lane2 + lane_h // 2, x1, y_lane2 + lane_h // 2)

        def tx(t: float) -> int:
            return int(x0 + (x1 - x0) * max(0.0, min(1.0, t / self._duration)))

        # 每 1 秒刻度
        p.setPen(QPen(QColor("#3c3c48"), 1))
        sec = 0
        while sec <= self._duration:
            p.drawLine(tx(sec), 4, tx(sec), H - 4)
            sec += 1
        self._hit = []
        for e in (self._report or {}).get("events") or []:
            key = str(e.get("key"))
            v, a = e.get("video"), e.get("audio")
            if v:
                xv = tx(v["start_time"])
                p.setBrush(QColor("#41c9a0" if e.get("status") != "unplanned" else "#e05561"))
                p.setPen(Qt.NoPen)
                p.drawRect(xv, y_lane1, max(2, tx(v["end_time"]) - xv + 1), lane_h)
                self._hit.append((xv - 3, xv + 5, key))
            if a:
                xa = tx(a["start_time"])
                p.setBrush(QColor("#7aa7ff" if e.get("status") != "unplanned" else "#e05561"))
                p.drawRect(xa, y_lane2, max(2, tx(a["end_time"]) - xa + 1), lane_h)
            if e.get("plan_time") is not None:
                xp = tx(e["plan_time"])
                p.setPen(QPen(QColor("#ececff"), 1))
                p.setBrush(QColor("#ececff"))
                p.drawPolygon([
                    QPoint(xp, 16), QPoint(xp - 3, 10),
                    QPoint(xp + 3, 10), QPoint(xp, 16),
                ])
            # 有问题的事件画一个红色底环
            if e.get("sync_tags") or e.get("source") == "extra":
                p.setPen(QPen(QColor("#ff6b6b"), 1))
                p.setBrush(Qt.NoBrush)
                if v:
                    p.drawRect(tx(v["start_time"]) - 2, y_lane1 - 2, 6, lane_h + 4)
                if a:
                    p.drawRect(tx(a["start_time"]) - 2, y_lane2 - 2, 6, lane_h + 4)

        # 播放头
        if 0 <= self._pos <= self._duration:
            p.setPen(QPen(QColor("#ffd166"), 1))
            p.drawLine(tx(self._pos), 2, tx(self._pos), H - 2)
        p.setPen(QColor("#9a9aa4"))
        p.drawText(12, H - 3, "画面")
        p.drawText(12, H - 17, "声音")
        p.end()

    def mousePressEvent(self, event) -> None:  # noqa: N802
        x = event.position().x()
        for a, b, key in self._hit:
            if a <= x <= b:
                self.eventClicked.emit(key)
                return
        x0, x1 = 12, max(13, self.width() - 12)
        self.seekRequested.emit((x - x0) / max(1, x1 - x0))

    def resizeEvent(self, event) -> None:  # noqa: N802
        self._update_duration()
        super().resizeEvent(event)


class GenerateDialog(QDialog):
    def __init__(self, out_dir: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle("生成测试短片")
        self._out_dir = out_dir
        v = QVBoxLayout(self)
        v.setSpacing(10)

        intro = QLabel(
            "程序会生成一段带编号闪画面 + 短提示声的短片, 并在旁边写出一份原计划 JSON。\n"
            "故障档位只改变实际片子的内容, 计划时刻始终是『原计划』。")
        intro.setWordWrap(True)
        intro.setStyleSheet("color:#55555d; font-size:12.5px;")
        v.addWidget(intro)

        grid = QGridLayout()
        grid.addWidget(QLabel("档位"), 0, 0)
        self._profile = QComboBox()
        for key, meta in generator.PROFILES.items():
            self._profile.addItem(f"{meta['title']} — {meta['desc']}", key)
        self._profile.currentIndexChanged.connect(self._update_desc)
        grid.addWidget(self._profile, 0, 1, 1, 2)

        self._desc = QLabel("")
        self._desc.setWordWrap(True)
        self._desc.setStyleSheet("color:#6b6b74; font-size:12px;")
        grid.addWidget(self._desc, 1, 1, 1, 2)

        grid.addWidget(QLabel("文件名"), 2, 0)
        self._name = QLineEdit("syncmark-test.mp4")
        grid.addWidget(self._name, 2, 1)
        self._btn_browse = QPushButton("选择位置…")
        self._btn_browse.clicked.connect(self._browse)
        grid.addWidget(self._btn_browse, 2, 2)

        grid.addWidget(QLabel("标记数量"), 3, 0)
        self._count = QSpinBox()
        self._count.setRange(1, model.MAX_MARKERS)
        self._count.setValue(model.DEFAULT_MARKER_COUNT)
        grid.addWidget(self._count, 3, 1)

        grid.addWidget(QLabel("帧率"), 3, 2)
        self._fps = QSpinBox()
        self._fps.setRange(12, 60)
        self._fps.setValue(model.DEFAULT_FPS)
        grid.addWidget(self._fps, 3, 3)

        grid.addWidget(QLabel("分辨率"), 4, 0)
        self._size = QComboBox()
        for w, h in ((640, 360), (960, 540), (1280, 720), (480, 270)):
            self._size.addItem(f"{w}×{h}", (w, h))
        grid.addWidget(self._size, 4, 1)

        grid.addWidget(QLabel("整体音频偏移 (ms)"), 4, 2)
        self._offset = QSpinBox()
        self._offset.setRange(-500, 500)
        self._offset.setSingleStep(10)
        grid.addWidget(self._offset, 4, 3)
        v.addLayout(grid)

        adv = QGroupBox("手工微调 (选择档位后仍可单独加减)")
        av = QGridLayout(adv)
        self._chk_missing = QCheckBox("首段画面+声音都缺失")
        self._chk_repeat = QCheckBox("重复一次同一编号")
        self._repeat_id = QSpinBox(); self._repeat_id.setRange(1, model.MAX_MARKERS)
        self._repeat_id.setValue(6)
        self._repeat_after = QSpinBox(); self._repeat_after.setRange(50, 2000)
        self._repeat_after.setSingleStep(50); self._repeat_after.setValue(350)
        self._repeat_after.setSuffix(" ms 后")
        self._chk_glitch = QCheckBox("插入一帧短暂重复帧")
        self._chk_trunc = QCheckBox("末尾刚好少一段")
        self._chk_zero = QCheckBox("首个标记就在第 0 帧")
        self._chk_shift = QCheckBox("个别事件单独偏移")
        self._shift_id = QSpinBox(); self._shift_id.setRange(1, model.MAX_MARKERS)
        self._shift_id.setValue(7)
        self._shift_v = QSpinBox(); self._shift_v.setRange(-1000, 1000)
        self._shift_v.setSingleStep(33); self._shift_v.setValue(133); self._shift_v.setSuffix(" ms 画面")
        self._shift_a = QSpinBox(); self._shift_a.setRange(-1000, 1000)
        self._shift_a.setSingleStep(10); self._shift_a.setValue(60); self._shift_a.setSuffix(" ms 声音")
        av.addWidget(self._chk_missing, 0, 0, 1, 2)
        av.addWidget(self._chk_glitch, 0, 2, 1, 2)
        av.addWidget(self._chk_trunc, 0, 4, 1, 2)
        av.addWidget(self._chk_zero, 0, 6, 1, 2)
        av.addWidget(self._chk_repeat, 1, 0)
        av.addWidget(self._repeat_id, 1, 1)
        av.addWidget(self._repeat_after, 1, 2)
        av.addWidget(self._chk_shift, 1, 3)
        av.addWidget(self._shift_id, 1, 4)
        av.addWidget(self._shift_v, 1, 5)
        av.addWidget(self._shift_a, 1, 6)
        v.addWidget(adv)

        row = QHBoxLayout()
        row.addStretch(1)
        self._btn_cancel = QPushButton("取消")
        self._btn_cancel.clicked.connect(self.reject)
        self._btn_ok = QPushButton("生成并回读")
        self._btn_ok.setDefault(True)
        self._btn_ok.clicked.connect(self._accept)
        row.addWidget(self._btn_cancel)
        row.addWidget(self._btn_ok)
        v.addLayout(row)

        self._update_desc()

    def _update_desc(self) -> None:
        key = self._profile.currentData()
        meta = generator.PROFILES.get(key, {})
        self._desc.setText(meta.get("desc", ""))
        opts = {k: v for k, v in meta.items() if k not in ("title", "desc")}
        self._chk_missing.setChecked(bool(opts.get("missing_first")))
        self._chk_repeat.setChecked(bool(opts.get("repeat_mid")))
        self._chk_glitch.setChecked(bool(opts.get("duplicate_glitch")))
        self._chk_trunc.setChecked(bool(opts.get("truncate_last")))
        self._chk_zero.setChecked(bool(opts.get("first_at_zero")))
        self._offset.setValue(int(round(float(opts.get("audio_offset_ms", 0.0)))))
        rep = opts.get("repeat_mid") or {}
        self._chk_repeat.setEnabled(True)
        self._repeat_id.setValue(int(rep.get("marker_id", self._repeat_id.value())))
        self._repeat_after.setValue(int(rep.get("after_ms", 350)))
        sh = opts.get("event_shift") or {}
        self._chk_shift.setChecked(bool(sh))
        if sh:
            self._shift_id.setValue(int(sh.get("marker_id", 7)))
            self._shift_v.setValue(int(round(float(sh.get("video_ms", 0.0)))))
            self._shift_a.setValue(int(round(float(sh.get("audio_ms", 0.0)))))
        base = key or "test"
        self._name.setText(f"syncmark-{base}.mp4")

    def _browse(self) -> None:
        path, _ = QFileDialog.getSaveFileName(
            self, "保存测试短片", os.path.join(self._out_dir, self._name.text()),
            "MP4 (*.mp4);;MOV (*.mov)")
        if path:
            self._out_dir = os.path.dirname(path)
            self._name.setText(os.path.basename(path))

    def _accept(self) -> None:
        name = self._name.text().strip() or "syncmark-test.mp4"
        if not os.path.splitext(name)[1]:
            name += ".mp4"
        path = name if os.path.isabs(name) else os.path.join(self._out_dir, name)
        if os.path.exists(path):
            r = QMessageBox.question(
                self, "覆盖?", f"{path}\n已存在, 要覆盖吗?\n(旁边的计划 JSON 也会一起更新)")
            if r != QMessageBox.Yes:
                return
        self._result_path = path
        self.accept()

    def options(self) -> dict[str, Any]:
        # 不把档位名传下去: 勾选框已按档位预填, 它才是唯一的真实来源,
        # 否则"选择档位后取消勾选"会被档位默认值覆盖回来.
        opts: dict[str, Any] = {
            "out_path": getattr(self, "_result_path", None) or self._name.text(),
            "marker_count": self._count.value(),
            "fps": self._fps.value(),
        }
        size = self._size.currentData()
        if size:
            opts["width"], opts["height"] = size
        if self._chk_missing.isChecked():
            opts["missing_first"] = True
        if self._chk_repeat.isChecked():
            opts["repeat_mid"] = {"marker_id": self._repeat_id.value(),
                                  "after_ms": self._repeat_after.value()}
        if self._chk_glitch.isChecked():
            opts["duplicate_glitch"] = True
        if self._chk_trunc.isChecked():
            opts["truncate_last"] = True
        if self._chk_zero.isChecked():
            opts["first_at_zero"] = True
        if self._chk_shift.isChecked():
            opts["event_shift"] = {"marker_id": self._shift_id.value(),
                                   "video_ms": float(self._shift_v.value()),
                                   "audio_ms": float(self._shift_a.value())}
        if self._offset.value():
            opts["audio_offset_ms"] = float(self._offset.value())
        return opts
