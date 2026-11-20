"""双通道到达时差手调对照台。"""

__version__ = "0.1.0"

from .models import DriftResult, Peak, TdoaResult  # noqa: E402
from .synth import Sample, make_preset, presets  # noqa: E402

__all__ = ["DriftResult", "Peak", "TdoaResult", "Sample", "make_preset", "presets"]
