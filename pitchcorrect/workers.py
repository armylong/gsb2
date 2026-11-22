"""后台线程: 参考分析与校正重采样都不短, 放 QThread 里避免界面卡死。"""
from __future__ import annotations

import numpy as np
from PySide6.QtCore import QThread, Signal

from .dsp import (analyze_reference, find_gaps, build_correction,
                  resample_correct, uncorrected_intervals, detect_events)


class AnalysisWorker(QThread):
    finished_ok = Signal(object, object)     # ReferenceAnalysis, list[Gap]
    failed = Signal(str)

    def __init__(self, ref: np.ndarray, sr: int, f_nom: float,
                 level_db: float, snr_db: float, purity: float):
        super().__init__()
        self._ref, self._sr = ref, sr
        self._f_nom = f_nom
        self._level_db, self._snr_db, self._purity = level_db, snr_db, purity

    def run(self):
        try:
            an = analyze_reference(self._ref, self._sr, self._f_nom,
                                   level_db_thresh=self._level_db,
                                   snr_db_thresh=self._snr_db,
                                   purity_thresh=self._purity)
            gaps = find_gaps(an)
            self.finished_ok.emit(an, gaps)
        except Exception as exc:  # noqa: BLE001 - 回传界面显示
            self.failed.emit(f"{type(exc).__name__}: {exc}")


class CorrectionWorker(QThread):
    finished_ok = Signal(dict)
    failed = Signal(str)

    def __init__(self, content, sr, an, gaps, params: dict):
        super().__init__()
        self._content, self._sr = content, sr
        self._an, self._gaps = an, gaps
        self._p = params

    def run(self):
        try:
            p = self._p
            curve = build_correction(
                self._an, self._gaps,
                slow_tau_s=p["slow_tau"], fast_tau_s=p["fast_tau"],
                fast_amount=p["fast_amount"],
                bridge_short=p["bridge_short"], edge_mode=p["edge_mode"])
            uncorr = uncorrected_intervals(
                self._an, self._gaps, p["bridge_short"], p["edge_mode"],
                self._content.size / self._sr)
            corr = resample_correct(
                self._content, self._sr, curve["frame_time"],
                curve["dev_total"], curve["valid_curve"], uncorr)
            events_before = detect_events(self._content, self._sr)
            events_after = detect_events(corr["out"], self._sr)
            self.finished_ok.emit({
                "curve": curve, "corr": corr, "uncorr": uncorr,
                "events_before": events_before,
                "events_after": events_after,
            })
        except Exception as exc:  # noqa: BLE001
            self.failed.emit(f"{type(exc).__name__}: {exc}")
