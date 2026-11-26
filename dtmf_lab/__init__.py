"""离线双音按键辨认工具的核心包."""

from .analysis import (  # noqa: F401
    DetectionRun,
    DetectionResult,
    DetectionSettings,
    SegmentAnalysis,
    detect,
    diff_results,
)
from .tones import (  # noqa: F401
    HIGH_GROUP,
    KEYPAD,
    LOW_GROUP,
    SynthSettings,
    ToneOverride,
    normalize_key_input,
    synthesize,
)
from .wavio import AudioClip, load_wav, save_wav  # noqa: F401

__all__ = [
    "AudioClip",
    "DetectionResult",
    "DetectionRun",
    "DetectionSettings",
    "HIGH_GROUP",
    "KEYPAD",
    "LOW_GROUP",
    "SegmentAnalysis",
    "SynthSettings",
    "ToneOverride",
    "detect",
    "diff_results",
    "load_wav",
    "normalize_key_input",
    "save_wav",
    "synthesize",
]
