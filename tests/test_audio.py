"""音频核心测试: 对齐、响度匹配、静音检测与 ffmpeg 往返。

需要 ffmpeg/ffprobe 在 PATH 中。
"""
import os
import tempfile
import unittest

import numpy as np

from blindabx import audio
from blindabx.audio import (
    PRESET_BY_KEY, SourceInfo, active_range, align_buffers, crop_common,
    encode_decode, full_process, measure_loudness, rebuild_final, write_wav,
)

SR = 48000


def _tone_with_silence(shift: int = 0, sr: int = SR) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(11)
    body = np.sin(2 * np.pi * 300 * np.arange(sr) / sr) + 0.3 * rng.standard_normal(sr)
    ref = np.zeros((2 * sr, 2), dtype=np.float32)
    ref[sr // 2: sr // 2 + sr] = body[:, None]
    size = 2 * sr + max(shift, 0)
    cand = np.zeros((size, 2), dtype=np.float32)
    s = sr // 2 + shift
    cand[s: s + sr] = (body * 0.9)[:, None]
    return ref, cand


class AlignmentTests(unittest.TestCase):
    def test_offsets_sample_accurate(self) -> None:
        ref, _ = _tone_with_silence()
        for shift in (0, 333, 1234, 2048):
            _, cand = _tone_with_silence(shift)
            aligned, off = align_buffers(
                {"ref": ref, "A": cand, "B": cand.copy()}, SR)
            self.assertEqual(off["A"], shift)
            self.assertEqual(len({len(v) for v in aligned.values()}), 1)
            corr = np.corrcoef(aligned["ref"].mean(1),
                               aligned["A"].mean(1))[0, 1]
            self.assertGreater(corr, 0.999)

    def test_negative_offset(self) -> None:
        ref, _ = _tone_with_silence()
        _, cand = _tone_with_silence(-100)
        _, off = align_buffers({"ref": ref, "A": cand, "B": cand.copy()}, SR)
        self.assertEqual(off["A"], -100)

    def test_active_range_finds_voiced_segment(self) -> None:
        buf = np.zeros((SR, 1), dtype=np.float32)
        buf[SR // 4: SR // 2, 0] = 0.5
        start, end = active_range(buf, SR)
        self.assertLessEqual(start, SR // 4)
        self.assertGreaterEqual(end, SR // 2 - 20)

    def test_active_range_all_silence_is_safe(self) -> None:
        buf = np.zeros((SR, 1), dtype=np.float32)
        start, end = active_range(buf, SR)
        self.assertEqual((start, end), (0, SR))

    def test_crop_common_equal_length(self) -> None:
        a = np.zeros((100, 2), np.float32)
        b = np.zeros((80, 2), np.float32)
        out = crop_common({"ref": a, "A": b, "B": b})
        self.assertTrue(all(len(v) == 80 for v in out.values()))


class LoudnessTests(unittest.TestCase):
    def test_loudness_known_tone(self) -> None:
        t = np.arange(2 * SR) / SR
        sine = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        buf = np.repeat(sine[:, None], 2, axis=1)
        lufs, peak = measure_loudness(buf, SR, 2)
        # 0.5 幅度立体声正弦: 峰值 -6.02 dBFS, K 加权后集成响度约 -6.7 LUFS
        self.assertAlmostEqual(lufs, -6.7, delta=0.6)
        self.assertAlmostEqual(peak, -6.0, delta=0.2)

    def test_loudness_match_converges_with_peak_protection(self) -> None:
        quiet = np.full((SR, 2), 0.05, np.float32)
        loud = np.full((SR, 2), 0.9, np.float32)
        out, gains = audio.match_loudness(
            {"ref": loud, "A": quiet, "B": quiet}, SR, 2)
        self.assertLessEqual(float(np.max(np.abs(out["A"]))), 1.0)
        self.assertTrue(gains["A"]["gain_db"] > 0)
        m_ref = measure_loudness(out["ref"], SR, 2)[0]
        m_a = measure_loudness(out["A"], SR, 2)[0]
        self.assertAlmostEqual(m_ref, m_a, delta=0.3)

    def test_peak_limiter_flags(self) -> None:
        # 候选近满幅、参考更响 -> 候选仍需放大, 必然触发峰值回填限制
        cand = np.full((SR, 2), 0.99, np.float32)
        ref2 = np.clip(np.full((SR, 2), 2.0, np.float32), -1, 1)
        _, gains = audio.match_loudness(
            {"ref": ref2, "A": cand, "B": cand}, SR, 2)
        self.assertTrue(any(g["peak_limited"] for g in gains.values()))
        # 常规场景不应误报
        quiet = np.full((SR, 2), 0.05, np.float32)
        _, gains2 = audio.match_loudness(
            {"ref": quiet, "A": quiet, "B": quiet}, SR, 2)
        self.assertFalse(any(g["peak_limited"] for g in gains2.values()))


class PipelineTests(unittest.TestCase):
    def test_builtin_samples_shapes(self) -> None:
        for key, (_label, builder) in audio.BUILTIN_SAMPLES.items():
            buf = builder(SR)
            self.assertEqual(buf.shape[1], 2)
            self.assertGreaterEqual(len(buf) / SR, 2.0)
            self.assertLessEqual(float(np.max(np.abs(buf))), 1.0)

    def test_encode_decode_roundtrip_and_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as work:
            buf = audio.build_sample_transients(SR)
            src = os.path.join(work, "ref.wav")
            write_wav(buf, SR, 2, src)
            info = SourceInfo("builtin", "t", src, SR, 2)
            bundle = full_process(
                info, PRESET_BY_KEY["mp3_128"], PRESET_BY_KEY["mp3_320"],
                work, alignment=True, loudness_match=True,
            )
            # 三路等长、指标齐全
            self.assertEqual(len({len(v) for v in bundle.final.values()}), 1)
            for key in ("ref", "A", "B"):
                m = bundle.final_metrics[key]
                for field_name in ("duration_s", "lufs", "peak_db",
                                   "silence_head_ms", "silence_tail_ms"):
                    self.assertIn(field_name, m)
                self.assertTrue(np.isfinite(m["lufs"]))
            # 重建开关不重新编码也能工作
            _, final2, _, m2, _ = rebuild_final(
                bundle.raw, SR, 2, False, False)
            self.assertEqual(len({len(v) for v in final2.values()}), 1)
            self.assertIn("A", m2)

    def test_encode_decode_writes_lossy_file(self) -> None:
        with tempfile.TemporaryDirectory() as work:
            buf = audio.build_sample_quiet_tail(SR)
            src = os.path.join(work, "ref.wav")
            write_wav(buf, SR, 2, src)
            setting = PRESET_BY_KEY["opus_64"]
            decoded, path = encode_decode(src, setting, work, SR, 2)
            self.assertTrue(os.path.exists(path))
            self.assertTrue(path.endswith(setting.ext))
            self.assertEqual(decoded.shape[1], 2)
            self.assertGreater(len(decoded), 0)


if __name__ == "__main__":
    unittest.main()
