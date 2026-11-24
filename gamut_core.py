"""gamut_core — 本地色域对照工具的色彩核心.

纯 numpy 实现, 不依赖 Pillow:
- sRGB / Display P3 两个明确来源的色域定义 (D65, 各自三刺激值矩阵)
- 编码(非线性) <-> 线性 <-> XYZ(D65) <-> CIELAB/LCh
- 两种目标映射: 逐通道截断 / 保持大致色相的色度压缩 (CIELAB, 二分搜索边界)
- PNG 解码 (8/16bit, 灰度/RGB/RGBA/调色板, 非隔行) 与编码 (8bit RGB,
  带 iCCP/sRGB/tEXt 块), 以及最小可用 ICC v2 矩阵剖面生成
- 内置样图: 中性色阶 / 饱和度递进 / 鲜绿组合
- 导出验证: 重新载入 PNG, 解析色域标记并与期望值比对
"""

from __future__ import annotations

import binascii
import struct
import zlib

import numpy as np

# ---------------------------------------------------------------------------
# 色域定义
# ---------------------------------------------------------------------------

# RGB(线性) -> XYZ(D65)
M_SRGB = np.array([
    [0.41239079926595934, 0.35758433938387800, 0.18048078840183430],
    [0.21263900587151027, 0.71516867876775600, 0.07219231536073371],
    [0.01933081871559182, 0.11919477979462600, 0.95053215224966070],
])

M_P3 = np.array([
    [0.48657094864821620, 0.26566769316909306, 0.19821728523436250],
    [0.22897456406974880, 0.69173852183650640, 0.07928691409374500],
    [0.00000000000000000, 0.04511338185890264, 1.04394436890097600],
])

D65 = np.array([0.95047, 1.0, 1.08883])
D50 = np.array([0.96422, 1.0, 0.82521])

GAMUT_TOL = 1e-4  # 判定色域外的容差(线性值)


def _srgb_decode(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def _srgb_encode(c):
    c = np.asarray(c, dtype=np.float64)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(np.maximum(c, 0.0), 1 / 2.4) - 0.055)


class Gamut:
    """一个 RGB 色域: 名称、RGB->XYZ 矩阵、电光转换(两者都用 sRGB 曲线)."""

    def __init__(self, key, label, matrix, icc_desc):
        self.key = key
        self.label = label
        self.M = np.asarray(matrix, dtype=np.float64)          # linear RGB -> XYZ
        self.M_inv = np.linalg.inv(self.M)                     # XYZ -> linear RGB
        self.icc_desc = icc_desc

    def decode(self, enc):
        return _srgb_decode(enc)

    def encode(self, lin):
        return _srgb_encode(lin)


GAMUTS = {
    "srgb": Gamut("srgb", "sRGB (IEC 61966-2-1, D65)", M_SRGB, "pyGT sRGB"),
    "p3": Gamut("p3", "Display P3 (D65)", M_P3, "pyGT Display P3"),
}


# ---------------------------------------------------------------------------
# 色彩空间换算
# ---------------------------------------------------------------------------

def src_to_target_lin(src_lin, src: Gamut, tgt: Gamut):
    """源线性 RGB -> XYZ(D65) -> 目标线性 RGB (理想值, 可能超出色域)."""
    xyz = src_lin @ src.M.T
    return xyz @ tgt.M_inv.T, xyz


def in_gamut_mask(rgb_lin, tol=GAMUT_TOL):
    """逐像素布尔: 是否落在目标色域可表达范围 [0,1] 内."""
    return np.all((rgb_lin >= -tol) & (rgb_lin <= 1.0 + tol), axis=-1)


