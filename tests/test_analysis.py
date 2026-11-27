"""分析算法测试：精度、缺口、不确定、八度候选、A4 无关性。"""

import math
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from pitch_lab import notes
from pitch_lab.analysis import AnalysisParams, analyze
from pitch_lab.signals import (
    make_gap_noise, make_glissando, make_reappearance, make_steady,
    make_weak_fundamental,
)


class TestPitchAnalysis(unittest.TestCase):
    def setUp(self):
        # 测试用稍紧的默认参数
        self.params = AnalysisParams()

    def test_steady_tone_accuracy(self):
        s = make_steady()
        r = analyze(s.x, s.fs, self.params)
        mid = (r.times > 0.3) & (r.times < 1.4)
        rel = r.reliable & mid
        self.assertGreater(rel.sum(), 50)
        true_f = s.references[0].f0
        err = np.median(np.abs(r.f0[rel] - true_f)) / true_f
        self.assertLess(err, 0.01)  # 误差小于 1%

    def test_glissando_tracks_continuous_truth(self):
        s = make_glissando()
        r = analyze(s.x, s.fs, self.params)
        rel = r.reliable
        self.assertGreater(rel.sum(), 100)
        ref = s.references[0]
        truth = ref.f0 * (ref.f1 / ref.f0) ** (r.times / 2.0)
        err = np.abs(r.f0[rel] - truth[rel]) / truth[rel]
        self.assertLess(np.median(err), 0.02)
        # 滑音整体应上行
        good = np.where(rel)[0]
        self.assertGreater(np.nanmedian(r.f0[good][-20:]),
                           np.nanmedian(r.f0[good][:20]))

    def test_noise_gap_is_nan_not_connected(self):
        s = make_gap_noise()
        r = analyze(s.x, s.fs, self.params)
        gap = (r.times > 0.85) & (r.times < 1.35)
        # 噪声段绝大多数帧不可靠
        self.assertLess(r.reliable[gap].mean(), 0.25)
        self.assertTrue(np.isnan(r.f0[gap]).mean() > 0.75)
        # 缺口两侧的可靠段都存在（没有被整段吞掉）
        left = r.reliable & (r.times < 0.75)
        right = r.reliable & (r.times > 1.45)
        self.assertGreater(left.sum(), 20)
        self.assertGreater(right.sum(), 20)
        # f0 数组里确实含 NaN —— 绘图据此留缺口
        self.assertTrue(np.isnan(r.f0).any())

    def test_silence_gap_between_notes(self):
        s = make_reappearance()
        r = analyze(s.x, s.fs, self.params)
        gap = (r.times > 0.75) & (r.times < 1.15)
        self.assertTrue(np.isnan(r.f0[gap]).all())
        g4 = r.reliable & (r.times < 0.65)
        e4 = r.reliable & (r.times > 1.3)
        self.assertAlmostEqual(np.median(r.f0[g4]), 392.0, delta=6.0)
        self.assertAlmostEqual(np.median(r.f0[e4]), 329.63, delta=6.0)

    def test_onset_marked_uncertain(self):
        s = make_steady()
        r = analyze(s.x, s.fs, self.params)
        head = r.times < 0.06
        self.assertTrue(r.frames[np.where(head)[0][0]].is_onset)

    def test_weak_fundamental_octave_candidates(self):
        s = make_weak_fundamental()
        r = analyze(s.x, s.fs, self.params)
        mid = (r.times > 0.4) & (r.times < 1.2)
        idxs = np.where(mid)[0]
        # 至少有一帧的候选里同时出现接近 f0 和 2f0 的两个频率
        found = False
        for i in idxs:
            freqs = sorted(c.freq for c in r.frames[i].candidates)
            if any(abs(f - 196.0) / 196.0 < 0.03 for f in freqs) and \
               any(abs(f - 392.0) / 392.0 < 0.03 for f in freqs):
                found = True
                break
        self.assertTrue(found, "弱基频样例应同时给出基频与高八度备选")
        # 主判断若可靠，应落在真实基频附近而不是直接跳八度
        rel_mid = r.reliable & mid
        if rel_mid.any():
            self.assertAlmostEqual(np.median(r.f0[rel_mid]), 196.0, delta=25.0)

    def test_a4_does_not_change_hz(self):
        s = make_steady()
        r1 = analyze(s.x, s.fs, AnalysisParams())
        r2 = analyze(s.x, s.fs, AnalysisParams())
        # 分析层完全不接收 A4：两次结果逐位一致
        np.testing.assert_array_equal(r1.f0, r2.f0)
        # 显示层：同一频率在不同 A4 下音名/绝对音高位置变化，Hz 不变
        f = 443.06
        n1 = notes.freq_to_note_name(f, 440.0)
        n2 = notes.freq_to_note_name(f, 415.0)
        self.assertNotEqual(n1, n2)
        m1 = float(notes.freq_to_midi(f, 440.0))
        m2 = float(notes.freq_to_midi(f, 415.0))
        # A4 基准移动 25 Hz，同一频率的相对 MIDI 位置应明显移动
        self.assertGreater(abs(m1 - m2), 1.0)
        # 而相对最近半音的 cent 偏差仍在正常范围
        self.assertLess(abs(float(notes.cents_from_nearest(f, 440.0))), 50.0)

    def test_analysis_range_respected(self):
        s = make_steady()  # 443 Hz
        # 把上限压到 300 Hz，443 Hz 不应作为可靠结果出现
        p = AnalysisParams(fmin=65, fmax=300)
        r = analyze(s.x, s.fs, p)
        finite = r.f0[np.isfinite(r.f0)]
        self.assertTrue(np.all(finite <= 300.0))


if __name__ == "__main__":
    unittest.main()
