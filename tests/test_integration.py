"""端到端集成测试：通过 Flask 测试客户端 + 真实 ffmpeg 验证关键需求。

运行：.venv/bin/pytest tests/ -v
前置：先执行 python scripts/generate_samples.py samples 生成样例。
"""

from __future__ import annotations

import io
import json
import os
import time
import zipfile

import pytest
from PIL import Image

from backend.app import create_app
from backend.ffmpeg_tools import list_frames, nearest_frame
from backend.pipeline import JobManager

SAMPLES_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "samples")


def _sample(name: str) -> str:
    path = os.path.join(SAMPLES_DIR, name)
    assert os.path.exists(path), f"缺少样例 {name}，请先运行 scripts/generate_samples.py"
    return path


@pytest.fixture()
def app(tmp_path):
    application = create_app(work_root=str(tmp_path / "workspace"))
    application.config["SAMPLE_DIR"] = SAMPLES_DIR
    application.config["TESTING"] = True
    return application


@pytest.fixture()
def client(app):
    return app.test_client()


def _create_job(client, sample_name: str):
    with open(_sample(sample_name), "rb") as fh:
        resp = client.post(
            "/api/jobs",
            data={"video": (fh, sample_name)},
            content_type="multipart/form-data",
        )
    assert resp.status_code == 201, resp.get_json()
    return resp.get_json()


def _wait_status(client, job_id, timeout=30.0):
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        resp = client.get(f"/api/jobs/{job_id}")
        assert resp.status_code == 200
        last = resp.get_json()
        if last["status"] != "analyzing":
            return last
        time.sleep(0.15)
    raise AssertionError(f"任务超时未结束，最后状态：{last and last['status']}")


def _analyze(client, job_id, params, timeout=30.0):
    resp = client.post(f"/api/jobs/{job_id}/analyze", json=params)
    assert resp.status_code == 200, resp.get_json()
    return _wait_status(client, job_id, timeout)


# ---------------------------------------------------------------- 媒体信息


def test_media_info_shows_duration_dimension_rotation(client):
    job = _create_job(client, "sample_rotated.mp4")
    assert job["rotation"] == 90
    stream = job["probe"]["video_streams"][0]
    assert stream["width"] == 640 and stream["height"] == 360
    assert abs(job["duration"] - 4.0) < 0.05
    # VFR 样例应被识别
    vfr_job = _create_job(client, "sample_vfr.mp4")
    assert vfr_job["is_vfr"] is True


def test_no_video_stream_returns_clear_error(client):
    with open(_sample("sample_audio_only.m4a"), "rb") as fh:
        resp = client.post(
            "/api/jobs",
            data={"video": (fh, "a.m4a")},
            content_type="multipart/form-data",
        )
    assert resp.status_code == 400
    assert "视频流" in resp.get_json()["error"]


def test_corrupt_file_returns_clear_error(client):
    with open(_sample("sample_corrupt.mp4"), "rb") as fh:
        resp = client.post(
            "/api/jobs",
            data={"video": (fh, "bad.mp4")},
            content_type="multipart/form-data",
        )
    assert resp.status_code == 400
    assert "ffprobe" in resp.get_json()["error"] or "损坏" in resp.get_json()["error"]


# ---------------------------------------------------------------- 真实帧时间


def test_interval_analysis_uses_real_frame_times_vfr(client):
    job = _create_job(client, "sample_vfr.mp4")
    result = _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 0.5, "max_frames": 10, "min_gap": 0},
    )
    assert result["status"] in ("ready", "ready_with_warnings")
    frames = list_frames(_sample("sample_vfr.mp4"), 0)
    for cand in result["candidates"]:
        # 实际时间必须是视频中真实存在的帧时间，而不是请求时间的简单回显
        real_times = {round(f.pts_time, 6) for f in frames}
        assert cand["actual_time"] in real_times
        # 请求时间与实际帧时间的偏差不应超过该位置相邻真实帧间隔
        nearest = nearest_frame(frames, cand["requested_time"])
        assert abs(cand["actual_time"] - nearest.pts_time) < 1e-6


def test_request_between_frames_reports_actual_time(client):
    job = _create_job(client, "sample_cut.mp4")
    # 选一个肯定落在两帧之间的时间（25fps，帧在 0.04 网格上）
    resp = client.post(f"/api/jobs/{job['id']}/frames", json={"time": 0.062})
    assert resp.status_code == 200
    cand = resp.get_json()["candidate"]
    assert cand["requested_time"] == pytest.approx(0.062)
    # 最近帧为 0.08（|0.08-0.062| < |0.04-0.062|）
    assert cand["actual_time"] == pytest.approx(0.08, abs=1e-6)
    assert abs(cand["actual_time"] - cand["requested_time"]) > 1e-4