def xyz_to_lab(xyz):
    t = xyz / D65
    d = 6.0 / 29.0
    f = np.where(t > d ** 3, np.cbrt(t), t / (3 * d * d) + 4.0 / 29.0)
    L = 116.0 * f[..., 1] - 16.0
    a = 500.0 * (f[..., 0] - f[..., 1])
    b = 200.0 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def lab_to_xyz(lab):
    L, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fy = (L + 16.0) / 116.0
    fx = fy + a / 500.0
    fz = fy - b / 200.0
    d = 6.0 / 29.0

    def inv(f):
        return np.where(f > d, f ** 3, 3 * d * d * (f - 4.0 / 29.0))

    return np.stack([inv(fx) * D65[0], inv(fy) * D65[1], inv(fz) * D65[2]], axis=-1)


def map_to_gamut(tgt_lin_ideal, tgt: Gamut, method: str):
    """把目标空间的理想线性值映射进色域.

    method:
      "none"  不映射 (仅转换; 超界值原样保留, 由调用方标记/拒绝导出)
      "clip"  逐通道截断到 [0,1]
      "hue"   保持大致色相: 在 CIELAB 中固定 L* 与 h, 二分压缩 C* 到边界
    返回 (mapped_lin, oog_mask) — mapped_lin 保证在 [0,1] (method="none" 除外).
    """
    oog = ~in_gamut_mask(tgt_lin_ideal)
    if method == "none":
        return tgt_lin_ideal.copy(), oog
    if method == "clip":
        return np.clip(tgt_lin_ideal, 0.0, 1.0), oog
    if method == "hue":
        out = tgt_lin_ideal.copy()
        idx = np.where(oog.ravel())[0]
        if idx.size == 0:
            return np.clip(out, 0.0, 1.0), oog
        flat = tgt_lin_ideal.reshape(-1, 3)[idx]              # (N,3) 超界像素
        xyz = flat @ tgt.M.T
        lab = xyz_to_lab(xyz)
        L, a, b = lab[:, 0], lab[:, 1], lab[:, 2]
        C = np.hypot(a, b)
        h = np.arctan2(b, a)
        cos_h, sin_h = np.cos(h), np.sin(h)
        lo = np.zeros_like(C)
        hi = C.copy()
        # 向量化二分: 找每个像素能落入色域的最大色度
        for _ in range(28):
            mid = 0.5 * (lo + hi)
            lab_c = np.stack([L, mid * cos_h, mid * sin_h], axis=-1)
            rgb = lab_to_xyz(lab_c) @ tgt.M_inv.T
            ok = np.all((rgb >= -1e-7) & (rgb <= 1.0 + 1e-7), axis=-1)
            lo = np.where(ok, mid, lo)
            hi = np.where(ok, hi, mid)
        lab_f = np.stack([L, lo * cos_h, lo * sin_h], axis=-1)
        rgb_f = lab_to_xyz(lab_f) @ tgt.M_inv.T
        out.reshape(-1, 3)[idx] = rgb_f
        return np.clip(out, 0.0, 1.0), oog
    raise ValueError(f"未知映射方式: {method}")


def delta_e76(xyz_a, xyz_b):
    """CIE76 ΔE (在 CIELAB D65 中). xyz_a/xyz_b 同形状 (...,3)."""
    la = xyz_to_lab(xyz_a)
    lb = xyz_to_lab(xyz_b)
    return np.sqrt(np.sum((la - lb) ** 2, axis=-1))


def pipeline(src_u8, src: Gamut, tgt: Gamut, method: str):
    """完整链路. 返回 dict, 供 GUI 点读/统计/预览/导出使用."""
    src_enc = src_u8.astype(np.float64) / 255.0
    src_lin = src.decode(src_enc)
    tgt_ideal, xyz = src_to_target_lin(src_lin, src, tgt)
    mapped_lin, oog = map_to_gamut(tgt_ideal, tgt, method)
    mapped_enc = tgt.encode(np.clip(mapped_lin, 0.0, 1.0))
    mapped_u8 = np.round(mapped_enc * 255.0).astype(np.uint8)
    xyz_out = np.clip(mapped_lin, 0.0, 1.0) @ tgt.M.T
    dE = delta_e76(xyz, xyz_out)
    return {
        "src_u8": src_u8,
        "src_lin": src_lin,
        "xyz": xyz,
        "tgt_ideal": tgt_ideal,
        "oog": oog,
        "mapped_lin": mapped_lin,
        "mapped_u8": mapped_u8,
        "deltaE": dE,
    }


