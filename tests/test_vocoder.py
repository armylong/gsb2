"""关键不变量测试: 接点、静音、时长对齐、频带时序、不混回原人声。

直接用标准库 unittest 跑:  .venv/bin/python -I -m unittest -v
"""
import unittest

import numpy as np

from band_vocoder import INTERNAL_SR
from band_vocoder.audio_io import (fit_modulator, loop_carrier,
                                   normalize_loudness)
from band_vocoder.synth import (alternating_band_modulator,
                                build_filterbank, erb_edges, filter_bank,
                                follow_envelopes, harmonic_carrier,
                                sine_carrier, vocode)


class TestLoopCarrier(unittest.TestCase):
    def test_loop_junction_is_smooth(self):
        """循环接点(淡化区内部)相邻采样差不能超过信号本身最大跳变。"""
        sr = INTERNAL_SR
        fade_s = 0.02
        base = harmonic_carrier(0.37, sr, f0=137.0, n_harmonics=10)
        out = loop_carrier(base, int(sr * 2.5), sr, fade_s=fade_s)
        n = len(base)
        fade_len = int(sr * fade_s)
        natural_step = np.max(np.abs(np.diff(base)))
        # 接点在淡化区中央附近, 那里两段权重都非零, 是最严的位置
        for junction in (n, 2 * n):
            probe = junction - fade_len // 2
            if 0 < probe < len(out):
                step = abs(out[probe] - out[probe - 1])
                self.assertLess(step, natural_step + 1e-9)

    def test_short_carrier_truncates_and_fades(self):
        sr = INTERNAL_SR
        base = sine_carrier(3.0, sr)
        out = loop_carrier(base, int(0.5 * sr), sr)
        self.assertEqual(len(out), int(0.5 * sr))
        self.assertTrue(np.all(np.isfinite(out)))
        # 首尾淡化: 端点接近零
        self.assertLess(abs(out[0]), 0.05)
        self.assertLess(abs(out[-1]), 0.05)


class TestDurationModes(unittest.TestCase):
    def test_fit_modulator_pads_and_truncates(self):
        x = np.ones(100)
        padded = fit_modulator(x, 150)
        self.assertEqual(len(padded), 150)
        np.testing.assert_array_equal(padded[:100], x)
        np.testing.assert_array_equal(padded[100:], np.zeros(50))
        cut = fit_modulator(x, 40)
        self.assertEqual(len(cut), 40)
        np.testing.assert_array_equal(cut, np.ones(40))


