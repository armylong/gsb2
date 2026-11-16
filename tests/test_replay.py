"""覆盖: 乱序、迟到、重复、冲突、坏行/坏文件、断点续跑、范围重算、可解释性。"""

from __future__ import annotations

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from eventreplay import processor
from eventreplay.config import load_config
from eventreplay.store import Store
from tests.helpers import make_config, pay_source, refund_source, write


@pytest.fixture
def env(tmp_path):
    """构造两个来源: pay(csv, 乱序+重复+坏行) 与 refund(jsonl, 坏时间+冲突)。"""
    base = str(tmp_path)
    write(
        os.path.join(base, "data/pay/day1.csv"),
        "order_id,pay_time,merchant,amount,state\n"
        "P3,2026-01-02 08:00:00,shopA,30,success\n"      # 乱序: 时间早于 P1
        "P1,2026-01-01 09:00:00,shopA,100,success\n"
        "P2,2026-01-01 10:00:00,shopB,200,fail\n"
        "P1,2026-01-01 09:00:00,shopA,100,success\n"    # 完全重复
        "P4,2026-01-02 11:00:00,shopB,abc,success\n",   # 金额非法 -> 跳过
    )
    write(
        os.path.join(base, "data/refund/day1.jsonl"),
        '{"rid": "R1", "ts": "2026-01-01T12:00:00Z", "shop": "shopA", "amt": 40, "result": "done"}\n'
        '{"rid": "R2", "ts": "bad-time", "shop": "shopB", "amt": 5, "result": "done"}\n'
        '{"rid": "R3", "ts": "2026-01-02T13:00:00Z", "shop": "shopA", "amt": 15, "result": "done"}\n',
    )
    cfg_path = make_config(
        base,
        [pay_source("data/pay/*.csv"), refund_source("data/refund/*.jsonl")],
    )
    cfg = load_config(cfg_path)
    store = Store(cfg["db"])
    yield base, cfg, store
    store.close()


def published(store):
    return {
        (r["biz_key"], r["window_start"]): r
        for r in store.conn.execute("SELECT * FROM published").fetchall()
    }


def test_out_of_order_and_window_alignment(env):
    _, cfg, store = env
    processor.run(cfg, store)
    pub = published(store)
    # P1(01-01 09:00) 落在 01-01 窗口, P3(01-02 08:00) 落在 01-02 窗口, 与到达顺序无关
    assert pub[("shopA", "2026-01-01T00:00:00Z")]["cnt"] == 2   # P1 + R1
    assert pub[("shopA", "2026-01-02T00:00:00Z")]["cnt"] == 2   # P3 + R3
    assert pub[("shopA", "2026-01-01T00:00:00Z")]["amount_sum"] == 140.0
    assert pub[("shopB", "2026-01-01T00:00:00Z")]["status_json"] == '{"fail": 1}'


def test_duplicate_deduped_and_conflict_recorded(env):
    base, cfg, store = env
    # 追加一个同编号不同内容的事件(冲突)
    write(
        os.path.join(base, "data/refund/day2.jsonl"),
        '{"rid": "R1", "ts": "2026-01-01T12:00:00Z", "shop": "shopA", "amt": 999, "result": "done"}\n',
    )
    processor.run(cfg, store)
    pub = published(store)
    # P1 出现两次但只计一次; R1 的冲突版本不计入
    assert pub[("shopA", "2026-01-01T00:00:00Z")]["amount_sum"] == 140.0
    conflicts = store.conn.execute("SELECT * FROM conflicts").fetchall()
    assert len(conflicts) == 1 and conflicts[0]["event_id"] == "R1"


def test_bad_rows_and_broken_file_are_locatable(env):
    base, cfg, store = env
    # 一个完全损坏的文件(非 UTF-8)
    bad = os.path.join(base, "data/pay/broken.csv")
    with open(bad, "wb") as fh:
        fh.write(b"\xff\xfe\x00bad")
    processor.run(cfg, store)
    skipped = store.conn.execute("SELECT * FROM skipped ORDER BY id").fetchall()
    reasons = {s["reason"] for s in skipped}
    assert any("金额" in r for r in reasons)          # P4 金额非法
    assert any("时间" in r for r in reasons)          # R2 时间非法
    for s in skipped:                                  # 可定位到文件与行号
        assert s["source_file"] and s["source_line"] > 0
    failed = store.conn.execute(
        "SELECT * FROM files WHERE status='failed'").fetchall()
    assert len(failed) == 1 and failed[0]["path"].endswith("broken.csv")
    # 其他文件不受影响
    assert published(store)[("shopA", "2026-01-01T00:00:00Z")]["cnt"] == 2


