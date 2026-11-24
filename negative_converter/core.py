from __future__ import annotations

"""Numerical core for the colour-negative converter.

The module is Qt-free so the important behaviour can be tested headlessly.
All rectangles shared with the GUI are normalised to ``[0, 1]``; this keeps
full-resolution statistics, downsampled previews and exported images in the
same coordinate system.
"""

import math
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Sequence

import numpy as np

CHANNELS = ("R", "G", "B")
SUPPORTED_INPUT_SUFFIXES = {".png", ".tif", ".tiff"}


# ---------------------------------------------------------------------------
# Geometry and image containers
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class NormRect:
    """An axis-aligned rectangle in normalised image coordinates."""

    x: float
    y: float
    w: float
    h: float

    @staticmethod
    def from_points(x0: float, y0: float, x1: float, y1: float) -> "NormRect":
        # Clip endpoints before calculating width. Clipping x and retaining the
        # raw endpoint-to-endpoint width would enlarge an out-of-bounds drag.
        left = min(1.0, max(0.0, min(x0, x1)))
        right = min(1.0, max(0.0, max(x0, x1)))
        top = min(1.0, max(0.0, min(y0, y1)))
        bottom = min(1.0, max(0.0, max(y0, y1)))
        return NormRect(left, top, max(right - left, 1e-6), max(bottom - top, 1e-6))

    def clamped(self) -> "NormRect":
        x = min(max(self.x, 0.0), 1.0)
        y = min(max(self.y, 0.0), 1.0)
        w = min(max(self.w, 0.0), 1.0 - x)
        h = min(max(self.h, 0.0), 1.0 - y)
        return NormRect(x, y, w, h)

    @property
    def center(self) -> tuple[float, float]:
        return self.x + self.w / 2.0, self.y + self.h / 2.0

    def pixel_bounds(self, height: int, width: int, min_size: int = 3) -> tuple[int, int, int, int]:
        x0 = int(math.floor(self.x * width))
        y0 = int(math.floor(self.y * height))
        x1 = int(math.ceil((self.x + self.w) * width))
        y1 = int(math.ceil((self.y + self.h) * height))
        x0 = max(0, min(width - 1, x0))
        y0 = max(0, min(height - 1, y0))
        x1 = max(x0 + 1, min(width, x1))
        y1 = max(y0 + 1, min(height, y1))
        if x1 - x0 < min_size and width >= min_size:
            cx = (x0 + x1) // 2
            x0 = max(0, min(width - min_size, cx - min_size // 2))
            x1 = min(width, x0 + min_size)
        if y1 - y0 < min_size and height >= min_size:
            cy = (y0 + y1) // 2
            y0 = max(0, min(height - min_size, cy - min_size // 2))
            y1 = min(height, y0 + min_size)
        return x0, y0, x1, y1

    def slices(self, height: int, width: int, min_size: int = 3):
        x0, y0, x1, y1 = self.pixel_bounds(height, width, min_size)
        return slice(y0, y1), slice(x0, x1)

    def contains(self, nx: float, ny: float, pad: float = 0.0) -> bool:
        return (
            self.x - pad <= nx <= self.x + self.w + pad
            and self.y - pad <= ny <= self.y + self.h + pad
        )


@dataclass
class ImageDoc:
    """Loaded image. Integer scans stay compact; floats are normalised on use."""

    codes: np.ndarray
    code_max: float = 255.0
    bit_depth: int = 8
    path: str | None = None

    def __post_init__(self):
        arr = np.asarray(self.codes)
        if arr.ndim != 3 or arr.shape[2] != 3:
            raise ValueError(f"expected HxWx3 RGB image, got {arr.shape}")
        if not arr.flags["C_CONTIGUOUS"]:
            arr = np.ascontiguousarray(arr)
        self.codes = arr

    @property
    def height(self) -> int:
        return int(self.codes.shape[0])

    @property
    def width(self) -> int:
        return int(self.codes.shape[1])

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(self.codes.shape)  # type: ignore[return-value]

    def full_float(self) -> np.ndarray:
        return self.codes.astype(np.float32, copy=False) / np.float32(self.code_max)

    def roi_float(self, rect: NormRect | None = None) -> np.ndarray:
        if rect is None:
            return self.full_float()
        ys, xs = rect.slices(self.height, self.width)
        roi = np.ascontiguousarray(self.codes[ys, xs])
        return roi.astype(np.float32, copy=False) / np.float32(self.code_max)

    def preview_float(self, max_dimension: int = 1500) -> np.ndarray:
        h, w = self.height, self.width
        longest = max(h, w)
        step = max(1, int(math.ceil(longest / max_dimension))) if longest > max_dimension else 1
        view = self.codes[::step, ::step]
        return np.ascontiguousarray(view).astype(np.float32) / np.float32(self.code_max)


# ---------------------------------------------------------------------------
# Loading and saving
# ---------------------------------------------------------------------------


def _normalise_array(arr: np.ndarray) -> np.ndarray:
    arr = np.asarray(arr)

    # Multi-page/multi-series TIFFs: use the first plane/page.
    while arr.ndim >= 4:
        arr = arr[0]

    if arr.ndim == 2:
        arr = np.stack([arr, arr, arr], axis=-1)
    elif arr.ndim == 3:
        # TIFF/ImageJ sometimes stores channels first.
        if arr.shape[-1] not in (1, 2, 3, 4) and arr.shape[0] in (1, 2, 3, 4):
            arr = np.moveaxis(arr, 0, -1)
        if arr.shape[-1] == 1:
            arr = np.repeat(arr, 3, axis=-1)
        elif arr.shape[-1] == 2:
            arr = np.repeat(arr[..., :1], 3, axis=-1)
        elif arr.shape[-1] == 4:
            arr = arr[..., :3]
        elif arr.shape[-1] != 3:
            raise ValueError(f"unsupported channel layout: {arr.shape}")
    else:
        raise ValueError(f"unsupported image dimensions: {arr.shape}")

    if np.issubdtype(arr.dtype, np.bool_):
        arr = arr.astype(np.uint8)
    elif np.issubdtype(arr.dtype, np.signedinteger):
        # Scans should be unsigned. Narrow wide integers to the supported
        # 8/16-bit code range *after* clipping, otherwise int32 -> uint16 wraps.
        info = np.iinfo(arr.dtype)
        if info.bits <= 8:
            arr = np.clip(arr, 0, 255).astype(np.uint8)
        else:
            arr = np.clip(arr, 0, 65535).astype(np.uint16)
    elif arr.dtype.byteorder not in ("=", "|"):
        # NumPy 2 ndarray no longer exposes newbyteorder(); converting through
        # the native-endian dtype performs the value-correct byte swap.
        arr = arr.astype(arr.dtype.newbyteorder("="))

    return np.ascontiguousarray(arr)


def load_image(path: str | os.PathLike) -> ImageDoc:
    """Load a normal PNG or an 8/16-bit TIFF/PNG into an :class:`ImageDoc`."""

    p = Path(path)
    suffix = p.suffix.lower()
    if suffix not in SUPPORTED_INPUT_SUFFIXES:
        raise ValueError(f"不支持的文件类型: {p.suffix}（请选择 PNG 或 TIFF）")

    if suffix in {".tif", ".tiff"}:
        import tifffile

        with tifffile.TiffFile(str(p)) as tif:
            if not tif.pages:
                raise ValueError("TIFF 中没有图像页")
            # Read the first page directly. series.asarray() on a multi-page
            # greyscale stack would expose an (N,H,W) page axis that could be
            # mistaken for channels by _normalise_array().
            arr = tif.pages[0].asarray()
            bits = None
            try:
                raw_bits = getattr(tif.pages[0], "bitspersample", None)
                if raw_bits is None:
                    raw_bits = getattr(tif.pages[0], "bits_per_sample", None)
                if raw_bits is not None:
                    if isinstance(raw_bits, (tuple, list, np.ndarray)):
                        bits = int(np.max(raw_bits))
                    else:
                        bits = int(raw_bits)
            except Exception:
                bits = None
        arr = _normalise_array(arr)
    else:
        from PIL import Image

        with Image.open(str(p)) as im:
            # Palette/CMYK PNGs are “ordinary PNGs” too. Convert only these
            # 8-bit modes; preserve I;16 so 16-bit greyscale data is not
            # quantised by an RGB conversion.
            if im.mode == "P":
                im = im.convert("RGBA" if "transparency" in im.info else "RGB")
            elif im.mode in {"CMYK", "YCbCr", "LA"}:
                im = im.convert("RGBA" if im.mode == "LA" else "RGB")
            arr = np.asarray(im)
        arr = _normalise_array(arr)
        bits = None

    if np.issubdtype(arr.dtype, np.integer):
        code_max = float(np.iinfo(arr.dtype).max)
        bit_depth = bits or (16 if arr.dtype.itemsize >= 2 else 8)
        # Some 12/14-bit data is stored in uint16; tag bits may refine it.
        if bits:
            bit_depth = int(bits)
    else:
        arr = np.clip(arr, 0.0, 1.0).astype(np.float32)
        code_max = 1.0
        bit_depth = 32

    return ImageDoc(codes=arr, code_max=code_max, bit_depth=bit_depth, path=str(p))


def expected_code_bounds(bit_depth: int = 8, range_preset: str = "full") -> tuple[int, int]:
    max_code = 255 if bit_depth <= 8 else 65535
    if range_preset == "legal":
        lo = int(round(16 / 255 * max_code))
        hi = int(round(235 / 255 * max_code))
    else:
        lo, hi = 0, max_code
    return lo, hi


def encode_positive(
    rgb01: np.ndarray,
    bit_depth: int = 8,
    range_preset: str = "full",
) -> np.ndarray:
    """Encode a float positive using either full or 16-235-equivalent range."""

    rgb01 = np.asarray(rgb01, dtype=np.float32)
    lo_n, hi_n = (16 / 255.0, 235 / 255.0) if range_preset == "legal" else (0.0, 1.0)
    mapped = lo_n + np.clip(rgb01, 0.0, 1.0) * (hi_n - lo_n)

    if bit_depth <= 8:
        return np.rint(mapped * 255.0).astype(np.uint8)
    return np.rint(mapped * 65535.0).astype(np.uint16)


def export_positive(
    path: str | os.PathLike,
    rgb01: np.ndarray,
    bit_depth: int = 8,
    range_preset: str = "full",
) -> Path:
    """Export an 8-bit PNG or an 8/16-bit TIFF."""

    p = Path(path)
    suffix = p.suffix.lower()
    codes = encode_positive(rgb01, bit_depth=bit_depth, range_preset=range_preset)

    if suffix == ".png":
        if codes.dtype != np.uint8:
            # Ordinary PNG path is kept to universally supported 8-bit RGB.
            codes = np.rint((codes.astype(np.float32) / 65535.0) * 255.0).astype(np.uint8)
        from PIL import Image

        Image.fromarray(codes, "RGB").save(p, optimize=False)
    elif suffix in {".tif", ".tiff"}:
        import tifffile

        tifffile.imwrite(str(p), codes, photometric="rgb")
    else:
        raise ValueError("导出格式请使用 .png、.tif 或 .tiff")
    return p


@dataclass
class ReadbackReport:
    path: str
    width: int
    height: int
    dtype: str
    bit_depth: int
    minimum: tuple[float, float, float]
    maximum: tuple[float, float, float]
    mean: tuple[float, float, float]
    expected_min_code: int
    expected_max_code: int
    global_min_code: int
    global_max_code: int
    range_preset: str
    matches_expected: bool
    message: str

    def as_text(self) -> str:
        def t3(v: Sequence[float]) -> str:
            return "(" + ", ".join(f"{x:.1f}" for x in v) + ")"

        return (
            f"回读文件: {self.path}\n"
            f"尺寸: {self.width}×{self.height}, {self.dtype}, 位深≈{self.bit_depth}\n"
            f"各通道最小值: {t3(self.minimum)}\n"
            f"各通道最大值: {t3(self.maximum)}\n"
            f"各通道平均值: {t3(self.mean)}\n"
            f"配置目标码值范围: {self.expected_min_code}–{self.expected_max_code} ({self.range_preset})\n"
            f"文件实际全局码值范围: {self.global_min_code}–{self.global_max_code}\n"
            f"核对结果: {self.message}"
        )


def readback_output(
    path: str | os.PathLike,
    range_preset: str = "full",
    bit_depth: int | None = 8,
) -> ReadbackReport:
    """Reload an export and compare its real code range with the requested range."""

    doc = load_image(path)
    if bit_depth is None:
        effective_depth = doc.bit_depth
    else:
        effective_depth = int(bit_depth)
    # A uint16 file is always compared on the 16-bit code scale, even if the
    # caller did not know its exact sensor bit depth.
    if doc.codes.dtype == np.uint16:
        effective_depth = 16
    codes = doc.codes
    flat = codes.reshape(-1, 3)
    mn = flat.min(axis=0).astype(float)
    mx = flat.max(axis=0).astype(float)
    mean = flat.mean(axis=0).astype(float)
    exp_lo, exp_hi = expected_code_bounds(effective_depth, range_preset)
    actual_lo = int(codes.min())
    actual_hi = int(codes.max())

    # The configured encoder writes exactly these endpoint codes when pixels
    # reach 0 and 1. Content may legitimately cover a narrower range.
    reaches_low = actual_lo <= exp_lo + max(1, exp_hi * 0.002)
    reaches_high = actual_hi >= exp_hi - max(1, exp_hi * 0.002)
    if reaches_low and reaches_high:
        ok = True
        msg = f"通过：回读范围覆盖目标 {exp_lo}–{exp_hi}。"
    else:
        ok = False
        missing = []
        if not reaches_low:
            missing.append("暗端")
        if not reaches_high:
            missing.append("亮端")
        msg = "可核对：实际内容未覆盖目标范围，缺少" + "、".join(missing) + "；这通常是画面内容而非写入错误。"

    return ReadbackReport(
        path=str(path),
        width=doc.width,
        height=doc.height,
        dtype=str(codes.dtype),
        bit_depth=doc.bit_depth,
        minimum=(float(mn[0]), float(mn[1]), float(mn[2])),
        maximum=(float(mx[0]), float(mx[1]), float(mx[2])),
        mean=(float(mean[0]), float(mean[1]), float(mean[2])),
        expected_min_code=exp_lo,
        expected_max_code=exp_hi,
        global_min_code=actual_lo,
        global_max_code=actual_hi,
        range_preset=range_preset,
        matches_expected=ok,
        message=msg,
    )


# ---------------------------------------------------------------------------
# Patch statistics and orange-base estimation
# ---------------------------------------------------------------------------


@dataclass
class PatchStats:
    median: np.ndarray
    mean: np.ndarray
    mad: np.ndarray
    overflow_fraction: float
    outlier_fraction: float
    overflow_count: int
    outlier_count: int
    pixel_count: int

    def as_dict(self) -> dict:
        return {
            "median": self.median.copy(),
            "mean": self.mean.copy(),
            "overflow_fraction": self.overflow_fraction,
            "outlier_fraction": self.outlier_fraction,
            "pixel_count": self.pixel_count,
        }


@dataclass
class SamplePatch:
    id: int
    rect: NormRect
    kind: str = "base"  # base | neutral
    status: str = "ok"  # ok | dust | overflow | dust_overflow | invalid
    reason: str = ""
    stats: PatchStats | None = None

    @property
    def bad(self) -> bool:
        return self.status not in {"ok"}

    @property
    def status_label(self) -> str:
        return {
            "ok": "正常",
            "dust": "疑似灰尘",
            "overflow": "溢出/死白",
            "dust_overflow": "灰尘+溢出",
            "invalid": "无效区域",
        }.get(self.status, self.status)


def analyze_patch(doc: ImageDoc, rect: NormRect) -> SamplePatch:
    ys, xs = rect.slices(doc.height, doc.width, min_size=5)
    roi = np.ascontiguousarray(doc.codes[ys, xs])
    if roi.size == 0:
        return SamplePatch(id=-1, rect=rect, status="invalid", reason="空区域")

    rgb = roi.astype(np.float32) / np.float32(doc.code_max)
    flat = rgb.reshape(-1, 3)
    n = flat.shape[0]
    median = np.median(flat, axis=0)
    mean = np.mean(flat, axis=0)
    mad = np.maximum(
        1.4826 * np.median(np.abs(flat - median), axis=0),
        0.75 / max(doc.code_max, 1.0),
    )

    # Exact/near exact detector saturation. The half-code tolerance handles
    # rounding while avoiding ordinary bright-orange base values.
    sat_level = 1.0 - 0.5 / doc.code_max if doc.code_max > 1.5 else 0.999
    overflow = np.any(flat >= sat_level, axis=1)
    overflow_count = int(np.count_nonzero(overflow))
    overflow_fraction = overflow_count / n

    z = np.abs(flat - median[None, :]) / mad[None, :]
    # Saturated pixels are reported as overflow first; do not let a large
    # clipped blob also produce a misleading dust classification.
    outliers = np.any(z > 8.0, axis=1) & ~overflow
    outlier_count = int(np.count_nonzero(outliers))
    outlier_fraction = outlier_count / n

    has_overflow = overflow_count >= max(3, int(n * 0.0005))
    has_dust = outlier_count >= max(6, int(n * 0.001))

    if has_overflow and has_dust:
        status = "dust_overflow"
        reason = f"异常像素 {outlier_fraction:.2%}，溢出 {overflow_fraction:.2%}"
    elif has_overflow:
        status = "overflow"
        reason = f"溢出像素 {overflow_fraction:.2%}"
    elif has_dust:
        status = "dust"
        reason = f"离群/灰尘像素 {outlier_fraction:.2%}"
    else:
        status = "ok"
        reason = f"中位 RGB {_rgb_text(median * 255)}"

    stats = PatchStats(
        median=median.astype(np.float32),
        mean=mean.astype(np.float32),
        mad=mad.astype(np.float32),
        overflow_fraction=overflow_fraction,
        outlier_fraction=outlier_fraction,
        overflow_count=overflow_count,
        outlier_count=outlier_count,
        pixel_count=n,
    )
    return SamplePatch(id=-1, rect=rect, status=status, reason=reason, stats=stats)


def _rgb_text(v: Sequence[float]) -> str:
    return f"({v[0]:.0f}, {v[1]:.0f}, {v[2]:.0f})"


DEFAULT_BASE = np.array([0.86, 0.54, 0.32], dtype=np.float32)


def estimate_base(patches: Iterable[SamplePatch]) -> tuple[np.ndarray, int]:
    good = [
        p
        for p in patches
        if p.kind == "base" and p.status == "ok" and p.stats is not None
    ]
    if not good:
        return DEFAULT_BASE.copy(), 0
    medians = np.stack([p.stats.median for p in good], axis=0)
    return np.median(medians, axis=0).astype(np.float32), len(good)


# ---------------------------------------------------------------------------
# Conversion parameters and math
# ---------------------------------------------------------------------------


@dataclass
class ConvertParams:
    base: tuple[float, float, float] = tuple(DEFAULT_BASE.tolist())  # type: ignore[assignment]
    black: float = 0.02
    white: float = 2.10
    gamma: float = 1.0
    gray: tuple[float, float, float] = (1.0, 1.0, 1.0)

    def base_array(self) -> np.ndarray:
        return np.asarray(self.base, dtype=np.float32)

    def gray_array(self) -> np.ndarray:
        return np.asarray(self.gray, dtype=np.float32)

    def clamped(self) -> "ConvertParams":
        black = float(min(max(self.black, -0.5), 3.8))
        white = float(min(max(self.white, black + 0.02), 4.5))
        gamma = float(min(max(self.gamma, 0.35), 2.5))
        gray = tuple(float(min(max(v, 0.2), 4.0)) for v in self.gray)
        base = tuple(float(min(max(v, 1e-4), 1.0)) for v in self.base)
        return ConvertParams(base=base, black=black, white=white, gamma=gamma, gray=gray)


def density_image(rgb01: np.ndarray, base: np.ndarray | Sequence[float]) -> np.ndarray:
    """Base-relative negative density: ``-log10(sample/base)`` per channel."""

    rgb01 = np.asarray(rgb01, dtype=np.float32)
    b = np.asarray(base, dtype=np.float32).reshape(1, 1, 3)
    ratio = rgb01 / np.maximum(b, 1e-5)
    # A tiny floor prevents log(0). The source float is retained elsewhere, so
    # moving parameters back can restore gradation without baked clipping.
    return -np.log10(np.maximum(ratio, 1e-7)).astype(np.float32)


def tone_before_gray(rgb01: np.ndarray, params: ConvertParams) -> tuple[np.ndarray, dict[str, np.ndarray]]:
    """Return shaped positive and diagnostic fields before gray gains."""

    p = params.clamped()
    density = density_image(rgb01, p.base_array())
    span = max(float(p.white - p.black), 1e-3)
    raw_t = (density - float(p.black)) / np.float32(span)
    shaped = np.clip(raw_t, 0.0, 1.0)
    shaped = np.power(shaped, np.float32(1.0 / max(p.gamma, 1e-3))).astype(np.float32)
    fields = {"density": density, "raw_t": raw_t, "shaped": shaped}
    return shaped, fields


def convert_positive(
    rgb01: np.ndarray,
    params: ConvertParams,
    details: bool = True,
) -> tuple[np.ndarray, dict[str, np.ndarray] | None]:
    if details:
        shaped, fields = tone_before_gray(rgb01, params)
        gray = params.clamped().gray_array().reshape(1, 1, 3)
        final = (shaped * gray).astype(np.float32)
        fields["final"] = final
        return final, fields

    # Full-resolution export path: process one channel at a time and mutate
    # its temporary buffer to keep peak memory manageable on large scans.
    p = params.clamped()
    base = p.base_array()
    gray = p.gray_array()
    span = max(float(p.white - p.black), 1e-3)
    inv_gamma = np.float32(1.0 / max(p.gamma, 1e-3))
    out = np.empty_like(rgb01, dtype=np.float32)
    for c in range(3):
        channel = np.divide(rgb01[..., c], np.float32(max(base[c], 1e-5)), dtype=np.float32)
        np.maximum(channel, 1e-7, out=channel)
        np.log10(channel, out=channel)
        np.negative(channel, out=channel)
        channel -= np.float32(p.black)
        channel /= np.float32(span)
        np.clip(channel, 0.0, 1.0, out=channel)
        if abs(float(inv_gamma) - 1.0) > 1e-6:
            np.power(channel, inv_gamma, out=channel)
        channel *= np.float32(gray[c])
        out[..., c] = channel
    return out, None


def auto_endpoints(
    rgb01: np.ndarray,
    base: np.ndarray | Sequence[float],
    low_quantile: float = 0.4,
    high_quantile: float = 99.6,
) -> tuple[float, float]:
    density = density_image(rgb01, base)
    lo = float(np.percentile(density, low_quantile))
    hi = float(np.percentile(density, high_quantile))
    lo = max(-0.15, min(lo, hi - 0.08))
    hi = max(hi, lo + 0.12)
    return round(lo, 4), round(min(hi, 4.2), 4)


def estimate_noise_floor(rgb01: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Estimate black floor and robust read-noise sigma from local differences."""

    rgb01 = np.asarray(rgb01, dtype=np.float32)
    flat = rgb01.reshape(-1, 3)
    floor = np.percentile(flat, 0.15, axis=0).astype(np.float32)

    # Horizontal and vertical differences make the estimator less dependent on
    # a single scan direction. Median absolute difference rejects real edges.
    dx = np.diff(rgb01, axis=1)
    dy = np.diff(rgb01, axis=0)
    d = np.concatenate([dx.reshape(-1, 3), dy.reshape(-1, 3)], axis=0)
    med_d = np.median(d, axis=0)
    mad_d = 1.4826 * np.median(np.abs(d - med_d), axis=0)
    sigma = (mad_d / math.sqrt(2.0)).astype(np.float32)
    sigma = np.maximum(sigma, 1e-5)
    return floor, sigma


def diagnostic_masks(
    rgb01: np.ndarray,
    params: ConvertParams,
    code_max: float = 65535.0,
    fields: dict[str, np.ndarray] | None = None,
) -> dict[str, np.ndarray]:
    if fields is None:
        final, fields = convert_positive(rgb01, params)
    else:
        final = fields.get("final")
        if final is None:
            shaped, fields = tone_before_gray(rgb01, params)
            final = shaped * params.clamped().gray_array().reshape(1, 1, 3)
            fields["final"] = final

    floor, sigma = estimate_noise_floor(rgb01)
    # Within roughly 3 stops? No: 3 robust sigma above the estimated floor.
    noise_mask = np.any(rgb01 <= (floor + 3.0 * sigma)[None, None, :], axis=2)

    sat_level = 1.0 - 0.5 / code_max if code_max > 1.5 else 0.999
    input_clip = np.any(rgb01 >= sat_level, axis=2)

    raw_t = fields["raw_t"]
    final = fields["final"]
    # Parameter-induced losses are deliberately separate from irreversible
    # detector clipping. Recomputing after moving a slider restores the data.
    endpoint_high = np.any(raw_t >= 1.0, axis=2)
    gain_high = np.any(final > 1.0, axis=2)
    output_high = endpoint_high | gain_high
    output_low = np.any(raw_t <= 0.0, axis=2)

    return {
        "noise_floor": noise_mask,
        "input_clip": input_clip,
        "output_high_clip": output_high,
        "output_low_crush": output_low,
    }


def mask_counts(masks: dict[str, np.ndarray]) -> dict[str, float]:
    total = next(iter(masks.values())).size
    return {key: float(np.count_nonzero(mask)) / max(total, 1) for key, mask in masks.items()}


def overlay_masks(display_u8: np.ndarray, masks: dict[str, np.ndarray]) -> np.ndarray:
    """Create a colour diagnostic overlay on an 8-bit RGB image."""

    out = display_u8.astype(np.float32) * 0.62
    colors = {
        "noise_floor": np.array([64, 132, 255], dtype=np.float32),       # blue
        "input_clip": np.array([255, 48, 48], dtype=np.float32),        # red
        "output_high_clip": np.array([255, 214, 0], dtype=np.float32),  # yellow
        "output_low_crush": np.array([0, 220, 230], dtype=np.float32), # cyan
    }
    alpha = {
        "noise_floor": 0.42,
        "input_clip": 0.58,
        "output_high_clip": 0.40,
        "output_low_crush": 0.34,
    }
    # Apply in order; irreversible input problems win visually.
    for key in ("output_low_crush", "noise_floor", "output_high_clip", "input_clip"):
        mask = masks.get(key)
        if mask is None:
            continue
        a = alpha[key] * mask[..., None].astype(np.float32)
        color = colors[key].reshape(1, 1, 3)
        out = out * (1.0 - a) + color * a

    return np.clip(out, 0, 255).astype(np.uint8)


def to_display_u8(rgb01: np.ndarray) -> np.ndarray:
    return np.clip(np.rint(np.asarray(rgb01) * 255.0), 0, 255).astype(np.uint8)


def autostretch_original_u8(rgb01: np.ndarray) -> np.ndarray:
    """Display-only robust stretch for viewing 12/16-bit originals."""

    lo = np.percentile(rgb01.reshape(-1, 3), 0.25, axis=0)
    hi = np.percentile(rgb01.reshape(-1, 3), 99.75, axis=0)
    span = np.maximum(hi - lo, 1e-4)
    stretched = np.clip((rgb01 - lo) / span, 0, 1)
    return to_display_u8(stretched)


# ---------------------------------------------------------------------------
# Neutral detail measurement and assisted gray balance
# ---------------------------------------------------------------------------


@dataclass
class NeutralStat:
    patch_id: int
    rect: NormRect
    pixel_count: int
    source_mean: np.ndarray
    source_chroma_median: float
    source_relative_median: float
    pregray_mean: np.ndarray
    pregray_chroma_median: float
    pregray_relative_median: float
    final_mean: np.ndarray
    final_chroma_median: float
    final_relative_median: float
    final_neutral_fraction: float
    final_clipped_fraction: float


@dataclass
class NeutralReport:
    items: list[NeutralStat] = field(default_factory=list)

    @property
    def count(self) -> int:
        return len(self.items)

    def aggregate(self) -> dict[str, float]:
        if not self.items:
            return {
                "source_chroma": math.nan,
                "pregray_chroma": math.nan,
                "final_chroma": math.nan,
                "neutral_fraction": math.nan,
                "clipped_fraction": math.nan,
            }
        weights = np.array([max(item.pixel_count, 1) for item in self.items], dtype=float)
        weights /= weights.sum()
        keys = [
            ("source_chroma", "source_chroma_median"),
            ("source_relative", "source_relative_median"),
            ("pregray_chroma", "pregray_chroma_median"),
            ("pregray_relative", "pregray_relative_median"),
            ("final_chroma", "final_chroma_median"),
            ("final_relative", "final_relative_median"),
            ("neutral_fraction", "final_neutral_fraction"),
            ("clipped_fraction", "final_clipped_fraction"),
        ]
        return {
            out_key: float(sum(w * getattr(item, attr) for w, item in zip(weights, self.items)))
            for out_key, attr in keys
        }

    def summary_text(self) -> str:
        if not self.items:
            return "尚未选择中性样本。"
        a = self.aggregate()
        return (
            f"中性块 {self.count} 个｜相对偏色 原片 {a['source_relative']:.0%} → "
            f"去底反相 {a['pregray_relative']:.1%} → 校正后 {a['final_relative']:.1%}\n"
            f"绝对色差 {a['source_chroma']:.3f} / {a['pregray_chroma']:.3f} / {a['final_chroma']:.3f}；"
            f"校正后近中性像素 {a['neutral_fraction']:.1%}，截断 {a['clipped_fraction']:.1%}"
        )


def _chroma(rgb: np.ndarray) -> np.ndarray:
    return rgb.max(axis=-1) - rgb.min(axis=-1)


def _relative_chroma(rgb: np.ndarray) -> np.ndarray:
    # Ratios matter in the dark orange negative: an absolute delta of 0.03 can
    # still be a strong cast when the mean is only 0.05.
    mean = rgb.mean(axis=-1)
    return _chroma(rgb) / np.maximum(mean, 1e-3)


def measure_neutral(
    doc: ImageDoc,
    patches: Iterable[SamplePatch],
    params: ConvertParams,
    neutral_tolerance: float = 0.035,
) -> NeutralReport:
    report = NeutralReport()
    for patch in patches:
        if patch.kind != "neutral":
            continue
        source = doc.roi_float(patch.rect)
        if source.size == 0:
            continue
        pregray, _ = tone_before_gray(source, params)
        final = pregray * params.clamped().gray_array().reshape(1, 1, 3)
        source_c = _chroma(source)
        source_rel = _relative_chroma(source)
        pre_c = _chroma(pregray)
        pre_rel = _relative_chroma(pregray)
        final_c = _chroma(final)
        final_rel = _relative_chroma(final)
        clipped = np.any((final > 1.0 + 1e-6) | (final < -1e-6), axis=-1)
        luma = 0.2126 * final[..., 0] + 0.7152 * final[..., 1] + 0.0722 * final[..., 2]
        measurable = (~clipped) & (luma > 0.035) & (luma < 0.985)
        if np.any(measurable):
            neutral_fraction = float(np.count_nonzero(final_c[measurable] <= neutral_tolerance) / np.count_nonzero(measurable))
        else:
            neutral_fraction = 0.0

        flat_final = np.clip(final.reshape(-1, 3), 0, 1)
        report.items.append(
            NeutralStat(
                patch_id=patch.id,
                rect=patch.rect,
                pixel_count=int(source.reshape(-1, 3).shape[0]),
                source_mean=source.reshape(-1, 3).mean(axis=0),
                source_chroma_median=float(np.median(source_c)),
                source_relative_median=float(np.median(source_rel)),
                pregray_mean=pregray.reshape(-1, 3).mean(axis=0),
                pregray_chroma_median=float(np.median(pre_c)),
                pregray_relative_median=float(np.median(pre_rel)),
                final_mean=flat_final.mean(axis=0),
                final_chroma_median=float(np.median(final_c)),
                final_relative_median=float(np.median(final_rel)),
                final_neutral_fraction=neutral_fraction,
                final_clipped_fraction=float(clipped.mean()),
            )
        )
    return report


def suggest_neutral_gray(
    doc: ImageDoc,
    patches: Iterable[SamplePatch],
    params: ConvertParams,
) -> tuple[tuple[float, float, float], str]:
    """Solve channel gains that make selected neutral details equal-valued."""

    medians: list[np.ndarray] = []
    counts: list[int] = []
    for patch in patches:
        if patch.kind != "neutral":
            continue
        source = doc.roi_float(patch.rect)
        if source.size == 0:
            continue
        shaped, _ = tone_before_gray(source, params)
        flat = shaped.reshape(-1, 3)
        # Median is robust to a few dust/highlight pixels inside the detail.
        medians.append(np.median(flat, axis=0))
        counts.append(flat.shape[0])

    if not medians:
        return params.gray, "请先框选至少一块已知应为中性的细节。"

    weights = np.asarray(counts, dtype=np.float64)
    weights /= weights.sum()
    channel_value = np.zeros(3, dtype=np.float64)
    for w, med in zip(weights, medians):
        channel_value += w * med.astype(np.float64)

    if np.min(channel_value) < 1e-4:
        return params.gray, "中性样本过暗或端点过重，某通道已无可用层次；请先拉回暗/亮端点。"

    target = float(channel_value.mean())
    gains = target / channel_value
    gains = np.clip(gains, 0.2, 4.0)
    text = f"建议灰平衡倍率 R={gains[0]:.3f}, G={gains[1]:.3f}, B={gains[2]:.3f}"
    return tuple(float(x) for x in gains), text