# ---------------------------------------------------------------------------
# 内置样图 (生成的是"编码值", 按当前来源色域解释)
# ---------------------------------------------------------------------------

def sample_neutral():
    """中性色阶: 16 级灰, 每级 48px 方块, 上下两排方向相反."""
    n, cell = 16, 48
    img = np.zeros((cell * 2, cell * n, 3), dtype=np.uint8)
    for i in range(n):
        v = round(i * 255 / (n - 1))
        img[0:cell, i * cell:(i + 1) * cell] = v
        img[cell:2 * cell, (n - 1 - i) * cell:(n - i) * cell] = v
    return img


def sample_saturation():
    """饱和度递进: 6 个色相行 (R Y G C B M) x 8 级饱和度, 从灰到纯色."""
    hues = [(1, 0, 0), (1, 1, 0), (0, 1, 0), (0, 1, 1), (0, 0, 1), (1, 0, 1)]
    steps, cell = 8, 56
    img = np.zeros((cell * len(hues), cell * steps, 3), dtype=np.uint8)
    for r, (hr, hg, hb) in enumerate(hues):
        for c in range(steps):
            s = c / (steps - 1)            # 0=中性灰 … 1=纯色
            base = 0.5
            col = [base + (h - base) * s for h in (hr, hg, hb)]
            img[r * cell:(r + 1) * cell, c * cell:(c + 1) * cell] = \
                np.round(np.array(col) * 255).astype(np.uint8)
    return img


def sample_greens():
    """鲜绿组合: 高色度绿色 4x4, 色相/明度略有差异 — 复现'几块绿看成一个色'."""
    cell = 64
    img = np.zeros((cell * 4, cell * 4, 3), dtype=np.uint8)
    for r in range(4):
        for c in range(4):
            g = 0.86 + 0.035 * r           # 绿通道 0.86~0.965
            rr = 0.02 + 0.06 * c           # 少量红
            bb = 0.05 + 0.05 * (r + c) / 6
            img[r * cell:(r + 1) * cell, c * cell:(c + 1) * cell] = \
                np.round(np.array([rr, g, bb]) * 255).astype(np.uint8)
    return img


SAMPLES = {
    "中性色阶": sample_neutral,
    "饱和度递进 (6色相x8级)": sample_saturation,
    "鲜绿组合 (高色度绿)": sample_greens,
}


# ---------------------------------------------------------------------------
# 最小 ICC v2 剖面 (矩阵 + 曲线), 供 PNG iCCP 块使用
# ---------------------------------------------------------------------------

_BRADFORD = np.array([
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
])


def _adapt_d65_to_d50(M):
    """Bradford 自适应: 把 D65 的 RGB->XYZ 矩阵换算到 D50(ICC PCS 要求)."""
    Ma = _BRADFORD
    Ma_inv = np.linalg.inv(Ma)
    src = Ma @ D65
    dst = Ma @ D50
    A = Ma_inv @ np.diag(dst / src) @ Ma
    return A @ M


def _s15(v):
    return struct.pack(">i", int(round(v * 65536)))


def _tag_xyz(xyz):
    return b"XYZ " + b"\0" * 4 + b"".join(_s15(v) for v in xyz)


def _tag_curv_srgb(n=1024):
    """sRGB 电光转换曲线 (设备值 -> 线性), curveType."""
    vals = [int(round(_srgb_decode(i / (n - 1)) * 65535)) for i in range(n)]
    return b"curv" + b"\0" * 4 + struct.pack(">I", n) + struct.pack(f">{n}H", *vals)


def _tag_desc(text):
    asc = text.encode("ascii") + b"\0"
    pad = (4 - len(asc) % 4) % 4
    return (b"desc" + b"\0" * 4 + struct.pack(">I", len(asc)) + asc + b"\0" * pad
            + struct.pack(">II", 0, 0) + struct.pack(">H", 0) + b"\0" + b"\0" * 67)


