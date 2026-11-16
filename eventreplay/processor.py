"""处理流程: 读取来源文件 -> 归一化 -> 去重/冲突 -> 窗口统计 -> 发布。"""

from __future__ import annotations

import csv
import glob
import hashlib
import json
import os
from collections import defaultdict

from .normalize import normalize_record
from .store import Store
from .timeutil import (
    day_ceiling,
    day_floor,
    window_end_for,
    window_size_seconds,
    window_start_for,
)


def _file_checksum(path: str) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _iter_records(source_cfg: dict, path: str):
    """逐行产出 (行号, 原始记录dict)。行号从 1 开始(csv 表头占第 1 行)。"""
    fmt = source_cfg["format"]
    if fmt == "csv":
        with open(path, "r", encoding="utf-8", newline="") as fh:
            reader = csv.DictReader(fh)
            for i, row in enumerate(reader, start=2):
                yield i, dict(row)
    else:  # jsonl
        with open(path, "r", encoding="utf-8") as fh:
            for i, line in enumerate(fh, start=1):
                text = line.strip()
                if not text:
                    continue
                yield i, json.loads(text)


def ingest_sources(store: Store, cfg: dict, run_id: int, from_event_pos=None,
                   use_checkpoints: bool = True) -> dict:
    """读取所有来源文件并入库。单文件失败不影响其他文件。

    from_event_pos: (source, source_file, source_line), 跳过该位置之前的记录。
    返回统计计数。
    """
    stats = defaultdict(int)
    for src in cfg["sources"]:
        pattern = src["path"]
        if not os.path.isabs(pattern):
            pattern = os.path.join(cfg["_base_dir"], pattern)
        paths = sorted(glob.glob(pattern))
        if not paths:
            store.record_file(run_id, src["name"], pattern, None, "failed",
                              "没有匹配到文件", 0, 0)
            stats["files_failed"] += 1
            continue
        for path in paths:
            rel = os.path.relpath(path, cfg["_base_dir"])
            try:
                checksum = _file_checksum(path)
            except OSError as exc:
                store.record_file(run_id, src["name"], rel, None, "failed", str(exc), 0, 0)
                stats["files_failed"] += 1
                continue
            if use_checkpoints and store.file_already_done(src["name"], rel, checksum):
                store.record_file(run_id, src["name"], rel, checksum, "skipped",
                                  "文件未变化, 已由之前运行处理", 0, 0)
                stats["files_skipped"] += 1
                continue
            total = ok = 0
            try:
                for line_no, raw in _iter_records(src, path):
                    total += 1
                    if from_event_pos and (src["name"], rel, line_no) <= tuple(from_event_pos):
                        stats["events_before_position"] += 1
                        continue
                    try:
                        ev = normalize_record(src, raw, rel, line_no)
                    except (ValueError, KeyError, TypeError) as exc:
                        store.record_skipped(run_id, src["name"], rel, line_no,
                                             str(exc), json.dumps(raw, ensure_ascii=False, default=str))
                        stats["events_skipped"] += 1
                        continue
                    outcome = store.insert_event(run_id, ev)
                    stats[f"events_{outcome}"] += 1
                    if outcome == "inserted":
                        ok += 1
            except (OSError, UnicodeDecodeError, csv.Error, json.JSONDecodeError) as exc:
                # 文件级损坏: 记录后继续处理其他文件
                store.record_file(run_id, src["name"], rel, checksum, "failed",
                                  f"{type(exc).__name__}: {exc}", total, ok)
                stats["files_failed"] += 1
                continue
            store.record_file(run_id, src["name"], rel, checksum, "ok", None, total, ok)
            store.set_checkpoint(src["name"], rel, checksum, total)
            stats["files_ok"] += 1
    store.conn.commit()
    return stats


def compute_windows(store: Store, cfg: dict, run_id: int,
                    range_start: str, range_end: str) -> int:
    """对 [range_start, range_end) 范围内的事件按业务键+窗口聚合。返回窗口数。"""
    size = window_size_seconds(cfg["window"])
    buckets = defaultdict(lambda: {"cnt": 0, "amount_sum": 0.0, "status": defaultdict(int)})
    members = defaultdict(list)
    for ev in store.events_in_range(range_start, range_end):
        w_start = window_start_for(ev["biz_time"], size)
        key = (ev["biz_key"], w_start)
        b = buckets[key]
        b["cnt"] += 1
        if ev["amount"] is not None:
            b["amount_sum"] += ev["amount"]
        if ev["status"] is not None:
            b["status"][ev["status"]] += 1
        members[key].append((ev["event_id"], ev["content_hash"]))
    for (biz_key, w_start), b in buckets.items():
        store.save_window(run_id, biz_key, w_start, window_end_for(w_start, size),
                          b["cnt"], round(b["amount_sum"], 6), dict(b["status"]))
        for event_id, content_hash in members[(biz_key, w_start)]:
            store.save_window_event(run_id, biz_key, w_start, event_id, content_hash)
    store.conn.commit()
    return len(buckets)


def run(cfg: dict, store: Store, from_date=None, to_date=None, from_event=None,
        kind="run", use_checkpoints=True) -> dict:
    """执行一次完整处理。任何异常都会把 run 标记为 failed, 不发布任何窗口。"""
    range_start = day_floor(from_date) if from_date else "0001-01-01T00:00:00Z"
    range_end = day_ceiling(to_date) if to_date else "9999-12-31T00:00:00Z"

    from_event_pos = None
    if from_event:
        pos = store.find_event_position(from_event)
        if pos is None:
            raise SystemExit(f"找不到事件 {from_event!r}, 无法从该位置继续")
        from_event_pos = (pos["source"], pos["source_file"], pos["source_line"])

    run_id = store.start_run(kind, range_start, range_end, from_event)
    try:
        ingest_stats = ingest_sources(store, cfg, run_id, from_event_pos,
                                      use_checkpoints=use_checkpoints)
        n_windows = compute_windows(store, cfg, run_id, range_start, range_end)
        n_published = store.publish_run(run_id)
    except Exception as exc:
        store.finish_run(run_id, "failed", note=f"{type(exc).__name__}: {exc}")
        raise
    summary = {
        "run_id": run_id,
        "range": [range_start, range_end],
        "windows": n_windows,
        "published": n_published,
        **dict(ingest_stats),
    }
    return summary
