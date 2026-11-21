"""工程模型: 原始音频、检测结果、候选编辑与修复状态."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .dsp import (DetectParams, detect, merge_spans, repair_channel,
                  region_error_db)
from .wavio import WavData, snap_to_grid


@dataclass
class Candidate:
    id: int
    channel: int
    start: int
    end: int
    peak_frame: int
    deviation_db: float
    z_score: float
    background_db: float
    slope_db: float
    kind: str                      # "spike" | "protected"
    reason: str
    state: str = "pending"         # pending | accepted | rejected
    merged_from: tuple[int, ...] = ()

    @property
    def width(self) -> int:
        return self.end - self.start + 1

    @property
    def is_spike(self) -> bool:
        return self.kind == "spike"

    def clone(self) -> "Candidate":
        return Candidate(**self.__dict__)


class Project:
    """一个 WAV 文件及其编辑状态; 所有修复都在内存中预览, 导出时才落盘."""

    def __init__(self) -> None:
        self.original: WavData | None = None
        self.path: str | None = None
        self.params = DetectParams()
        self.method = "linear"
        self.candidates: dict[int, Candidate] = {}
        self._next_id = 1
        self.merge_log: list[str] = []
        self.detect_note: str = ""
        self.preview_candidate: int | None = None
        self.include_preview: bool = True
        self.reference: WavData | None = None   # 可选的干净参考 (用于误差统计)
        self._repaired_cache: np.ndarray | None = None
        self._cache_key = None
        self._undo: list[tuple[dict[int, Candidate], int]] = []

    # ------------------------------------------------------------------ 载入
    def load(self, wav: WavData, path: str | None = None,
             reference: WavData | None = None) -> None:
        # 量化到位深网格, 保证未修改区间导出后逐位一致
        wav = snap_to_grid(wav)
        self.original = wav.copy()
        self.path = path
        self.reference = None
        if reference is not None and reference.frames == wav.frames \
                and reference.channels == wav.channels:
            self.reference = snap_to_grid(reference)
        self.candidates.clear()
        self._next_id = 1
        self.merge_log.clear()
        self.detect_note = ""
        self.preview_candidate = None
        self._undo.clear()
        self._invalidate()

    @property
    def loaded(self) -> bool:
        return self.original is not None

    @property
    def frames(self) -> int:
        return self.original.frames if self.original else 0

    @property
    def channels(self) -> int:
        return self.original.channels if self.original else 0

    @property
    def sample_rate(self) -> int:
        return self.original.sample_rate if self.original else 0

    # ------------------------------------------------------------------ 撤销
    def snapshot(self) -> None:
        self._undo.append(({cid: c.clone() for cid, c in self.candidates.items()},
                           self._next_id))
        if len(self._undo) > 100:
            self._undo.pop(0)

    def undo(self) -> bool:
        if not self._undo:
            return False
        cands, next_id = self._undo.pop()
        self.candidates = cands
        self._next_id = next_id
        self.merge_log.clear()
        self._invalidate()
        return True

    # ------------------------------------------------------------------ 检测
    def run_detection(self, channel: int | None = None) -> dict[str, int]:
        if self.original is None:
            return {}
        self.snapshot()
        result = detect(self.original.samples, self.params, channel=channel)
        if channel is None:
            self.candidates.clear()
        else:
            self.candidates = {cid: c for cid, c in self.candidates.items()
                               if c.channel != channel}
        count = 0
        for det in result.detections():
            self.candidates[self._next_id] = Candidate(
                id=self._next_id,
                channel=det.channel,
                start=det.start,
                end=det.end,
                peak_frame=det.peak_frame,
                deviation_db=det.deviation_db,
                z_score=det.z_score,
                background_db=det.background_db,
                slope_db=det.slope_db,
                kind=det.kind,
                reason=det.reason,
            )
            self._next_id += 1
            count += 1
        merged = 0
        for ch in range(self.channels):
            merged += len(self._merge_channel(ch))
        self.detect_note = (
            f"标记 {count} 个事件: 可修复 {len(self.spikes)} / 待确认 {len(self.protected)}"
            + (f"; 合并重叠候选 {merged} 处" if merged else "")
        )
        for c in self.candidates.values():
            if c.kind != "spike" and c.state == "accepted":
                c.state = "pending"
        self._invalidate()
        return {"total": count, "spike": len(self.spikes),
                "protected": len(self.protected), "merged": merged}

    # ------------------------------------------------------------------ 查询
    @property
    def spikes(self) -> list[Candidate]:
        return [c for c in self.sorted_candidates() if c.kind == "spike"]

    @property
    def protected(self) -> list[Candidate]:
        return [c for c in self.sorted_candidates() if c.kind == "protected"]

    def sorted_candidates(self, channel: int | None = None) -> list[Candidate]:
        items = [c for c in self.candidates.values()
                 if channel is None or c.channel == channel]
        return sorted(items, key=lambda c: (c.channel, c.start, c.id))

    def candidate(self, cid: int) -> Candidate | None:
        return self.candidates.get(cid)

    def accepted(self, channel: int | None = None) -> list[Candidate]:
        return [c for c in self.sorted_candidates(channel) if c.state == "accepted"]

    def applied_spans(self) -> dict[int, list[tuple[int, int]]]:
        out: dict[int, list[tuple[int, int]]] = {}
        for ch in range(self.channels):
            spans = [(c.start, c.end) for c in self.accepted(ch)]
            out[ch] = merge_spans(spans, gap=0)[0]
        return out

    # ------------------------------------------------------------------ 编辑
    def accept(self, cid: int) -> bool:
        c = self.candidates.get(cid)
        if c is None:
            return False
        self.snapshot()
        c.state = "accepted"
        self._merge_channel(c.channel, keep=cid)
        self._invalidate()
        return True

    def reject(self, cid: int) -> bool:
        c = self.candidates.get(cid)
        if c is None:
            return False
        self.snapshot()
        c.state = "rejected"
        self._invalidate()
        return True

    def reset(self, cid: int) -> bool:
        c = self.candidates.get(cid)
        if c is None:
            return False
        self.snapshot()
        c.state = "pending"
        self._invalidate()
        return True

    def accept_all(self, channel: int | None = None) -> int:
        self.snapshot()
        n = 0
        for c in self.sorted_candidates(channel):
            if c.kind == "spike" and c.state == "pending":
                c.state = "accepted"
                n += 1
        for ch in range(self.channels):
            self._merge_channel(ch)
        self._invalidate()
        return n

    def reject_all(self, channel: int | None = None) -> int:
        self.snapshot()
        n = 0
        for c in self.sorted_candidates(channel):
            if c.state != "rejected":
                c.state = "rejected"
                n += 1
        self._invalidate()
        return n

    def set_range(self, cid: int, start: int, end: int) -> list[int]:
        """手工调整修复范围; 与同声道其他候选重叠时自动合并.

        返回被合并掉的候选 id 列表 (供界面提示).
        """
        c = self.candidates.get(cid)
        if c is None or self.original is None:
            return []
        self.snapshot()
        n = self.frames
        start = int(np.clip(start, 0, n - 1))
        end = int(np.clip(end, 0, n - 1))
        if end < start:
            start, end = end, start
        c.start, c.end = start, end
        c.peak_frame = int(np.clip(c.peak_frame, start, end))
        removed = self._merge_channel(c.channel, keep=cid)
        self._invalidate()
        return removed

    def overlapping_pairs(self, cid: int, start: int, end: int) -> list[Candidate]:
        """预览某范围会与哪些候选重叠 (用于界面先提示再合并)."""
        c = self.candidates.get(cid)
        if c is None:
            return []
        return [o for o in self.sorted_candidates(c.channel)
                if o.id != cid and not (o.end < start or o.start > end)]

    def _merge_channel(self, channel: int, keep: int | None = None) -> list[int]:
        """合并同声道内相互重叠的候选; 相邻但不相交的保持独立."""
        removed: list[int] = []
        while True:
            items = self.sorted_candidates(channel)
            pair = None
            for a, b in zip(items, items[1:]):
                if b.start <= a.end:
                    pair = (a, b)
                    break
            if pair is None:
                break
            a, b = pair
            if keep is not None and a.id == keep:
                target, other = a, b
            elif keep is not None and b.id == keep:
                target, other = b, a
            else:
                target, other = a, b
            self._merge_into(target, other)
            removed.append(other.id)
        return removed

    def _merge_into(self, target: Candidate, other: Candidate) -> None:
        if other.id not in self.candidates or target.id not in self.candidates:
            return
        if other.id == target.id:
            return
        target.start = min(target.start, other.start)
        target.end = max(target.end, other.end)
        if other.deviation_db > target.deviation_db:
            target.peak_frame = other.peak_frame
            target.deviation_db = other.deviation_db
            target.z_score = other.z_score
        target.peak_frame = int(np.clip(target.peak_frame, target.start, target.end))
        # 保守: 任一候选为 protected, 合并结果仍为 protected
        if "protected" in (target.kind, other.kind):
            target.kind = "protected"
        if other.state == "accepted" or target.state == "accepted":
            target.state = "accepted"
        elif target.state == "pending" or other.state == "pending":
            target.state = "pending"
        else:
            target.state = "rejected"
        target.merged_from = tuple(sorted(set(target.merged_from) | {other.id}
                                          | set(other.merged_from)))
        target.reason = f"{target.reason}; 已合并 #{other.id}"
        del self.candidates[other.id]
        self.merge_log.append(
            f"候选 #{other.id} 与 #{target.id} 重叠 -> 合并为 #{target.id} "
            f"[{target.start}, {target.end}]"
        )

    def merge_all_overlaps(self) -> int:
        self.snapshot()
        before = len(self.candidates)
        for ch in range(self.channels):
            self._merge_channel(ch)
        if len(self.candidates) != before:
            self._invalidate()
        return before - len(self.candidates)

    # ------------------------------------------------------------------ 修复
    def _invalidate(self) -> None:
        self._repaired_cache = None
        self._cache_key = None

    def _cache_key_value(self):
        spans = tuple((ch, tuple(s)) for ch, s in self.applied_spans().items())
        preview = None
        if self.include_preview and self.preview_candidate is not None:
            c = self.candidates.get(self.preview_candidate)
            if c is not None and c.state != "rejected":
                preview = (c.channel, c.start, c.end, c.kind)
        return spans, self.method, preview

    def repaired_samples(self, include_preview: bool | None = None) -> np.ndarray:
        """已接受区间的修复结果; 可选择把当前高亮候选的修复也叠加用于试听."""
        if self.original is None:
            raise RuntimeError("尚未载入音频")
        if include_preview is None:
            include_preview = self.include_preview
        key = self._cache_key_value() if include_preview else (
            tuple((ch, tuple(s)) for ch, s in self.applied_spans().items()), self.method, None)
        if self._repaired_cache is not None and self._cache_key == key:
            return self._repaired_cache
        spans = {ch: list(s) for ch, s in self.applied_spans().items()}
        if include_preview and self.preview_candidate is not None:
            c = self.candidates.get(self.preview_candidate)
            if c is not None and c.state != "rejected":
                spans[c.channel] = merge_spans(
                    spans.get(c.channel, []) + [(c.start, c.end)], gap=0)[0]
        out = self.original.samples.copy()
        for ch, ch_spans in spans.items():
            if ch_spans:
                out[:, ch] = repair_channel(out[:, ch], ch_spans, self.method)
        self._repaired_cache = out
        self._cache_key = key
        return out

    def preview_wav(self, include_preview: bool = False) -> WavData:
        if self.original is None:
            raise RuntimeError("尚未载入音频")
        return WavData(self.repaired_samples(include_preview),
                       self.original.sample_rate, self.original.bits_per_sample,
                       self.original.audio_format)

    def region_playback(self, start: int, end: int, use_repaired: bool) -> WavData:
        """截取同一帧区间的原声/修复信号, 保证 A/B 试听位置完全一致."""
        if self.original is None:
            raise RuntimeError("尚未载入音频")
        start = max(0, min(start, self.frames))
        end = max(start, min(end, self.frames))
        samples = (self.repaired_samples(include_preview=True)
                   if use_repaired else self.original.samples)
        seg = np.ascontiguousarray(samples[start:end])
        return WavData(seg, self.original.sample_rate, self.original.bits_per_sample,
                       self.original.audio_format)

    def verification(self) -> dict:
        """当前修复状态的客观校验."""
        if self.original is None:
            return {}
        base = self.original.samples
        rep = self.repaired_samples(include_preview=False)
        spans = self.applied_spans()
        mask = np.zeros(self.frames, dtype=bool)
        for ch_spans in spans.values():
            for a, b in ch_spans:
                mask[max(0, a):min(self.frames, b + 1)] = True
        outside = ~mask
        outside_changed = int(np.count_nonzero(
            np.any(rep[outside] != base[outside], axis=1)))
        per_channel = {}
        for ch, ch_spans in spans.items():
            if ch_spans:
                change_rms, change_peak = region_error_db(rep, base, ch_spans, ch)
                entry = {"rms_db": change_rms, "peak_db": change_peak,
                         "spans": ch_spans}
                if self.reference is not None:
                    after_rms, after_peak = region_error_db(
                        rep, self.reference.samples, ch_spans, ch)
                    before_rms, before_peak = region_error_db(
                        base, self.reference.samples, ch_spans, ch)
                    entry.update({
                        "ref_after_rms_db": after_rms,
                        "ref_after_peak_db": after_peak,
                        "ref_before_rms_db": before_rms,
                        "ref_before_peak_db": before_peak,
                    })
                per_channel[ch] = entry
        return {
            "spans": spans,
            "outside_changed": outside_changed,
            "per_channel": per_channel,
            "repaired": rep,
        }

    def export(self, path: str) -> dict:
        if self.original is None:
            raise RuntimeError("尚未载入音频")
        from .wavio import load_wav, save_wav
        wav = self.preview_wav(include_preview=False)
        save_wav(path, wav)
        check = load_wav(path)
        mask = np.zeros(self.frames, dtype=bool)
        for ch_spans in self.applied_spans().values():
            for a, b in ch_spans:
                mask[max(0, a):min(self.frames, b + 1)] = True
        outside = ~mask
        changed = int(np.count_nonzero(
            np.any(check.samples[outside] != self.original.samples[outside], axis=1)
        ))
        return {
            "path": path,
            "outside_changed": changed,
            "frames": check.frames,
            "channels": check.channels,
            "bits": check.bits_per_sample,
            "shape_ok": check.frames == self.frames and check.channels == self.channels,
        }