def _tag_text(text):
    return b"text" + b"\0" * 4 + text.encode("ascii") + b"\0"


def build_icc(gamut: Gamut) -> bytes:
    M50 = _adapt_d65_to_d50(gamut.M)
    tags = [
        (b"bXYZ", _tag_xyz(M50[:, 2])),
        (b"cprt", _tag_text("Public domain - generated by pyGT")),
        (b"desc", _tag_desc(gamut.icc_desc)),
        (b"gTRC", _tag_curv_srgb()),
        (b"gXYZ", _tag_xyz(M50[:, 1])),
        (b"rTRC", _tag_curv_srgb()),
        (b"rXYZ", _tag_xyz(M50[:, 0])),
        (b"wtpt", _tag_xyz(D50)),
    ]
    # bTRC 与 gTRC 相同, 复用同一数据块
    tags.insert(0, (b"bTRC", tags[3][1]))
    n = len(tags)
    offset = 128 + 4 + 12 * n
    entries, blobs = [], []
    seen = {}
    for sig, data in tags:
        if data in seen:
            off = seen[data]
        else:
            off = offset
            seen[data] = off
            blobs.append((off, data))
            offset += (len(data) + 3) & ~3
        entries.append(struct.pack(">4sII", sig, off, len(data)))
    header = bytearray(128)
    struct.pack_into(">I", header, 0, offset)          # 剖面总长度
    header[4:8] = b"pyGT"
    struct.pack_into(">I", header, 8, 0x02400000)      # ICC v2.4
    header[12:16] = b"mntr"
    header[16:20] = b"RGB "
    header[20:24] = b"XYZ "
    struct.pack_into(">6H", header, 24, 2026, 1, 1, 0, 0, 0)
    header[36:40] = b"acsp"
    struct.pack_into(">I", header, 64, 0)              # 感知意图
    struct.pack_into(">3i", header, 68,
                     int(round(D50[0] * 65536)),
                     int(round(D50[1] * 65536)),
                     int(round(D50[2] * 65536)))
    header[80:84] = b"pyGT"
    body = b"".join(entries)
    tag_data = bytearray()
    for off, data in blobs:
        tag_data += data + b"\0" * ((4 - len(data) % 4) % 4)
    return bytes(header) + struct.pack(">I", n) + body + bytes(tag_data)


def icc_read_desc(icc: bytes) -> str:
    """从 ICC 剖面中读出 desc 标签的 ASCII 描述 (找不到返回 '')."""
    try:
        n = struct.unpack_from(">I", icc, 128)[0]
        for i in range(n):
            sig, off, size = struct.unpack_from(">4sII", icc, 132 + 12 * i)
            if sig == b"desc" and icc[off:off + 4] == b"desc":
                count = struct.unpack_from(">I", icc, off + 8)[0]
                return icc[off + 12:off + 12 + max(count - 1, 0)].decode("ascii", "replace")
    except Exception:
        pass
    return ""


# ---------------------------------------------------------------------------
# PNG 读写
# ---------------------------------------------------------------------------

PNG_SIG = b"\x89PNG\r\n\x1a\n"


def _chunk(typ: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + typ + data
            + struct.pack(">I", binascii.crc32(typ + data) & 0xFFFFFFFF))


def write_png(path, rgb_u8, gamut: Gamut, extra_text=None):
    """写出 8bit RGB PNG, 带目标色域说明.

    sRGB 目标 -> sRGB 块; 其他目标 -> iCCP 块(内嵌最小 ICC 剖面).
    另写 tEXt: Target Gamut / Mapping 等说明.
    """
    h, w = rgb_u8.shape[:2]
    out = bytearray(PNG_SIG)
    out += _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
    if gamut.key == "srgb":
        out += _chunk(b"sRGB", b"\x00")               # 感知意图
        out += _chunk(b"gAMA", struct.pack(">I", 45455))
    else:
        icc = build_icc(gamut)
        out += _chunk(b"iCCP", b"ICC profile\x00\x00" + zlib.compress(icc, 9))
    texts = {"Target Gamut": gamut.label, "Software": "gamut-compare (pyGT)"}
    if extra_text:
        texts.update(extra_text)
    for k, v in texts.items():
        out += _chunk(b"tEXt", k.encode("latin-1") + b"\x00" + v.encode("latin-1"))
    raw = b"".join(b"\x00" + rgb_u8[y].tobytes() for y in range(h))
    out += _chunk(b"IDAT", zlib.compress(raw, 6))
    out += _chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(bytes(out))


