"""BVD (block video draft) 自定义实验容器格式。

布局:
  文件头  HEADER_STRUCT
  帧记录  FRAME_STRUCT + payload, 重复 N 次

每帧要么是关键帧(整块画面 zlib 压缩的 RGBA),
要么是增量帧(若干变化小块, 每块自带坐标/尺寸, 边缘块宽高不足一块也照常记录)。
每条帧记录带 CRC32, 解码端据此识别损坏数据并重新同步。
"""
import struct
import zlib

MAGIC_FILE = b"BVD1"
MAGIC_FRAME = b"FRM0"

PIX_FMT_RGBA = 0

FRAME_KEY = 0
FRAME_DELTA = 1

# magic, pixfmt, width, height, fps_num, fps_den, block_w, block_h, keyint, frame_count
HEADER_STRUCT = struct.Struct("<4sB8H")
# magic, frame_index, pts_ms, frame_type, block_count, payload_len, raw_len, crc32(payload)
FRAME_STRUCT = struct.Struct("<4sIqBHIII")
# x, y, w, h, compressed_len
BLOCK_STRUCT = struct.Struct("<HHHHI")


def write_header(w, h, fps_num, fps_den, block_w, block_h, keyint, frame_count):
    return HEADER_STRUCT.pack(
        MAGIC_FILE, PIX_FMT_RGBA, w, h, fps_num, fps_den,
        block_w, block_h, keyint, frame_count,
    )


def read_header(buf):
    (magic, pixfmt, w, h, fps_num, fps_den,
     block_w, block_h, keyint, frame_count) = HEADER_STRUCT.unpack(buf)
    if magic != MAGIC_FILE:
        raise ValueError("not a BVD file")
    if pixfmt != PIX_FMT_RGBA:
        raise ValueError("unsupported pixel format")
    return {
        "width": w, "height": h,
        "fps_num": fps_num, "fps_den": fps_den,
        "block_w": block_w, "block_h": block_h,
        "keyint": keyint, "frame_count": frame_count,
    }


def pack_key_payload(frame_rgba: bytes) -> bytes:
    return zlib.compress(frame_rgba, 6)


def pack_delta_payload(blocks) -> bytes:
    """blocks: list of (x, y, w, h, raw_bytes)"""
    out = bytearray()
    for x, y, w, h, raw in blocks:
        comp = zlib.compress(raw, 6)
        out += BLOCK_STRUCT.pack(x, y, w, h, len(comp))
        out += comp
    return bytes(out)


def unpack_delta_payload(payload: bytes):
    blocks = []
    off = 0
    while off < len(payload):
        x, y, w, h, clen = BLOCK_STRUCT.unpack_from(payload, off)
        off += BLOCK_STRUCT.size
        comp = payload[off:off + clen]
        if len(comp) != clen:
            raise ValueError("truncated block data")
        off += clen
        raw = zlib.decompress(comp)
        if len(raw) != w * h * 4:
            raise ValueError("block size mismatch")
        blocks.append((x, y, w, h, raw))
    return blocks


def write_frame_record(frame_index, pts_ms, frame_type, block_count, payload):
    crc = zlib.crc32(payload) & 0xFFFFFFFF
    head = FRAME_STRUCT.pack(
        MAGIC_FRAME, frame_index, pts_ms, frame_type,
        block_count, len(payload), 0, crc,
    )
    return head + payload


def parse_frame_record(buf, offset):
    """在 offset 处解析一条帧记录。返回 (info_dict, next_offset)。
    校验失败抛 ValueError。"""
    if offset + FRAME_STRUCT.size > len(buf):
        raise ValueError("eof")
    (magic, frame_index, pts_ms, frame_type,
     block_count, payload_len, _raw_len, crc) = FRAME_STRUCT.unpack_from(buf, offset)
    if magic != MAGIC_FRAME:
        raise ValueError("bad frame magic")
    end = offset + FRAME_STRUCT.size + payload_len
    if end > len(buf):
        raise ValueError("truncated payload")
    payload = buf[offset + FRAME_STRUCT.size:end]
    if (zlib.crc32(payload) & 0xFFFFFFFF) != crc:
        raise ValueError("crc mismatch")
    info = {
        "frame_index": frame_index,
        "pts_ms": pts_ms,
        "frame_type": frame_type,
        "block_count": block_count,
        "payload_len": payload_len,
        "payload": payload,
        "offset": offset,
        "record_len": FRAME_STRUCT.size + payload_len,
    }
    return info, end