def test_out_of_range_request_rejected(client):
    job = _create_job(client, "sample_cut.mp4")
    resp = client.post(
        f"/api/jobs/{job['id']}/frames", json={"time": job["duration"] + 10}
    )
    assert resp.status_code == 400
    assert "超出视频时长" in resp.get_json()["error"]


# ---------------------------------------------------------------- 去重


def test_duplicate_time_does_not_create_extra_screenshot(client):
    job = _create_job(client, "sample_cut.mp4")
    first = client.post(f"/api/jobs/{job['id']}/frames", json={"time": 1.0}).get_json()
    # 同一时间再来一次
    second = client.post(f"/api/jobs/{job['id']}/frames", json={"time": 1.0}).get_json()
    # 不同请求时间但命中同一真实帧，也不应产生新截图
    third = client.post(
        f"/api/jobs/{job['id']}/frames", json={"time": 1.01}
    ).get_json()

    assert first["candidate"]["id"] == second["candidate"]["id"]
    assert first["candidate"]["id"] == third["candidate"]["id"]
    status = client.get(f"/api/jobs/{job['id']}").get_json()
    assert len(status["candidates"]) == 1
    assert len(third["candidate"]["merged_requests"]) >= 1


# ---------------------------------------------------------------- 场景检测


def test_scene_detection_finds_hard_cuts_not_gradual(client):
    cut_job = _create_job(client, "sample_cut.mp4")
    cut_result = _analyze(
        client,
        cut_job["id"],
        {"mode": "scene", "sensitivity": 3, "max_frames": 20, "min_gap": 0.2},
    )
    # 硬切换样例在 2s/4s/6s 附近至少能检出 2 个切换点
    scene_times = [
        c["actual_time"]
        for c in cut_result["candidates"]
        if c["source"] == "scene"
    ]
    assert len(scene_times) >= 2
    assert any(1.7 < t < 2.3 for t in scene_times)

    gradual_job = _create_job(client, "sample_gradual.mp4")
    gradual_result = _analyze(
        client,
        gradual_job["id"],
        {"mode": "scene", "sensitivity": 1, "max_frames": 20, "min_gap": 0.2},
    )
    # 低灵敏度下渐变不应被当成硬切换（允许起点候选，但不应有 scene 来源候选）
    assert all(c["source"] != "scene" for c in gradual_result["candidates"])


# ---------------------------------------------------------------- 旋转与宽高比


def test_rotated_screenshot_orientation_and_aspect(client):
    job = _create_job(client, "sample_rotated.mp4")
    result = _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 1.0, "max_frames": 3, "min_gap": 0},
    )
    cand = next(c for c in result["candidates"] if c["image_ready"])
    resp = client.get(f"/api/jobs/{job['id']}/frames/{cand['id']}/image")
    assert resp.status_code == 200
    with Image.open(io.BytesIO(resp.data)) as im:
        # 编码为 640x360 + 顺时针 90°，校正后应为竖向 360x640，宽高比 9:16
        assert im.width == 360 and im.height == 640
        assert im.width / im.height == pytest.approx(360 / 640, abs=0.01)


# ---------------------------------------------------------------- 取消与隔离


def test_cancel_stops_analysis_and_keeps_results_isolated(client, app):
    job = _create_job(client, "sample_vfr.mp4")
    resp = client.post(
        f"/api/jobs/{job['id']}/analyze",
        json={"mode": "interval", "interval": 0.1, "max_frames": 100, "min_gap": 0},
    )
    assert resp.status_code == 200
    # 立即取消（小文件可能很快完成，两种结局都校验语义）
    client.post(f"/api/jobs/{job['id']}/cancel")
    result = _wait_status(client, job["id"])
    if result["status"] == "canceled":
        # 取消后候选必须清空，不能残留半成品
        assert result["candidates"] == []
        assert result["progress_stage"] == "已取消"

    # 再跑一轮正常分析，应能成功且不受上一轮影响
    rerun = _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 1.0, "max_frames": 5, "min_gap": 0},
    )
    assert rerun["status"] in ("ready", "ready_with_warnings")
    assert len(rerun["candidates"]) >= 1
    assert all(c["image_ready"] for c in rerun["candidates"])