class PNGError(Exception):
    """PNG 无法载入时抛出, message 即原因."""


_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


def read_png(path):
    """读入 PNG -> dict(rgb=uint8 HxWx3, icc_desc, texts, gamma, has_srgb, info).

    支持 8/16bit、灰度/RGB/RGBA/灰+alpha/调色板、非隔行.
    不支持的情况抛出 PNGError 并说明原因.
    """
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(PNG_SIG):
        raise PNGError("不是 PNG 文件 (文件头签名不符)")
    pos = len(PNG_SIG)
    idat = bytearray()
    plte = None
    ihdr = None
    icc_desc = ""
    texts = {}
    gamma = None
    has_srgb = False
    while pos + 8 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        typ = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if typ == b"IHDR":
            ihdr = struct.unpack(">IIBBBBB", body)
        elif typ == b"PLTE":
            plte = np.frombuffer(body, dtype=np.uint8).reshape(-1, 3)
        elif typ == b"IDAT":
            idat += body
        elif typ == b"iCCP":
            nul = body.index(b"\x00")
            try:
                icc_desc = icc_read_desc(zlib.decompress(body[nul + 2:]))
            except Exception:
                icc_desc = "(iCCP 解压失败)"
        elif typ == b"sRGB":
            has_srgb = True
        elif typ == b"gAMA":
            (gamma,) = struct.unpack(">I", body)
        elif typ == b"tEXt":
            nul = body.index(b"\x00")
            texts[body[:nul].decode("latin-1")] = body[nul + 1:].decode("latin-1")
        elif typ == b"IEND":
            break
    if ihdr is None:
        raise PNGError("缺少 IHDR 块")
    w, h, depth, ctype, comp, filt, interlace = ihdr
    if comp != 0 or filt != 0:
        raise PNGError(f"不支持的压缩/滤波方式 (comp={comp}, filter={filt})")
    if interlace != 0:
        raise PNGError("隔行扫描 (Adam7) PNG 暂不支持, 请先转为非隔行")
    if ctype not in _CHANNELS:
        raise PNGError(f"未知颜色类型 {ctype}")
    if depth not in (8, 16):
        raise PNGError(f"位深 {depth}bit 暂不支持 (支持 8/16bit)")
    ch = _CHANNELS[ctype]
    bpp = ch * (depth // 8)
    stride = w * bpp
    try:
        raw = zlib.decompress(bytes(idat))
    except zlib.error as e:
        raise PNGError(f"IDAT 解压失败: {e}")
    expect = (stride + 1) * h
    if len(raw) < expect:
        raise PNGError(f"像素数据长度不足 (期望 {expect}, 实际 {len(raw)})")

    # 反滤波
    out = np.zeros((h, stride), dtype=np.uint8)
    prev = np.zeros(stride, dtype=np.uint8)
    for y in range(h):
        ftype = raw[y * (stride + 1)]
        line = np.frombuffer(raw, dtype=np.uint8, count=stride,
                             offset=y * (stride + 1) + 1).copy()
        if ftype == 0:
            pass
        elif ftype == 1:  # Sub
            line = (line.reshape(-1, bpp).astype(np.uint16).cumsum(axis=0) % 256
                    ).astype(np.uint8).reshape(-1)
        elif ftype == 2:  # Up
            line = ((line.astype(np.uint16) + prev.astype(np.uint16)) % 256).astype(np.uint8)
        elif ftype == 3:  # Average
            recon = bytearray(stride)
            for i in range(stride):
                a = recon[i - bpp] if i >= bpp else 0
                recon[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
            line = np.frombuffer(bytes(recon), dtype=np.uint8)
        elif ftype == 4:  # Paeth
            recon = bytearray(stride)
            for i in range(stride):
                a = recon[i - bpp] if i >= bpp else 0
                b = int(prev[i])
                c = int(prev[i - bpp]) if i >= bpp else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                recon[i] = (line[i] + pr) & 0xFF
            line = np.frombuffer(bytes(recon), dtype=np.uint8)
        else:
            raise PNGError(f"未知滤波类型 {ftype} (第 {y} 行)")
        out[y] = line
        prev = line

    if depth == 16:
        out = out.reshape(h, w, ch * 2)[:, :, 0::2]   # 取高字节
    arr = out.reshape(h, w, ch)
    note = ""
    if ctype == 0:
        rgb = np.repeat(arr, 3, axis=2)
    elif ctype == 2:
        rgb = arr
    elif ctype == 3:
        if plte is None:
            raise PNGError("调色板 PNG 缺少 PLTE 块")
        rgb = plte[arr[:, :, 0]]
    elif ctype == 4:
        rgb = np.repeat(arr[:, :, :1], 3, axis=2)
        note = "已丢弃 alpha 通道"
    else:  # 6
        rgb = arr[:, :, :3]
        note = "已丢弃 alpha 通道"
    return {
        "rgb": np.ascontiguousarray(rgb),
        "width": w, "height": h,
        "icc_desc": icc_desc, "texts": texts,
        "gamma": gamma, "has_srgb": has_srgb,
        "note": note,
    }


# ---------------------------------------------------------------------------
# 导出验证
# ---------------------------------------------------------------------------

def verify_export(path, expected_u8=None, tgt: Gamut | None = None):
    """重新载入导出的 PNG, 返回 (ok, 报告文本)."""
    lines = [f"验证文件: {path}"]
    ok = True
    try:
        png = read_png(path)
    except PNGError as e:
        return False, f"验证失败: 无法载入 — {e}"
    lines.append(f"尺寸: {png['width']}x{png['height']}")
    # 色域标记
    if png["icc_desc"]:
        lines.append(f"内嵌 ICC 剖面描述: {png['icc_desc']}")
    elif png["has_srgb"]:
        lines.append("色域标记: sRGB 块 (IEC 61966-2-1)")
    else:
        lines.append("色域标记: 无 (未嵌入 iCCP/sRGB)")
        ok = False
    if tgt is not None:
        declared = png["texts"].get("Target Gamut", "")
        if declared == tgt.label:
            lines.append(f"tEXt 目标色域说明一致: {declared}")
        else:
            lines.append(f"目标色域说明不符: 期望 '{tgt.label}', 实际 '{declared}'")
            ok = False
    for k, v in png["texts"].items():
        lines.append(f"tEXt[{k}] = {v}")
    if png["note"]:
        lines.append(f"注意: {png['note']}")
    # 编码值比对
    if expected_u8 is not None:
        if expected_u8.shape != png["rgb"].shape:
            lines.append(f"形状不符: 期望 {expected_u8.shape}, 实际 {png['rgb'].shape}")
            ok = False
        else:
            diff = np.abs(png["rgb"].astype(int) - expected_u8.astype(int))
            lines.append(f"编码值比对: 最大差异 {diff.max()} / 平均 {diff.mean():.4f} "
                         f"(0 = 与内存中的映射结果完全一致)")
            if diff.max() > 0:
                ok = False
    # 目标色域自检: 载入值解码后必然在色域内, 这里确认无 NaN/异常
    if tgt is not None:
        lin = tgt.decode(png["rgb"].astype(np.float64) / 255.0)
        bad = int((~in_gamut_mask(lin)).sum())
        lines.append(f"目标色域自检: 超界像素 {bad} 个 (应为 0)")
        if bad:
            ok = False
    lines.append("结论: " + ("通过" if ok else "未通过"))
    return ok, "\n".join(lines)
