"""纯 numpy 核心的数值测试 (不启动 Qt 事件循环)。"""

import os
import tempfile
import unittest

import numpy as np

from cue_lab import PROJECT_SR, audio_io, examples, synth
from cue_lab.analysis import N_BANDS, analyze, band_edges, stft, to_db
from cue_lab.mixer import (
    MODE_BG,
    MODE_CUE,
    MODE_MIX,
    CueState,
    ProjectState,
    background_stem,
    cue_stem,
    db_to_lin,
    lin_to_db,
    place_on_timeline,
    render_mode,
    segment_sample_range,
)
from cue_lab import project as project_io

SR = PROJECT_SR


def _tone(freq: float, dur: float, sr: int = SR) -> np.ndarray:
    t = np.arange(int(sr * dur)) / sr
    return np.sin(2 * np.pi * freq * t)


class TestMixer(unittest.TestCase):
    def test_gain_does_not_shift_position(self):
        """调增益只改幅度, 非零样本的下标集合必须完全不变。"""
        s = ProjectState(sr=SR, background=_tone(440, 2.0))
        s.bg_gain_db = -12.0
        stem = background_stem(s)
        ref = place_on_timeline(s.background, 0.0, s.total_samples(), SR)
        nz_ref = np.flatnonzero(np.abs(ref) > 1e-9)
        nz_got = np.flatnonzero(np.abs(stem) > 1e-9)
        np.testing.assert_array_equal(nz_ref, nz_got)
        np.testing.assert_allclose(stem[nz_ref], ref[nz_ref] * db_to_lin(-12), rtol=1e-12)

    def test_cue_start_absolute_time_kept(self):
        """开始时刻决定采样位置; 改增益后起始下标不允许漂移。"""
        audio = _tone(1000, 0.5)
        cue = CueState("c", audio, start=1.234, gain_db=0.0)
        s = ProjectState(sr=SR, cues=[cue], test_end=3.0)
        first = int(round(1.234 * SR))
        stem0 = cue_stem(s, 0)
        # 直接校验放置起点 (sin(0)=0, 首个非零样本会晚 1 个采样, 属正常)
        self.assertTrue(np.all(stem0[:first] == 0.0))
        np.testing.assert_allclose(stem0[first:first + 8], audio[:8], rtol=1e-12)
        cue.gain_db = 7.5
        stem1 = cue_stem(s, 0)
        self.assertTrue(np.all(stem1[:first] == 0.0))
        np.testing.assert_allclose(
            stem1[first:first + 10],
            stem0[first:first + 10] * db_to_lin(7.5),
            rtol=1e-12,
        )

    def test_cue_overlapping_segment_only_intersection(self):
        """提示音超出试听段时, 段内只混入交集, 时刻仍按原绝对位置。"""
        audio = _tone(1000, 1.0)
        cue = CueState("c", audio, start=0.9, gain_db=0.0)
        s = ProjectState(sr=SR, cues=[cue], test_start=0.0, test_end=3.0,
                         seg_start=0.0, seg_dur=1.0)
        s.clamp_segment()
        i0, i1 = segment_sample_range(s)
        mix = render_mode(s, MODE_MIX)
        cue_first_global = int(round(0.9 * SR))
        # 段尾 (1.0s) 处提示音只出现了 0.1s 的交集, 且起点仍是绝对时刻
        self.assertEqual(i0, 0)
        self.assertTrue(np.all(mix[:cue_first_global] == 0.0))
        np.testing.assert_allclose(
            mix[cue_first_global:i1], audio[: i1 - cue_first_global], rtol=1e-12
        )
        self.assertEqual(i1 - i0, SR)
        # 段外之后提示音仍在继续 (没有被重排到段首)
        self.assertTrue(np.any(np.abs(mix[i1:i1 + SR // 2]) > 0))

    def test_negative_and_beyond_end_placement(self):
        total = SR * 2
        audio = np.ones(SR)
        # 起点在时间轴之前: 只保留交集且样本值仍对应原时刻
        placed = place_on_timeline(audio, -0.5, total, SR)
        self.assertEqual(placed[0], 1.0)
        self.assertEqual(np.flatnonzero(placed)[0], 0)
        self.assertEqual(np.flatnonzero(placed)[-1], SR // 2 - 1)
        # 起点超出右端: 全部落在交集外
        placed2 = place_on_timeline(audio, 2.0, total, SR)
        self.assertEqual(np.count_nonzero(placed2), 0)

    def test_listen_modes_share_segment_range(self):
        s = examples.build_intermittent_example()
        s.seg_start, s.seg_dur = 0.4, 1.3
        rng = segment_sample_range(s)
        for mode in (MODE_MIX, MODE_BG, MODE_CUE):
            s.mode = mode
            y = render_mode(s, mode)
            self.assertEqual(len(y), s.total_samples())
        self.assertEqual(segment_sample_range(s), rng)
        # 只听背景模式下提示音位置必须为零
        s.mode = MODE_BG
        bg_only = render_mode(s, MODE_BG)
        # 背景从 0 开始, 提示音从 0.55 开始; 取提示音中部区间验证与背景 stem 相同
        np.testing.assert_array_equal(bg_only, background_stem(s))

    def test_db_roundtrip(self):
        self.assertAlmostEqual(lin_to_db(db_to_lin(-6.0)), -6.0, places=6)

    def test_volume_changes_never_move_relative_timing(self):
        """需求 4: 改背景/提示增益不挪动相对时刻。

        拆成两条独立事实:
        1. 时间位置只由 start 决定 —— 用单位增益放置 (place_on_timeline) 校验,
           与任何增益无关;
        2. 增益是逐采样标量乘法 —— 在可表示的样本上 stem 严格等于音频 * 增益,
           不产生时间偏移。
        """
        s = examples.build_intermittent_example()
        total = s.total_samples()
        # 事实 1: 单位增益放置的支撑区间就是时间轴位置
        bg_place_zero = place_on_timeline(s.background, 0.0, total, SR) == 0.0
        cue_place_zero = [
            place_on_timeline(c.audio, c.start, total, SR) == 0.0 for c in s.cues
        ]
        # 单位增益渲染 (gain=0dB) 的零集合必须与放置结果一致
        s.bg_gain_db, saved_bg = 0.0, s.bg_gain_db
        saved_cue = [c.gain_db for c in s.cues]
        for c in s.cues:
            c.gain_db = 0.0
        np.testing.assert_array_equal(background_stem(s) == 0.0, bg_place_zero)
        for i in range(len(s.cues)):
            np.testing.assert_array_equal(cue_stem(s, i) == 0.0, cue_place_zero[i])

        # 事实 2: 换任意增益, 起始下标不变, 幅度按线性增益成比例
        s.bg_gain_db = 9.0
        for i, g in enumerate([-21.0, 4.5, -12.0]):
            s.cues[i].gain_db = g
        for i, cue in enumerate(s.cues):
            start_idx = int(round(cue.start * SR))
            stem = cue_stem(s, i)
            self.assertTrue(np.all(stem[:start_idx] == 0.0))
            scale = db_to_lin(cue.gain_db)
            seg = stem[start_idx:start_idx + len(cue.audio)]
            tol = max(1e-18, 1e-12 * scale)
            np.testing.assert_allclose(seg, cue.audio * scale, rtol=1e-12, atol=tol)
        # 还原 (本测试自行构造, 不影响其他用例)
        s.bg_gain_db = saved_bg
        for c, g in zip(s.cues, saved_cue):
            c.gain_db = g

    def test_clamp_segment_inside_test(self):
        s = ProjectState(sr=SR, test_start=1.0, test_end=2.0,
                         seg_start=9.0, seg_dur=5.0)
        s.clamp_segment()
        self.assertGreaterEqual(s.seg_start, s.test_start - 1e-9)
        self.assertLessEqual(s.seg_end(), s.test_end + 1e-9)


class TestAnalysis(unittest.TestCase):
    def test_band_count_and_edges(self):
        edges = band_edges(SR)
        self.assertEqual(len(edges), N_BANDS + 1)
        self.assertGreater(edges[0], 0)
        self.assertLessEqual(edges[-1], SR / 2)
        # 对数等距
        ratios = edges[1:] / edges[:-1]
        np.testing.assert_allclose(ratios, ratios[0], rtol=1e-12)

    def test_tone_energy_concentrated_in_its_band(self):
        x = _tone(2000, 1.0)
        an = analyze(x, SR)
        edges = an["edges"]
        band = int(np.searchsorted(edges, 2000, side="right") - 1)
        band = np.clip(band, 0, N_BANDS - 1)
        db = an["band_db"]
        frame = db[db.shape[0] // 2]
        self.assertEqual(int(np.argmax(frame)), band)
        # 目标带比相邻带高出一截 (纯音能量集中)
        others = np.delete(frame, band)
        self.assertGreater(frame[band] - np.max(others), 12.0)

    def test_silence_near_floor(self):
        an = analyze(np.zeros(SR), SR)
        self.assertTrue(np.all(an["band_db"] <= -88))
        self.assertTrue(np.all(an["heat_db"] <= -88))

    def test_stft_short_signal(self):
        x = _tone(1000, 0.02)  # 短于一帧
        power = stft(x)
        self.assertEqual(power.shape[0], 1)
        self.assertTrue(np.isfinite(power).all())

    def test_to_db_floor(self):
        self.assertAlmostEqual(float(to_db(np.zeros(3))[0]), -90.0)


class TestAudioIO(unittest.TestCase):
    def test_wav_roundtrip_16bit(self):
        x = 0.7 * _tone(440, 0.5)
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "a.wav")
            audio_io.write_wav_int16(p, x, SR)
            y, sr = audio_io.read_wav(p)
        self.assertEqual(sr, SR)
        self.assertEqual(len(y), len(x))
        # 16-bit 量化误差 < 1 LSB 量级
        np.testing.assert_allclose(y, x, atol=2e-4)

    def test_resample_identity_and_ratio(self):
        x = _tone(440, 1.0, sr=SR)
        np.testing.assert_array_equal(audio_io.resample_linear(x, SR, SR), x)
        y = audio_io.resample_linear(x, SR, SR // 2)
        self.assertAlmostEqual(len(y), len(x) / 2, delta=2)
        # 时长保持
        self.assertAlmostEqual(len(y) / (SR // 2), len(x) / SR, places=4)

    def test_embedded_bytes_roundtrip(self):
        x = synth.chirp_cue(SR, 0.4)
        b = audio_io.wav_to_bytes(x, SR)
        y, sr = audio_io.read_wav_from_bytes(b)
        self.assertEqual(sr, SR)
        np.testing.assert_allclose(y, x, atol=2e-4)

    def test_read_24bit_stereo_downmix(self):
        """24-bit 立体声 wav 能正确读为单声道 (覆盖手动 chunk 解析与有符号扩展)。"""
        import wave
        n = 2048
        t = np.arange(n) / 48000.0
        stereo = np.stack([0.5 * np.sin(2 * np.pi * 440 * t),
                           0.5 * np.sin(2 * np.pi * 880 * t)], axis=1)
        int24 = np.clip(np.round(stereo * (2 ** 23)), -(2 ** 23), 2 ** 23 - 1).astype(np.int32)
        raw = np.zeros((n, 6), dtype=np.uint8)
        for ch in range(2):
            v = int24[:, ch]
            raw[:, ch * 3] = v & 0xFF
            raw[:, ch * 3 + 1] = (v >> 8) & 0xFF
            raw[:, ch * 3 + 2] = (v >> 16) & 0xFF
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "s24.wav")
            with wave.open(p, "wb") as wf:
                wf.setnchannels(2)
                wf.setsampwidth(3)
                wf.setframerate(48000)
                wf.writeframes(raw.tobytes())
            x, sr = audio_io.read_wav(p)
        self.assertEqual(sr, 48000)
        self.assertEqual(x.ndim, 1)
        self.assertEqual(x.size, n)
        # 下混为等权平均, 峰值不超过输入
        self.assertLessEqual(float(np.max(np.abs(x))), 0.5 + 1e-6)


class TestProjectSaveLoad(unittest.TestCase):
    def test_save_load_preserves_comparison(self):
        s = examples.build_narrowband_example()
        s.mode = MODE_CUE
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "p.cuelab.json")
            project_io.save_project(p, s)
            loaded = project_io.load_project(p)
            lp = os.path.join(d, "lv.levels.json")
            project_io.export_levels(lp, loaded)
        self.assertEqual(loaded.sr, s.sr)
        self.assertEqual(len(loaded.cues), len(s.cues))
        np.testing.assert_allclose(loaded.background, s.background, atol=2e-4)
        for a, b in zip(loaded.cues, s.cues):
            self.assertEqual(a.name, b.name)
            self.assertAlmostEqual(a.start, b.start, places=6)
            self.assertAlmostEqual(a.gain_db, b.gain_db, places=6)
            np.testing.assert_allclose(a.audio, b.audio, atol=2e-4)
        self.assertAlmostEqual(loaded.seg_start, s.seg_start, places=6)
        self.assertEqual(loaded.mode, MODE_CUE)
        # 重新加载后渲染结果应与原工程一致
        np.testing.assert_allclose(
            render_mode(loaded, MODE_MIX), render_mode(s, MODE_MIX), atol=4e-4
        )

    def test_reject_foreign_json(self):
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "x.json")
            with open(p, "w", encoding="utf-8") as fh:
                fh.write('{"format": "something-else"}')
            with self.assertRaises(ValueError):
                project_io.load_project(p)


class TestExamples(unittest.TestCase):
    def test_both_examples_valid(self):
        for builder in examples.EXAMPLES.values():
            s = builder()
            self.assertLessEqual(len(s.cues), 3)
            self.assertEqual(s.sr, SR)
            # 每路提示音都与测试区间有交集
            for c in s.cues:
                self.assertLess(c.start, s.test_end)
                self.assertGreater(c.end_time(SR), s.test_start)
            # 混合输出有限且无异常值
            y = render_mode(s, MODE_MIX)
            self.assertTrue(np.isfinite(y).all())
            self.assertLess(np.max(np.abs(y)), 5.0)
            an = analyze(y, SR)
            self.assertEqual(an["band_db"].shape[1], N_BANDS)


if __name__ == "__main__":
    unittest.main()