def test_two_jobs_have_isolated_workspaces(client, app):
    job_a = _create_job(client, "sample_cut.mp4")
    job_b = _create_job(client, "sample_gradual.mp4")
    assert job_a["id"] != job_b["id"]
    manager: JobManager = app.config["MANAGER"]
    ja = manager.get(job_a["id"])
    jb = manager.get(job_b["id"])
    assert ja.work_dir != jb.work_dir
    assert os.path.isdir(ja.frames_dir) and os.path.isdir(jb.frames_dir)
    # 两个任务并行分析互不覆盖
    client.post(
        f"/api/jobs/{job_a['id']}/analyze",
        json={"mode": "interval", "interval": 1.0, "max_frames": 5, "min_gap": 0},
    )
    client.post(
        f"/api/jobs/{job_b['id']}/analyze",
        json={"mode": "interval", "interval": 1.0, "max_frames": 5, "min_gap": 0},
    )
    ra = _wait_status(client, job_a["id"])
    rb = _wait_status(client, job_b["id"])
    assert ra["status"] in ("ready", "ready_with_warnings")
    assert rb["status"] in ("ready", "ready_with_warnings")
    # 帧图文件各自落在独立目录
    a_files = set(os.listdir(ja.frames_dir))
    b_files = set(os.listdir(jb.frames_dir))
    assert a_files and b_files and a_files.isdisjoint(b_files)


def test_restart_analysis_discards_stale_generation(client):
    job = _create_job(client, "sample_cut.mp4")
    # 第一轮参数
    first = _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 2.0, "max_frames": 4, "min_gap": 0},
    )
    first_generation = first["analysis_generation"]
    # 第二轮参数完全不同
    second = _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 0.5, "max_frames": 8, "min_gap": 0},
    )
    assert second["analysis_generation"] == first_generation + 1
    # 所有候选都来自新一轮（数量与第二轮参数吻合，不混入第一轮的 2s 间隔结果）
    assert len(second["candidates"]) <= 8
    assert all(c["source"] == "interval" for c in second["candidates"])


# ---------------------------------------------------------------- 导出


def test_export_zip_matches_manifest_and_excludes_unselected(client):
    job = _create_job(client, "sample_cut.mp4")
    result = _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 1.0, "max_frames": 6, "min_gap": 0},
    )
    candidates = result["candidates"]
    # 取消勾选其中一个
    target = candidates[2]
    client.post(
        f"/api/jobs/{job['id']}/frames/{target['id']}/select",
        json={"selected": False},
    )
    resp = client.get(f"/api/jobs/{job['id']}/export")
    assert resp.status_code == 200
    zf = zipfile.ZipFile(io.BytesIO(resp.data))
    names = zf.namelist()
    assert "contact_sheet.png" in names
    assert "manifest.json" in names and "manifest.csv" in names
    frame_files = [n for n in names if n.startswith("frames/")]
    # 取消勾选的不在包内
    assert len(frame_files) == len(candidates) - 1

    manifest = json.loads(zf.read("manifest.json"))
    assert manifest["frame_count"] == len(frame_files)
    # 清单条目与图片一一对应，且包含请求时间与实际帧时间
    listed = {entry["export_file"] for entry in manifest["frames"]}
    assert listed == set(frame_files)
    for entry in manifest["frames"]:
        assert "requested_time_seconds" in entry
        assert "actual_frame_time_seconds" in entry
        assert entry["actual_frame_time_hms"]
    # 总览图是合法 PNG
    with Image.open(io.BytesIO(zf.read("contact_sheet.png"))) as im:
        assert im.format == "PNG"


def test_export_rejects_when_nothing_selected(client):
    job = _create_job(client, "sample_cut.mp4")
    _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 1.0, "max_frames": 3, "min_gap": 0},
    )
    for cand in client.get(f"/api/jobs/{job['id']}").get_json()["candidates"]:
        client.post(
            f"/api/jobs/{job['id']}/frames/{cand['id']}/select",
            json={"selected": False},
        )
    resp = client.get(f"/api/jobs/{job['id']}/export")
    assert resp.status_code == 400


# ---------------------------------------------------------------- 参数校验


def test_invalid_time_range_rejected(client):
    job = _create_job(client, "sample_cut.mp4")
    resp = client.post(
        f"/api/jobs/{job['id']}/analyze",
        json={"mode": "interval", "interval": 1, "start": 5, "end": 2,
              "max_frames": 5, "min_gap": 0},
    )
    assert resp.status_code == 200
    result = _wait_status(client, job["id"])
    assert result["status"] == "error"
    assert "起点必须早于终点" in result["message"]


def test_min_gap_and_max_frames_are_respected(client):
    job = _create_job(client, "sample_cut.mp4")
    result = _analyze(
        client,
        job["id"],
        {"mode": "interval", "interval": 0.2, "max_frames": 4, "min_gap": 1.0},
    )
    cands = result["candidates"]
    assert len(cands) <= 4
    times = sorted(c["actual_time"] for c in cands)
    for a, b in zip(times, times[1:]):
        assert b - a >= 1.0 - 1e-6
