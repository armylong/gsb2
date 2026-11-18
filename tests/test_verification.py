"""核对结论测试: 正常关联 / 待核对 / 时间错位 / 错片 / 少段 / 原片被替换。"""

import json

from proxy_check.verification import Status, verify


def _by_id(report, cid):
    return next(c for c in report.checks if c.id == cid)


# ---------------------------------------------------------- 1. 正常关联
def test_good_proxy_full_pass(paths):
    r = verify(paths["source"], paths["good"])
    assert r.overall == Status.PASS
    assert _by_id(r, "association").status == Status.PASS
    assert _by_id(r, "frame_count").status == Status.PASS
    assert _by_id(r, "timestamps").status == Status.PASS
    assert _by_id(r, "coverage").status == Status.PASS
    assert _by_id(r, "av_length").status == Status.PASS
    # 分辨率是预期差异, INFO 而非 FAIL。
    assert _by_id(r, "resolution").status == Status.INFO
    content = _by_id(r, "content")
    assert content.status == Status.PASS
    assert r.best_offset_frames == 0
    assert r.content_mae < 0.02
    # 检查点覆盖全片(含首尾)。
    assert r.checkpoints[0].source_index == 0
    assert r.checkpoints[-1].source_index == r.source.nb_video_frames - 1


# ------------------------------------------------- 2. 缺 sidecar => 待核对
def test_missing_sidecar_marks_pending_even_if_content_ok(
        paths, sidecar_less_good_copy):
    r = verify(paths["source"], sidecar_less_good_copy)
    assert _by_id(r, "association").status == Status.PENDING
    # 客观内容检查仍然真实执行并通过。
    assert _by_id(r, "content").status == Status.PASS
    assert r.overall == Status.PENDING
    assert "不能声称通过" in _by_id(r, "association").detail


# ------------------------------------------------------- 3. 时间错位
def test_offset_proxy_warns_with_exact_offset(paths):
    r = verify(paths["source"], paths["offset"])
    content = _by_id(r, "content")
    assert content.status == Status.WARN
    assert r.best_offset_frames == 15          # 与生成参数精确一致
    assert r.content_mae < 0.02                # 对齐后内容其实一致
    assert "错位" in content.detail
    # 关联缺失 => 整体 PENDING, 且结构项不受影响。
    assert r.overall == Status.PENDING
    assert _by_id(r, "frame_count").status == Status.PASS
    # 证据里能看到首检查点落在代理覆盖外(MAE=1)。
    assert r.checkpoints[0].mae == 1.0


# ---------------------------------------------------------- 4. 错片
def test_different_content_fails(paths):
    r = verify(paths["source"], paths["different"])
    content = _by_id(r, "content")
    assert content.status == Status.FAIL
    assert r.overall == Status.FAIL
    failed = [cp for cp in r.checkpoints if cp.status == Status.FAIL]
    assert len(failed) >= 3
    # 元数据可以完全相近, 但内容检查必须识破。
    assert r.proxy.nb_video_frames == r.source.nb_video_frames
    assert r.proxy.frame_rate == r.source.frame_rate


# --------------------------------------------------- 5. 代理少一段 => FAIL
def test_truncated_proxy_fails_frame_count(paths, truncated_proxy):
    r = verify(paths["source"], truncated_proxy)
    fc = _by_id(r, "frame_count")
    assert fc.status == Status.FAIL
    assert fc.evidence["delta"] == 30
    assert r.overall == Status.FAIL


# ---------------------------------------------- 6. 原片被替换 => 关联 FAIL
def test_replaced_source_fails_association(paths, replaced_source):
    # 代理是为真正的 source 生成并带 sidecar 的。
    r = verify(replaced_source, paths["good"])
    assoc = _by_id(r, "association")
    assert assoc.status == Status.FAIL
    assert "sha256" in assoc.detail or "内容指纹" in assoc.detail
    assert r.overall == Status.FAIL


# ---------------------------------------- 7. sidecar 被篡改 => 关联 FAIL
def test_tampered_sidecar_detected(paths, work_dir):
    import shutil
    proxy = work_dir / "proxy_good.mp4"
    shutil.copy2(paths["good"], proxy)
    shutil.copy2(paths["good"].with_name(
        paths["good"].name + ".sidecar.json"),
        proxy.with_name(proxy.name + ".sidecar.json"))
    sc_path = proxy.with_name(proxy.name + ".sidecar.json")
    data = json.loads(sc_path.read_text("utf-8"))
    data["source"]["sha256"] = "0" * 64
    sc_path.write_text(json.dumps(data), "utf-8")

    r = verify(paths["source"], proxy)
    assert _by_id(r, "association").status == Status.FAIL
    assert r.overall == Status.FAIL


# -------------------------------------------------- 8. 导出记录正确性
def test_export_matches_exact_pair(paths, work_dir):
    r = verify(paths["source"], paths["good"])
    out = work_dir / "report.json"
    r.save_json(out)
    data = json.loads(out.read_text("utf-8"))

    assert data["overall"] == "PASS"
    # 记录绑定两份文件的 sha256, 不依赖文件名。
    assert data["source"]["sha256"] == r.source.sha256
    assert data["proxy"]["sha256"] == r.proxy.sha256
    assert data["source"]["nb_video_frames"] == 300
    assert data["content_check"]["best_offset_in_source_frames"] == 0
    assert len(data["content_check"]["checkpoints"]) == len(r.checkpoints)
    # 每条检查都有明确状态。
    for c in data["checks"]:
        assert c["status"] in {s.value for s in Status}
        assert c["detail"]


def test_failed_verification_still_exposes_evidence(paths, work_dir):
    r = verify(paths["source"], paths["different"])
    out = work_dir / "fail_report.json"
    r.save_json(out)
    data = json.loads(out.read_text("utf-8"))
    assert data["overall"] == "FAIL"
    # 失败也要能查看证据与两份文件的实际媒体信息。
    assert data["content_check"]["checkpoints"]
    assert data["source"]["resolution"] and data["proxy"]["resolution"]
    assert any(c["status"] == "FAIL" for c in data["checks"])
