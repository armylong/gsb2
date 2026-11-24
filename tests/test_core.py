from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np

from audio_quant_lab.cache import ResultCache
from audio_quant_lab.dsp import (
    QuantParams,
    compute_spectrum,
    make_fading_tone,
    quantize_direct,
    quantize_dither,
    quantize_noise_shaped,
)
from audio_quant_lab.wav_io import export_quantized_wav, read_wav


class QuantizationTests(unittest.TestCase):
    def test_direct_uses_exact_target_codes_and_level_count(self) -> None:
        x = np.linspace(-1.0, 1.0, 10_001)
        params = QuantParams(bits=4)
        result = quantize_direct(x, params)
        self.assertEqual(result.target_levels, 16)
        self.assertTrue(np.all((result.codes >= -8) & (result.codes <= 7)))
        self.assertEqual(result.used_levels, 16)
        # Reconstruction is exactly code / 2**(bits-1).
        np.testing.assert_allclose(result.y, result.codes / 8.0)
        np.testing.assert_allclose(result.error, result.y - x)

    def test_dither_seed_is_reproducible(self) -> None:
        x = make_fading_tone(seconds=0.25).samples
        params = QuantParams(bits=6, seed=12345, dither_strength=1.0)
        a = quantize_dither(x, params)
        b = quantize_dither(x, params)
        np.testing.assert_array_equal(a.codes, b.codes)

        other = quantize_dither(x, QuantParams(bits=6, seed=54321))
        self.assertFalse(np.array_equal(a.codes, other.codes))

    def test_noise_shaper_is_finite_and_reproducible(self) -> None:
        x = make_fading_tone(seconds=0.25).samples
        params = QuantParams(bits=5, seed=7, ns_order=2)
        a = quantize_noise_shaped(x, params)
        b = quantize_noise_shaped(x, params)
        self.assertTrue(np.all(np.isfinite(a.y)))
        np.testing.assert_array_equal(a.codes, b.codes)
        self.assertTrue(np.all((a.codes >= -16) & (a.codes <= 15)))

    def test_cache_reuses_results_for_back_and_forth_switches(self) -> None:
        audio = make_fading_tone(seconds=0.1)
        cache = ResultCache()
        params = QuantParams(bits=8, seed=1)
        first = cache.get_all(1, audio, params)
        second = cache.get_all(1, audio, params)
        self.assertIs(first, second)

        changed = cache.get_all(1, audio, QuantParams(bits=4, seed=1))
        self.assertIsNot(first, changed)
        back = cache.get_all(1, audio, params)
        self.assertIs(first, back)

    def test_edge_signals_have_finite_spectra(self) -> None:
        for n in (0, 1, 2, 3, 17, 2047):
            x = np.zeros(n)
            freqs, db, segment, nfft = compute_spectrum(x, 48_000)
            self.assertEqual(freqs.shape, db.shape)
            self.assertTrue(np.all(np.isfinite(db)))
            if n:
                self.assertLessEqual(segment, n)
                self.assertGreaterEqual(nfft, 1)

        short_tone = make_fading_tone(seconds=0.0001, sample_rate=8_000)
        freqs, db, segment, _ = compute_spectrum(short_tone.samples, 8_000)
        self.assertEqual(segment, short_tone.samples.size)
        self.assertTrue(np.all(np.isfinite(db)))


class SaturationAndExportTests(unittest.TestCase):
    def test_saturation_count_is_explicit(self) -> None:
        from audio_quant_lab.dsp import quantize_direct

        x = np.array([-1.0, -0.999, 0.0, 0.996, 1.0])
        result = quantize_direct(x, QuantParams(bits=8))
        # +1.0 is one code beyond the maximum signed code and is clamped.
        self.assertEqual(result.clipped_samples, 1)
        self.assertGreaterEqual(result.rail_samples, 2)

    def test_export_readback_matches_reported_levels(self) -> None:
        from audio_quant_lab.dsp import quantize_dither

        x = make_fading_tone(seconds=0.2, sample_rate=32_000).samples
        with tempfile.TemporaryDirectory() as tmp:
            for bits in (4, 8, 12, 16, 20, 24):
                with self.subTest(bits=bits):
                    result = quantize_dither(x, QuantParams(bits=bits, seed=9))
                    path = Path(tmp) / f"q{bits}.wav"
                    report = export_quantized_wav(path, result, 32_000, "auto")
                    self.assertTrue(report.readback_matches)
                    self.assertEqual(
                        report.readback_unique_levels, result.used_levels
                    )
                    read = read_wav(path)
                    self.assertEqual(read.audio.sample_rate, 32_000)
                    self.assertEqual(read.audio.channels, 1)

                    if bits in (8, 16, 24):
                        self.assertTrue(report.true_native_depth)
                        self.assertEqual(report.container_bits, bits)
                    else:
                        self.assertFalse(report.true_native_depth)
                        self.assertGreaterEqual(report.container_bits, bits)

    def test_explicit_wide_container_preserves_exact_target_grid(self) -> None:
        from audio_quant_lab.dsp import quantize_direct

        result = quantize_direct(
            np.array([-0.75, -0.25, 0.0, 0.25, 0.75]), QuantParams(bits=4)
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "wide24.wav"
            report = export_quantized_wav(path, result, 44_100, 24)
            self.assertEqual(report.container_bits, 24)
            self.assertEqual(report.shift, 20)
            read = read_wav(path)
            expected = result.codes.astype(np.int64) << 20
            np.testing.assert_array_equal(read.raw_signed[:, 0], expected)
            self.assertTrue(report.readback_matches)


if __name__ == "__main__":
    unittest.main()