def test_rerun_is_idempotent(env):
    _, cfg, store = env
    processor.run(cfg, store)
    first = published(store)
    processor.run(cfg, store)  # 断点命中, 文件被跳过
    second = published(store)
    assert {k: (v["cnt"], v["amount_sum"]) for k, v in first.items()} == \
           {k: (v["cnt"], v["amount_sum"]) for k, v in second.items()}
    skipped_files = store.conn.execute(
        "SELECT COUNT(*) c FROM files WHERE status='skipped'").fetchone()["c"]
    assert skipped_files >= 2


def test_interrupted_run_does_not_publish(env, monkeypatch):
    _, cfg, store = env

    def boom(*a, **kw):
        raise RuntimeError("模拟中断")

    monkeypatch.setattr(processor, "compute_windows", boom)
    with pytest.raises(RuntimeError):
        processor.run(cfg, store)
    assert published(store) == {}                      # 未完成窗口不结算
    run = store.conn.execute("SELECT * FROM runs").fetchone()
    assert run["status"] == "failed"

    monkeypatch.undo()
    processor.run(cfg, store)                          # 断点续跑后正常发布
    assert published(store)[("shopA", "2026-01-01T00:00:00Z")]["cnt"] == 2


def test_resume_from_event(env):
    _, cfg, store = env
    processor.run(cfg, store)
    before = store.conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"]
    # 从 P3(day1.csv 第 2 行)之后继续: 之前的记录被跳过, 已存在的靠去重
    summary = processor.run(cfg, store, from_event="P3", use_checkpoints=False)
    assert summary["events_before_position"] >= 1
    after = store.conn.execute("SELECT COUNT(*) c FROM events").fetchone()["c"]
    assert after == before                             # 没有重复计入


def test_reprocess_with_late_file_keeps_old_until_publish(env):
    base, cfg, store = env
    processor.run(cfg, store, from_date="2026-01-01", to_date="2026-01-02")
    old = published(store)
    old_cnt = old[("shopA", "2026-01-01T00:00:00Z")]["cnt"]

    # 迟到文件: 补充 01-01 的两条事件
    write(
        os.path.join(base, "data/pay/late.csv"),
        "order_id,pay_time,merchant,amount,state\n"
        "P9,2026-01-01 20:00:00,shopA,7,success\n"
        "P10,2026-01-01 21:00:00,shopC,3,success\n",
    )
    summary = processor.run(
        cfg, store, from_date="2026-01-01", to_date="2026-01-02",
        kind="reprocess", use_checkpoints=False,
    )
    new = published(store)
    assert new[("shopA", "2026-01-01T00:00:00Z")]["cnt"] == old_cnt + 1
    assert ("shopC", "2026-01-01T00:00:00Z") in new
    # 前后差异已记录
    diffs = store.conn.execute(
        "SELECT * FROM publish_diffs WHERE run_id=?", (summary["run_id"],)
    ).fetchall()
    assert diffs, "应记录发布前后差异"
    diff_keys = {(d["biz_key"], d["window_start"]) for d in diffs}
    assert ("shopA", "2026-01-01T00:00:00Z") in diff_keys
    shopA_diff = [d for d in diffs if d["biz_key"] == "shopA"][0]
    assert json.loads(shopA_diff["old_json"])["cnt"] == old_cnt
    assert json.loads(shopA_diff["new_json"])["cnt"] == old_cnt + 1


def test_explain_traces_stat_to_source_lines(env):
    _, cfg, store = env
    processor.run(cfg, store)
    pub, events = store.explain_window("shopA", "2026-01-01T00:00:00Z")
    assert pub["cnt"] == len(events) == 2
    assert round(sum(e["amount"] for e in events), 6) == pub["amount_sum"]
    locations = {(e["source_file"], e["source_line"]) for e in events}
    assert ("data/pay/day1.csv", 3) in locations       # P1 在 csv 第 3 行
    assert ("data/refund/day1.jsonl", 1) in locations  # R1 在 jsonl 第 1 行


def test_window_boundaries_stable_with_hour_window(tmp_path):
    base = str(tmp_path)
    write(
        os.path.join(base, "d/p.csv"),
        "order_id,pay_time,merchant,amount,state\n"
        "A1,2026-01-01 00:59:59,m,1,ok\n"
        "A2,2026-01-01 01:00:00,m,2,ok\n",
    )
    cfg = load_config(make_config(base, [pay_source("d/*.csv")], window="1h"))
    store = Store(cfg["db"])
    processor.run(cfg, store)
    pub = published(store)
    assert pub[("m", "2026-01-01T00:00:00Z")]["cnt"] == 1
    assert pub[("m", "2026-01-01T01:00:00Z")]["cnt"] == 1
    store.close()
