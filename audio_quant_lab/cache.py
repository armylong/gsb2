"""LRU cache keyed by source version and complete quantization parameters."""

from __future__ import annotations

from collections import OrderedDict

from .dsp import AudioData, QuantParams, QuantResult, quantize_method


class ResultCache:
    def __init__(self, max_parameter_sets: int = 6) -> None:
        self.max_parameter_sets = max(1, int(max_parameter_sets))
        self._items: OrderedDict[tuple, dict[str, QuantResult]] = OrderedDict()

    @staticmethod
    def make_key(source_version: int, audio: AudioData, params: QuantParams) -> tuple:
        # Source version is enough within one session; sample count/rate make
        # status/reporting mistakes obvious if versions are managed badly.
        return (
            int(source_version),
            int(audio.sample_rate),
            int(audio.samples.size),
            int(params.bits),
            int(params.seed),
            round(float(params.dither_strength), 6),
            int(params.ns_order),
            round(float(params.ns_dither_strength), 6),
        )

    def get_all(
        self, source_version: int, audio: AudioData, params: QuantParams
    ) -> dict[str, QuantResult]:
        key = self.make_key(source_version, audio, params)
        if key in self._items:
            self._items.move_to_end(key)
            return self._items[key]

        # Every call receives audio.samples, never a previously emitted result.
        results = {
            method: quantize_method(audio.samples, method, params)
            for method in ("direct", "dither", "noise_shaped")
        }
        self._items[key] = results
        self._items.move_to_end(key)
        while len(self._items) > self.max_parameter_sets:
            self._items.popitem(last=False)
        return results

    def clear(self) -> None:
        self._items.clear()
