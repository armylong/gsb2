"""主窗口：播放/逐帧/框选/示波/范围切换/对照快照/导出。

管线：
    DecodeWorker(QThread)  —— 按需从帧源取 YUV 帧（带代数编号，换源后丢弃旧帧）
    AnalysisTask(QThreadPool) —— YUV->RGB、波形、分量、压边界统计
    主线程 —— 只展示“最新完成”的分析；示波图始终标注读数对应帧号，
              播放过快时旧读数不会被当成新帧。
"""
from __future__ import annotations

import json
import sys
import threading

from PySide6.QtCore import QObject, QRect, QRunnable, QThread, QThreadPool, QTimer, Signal
from PySide6.QtWidgets import (
    QApplication, QComboBox, QFileDialog, QHBoxLayout, QLabel, QMainWindow,
    QPlainTextEdit, QPushButton, QSpinBox, QSplitter, QVBoxLayout, QWidget,
)

from .analysis import analyze_frame, pixels_at
from .colorutil import RANGE_LABELS
from .sources import FFmpegSource, SyntheticSource
from .widgets import (
    ScopeWidget, VideoWidget, parade_to_qimage, rgb_to_qimage,
    waveform_to_qimage,
)

SCOPE_W = 512  # 示波图内部分析分辨率（列）


# ---------------------------------------------------------------- 工作线程

class DecodeWorker(QObject):
    frameReady = Signal(int, int, object)   # gen, idx, (Y,U,V)
    failed = Signal(int, str)               # gen, message

    def __init__(self, lock: threading.Lock):
        super().__init__()
        self.source = None
        self.lock = lock

    def request(self, gen: int, idx: int):
        src = self.source
        if src is None:
            return
        try:
            with self.lock:
                f = src.frame(idx)
            self.frameReady.emit(gen, idx, f)
        except Exception as e:  # noqa: BLE001
            self.failed.emit(gen, str(e))


class AnalysisSignals(QObject):
    done = Signal(int, int, object)  # gen, idx, result dict


class AnalysisTask(QRunnable):
    def __init__(self, gen, idx, planes, rng, roi, signals):
        super().__init__()
        self.gen, self.idx, self.planes = gen, idx, planes
        self.rng, self.roi, self.signals = rng, roi, signals

    def run(self):
        Y, U, V = self.planes
        res = analyze_frame(Y, U, V, self.rng, self.roi, SCOPE_W)
        self.signals.done.emit(self.gen, self.idx, res)


# ---------------------------------------------------------------- 主窗口

