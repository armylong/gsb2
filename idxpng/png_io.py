"""索引色 PNG 的读取、写出与回读核对。

读取用 Pillow(能把 1/2/4/8 位索引全部解包成每像素一字节),
但 PLTE / tRNS / IHDR 以我们自己解析的 chunk 为准, 从而:
- 拿到 PLTE 的真实条目数(不被 Pillow 补成 768 项迷惑);
- 拿到每个色号的精确 alpha(tRNS);
- 知道原始位深。

写出使用自带的极简 PNG 编码器, 只写 color type 3(索引色),
PLTE 原样保留每一个槽位 —— 即使两个槽位 RGB 完全相同也绝不合并,
tRNS 逐槽位写出 alpha, 并支持 4 位打包(奇数宽行尾补半字节)。
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional, Union

from PIL import Image

from .model import MISSING_RGBA, IndexedImage, RGBA

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PathLike = Union[str, Path]


class PngIoError(Exception):
    """PNG 读写错误。"""


class NotIndexedPngError(PngIoError):
    """打开的不是索引色(P 模式 / color type 3)图。现有编辑应被保留。"""

    def __init__(self, path: PathLike, mode: str, color_type: Optional[int] = None):
        self.path = str(path)
        self.mode = mode
        self.color_type = color_type
        super().__init__(f"{path} 不是索引色 PNG (Pillow mode={mode!r}, color_type={color_type})")

    def user_message(self) -> str:
        mode_desc = {
            "RGBA": "RGBA 真彩 + Alpha 透明",
            "RGB": "RGB 真彩(无调色板)",
            "L": "8 位灰度",
            "LA": "灰度 + Alpha",
            "1": "二值图",
            "CMYK": "CMYK 印刷色",
        }.get(self.mode, f"{self.mode} 模式")
        return (
            f"这个文件是「{mode_desc}」，不是索引色 PNG。\n\n"
            "它内部没有色表，也没有保存“每个像素选的是第几号色”，"
            "直接载入只能靠量化/猜最近色生成一张新色表，"
            "还可能把两个恰好同色的编号合并，无法保证色号语义。\n\n"
            "为了不破坏你当前的编辑，本次打开已被取消，现有内容原样保留。\n"
            "请改用 mode=P 的 4 位或 8 位索引色 PNG（也可以用菜单里的自带样本）。"
        )


# ---------------------------------------------------------------------------
# chunk 解析
# ---------------------------------------------------------------------------


@dataclass
class PngChunks:
    width: int = 0
    height: int = 0
    bit_depth: int = 0
    color_type: int = 0
    compression: int = 0
    filter_method: int = 0
    interlace: int = 0
    plte: Optional[list[tuple[int, int, int]]] = None
    trns: Optional[bytes] = None
    other: list[bytes] = field(default_factory=list)


def parse_chunks(source: Union[PathLike, bytes]) -> PngChunks:
    """解析 PNG 的 IHDR / PLTE / tRNS。source 可以是路径或文件字节。"""
    if isinstance(source, (str, Path)):
        data = Path(source).read_bytes()
    else:
        data = bytes(source)

    if data[:8] != PNG_SIGNATURE:
        raise PngIoError("不是合法的 PNG 文件(签名不符)")

    info = PngChunks()
    off = 8
    while off + 8 <= len(data):
        (length,) = struct.unpack(">I", data[off : off + 4])
        ctype = data[off + 4 : off + 8]
        cdata = data[off + 8 : off + 8 + length]
        # crc = data[off + 8 + length : off + 12 + length]
        off += 12 + length
        if len(cdata) != length:
            raise PngIoError(f"PNG chunk {ctype!r} 长度被截断")

        if ctype == b"IHDR":
            (
                info.width,
                info.height,
                info.bit_depth,
                info.color_type,
                info.compression,
                info.filter_method,
                info.interlace,
            ) = struct.unpack(">IIBBBBB", cdata)
        elif ctype == b"PLTE":
            if length % 3 != 0:
                raise PngIoError("PLTE 块长度不是 3 的倍数")
            info.plte = [
                (cdata[i], cdata[i + 1], cdata[i + 2]) for i in range(0, length, 3)
            ]
        elif ctype == b"tRNS":
            info.trns = cdata
        elif ctype == b"IEND":
            break
    return info


# ---------------------------------------------------------------------------
# 读取
# ---------------------------------------------------------------------------


def load_indexed_png(path: PathLike) -> IndexedImage:
    """打开 4 位或 8 位(也兼容 1/2 位)索引色 PNG。

    非 P 模式抛 NotIndexedPngError, 调用方负责保留现有编辑。
    """
    p = Path(path)
    if not p.exists():
        raise PngIoError(f"文件不存在: {p}")

    chunks = parse_chunks(p)

    with Image.open(p) as im:
        im.load()
        mode = im.mode
        if mode != "P" or chunks.color_type not in (None, 3):
            raise NotIndexedPngError(p, mode, chunks.color_type or None)

        width, height = im.size
        # P 模式 tobytes() 恒为每像素一个字节的色号(Pillow 已解包低位深)
        indices = bytearray(im.tobytes())

    # PLTE 以 chunk 为准
    if chunks.plte is not None:
        rgb_list = chunks.plte
    else:
        # 理论上 color type 3 必有 PLTE, 这里只是兜底
        with Image.open(p) as im:
            flat = im.getpalette() or []
        rgb_list = [tuple(flat[i : i + 3]) for i in range(0, len(flat) - 2, 3)]  # type: ignore[misc]
        rgb_list = rgb_list[: 1 << max(chunks.bit_depth, 8)]

    n = len(rgb_list)
    alphas = [255] * n
    if chunks.trns:
        for i, a in enumerate(chunks.trns):
            if i < n:
                alphas[i] = a

    palette: list[RGBA] = [(r, g, b, alphas[i]) for i, (r, g, b) in enumerate(rgb_list)]

    return IndexedImage(
        width=width,
        height=height,
        indices=indices,
        palette=palette,
        bit_depth=chunks.bit_depth or 8,
        source_path=str(p.resolve()),
        title=p.name,
    )


# ---------------------------------------------------------------------------
# 写出
# ---------------------------------------------------------------------------


def prepare_for_export(doc: IndexedImage) -> tuple[IndexedImage, list[str]]:
    """补齐“色表不足”的槽位, 保证输出 PNG 合法且色号一个不丢。

    缺失槽位用品红占位(只补 PLTE 长度, 绝不改动任何像素色号)。
    """
    out = doc.clone()
    notes: list[str] = []
    max_idx = out.max_index()
    need = max_idx + 1
    if need > len(out.palette):
        old_n = len(out.palette)
        for i in range(old_n, need):
            out.palette.append(MISSING_RGBA)
        gaps = out.gap_indices()
        notes.append(
            f"色表只有 {old_n} 格, 但像素用到了第 {gaps} 号; "
            f"已把 PLTE 补到 {need} 格(缺失项用品红占位), 像素编号保持不变。"
        )
    return out, notes


def resolve_bit_depth(doc: IndexedImage, preference: str = "auto") -> int:
    """preference: 'auto' | '4' | '8'。返回实际位深(这里只写 4/8)。"""
    max_idx = doc.max_index()
    if preference == "8":
        return 8
    feasible4 = max_idx <= 15 and len(doc.palette) <= 16
    if preference == "4":
        if not feasible4:
            raise PngIoError(
                f"无法输出 4 位: 最大色号 {max_idx}, 色表格数 {len(doc.palette)} "
                "(4 位最多 16 格、色号 0..15)"
            )
        return 4
    # auto: 原本是 4 位且仍然放得下就保持 4 位; 1/2 位统一升 8 位(仍是索引色)
    if doc.bit_depth == 4 and feasible4:
        return 4
    return 8


def _pack_row(row: Union[bytearray, bytes], depth: int) -> bytes:
    """把每像素一字节的色号按 depth 位大端打包(PNG 的高位在前)。"""
    if depth == 8:
        return bytes(row)
    out = bytearray()
    acc = 0
    bits = 0
    mask = (1 << depth) - 1
    for value in row:
        acc = (acc << depth) | (value & mask)
        bits += depth
        while bits >= 8:
            shift = bits - 8
            out.append((acc >> shift) & 0xFF)
            bits = shift
            acc &= (1 << bits) - 1 if bits else 0
    if bits:
        out.append((acc << (8 - bits)) & 0xFF)
    return bytes(out)


def _chunk(chunk_type: bytes, data: bytes) -> bytes:
    body = chunk_type + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def build_indexed_png_bytes(doc: IndexedImage, bit_depth: int) -> bytes:
    """把 doc 编码成索引色 PNG 字节。doc 必须已 prepare_for_export。"""
    if not 1 <= len(doc.palette) <= 256:
        raise PngIoError("PLTE 条目数必须在 1..256")
    if bit_depth == 4 and (len(doc.palette) > 16 or doc.max_index() > 15):
        raise PngIoError("4 位编码条件不满足")

    ihdr = struct.pack(
        ">IIBBBBB",
        doc.width,
        doc.height,
        bit_depth,
        3,  # color type 3 = indexed
        0,  # compression
        0,  # filter method
        0,  # interlace
    )
    plte = b"".join(bytes(c[:3]) for c in doc.palette)
    trns = bytes(c[3] for c in doc.palette)

    raw = bytearray()
    stride = doc.width
    for y in range(doc.height):
        raw.append(0)  # filter type 0 (None), 每条扫描线都要
        raw.extend(_pack_row(doc.indices[y * stride : (y + 1) * stride], bit_depth))
    idat = zlib.compress(bytes(raw), 9)

    return (
        PNG_SIGNATURE
        + _chunk(b"IHDR", ihdr)
        + _chunk(b"PLTE", plte)
        + _chunk(b"tRNS", trns)
        + _chunk(b"IDAT", idat)
        + _chunk(b"IEND", b"")
    )


def write_indexed_png(
    doc: IndexedImage,
    path: PathLike,
    bit_depth: str = "auto",
) -> tuple[Path, int, list[str]]:
    """写出索引色 PNG。返回 (路径, 实际位深, 补齐说明)。"""
    prepared, notes = prepare_for_export(doc)
    depth = resolve_bit_depth(prepared, bit_depth)
    data = build_indexed_png_bytes(prepared, depth)
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(data)
    return p, depth, notes


# ---------------------------------------------------------------------------
# 回读核对
# ---------------------------------------------------------------------------


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str = ""

    def line(self) -> str:
        mark = "PASS" if self.ok else "FAIL"
        return f"[{mark}] {self.name}" + (f" — {self.detail}" if self.detail else "")


def verify_output(path: PathLike, expected: IndexedImage) -> list[CheckResult]:
    """从磁盘重新读回文件, 逐项核对索引、色板、透明项和同色异号槽位。

    expected 应当是 prepare_for_export 之后、实际写盘的那份 doc。
    """
    p = Path(path)
    checks: list[CheckResult] = []

    def add(name: str, ok: bool, detail: str = "") -> None:
        checks.append(CheckResult(name, bool(ok), detail))

    if not p.exists():
        return [CheckResult("文件存在", False, str(p))]
    add("文件存在", True, str(p))

    raw = p.read_bytes()
    try:
        info = parse_chunks(raw)
    except Exception as exc:  # noqa: BLE001 - 核对时要把任何异常变成 FAIL 项
        add("PNG 结构解析", False, repr(exc))
        return checks
    add("PNG 签名与 chunk 结构", True, f"{info.width}x{info.height}, depth={info.bit_depth}")
    add("IHDR 颜色类型为 3(索引色)", info.color_type == 3, f"color_type={info.color_type}")
    add("宽高与期望一致", (info.width, info.height) == (expected.width, expected.height))

    # ---- Pillow 回读: 逐像素色号必须完全一致 ----
    try:
        with Image.open(p) as im:
            add("Pillow 回读模式为 P", im.mode == "P", f"mode={im.mode}")
            im.load()
            actual_indices = bytearray(im.tobytes()) if im.mode == "P" else bytearray()
    except Exception as exc:  # noqa: BLE001
        add("Pillow 回读", False, repr(exc))
        actual_indices = bytearray()

    if actual_indices:
        same = actual_indices == expected.indices
        if same:
            add("逐像素索引与输出预期完全一致", True, f"{len(actual_indices)} 个像素")
        else:
            diff = sum(a != b for a, b in zip(actual_indices, expected.indices))
            add("逐像素索引与输出预期完全一致", False, f"{diff} 个像素不一致")

    # ---- PLTE 必须逐槽位一致(重复 RGB 也保留) ----
    exp_rgb = [tuple(c[:3]) for c in expected.palette]
    if info.plte is None:
        add("PLTE 块存在", False, "缺少 PLTE")
    else:
        add("PLTE 条目数一致", len(info.plte) == len(exp_rgb),
            f"文件 {len(info.plte)} 格 / 预期 {len(exp_rgb)} 格")
        rgb_same = info.plte[: len(exp_rgb)] == exp_rgb
        add("PLTE 每格 RGB 一致(含重复色)", rgb_same)

        # 明确验证: 相同 RGB 的不同槽位没有被合并
        groups: dict[tuple[int, int, int], list[int]] = {}
        for i, rgb in enumerate(exp_rgb):
            groups.setdefault(rgb, []).append(i)
        dup_groups = {rgb: ids for rgb, ids in groups.items() if len(ids) > 1}
        if dup_groups:
            preserved = all(
                all(i < len(info.plte) and info.plte[i] == rgb for i in ids)
                for rgb, ids in dup_groups.items()
            )
            detail = "; ".join(
                f"RGB{rgb} 仍分别占据色号 {ids}" for rgb, ids in list(dup_groups.items())[:4]
            )
            add("同色但不同编号的槽位未被合并", preserved, detail)
        else:
            add("同色但不同编号的槽位未被合并", True, "本样本没有重复 RGB 槽位")

    # ---- tRNS / alpha 核对 ----
    exp_alpha = [c[3] for c in expected.palette]
    if info.trns is None:
        actual_alpha = [255] * (info.plte and len(info.plte) or 0)
    else:
        n = len(info.plte or [])
        actual_alpha = [255] * n
        for i, a in enumerate(info.trns):
            if i < n:
                actual_alpha[i] = a
    alpha_same = actual_alpha[: len(exp_alpha)] == exp_alpha
    semi = [i for i, a in enumerate(exp_alpha) if 0 < a < 255]
    transparent = [i for i, a in enumerate(exp_alpha) if a == 0]
    detail_parts = []
    if transparent:
        detail_parts.append(f"全透明色号 {transparent}")
    if semi:
        detail_parts.append(f"半透明色号 {semi} (alpha={[exp_alpha[i] for i in semi]})")
    add("tRNS 透明度逐项一致", alpha_same, "; ".join(detail_parts) or "全部不透明")

    # ---- 各色号像素数量 ----
    if actual_indices:
        actual_counts = [0] * 256
        for v in actual_indices:
            actual_counts[v] += 1
        exp_counts = expected.counts()
        used = [i for i, c in enumerate(exp_counts) if c]
        mismatch = [i for i in used if actual_counts[i] != exp_counts[i]]
        add("各索引像素数量一致", not mismatch,
            "全部一致" if not mismatch else f"色号 {mismatch} 数量不符")

    return checks


def all_passed(checks: list[CheckResult]) -> bool:
    return all(c.ok for c in checks)
