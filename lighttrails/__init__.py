"""Local fixed-view image stacking toolkit for slow light trails."""

from .engine import (
    StackParams,
    StackResult,
    FrameStat,
    LockRegion,
    stack_sequence,
    roi_contributors,
    source_overlay,
)
from .sequence import (
    FrameItem,
    MissingGap,
    natural_key,
    sort_paths,
    detect_missing_gaps,
)
from .synth import sample_frames, write_sample_sequence, SAMPLE_PLAN

__all__ = [
    "StackParams",
    "StackResult",
    "FrameStat",
    "LockRegion",
    "stack_sequence",
    "roi_contributors",
    "source_overlay",
    "FrameItem",
    "MissingGap",
    "natural_key",
    "sort_paths",
    "detect_missing_gaps",
    "sample_frames",
    "write_sample_sequence",
    "SAMPLE_PLAN",
]

__version__ = "0.1.0"
