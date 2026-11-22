"""解码器: 扫描 .bvd 建立帧索引, 从最近关键帧无损重建任意帧。

损坏处理: 帧记录 magic/长度/CRC 任一不符即标记为损坏, 扫描时跳到下一个
FRM0 magic 重新同步; 从损坏点到下一个完好关键帧之间的帧都标记为受影响。
"""
import zlib

import numpy as np

from . import container


class CorruptError(Exception):
    """请求的帧落在损坏影响范围内。"""

    def __init__(self, frame_index, ranges):
        self.frame_index = frame_index
        self.ranges = ranges
        super().__init__(f"frame {frame_index} 受损坏数据影响, 范围: {ranges}")


class FrameInfo:
    __slots__ = ("index", "pts_ms", "type", "block_count", "payload_len",
                 "offset", "record_len", "valid", "affected")

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))

    @property
    def is_key(self):
        return self.type == container.FRAME_KEY


class Decoder:
    def __init__(self, path):
        with open(path, "rb") as f:
            self._buf = f.read()
        if len(self._buf) < container.HEADER_STRUCT.size:
            raise ValueError("文件太小, 不是有效的 BVD")
        self.header = container.read_header(
            self._buf[:container.HEADER_STRUCT.size])
        self.width = self.header["width"]
        self.height = self.header["height"]
        self.declared_frames = self.header["frame_count"]
        self.frames = []            # FrameInfo, 按 frame_index 升序(可能有缺号)
        self._by_index = {}
        self.corrupt_records = []   # 扫描中发现的损坏记录
        self._scan()
        self.affected_ranges = self._compute_affected()
        for fi in self.frames:
            fi.affected = any(lo <= fi.index < hi
                              for lo, hi in self.affected_ranges)
        self._cache_idx = -1
        self._cache_frame = None

    # ---- 扫描与索引 ----

    def _scan(self):
        buf = self._buf
        off = container.HEADER_STRUCT.size
        while off < len(buf):
            try:
                rec, next_off = container.parse_frame_record(buf, off)
            except ValueError as e:
                if str(e) == "eof":
                    break
                nxt = buf.find(container.MAGIC_FRAME, off + 1)
                self.corrupt_records.append(
                    {"offset": off, "reason": str(e),
                     "resync": nxt if nxt != -1 else len(buf)})
                if nxt == -1:
                    break
                off = nxt
                continue
            idx = rec["frame_index"]
            if idx not in self._by_index:
                fi = FrameInfo(
                    index=idx, pts_ms=rec["pts_ms"], type=rec["frame_type"],
                    block_count=rec["block_count"],
                    payload_len=rec["payload_len"],
                    offset=rec["offset"], record_len=rec["record_len"],
                    valid=True, affected=False)
                self._by_index[idx] = fi
                self.frames.append(fi)
            off = next_off
        self.frames.sort(key=lambda f: f.index)

    def _compute_affected(self):
        """每处损坏: 影响 [损坏点前最后一个有效帧+1, 之后第一个完好关键帧)。"""
        ranges = []
        for bad in self.corrupt_records:
            prev_valid = [f.index for f in self.frames
                          if f.offset < bad["offset"]]
            lo = (prev_valid[-1] + 1) if prev_valid else 0
            hi = None
            for f in self.frames:
                if f.offset > bad["offset"] and f.is_key:
                    hi = f.index
                    break
            if hi is None:
                hi = self.declared_frames or (
                    self.frames[-1].index + 1 if self.frames else lo)
            if hi > lo:
                ranges.append((lo, hi))
        return ranges

    def is_affected(self, n):
        return any(lo <= n < hi for lo, hi in self.affected_ranges)

    @property
    def max_frame(self):
        if self.declared_frames:
            return self.declared_frames - 1
        return self.frames[-1].index if self.frames else -1

    # ---- 解码 ----

    def _payload_of(self, fi):
        start = fi.offset + container.FRAME_STRUCT.size
        return self._buf[start:start + fi.payload_len]

    def _apply(self, frame, fi):
        payload = self._payload_of(fi)
        if fi.is_key:
            raw = zlib.decompress(payload)
            if len(raw) != self.width * self.height * 4:
                raise ValueError("关键帧尺寸不符")
            return np.frombuffer(raw, dtype=np.uint8).reshape(
                self.height, self.width, 4).copy()
        for x, y, w, h, raw in container.unpack_delta_payload(payload):
            frame[y:y + h, x:x + w] = np.frombuffer(
                raw, dtype=np.uint8).reshape(h, w, 4)
        return frame

    def get_frame(self, n):
        """重建第 n 帧, 返回 (H, W, 4) uint8。受影响/缺失帧抛 CorruptError。"""
        if not self.frames:
            raise ValueError("没有可用帧")
        if n < 0 or n > self.max_frame:
            raise ValueError(f"帧号越界: {n}")
        if self.is_affected(n) or n not in self._by_index:
            raise CorruptError(n, self.affected_ranges or [(n, n + 1)])
        fi = self._by_index[n]

        # <= n 的最近完好关键帧
        key_idx = n
        while key_idx > 0 and not (
                key_idx in self._by_index and self._by_index[key_idx].is_key):
            key_idx -= 1
        if self.is_affected(key_idx) or key_idx not in self._by_index:
            raise CorruptError(n, self.affected_ranges)

        # 增量缓存: 同一关键帧段内顺序访问可直接续用
        if self._cache_frame is not None and key_idx <= self._cache_idx < n:
            # 确认中间没有缺号
            if all(i in self._by_index
                   for i in range(self._cache_idx + 1, n + 1)):
                frame = self._cache_frame
                start = self._cache_idx + 1
            else:
                frame, start = None, key_idx
        else:
            frame, start = None, key_idx
        for i in range(start, n + 1):
            frame = self._apply(frame, self._by_index[i])
        self._cache_idx = n
        self._cache_frame = frame
        return frame.copy()

    def frame_blocks(self, n):
        """第 n 帧实际保存的小块矩形 [(x, y, w, h)], 关键帧返回整幅。"""
        fi = self._by_index[n]
        if fi.is_key:
            return [(0, 0, self.width, self.height)]
        payload = self._payload_of(fi)
        return [(x, y, w, h)
                for x, y, w, h, _ in container.unpack_delta_payload(payload)]

    def stats(self):
        key_bytes = sum(f.record_len for f in self.frames if f.is_key)
        delta_bytes = sum(f.record_len for f in self.frames if not f.is_key)
        return {
            "frames": len(self.frames),
            "declared_frames": self.declared_frames,
            "key_frames": sum(1 for f in self.frames if f.is_key),
            "delta_frames": sum(1 for f in self.frames if not f.is_key),
            "key_bytes": key_bytes,
            "delta_bytes": delta_bytes,
            "file_bytes": len(self._buf),
            "raw_bytes": self.width * self.height * 4 * len(self.frames),
            "blocks_saved": sum(f.block_count for f in self.frames),
            "affected_ranges": list(self.affected_ranges),
            "corrupt_records": list(self.corrupt_records),
        }
