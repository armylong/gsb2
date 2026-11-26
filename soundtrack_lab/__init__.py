"""Old-film optical soundtrack classroom laboratory."""

from .core import (
    DecodeResult,
    DefectInterval,
    EncodedTrack,
    ReadParams,
    Segment,
    add_defects,
    band_amplitude,
    build_demo,
    decode_image,
    detect_defects,
    encode_samples,
    load_wav,
    metrics_rows,
    write_wav,
)

__all__ = [
    "DecodeResult",
    "DefectInterval",
    "EncodedTrack",
    "ReadParams",
    "Segment",
    "add_defects",
    "band_amplitude",
    "build_demo",
    "decode_image",
    "detect_defects",
    "encode_samples",
    "load_wav",
    "metrics_rows",
    "write_wav",
]