class MainWindow(QMainWindow):
    decodeRequested = Signal(int, int)  # gen, idx（跨线程发给 DecodeWorker）

    def __init__(self):
        super().__init__()
        self.setWindowTitle("视频示波器 (SDR)")
        self.resize(1280, 800)

        self._decode_lock = threading.Lock()
        self._worker = DecodeWorker(self._decode_lock)
        self._thread = QThread(self)
        self._worker.moveToThread(self._thread)
        self.decodeRequested.connect(self._worker.request)
        self._worker.frameReady.connect(self._on_frame)
        self._worker.failed.connect(self._on_decode_failed)
        self._thread.start()

        self._pool = QThreadPool(self)
        self._signals = AnalysisSignals()
        self._signals.done.connect(self._on_analysis)

        self.source = None
        self._gen = 0
        self._playing = False
        self._decode_busy = False
        self._decode_pos = 0          # 播放/解码目标位置
        self._latest = None           # (idx, planes) 待分析的最新帧
        self._analysis_busy = False
        self._cur_idx = -1            # 当前画面/读数对应帧
        self._cur_planes = None
        self._cur_result = None
        self._roi = None              # (x0,y0,x1,y1) 全图坐标
        self._snapshot = None         # dict(idx, wf_img, parade_img, report)

        self._build_ui()
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)

    # ------------------------------------------------------------ UI
    def _build_ui(self):
        tb = QHBoxLayout()
        self.btn_open = QPushButton("打开短片…")
        self.btn_open.clicked.connect(self._open_file)
        tb.addWidget(self.btn_open)
        for kind, label in (("bars", "内置彩条"), ("blueramp", "样片:偏蓝灰阶"),
                            ("overflow", "样片:局部溢出")):
            b = QPushButton(label)
            b.clicked.connect(lambda _=False, k=kind: self._open_synthetic(k))
            tb.addWidget(b)
        tb.addSpacing(12)
        tb.addWidget(QLabel("范围:"))
        self.combo_range = QComboBox()
        self.combo_range.addItems(["自动(按文件声明)", RANGE_LABELS["tv"],
                                   RANGE_LABELS["pc"]])
        self.combo_range.currentIndexChanged.connect(self._on_range_changed)
        tb.addWidget(self.combo_range)
        self.lbl_declared = QLabel("声明: —")
        tb.addWidget(self.lbl_declared)
        tb.addStretch(1)

        pb = QHBoxLayout()
        self.btn_play = QPushButton("播放")
        self.btn_play.clicked.connect(self._toggle_play)
        self.btn_prev = QPushButton("◀ 上一帧")
        self.btn_prev.clicked.connect(lambda: self._step(-1))
        self.btn_next = QPushButton("下一帧 ▶")
        self.btn_next.clicked.connect(lambda: self._step(1))
        self.spin_frame = QSpinBox()
        self.spin_frame.setPrefix("帧 ")
        self.btn_jump = QPushButton("跳转")
        self.btn_jump.clicked.connect(lambda: self._seek(self.spin_frame.value()))
        self.btn_clear_roi = QPushButton("清除框选")
        self.btn_clear_roi.clicked.connect(self._clear_roi)
        self.btn_snap = QPushButton("保留读数作对照")
        self.btn_snap.clicked.connect(self._take_snapshot)
        self.btn_export = QPushButton("导出指定帧…")
        self.btn_export.clicked.connect(self._export)
        for w in (self.btn_play, self.btn_prev, self.btn_next, self.spin_frame,
                  self.btn_jump, self.btn_clear_roi, self.btn_snap,
                  self.btn_export):
            pb.addWidget(w)
        pb.addStretch(1)
        self.lbl_frame = QLabel("—")
        pb.addWidget(self.lbl_frame)

        self.video = VideoWidget()
        self.video.roiSelected.connect(self._on_roi)

        right = QWidget()
        rl = QVBoxLayout(right)
        self.lbl_scope = QLabel("示波读数对应帧: —")
        rl.addWidget(self.lbl_scope)
        rl.addWidget(QLabel("亮度波形 (Y)"))
        self.scope_luma = ScopeWidget("luma")
        self.scope_luma.clicked.connect(self._on_scope_click)
        rl.addWidget(self.scope_luma, 1)
        rl.addWidget(QLabel("RGB 三通道分量"))
        self.scope_parade = ScopeWidget("parade")
        self.scope_parade.clickedParade.connect(self._on_parade_click)
        rl.addWidget(self.scope_parade, 1)
        rl.addWidget(QLabel("关键计数 (压边界/越界)"))
        self.report = QPlainTextEdit()
        self.report.setReadOnly(True)
        self.report.setMaximumBlockCount(200)
        rl.addWidget(self.report, 1)

        split = QSplitter()
        split.addWidget(self.video)
        split.addWidget(right)
        split.setStretchFactor(0, 3)
        split.setStretchFactor(1, 2)

        root = QWidget()
        lay = QVBoxLayout(root)
        lay.addLayout(tb)
        lay.addLayout(pb)
        lay.addWidget(split, 1)
        self.setCentralWidget(root)
        self.statusBar().showMessage("就绪")

    # ------------------------------------------------------------ 帧源
    def _set_source(self, src):
        self._pause()
        self._gen += 1
        if self.source is not None:
            try:
                self.source.close()
            except Exception:
                pass
        self.source = src
        self._worker.source = src
        self._latest = None
        self._cur_idx = -1
        self._cur_planes = None
        self._cur_result = None
        self._roi = None
        self._snapshot = None
        self.video.set_roi(None)
        self.video.set_highlight(None)
        self.scope_luma.set_snapshot(None)
        self.scope_parade.set_snapshot(None)
        self.spin_frame.setMaximum(max(0, src.n_frames - 1))
        declared = {None: "缺失(可按有限处理或手动选择)",
                    "tv": "有限范围", "pc": "全范围"}[src.declared_range]
        self.lbl_declared.setText(f"声明: {declared}")
        self.setWindowTitle(f"视频示波器 (SDR) — {src.title}")
        self._timer.setInterval(max(10, int(1000.0 / src.fps)))
        self._seek(0)

    def _open_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self, "打开本地短片", "", "视频文件 (*.mp4 *.mov *.mkv *.avi *.m4v *.webm);;所有文件 (*)")
        if not path:
            return
        try:
            self._set_source(FFmpegSource(path))
        except Exception as e:  # noqa: BLE001
            self.statusBar().showMessage(f"打开失败: {e}")

    def _open_synthetic(self, kind):
        self._set_source(SyntheticSource(kind))

    # ------------------------------------------------------------ 播放控制
    def _toggle_play(self):
        if self.source is None:
            return
        self._playing = not self._playing
        self.btn_play.setText("暂停" if self._playing else "播放")
        if self._playing:
            self._timer.start()
        else:
            self._timer.stop()

    def _pause(self):
        self._playing = False
        self.btn_play.setText("播放")
        self._timer.stop()

    def _tick(self):
        if self.source is None or self._decode_busy:
            return  # 解码跟不上就丢拍，不排队积压
        nxt = self._decode_pos + 1
        if self.source.n_frames and nxt >= self.source.n_frames:
            self._pause()
            return
        self._request(nxt)

    def _step(self, d):
        if self.source is None:
            return
        self._pause()
        self._request(self._decode_pos + d)

    def _seek(self, idx):
        if self.source is None:
            return
        self._pause()
        self._request(idx)

    def _request(self, idx):
        if self.source is None or self._decode_busy:
            return
        idx = max(0, min(idx, (self.source.n_frames or idx + 1) - 1))
        self._decode_busy = True
        self._decode_pos = idx
        self.decodeRequested.emit(self._gen, idx)

    # ------------------------------------------------------------ 解码回调
    def _on_frame(self, gen, idx, planes):
        if gen != self._gen:
            return
        self._decode_busy = False
        self._latest = (idx, planes)
        self._maybe_analyze()
        self._update_frame_label()

    def _on_decode_failed(self, gen, msg):
        if gen != self._gen:
            return
        self._decode_busy = False
        self.statusBar().showMessage(f"解码失败: {msg}")

    # ------------------------------------------------------------ 分析
    def _rng(self) -> str:
        i = self.combo_range.currentIndex()
        if i == 1:
            return "tv"
        if i == 2:
            return "pc"
        return self.source.declared_range or "tv"  # 自动：缺失按有限

    def _maybe_analyze(self, force=False):
        if self._analysis_busy or self._latest is None:
            return
        idx, planes = self._latest
        if not force and idx == self._cur_idx:
            return
        self._analysis_busy = True
        self._pool.start(AnalysisTask(self._gen, idx, planes,
                                      self._rng(), self._roi, self._signals))

    def _on_analysis(self, gen, idx, res):
        if gen != self._gen:
            return
        self._analysis_busy = False
        self._cur_idx = idx
        self._cur_planes = self._latest[1] if self._latest else None
        self._cur_result = res
        R, G, B = res["rgb"]
        self.video.set_frame(rgb_to_qimage(R, G, B))
        fw = self.source.width
        self.scope_luma.set_scope(waveform_to_qimage(res["waveform"]), fw)
        self.scope_parade.set_scope(
            parade_to_qimage(res["parade"], SCOPE_W), fw)
        self._show_report(idx, res["report"])
        self._update_frame_label()
        # 若播放中又有更新的帧到达，继续分析（读数帧号始终如实标注）
        self._maybe_analyze()

    def _update_frame_label(self):
        if self.source is None:
            return
        total = self.source.n_frames or "?"
        self.lbl_frame.setText(
            f"解码位置 {self._decode_pos} / {total}")
        if self._cur_idx >= 0:
            lag = self._decode_pos - self._cur_idx
            txt = f"示波读数对应帧: {self._cur_idx}"
            if lag > 0:
                txt += f"  (画面落后 {lag} 帧, 读数仍属第 {self._cur_idx} 帧)"
                self.lbl_scope.setStyleSheet("color: #e0a030;")
            else:
                self.lbl_scope.setStyleSheet("")
            self.lbl_scope.setText(txt)

    # ------------------------------------------------------------ 报告
    def _show_report(self, idx, rep):
        rng_label = RANGE_LABELS[rep["range"]]
        roi_txt = ("全图" if self._roi is None
                   else f"ROI {self._roi} (全图坐标)")
        lines = [
            f"帧 {idx} | {rng_label} | {roi_txt}",
            f"Y min/max/mean: {rep['y_min']} / {rep['y_max']} / {rep['y_mean']}",
            f"暗部压边界 Y≤{rep['range_lo']+1}: {rep['shadow_crush_px']} px "
            f"({rep['shadow_crush_pct']}%)",
            f"亮部压边界 Y≥{rep['range_hi']-1}: {rep['highlight_crush_px']} px "
            f"({rep['highlight_crush_pct']}%)",
            f"越出合法范围: 低于{rep['range_lo']} {rep['below_legal_px']} px, "
            f"高于{rep['range_hi']} {rep['above_legal_px']} px",
            f"R 顶格0/255: {rep['r_clip_lo_px']}/{rep['r_clip_hi_px']}  "
            f"G: {rep['g_clip_lo_px']}/{rep['g_clip_hi_px']}  "
            f"B: {rep['b_clip_lo_px']}/{rep['b_clip_hi_px']}",
        ]
        if self._snapshot is not None:
            s = self._snapshot["report"]
            lines.append(f"— 对照帧 {self._snapshot['idx']}: "
                         f"暗部 {s['shadow_crush_pct']}%  "
                         f"亮部 {s['highlight_crush_pct']}%  "
                         f"Ymean {s['y_mean']}")
        self.report.setPlainText("\n".join(lines))

    # ------------------------------------------------------------ 框选/点击
    def _on_roi(self, roi):
        self._roi = roi
        self.video.set_roi(None if roi is None else QRect(
            roi[0], roi[1], roi[2] - roi[0], roi[3] - roi[1]))
        self.video.set_highlight(None)
        if roi is None:
            self.statusBar().showMessage("已清除框选，统计全图")
        else:
            self.statusBar().showMessage(
                f"框选 {roi}（示波 x 轴仍为全图坐标）")
        self._reanalyze()

    def _clear_roi(self):
        self.video.set_roi(None)
        self._on_roi(None)

    def _reanalyze(self):
        """范围/ROI 变化后，对当前帧重新分析。"""
        if self._cur_planes is not None:
            self._latest = (self._cur_idx, self._cur_planes)
            self._cur_idx = -1
            self._maybe_analyze()

    def _on_scope_click(self, fx, level):
        self._highlight(fx, level, plane_idx=None)

    def _on_parade_click(self, ch, fx, level):
        self._highlight(fx, level, plane_idx=ch)

    def _highlight(self, fx, level, plane_idx):
        if self._cur_planes is None or self._cur_result is None:
            return
        if plane_idx is None:
            plane = self._cur_planes[0]
            what = f"Y={level}"
        else:
            plane = self._cur_result["rgb"][plane_idx]
            what = f"{'RGB'[plane_idx]}={level}"
        mask = pixels_at(plane, fx, level, self._roi)
        self.video.set_highlight(mask)
        n = int(mask.sum())
        scope = "选区内" if self._roi else "全图"
        self.statusBar().showMessage(
            f"反查: {scope}列 {fx}±3, {what}±3 → {n} 个像素已高亮")

    # ------------------------------------------------------------ 范围切换
    def _on_range_changed(self):
        if self.source is None:
            return
        rng = self._rng()
        self._reanalyze()
        if self._cur_result is not None:
            rep = self._cur_result["report"]
            lo, hi = rep["range_lo"], rep["range_hi"]
            self.statusBar().showMessage(
                f"已切换为{RANGE_LABELS[rng]}解释: "
                f"亮部压边界(Y≥{hi-1}) {rep['highlight_crush_px']} px, "
                f"暗部压边界(Y≤{lo+1}) {rep['shadow_crush_px']} px")

    # ------------------------------------------------------------ 对照快照
    def _take_snapshot(self):
        if self._cur_result is None:
            self.statusBar().showMessage("还没有可保留的读数")
            return
        res = self._cur_result
        self._snapshot = {
            "idx": self._cur_idx,
            "wf_img": waveform_to_qimage(res["waveform"], (255, 170, 60)),
            "parade_img": parade_to_qimage(res["parade"], SCOPE_W),
            "report": res["report"],
        }
        label = f"对照: 第 {self._cur_idx} 帧"
        self.scope_luma.set_snapshot(self._snapshot["wf_img"], label)
        self.scope_parade.set_snapshot(self._snapshot["parade_img"], label)
        self._show_report(self._cur_idx, res["report"])
        self.statusBar().showMessage(f"已保留第 {self._cur_idx} 帧读数作对照")

    # ------------------------------------------------------------ 导出
    def _export(self):
        if self.source is None:
            return
        k = self.spin_frame.value()
        out_dir = QFileDialog.getExistingDirectory(self, "选择导出目录")
        if not out_dir:
            return
        self._pause()
        rng = self._rng()
        try:
            with self._decode_lock:  # 与解码线程互斥，直接取指定帧
                planes = self.source.frame(k)
        except Exception as e:  # noqa: BLE001
            self.statusBar().showMessage(f"读取第 {k} 帧失败: {e}")
            return
        Y, U, V = planes
        res = analyze_frame(Y, U, V, rng, self._roi, 1024)
        stem = f"{out_dir}/frame_{k:06d}"
        R, G, B = res["rgb"]
        rgb_to_qimage(R, G, B).save(f"{stem}.png")
        waveform_to_qimage(res["waveform"]).save(f"{stem}_waveform.png")
        parade_to_qimage(res["parade"], 1024).save(f"{stem}_parade.png")
        payload = {
            "source": self.source.title,
            "frame": k,
            "range_mode": rng,
            "range_declared": self.source.declared_range,
            "roi_full_frame_coords": self._roi,
            "report": res["report"],
        }
        with open(f"{stem}_report.json", "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        self.statusBar().showMessage(
            f"已导出第 {k} 帧: 画面/波形/分量 PNG + report.json → {out_dir}")

    # ------------------------------------------------------------ 收尾
    def closeEvent(self, e):
        self._pause()
        if self.source is not None:
            try:
                self.source.close()
            except Exception:
                pass
        self._thread.quit()
        self._thread.wait(2000)
        super().closeEvent(e)


def main():
    app = QApplication(sys.argv)
    w = MainWindow()
    w.show()
    sys.exit(app.exec())


if __name__ == "__main__":
    main()
