"""Qt-independent view model shared by the window and the tests.

The controller owns the current image pair, the mask document and the blend
configuration, and caches the blend results so that every view (main canvas,
comparison view, probe panel, level inspector, export) reads exactly the same
numbers.  Any parameter change bumps a revision and invalidates the cache.

The comparison result is computed lazily: painting only needs the active
result, and the naive/pyramid counterpart is computed when the comparison tab
or the probe panel asks for it.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import numpy as np

from .color import linear_to_rgb8, linear_to_rgb8_float
from .engine import MODE_NAIVE, MODE_PYRAMID, BlendConfig, BlendEngine
from .mask import MaskDocument

LEVEL_PAGES = ("result", "comparison", "a", "b", "mask", "levels")


@dataclass
class ViewState:
    """Snapshot of everything a view needs for one revision."""

    revision: int
    a_rgb8: np.ndarray
    b_rgb8: np.ndarray
    mask: np.ndarray
    config: BlendConfig
    result_linear: np.ndarray
    size: tuple[int, int]
    max_levels: int
    comparison_linear: Optional[np.ndarray] = None


class Session:
    """A loaded image pair plus its mask and blend settings."""

    def __init__(
        self,
        a_rgb8: np.ndarray,
        b_rgb8: np.ndarray,
        *,
        name: str = "",
        mask: np.ndarray | None = None,
    ) -> None:
        self.engine = BlendEngine(a_rgb8, b_rgb8)
        self.height, self.width = self.engine.height, self.engine.width
        self.name = name or f"{self.width}×{self.height}"
        self.mask_doc = MaskDocument(self.height, self.width)
        if mask is not None and mask.shape == (self.height, self.width):
            self.mask_doc.mask[:] = np.clip(mask, 0.0, 1.0)
        self.initial_mask = self.mask_doc.mask.copy()
        self.max_levels = self.engine.max_levels
        self.pyramid_available = self.max_levels >= 2
        if self.pyramid_available:
            self.config = BlendConfig(MODE_PYRAMID, min(4, self.max_levels))
        else:
            self.config = BlendConfig(MODE_NAIVE, 2)
        self.revision = 0
        self.pick: tuple[int, int] | None = None
        self.inspected_level = 0
        self._cache_key: tuple | None = None
        self._result: np.ndarray | None = None
        self._comparison: np.ndarray | None = None
        self._result_rgb: np.ndarray | None = None
        self._comparison_rgb: np.ndarray | None = None

    # -- parameters ------------------------------------------------------
    def set_mode(self, mode: str) -> None:
        if mode not in (MODE_NAIVE, MODE_PYRAMID):
            raise ValueError(f"unknown mode {mode}")
        if mode == MODE_PYRAMID and not self.pyramid_available:
            raise ValueError("图像尺寸过小，无法进行多分辨率分解")
        if mode == self.config.mode:
            return
        self.config = BlendConfig(mode, self.config.levels)
        self.touch()

    def set_levels(self, levels: int) -> None:
        if not self.pyramid_available:
            raise ValueError("图像尺寸过小，无法进行多分辨率分解")
        limit = min(6, self.max_levels)
        levels = int(levels)
        if limit >= 2 and not 2 <= levels <= limit:
            raise ValueError(f"层数必须在 2–{limit} 之间")
        if self.config.levels == levels:
            return
        self.config = BlendConfig(self.config.mode, levels)
        self.inspected_level = min(self.inspected_level, levels - 1)
        self.touch()

    def set_inspected_level(self, index: int) -> None:
        index = int(index)
        if not 0 <= index < self.config.levels:
            raise ValueError("层索引超出范围")
        self.inspected_level = index

    def set_pick(self, position: tuple[int, int] | None) -> None:
        self.pick = position

    def touch(self) -> None:
        """Invalidate cached results after the mask or parameters changed."""
        self.revision += 1
        self._cache_key = None
        self._result = None
        self._comparison = None
        self._result_rgb = None
        self._comparison_rgb = None

    # -- derived state ---------------------------------------------------
    @property
    def mask(self) -> np.ndarray:
        return self.mask_doc.mask

    def _key(self) -> tuple:
        return (
            self.revision,
            self.mask_doc.revision,
            self.config.mode,
            self.config.levels,
        )

    def _ensure(self) -> None:
        key = self._key()
        if self._cache_key == key and self._result is not None:
            return
        self._cache_key = key
        self._result = self.engine.result(self.mask, self.config)
        self._comparison = None
        self._result_rgb = None
        self._comparison_rgb = None

    def _ensure_comparison(self) -> None:
        self._ensure()
        if self._comparison is not None:
            return
        self._comparison = self.engine.reference(self.mask, self.config)

    def result_linear(self) -> np.ndarray:
        self._ensure()
        return self._result  # type: ignore[return-value]

    def comparison_linear(self) -> np.ndarray:
        self._ensure_comparison()
        return self._comparison  # type: ignore[return-value]

    def result_rgb8(self) -> np.ndarray:
        self._ensure()
        if self._result_rgb is None:
            self._result_rgb = linear_to_rgb8(self._result)  # type: ignore[arg-type]
        return self._result_rgb

    def comparison_rgb8(self) -> np.ndarray:
        self._ensure_comparison()
        if self._comparison_rgb is None:
            self._comparison_rgb = linear_to_rgb8(self._comparison)  # type: ignore[arg-type]
        return self._comparison_rgb

    def result_srgb_float(self) -> np.ndarray:
        return linear_to_rgb8_float(self.result_linear())

    def comparison_diff_rgb8(self, gain: float = 10.0) -> np.ndarray:
        """Amplified absolute difference between the two blend flavours.

        The difference is taken in linear light, scaled by ``gain`` and shown
        with a grey bias so zero difference is mid-grey.
        """
        difference = np.abs(self.result_linear() - self.comparison_linear())
        display = np.clip(0.5 + difference * float(gain), 0.0, 1.0)
        values = np.clip(np.rint(display * 255.0), 0, 255).astype(np.uint8)
        return np.ascontiguousarray(values)

    def state(self, need_comparison: bool = True) -> ViewState:
        self._ensure()
        if need_comparison:
            self._ensure_comparison()
        return ViewState(
            revision=self.revision,
            a_rgb8=self.engine.a_rgb8,
            b_rgb8=self.engine.b_rgb8,
            mask=self.mask,
            config=self.config,
            result_linear=self._result,  # type: ignore[arg-type]
            comparison_linear=self._comparison,
            size=(self.width, self.height),
            max_levels=self.max_levels,
        )

    def probe(self) -> dict | None:
        """Sample the cached result at the picked pixel."""
        if self.pick is None:
            return None
        x, y = self.pick
        if not (0 <= x < self.width and 0 <= y < self.height):
            return None
        self._ensure()
        self._ensure_comparison()
        assert self._result is not None and self._comparison is not None
        if self.config.mode == MODE_PYRAMID:
            pyramid_linear = self._result[y, x]
            naive_linear = self._comparison[y, x]
        else:
            naive_linear = self._result[y, x]
            pyramid_linear = self._comparison[y, x]
        return {
            "x": x,
            "y": y,
            "a_rgb8": self.engine.a_rgb8[y, x].copy(),
            "b_rgb8": self.engine.b_rgb8[y, x].copy(),
            "a_linear": self.engine.a_linear[y, x].copy(),
            "b_linear": self.engine.b_linear[y, x].copy(),
            "mask": float(self.mask[y, x]),
            "naive_linear": np.asarray(naive_linear, dtype=np.float32).copy(),
            "pyramid_linear": np.asarray(pyramid_linear, dtype=np.float32).copy(),
            "result_linear": np.asarray(self._result[y, x], dtype=np.float32).copy(),
            "mode": self.config.mode,
        }

    def valid_levels(self) -> tuple[int, ...]:
        limit = min(6, self.max_levels)
        return tuple(range(2, limit + 1))

    def _level_count_for_views(self) -> int:
        return self.config.levels

    def level_views(self) -> list[dict]:
        if not self.pyramid_available:
            return []
        return self.engine.level_views(self.mask, self._level_count_for_views())

    def residual_view(self) -> dict | None:
        if not self.pyramid_available:
            return None
        return self.engine.residual_view(self._level_count_for_views())

    def export(self, directory: str, stem: str):
        from .export import export_result

        self._ensure()
        assert self._result is not None
        return export_result(
            directory,
            stem,
            self._result,
            self.mask,
            mode=self.config.mode,
            levels=self.config.levels,
        )


def _comparison_levels(max_levels: int) -> int:
    return max(2, min(4, max_levels))
