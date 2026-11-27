"""导出不变性与 wav 往返测试。"""

import csv
import math
import os
import sys
import tempfile
import unittest

import numpy as np
from scipy.io import wavfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitch_lab.analysis import AnalysisParams, analyze
from pitch_lab.exporter import CSV_HEADER, export_segment_csv
from pitch_lab.signals import make_gap_noise, make_steady
from pitch_lab.wavio import load_wav


class TestExportAndWav(unittest.TestCase):
    def test_export_times_are_real_seconds_and_a4_independent(self):
        s = make_steady()
        r = analyze(s.x, s.fs, AnalysisParams())
        with tempfile.TemporaryDirectory() as d:
            p1 = os.path.join(d, "a440.csv")
            p2 = os.path.join(d, "a442.csv")
            n1 = export_segment_csv(p1, r, 0.2, 1.0, 440.0)
            n2 = export_segment_csv(p2, r, 0.2, 1.0, 442.0)
            self.assertEqual(n1, n2)
            with open(p1, encoding="utf-8-sig") as f1, \
                 open(p2, encoding="utf-8-sig") as f2:
                rows1 = list(csv.reader(f1))
                rows2 = list(csv.reader(f2))
            self.assertEqual(rows1[0], CSV_HEADER)
            # 真实秒与 Hz 列完全一致；仅音名/音分参考列允许变化
            for a, b in zip(rows1[1:], rows2[1:]):
                self.assertEqual(a[0], b[0])   # time_sec
                self.assertEqual(a[1], b[1])   # freq_hz
                self.assertEqual(a[2], b[2])   # freq_est_hz
                self.assertEqual(a[5], b[5])   # confidence
            times = [float(row[0]) for row in rows1[1:]]
            self.assertTrue(all(0.2 - 1e-9 <= t <= 1.0 + 1e-9 for t in times))

    def test_export_keeps_gap_and_candidates(self):
        s = make_gap_noise()
        r = analyze(s.x, s.fs, AnalysisParams())
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "gap.csv")
            export_segment_csv(path, r, 0.0, 2.3, 440.0)
            with open(path, encoding="utf-8-sig") as fh:
                rows = list(csv.DictReader(fh))
            gap_rows = [row for row in rows
                        if 0.85 < float(row["time_sec"]) < 1.35]
            self.assertTrue(any(row["freq_hz"] == "" for row in gap_rows))
            # 争议/正常帧都带备选列
            cand_rows = [row for row in rows if row["candidates_hz"]]
            self.assertGreater(len(cand_rows), 10)
            for row in cand_rows:
                self.assertEqual(len(row["candidates_hz"].split("|")),
                                 len(row["candidates_scores"].split("|")))

    def test_wav_roundtrip(self):
        s = make_steady()
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "t.wav")
            pcm = (s.x * 32767).astype(np.int16)
            wavfile.write(path, s.fs, pcm)
            x, fs = load_wav(path)
            self.assertEqual(fs, s.fs)
            self.assertEqual(x.ndim, 1)
            self.assertLess(np.max(np.abs(x - s.x)), 0.01)


if __name__ == "__main__":
    unittest.main()
