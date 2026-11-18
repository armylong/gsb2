"""代理生成与 sidecar 关联测试。"""

import json

import pytest

from proxy_check.errors import ValidationError
from proxy_check.ffmedia import probe
from proxy_check.proxy import (
    MAX_DURATION_SEC, build_proxy, load_sidecar,
    sidecar_path_for, target_dimensions, validate_source,
)


def test_target_dimensions_keeps_aspect_and_no_upscale():
    assert target_dimensions(960, 540) == (640, 360)
    assert target_dimensions(1920, 1080) == (640, 360)
    assert target_dimensions(720, 1280) == (202, 360)  # 竖屏, 宽度取偶
    assert target_dimensions(320, 240) == (320, 240)   # 小于 360p 不放大


def test_build_proxy_writes_real_mp4_and_sidecar(paths, work_dir):
    out = work_dir / "p.mp4"
    info, sidecar = build_proxy(paths["source"], out)
    assert out.is_file()
    assert sidecar_path_for(out).is_file()
    assert info.nb_video_frames == 300
    assert (info.width, info.height) == (640, 360)
    assert info.frame_rate == pytest.approx(30.0, abs=1e-3)

    saved = json.loads(sidecar_path_for(out).read_text("utf-8"))
    assert saved["source"]["sha256"]
    assert saved["proxy"]["sha256"]
    # 关联信息记录的是真实探测值, 不是文件名。
    assert saved["source"]["path"].endswith("source.mp4")
    assert saved["source"]["nb_video_frames"] == 300
    assert load_sidecar(out)["schema_version"] == 1


def test_validate_source_rejects_overlong(tmp_path):
    long_file = tmp_path / "long.mp4"
    import subprocess
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i",
        f"testsrc2=size=640x360:rate=30:duration={MAX_DURATION_SEC + 2}",
        "-an", str(long_file),
    ], check=True)
    with pytest.raises(ValidationError, match="时长"):
        validate_source(probe(long_file))


def test_validate_source_rejects_oversized(tmp_path):
    big = tmp_path / "big.mp4"
    import subprocess
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=1920x1200:rate=30:duration=1",
        "-an", str(big),
    ], check=True)
    with pytest.raises(ValidationError, match="分辨率"):
        validate_source(probe(big))


def test_validate_source_rejects_non_mp4(tmp_path):
    mov = tmp_path / "clip.mov"
    import subprocess
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30:duration=1",
        "-an", str(mov),
    ], check=True)
    with pytest.raises(ValidationError, match="mp4"):
        validate_source(probe(mov))


def test_failed_build_leaves_no_half_proxy(paths, work_dir):
    bad_target = work_dir / "nested" / "x.mp4"
    # 指向一个不存在的原片: 必须抛错且不留临时文件。
    with pytest.raises(Exception):
        build_proxy(work_dir / "nope.mp4", bad_target)
    leftovers = list(work_dir.rglob(".proxy_tmp_*"))
    assert leftovers == []
    assert not bad_target.exists()


def test_sidecar_distinguishes_same_named_different_file(
        paths, work_dir, replaced_source):
    """同名不等于同片: 用另一份内容顶替原片, sidecar 校验必须失败。"""
    out = work_dir / "proxy_good.mp4"
    build_proxy(paths["source"], out)
    # 把被替换的原片也命名成 source.mp4 放在另一目录。
    fake_dir = work_dir / "fakedir"
    fake_dir.mkdir()
    fake_source = fake_dir / "source.mp4"
    import shutil
    shutil.copy2(replaced_source, fake_source)

    from proxy_check.verification import verify, Status
    report = verify(fake_source, out)
    assoc = next(c for c in report.checks if c.id == "association")
    assert assoc.status == Status.FAIL
    assert report.overall == Status.FAIL