class TestEnvelopeAndSilence(unittest.TestCase):
    def test_gate_closes_on_silence(self):
        """调制声中间的真静音必须让包络归零, 不被 release 拖尾巴。"""
        sr = 8000
        t = np.arange(sr) / sr
        x = np.concatenate([
            np.sin(2 * np.pi * 440 * t[: sr // 2]),
            np.zeros(sr // 2),
        ])
        sos, _ = build_filterbank(4, sr)
        bands = filter_bank(x, sos)
        env = follow_envelopes(bands, sr, attack_ms=10, release_ms=120)
        silent_part = env[:, int(0.75 * sr):]
        np.testing.assert_array_equal(silent_part, np.zeros_like(silent_part))

    def test_envelope_is_nonnegative(self):
        sr = INTERNAL_SR
        x = alternating_band_modulator(1.0, sr, n_bands=6)
        sos, _ = build_filterbank(6, sr)
        env = follow_envelopes(filter_bank(x, sos), sr, 5, 40)
        self.assertTrue(np.all(env >= 0))


class TestFilterbank(unittest.TestCase):
    def test_erb_edges_monotonic_in_range(self):
        for n in (1, 4, 16, 32):
            edges = erb_edges(n, INTERNAL_SR)
            self.assertEqual(len(edges), n + 1)
            self.assertTrue(np.all(np.diff(edges) > 0))

    def test_band_count_matches(self):
        sos_list, edges = build_filterbank(10, INTERNAL_SR)
        self.assertEqual(len(sos_list), 10)
        bands = filter_bank(np.zeros(INTERNAL_SR), sos_list)
        self.assertEqual(bands.shape, (10, INTERNAL_SR))


class TestVocoder(unittest.TestCase):
    def _alternating_demo(self, n_bands=8, seg=0.2):
        sr = INTERNAL_SR
        total = (2 * n_bands + 1) * seg + 0.05
        mod = alternating_band_modulator(total, sr, n_bands, seg)
        car = harmonic_carrier(total, sr, f0=110, n_harmonics=80)
        return mod, car, sr, n_bands, seg

    def test_silence_window_preserved(self):
        mod, car, sr, nb, seg = self._alternating_demo()
        res = vocode(mod, car, sr, nb, 10, 60)
        n_seg = int(round(seg * sr))
        a, b = nb * n_seg, (nb + 1) * n_seg
        silent_out = res["output"][a:b]
        # 与发声窗能量相比, 静音窗低 40dB 以上
        voiced = res["output"][:n_seg]
        self.assertLess(np.sqrt(np.mean(silent_out ** 2)),
                        0.01 * np.sqrt(np.mean(voiced ** 2)))

    def test_band_timing_tracks_modulator(self):
        mod, car, sr, nb, seg = self._alternating_demo(12)
        res = vocode(mod, car, sr, nb, 10, 60)
        sos, _ = build_filterbank(nb, sr)
        out_bands = filter_bank(res["output"], sos)
        n_seg = int(round(seg * sr))
        expected = list(range(nb)) + [-1] + list(range(nb - 1, -1, -1))
        for win, expect in enumerate(expected):
            a, b = win * n_seg, min((win + 1) * n_seg, len(mod))
            rms = np.sqrt(np.mean(out_bands[:, a:b] ** 2, axis=1))
            if expect >= 0:
                self.assertLessEqual(abs(int(np.argmax(rms)) - expect), 1)

    def test_dead_carrier_bands_stay_silent(self):
        """单频载波没有能量的频带, 输出在任何时刻都不能有该带内容。"""
        mod, _, sr, nb, seg = self._alternating_demo()
        car = sine_carrier(len(mod) / sr, sr, freq=220)
        res = vocode(mod, car, sr, nb, 10, 60)
        dead = res["carrier_energy"] < 0.01 * res["carrier_energy"].max()
        for i in range(nb):
            if dead[i]:
                peak = np.max(np.abs(res["band_outputs"][i]))
                self.assertLess(peak,
                                0.1 * np.max(np.abs(res["band_outputs"])))

    def test_output_contains_no_direct_modulator(self):
        """输出只由载波分带构成: 把载波全置零后输出必须严格为零。"""
        mod, car, sr, nb, _ = self._alternating_demo()
        res = vocode(mod, np.zeros_like(car), sr, nb, 10, 60)
        np.testing.assert_array_equal(res["output"], np.zeros_like(mod))

    def test_band_count_change_gives_consistent_loudness(self):
        """1/N 缩放: 不同频带数下持续发声段的输出 RMS 应在同一量级。"""
        mod, car, sr, _, seg = self._alternating_demo(16)
        rms_values = []
        n_seg = int(round(seg * sr))
        for nb in (4, 8, 16, 32):
            m = alternating_band_modulator(len(mod) / sr, sr, nb, seg)
            c = harmonic_carrier(len(mod) / sr, sr, 110, 80)
            out = vocode(m, c, sr, nb, 10, 60)["output"]
            rms_values.append(np.sqrt(np.mean(out[:n_seg] ** 2)))
        ratio = max(rms_values) / max(min(rms_values), 1e-12)
        self.assertLess(ratio, 6.0)


class TestNormalize(unittest.TestCase):
    def test_peak_limit_respected(self):
        x = np.random.default_rng(0).normal(size=4410) * 3
        y, _ = normalize_loudness(x)
        self.assertLessEqual(np.max(np.abs(y)), 0.89 + 1e-12)

    def test_silence_unchanged(self):
        x = np.zeros(100)
        y, scale = normalize_loudness(x)
        np.testing.assert_array_equal(x, y)
        self.assertEqual(scale, 1.0)


if __name__ == "__main__":
    unittest.main()
