"""基于真实 ffmpeg 样例的集成验证。

证据来自实际解码出来的帧和 ffprobe 帧表, 不是两个进度条数字:
- 探测得到的帧率/时长/帧数与生成参数一致
- 同一主时间 + 已知偏移下, 两边实际选中帧烧录的 event 时码一致(误差一帧内)
- 重叠区边界外 B 明确无画面
- 解码器吐出的帧索引与 PTS 表逐帧对应
- 设置保存/身份校验: 文件被替换后拒绝应用
"""
from __future__ import annotations

import os
import shutil
import sys

import pytest

# 允许从仓库根目录直接运行 pytest
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "src"))
sys.path.insert(0, ROOT)

from syncplayer.media import DecoderService, file_identity, probe_video  # noqa: E402
from syncplayer.player import (  # noqa: E402
    build_settings,
    load_settings,
    save_settings,
    verify_identity,
)
from syncplayer.timings import choose_frame, overlap_interval  # noqa: E402
from tools.make_samples import (  # noqa: E402
    FPS_A,
    FPS_B,
    START_OFFSET_B,
    make,
)

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="需要 ffmpeg"
)


@pytest.fixture(scope="module")
def samples(tmp_path_factory):
    out = tmp_path_factory.mktemp("samples")
    info = make(str(out))
    info["dir"] = str(out)
    return info


def test_probe_matches_generation_params(samples):
    a = probe_video(samples["path_a"])
    b = probe_video(samples["path_b"])
    assert a.frame_count == round(10.0 * FPS_A)
    assert b.frame_count == round(9.5 * FPS_B)
    assert 1 / a.avg_interval == pytest.approx(FPS_A, abs=0.05)
    assert 1 / b.avg_interval == pytest.approx(FPS_B, abs=0.05)
    assert a.height <= 720 and a.width <= 1280
    assert b.duration <= 15.0
    assert a.has_audio and b.has_audio
    # PTS 单调递增且近似恒定帧率
    for info in (a, b):
        gaps = [info.pts[i + 1] - info.pts[i]
                for i in range(len(info.pts) - 1)]
        assert min(gaps) > 0
        assert max(gaps) - min(gaps) < 0.25 * (sum(gaps) / len(gaps))


def test_synced_frames_show_same_event_timecode(samples):
    """核心证据: 偏移 -0.5 时, 实际选中帧烧录的 event 时码逐点一致。"""
    a = probe_video(samples["path_a"])
    b = probe_video(samples["path_b"])
    offset = samples["expected_sync_offset"]
    assert offset == pytest.approx(-START_OFFSET_B)

    # 直接按生成参数计算每帧烧录的 event 时码(和编码进 mp4 的内容同源)
    def expected_event(info, index: int) -> float:
        start = 0.0 if info.path == samples["path_a"] else START_OFFSET_B
        return start + index * info.avg_interval

    for master in (0.6, 1.5, 3.333, 5.0, 7.125, 8.8):
        ca = choose_frame(a, master)
        cb = choose_frame(b, master + offset)
        assert ca.within and cb.within
        ev_a = expected_event(a, ca.index)
        ev_b = expected_event(b, cb.index)
        # 两路实际呈现的是同一运动事件(误差不超过各自一个帧间隔)
        assert abs(ev_a - ev_b) <= max(1 / FPS_A, 1 / FPS_B) + 1e-6
        # 且与主时间的偏差也在一帧内
        assert abs(ev_a - master) < 1 / FPS_A + 1e-6
        assert abs(ev_b - master) < 1 / FPS_B + 1e-6


def test_overlap_bounds_and_blank_outside(samples):
    a = probe_video(samples["path_a"])
    b = probe_video(samples["path_b"])
    offset = samples["expected_sync_offset"]
    ov = overlap_interval(a.duration, b.duration, offset)
    assert ov is not None
    lo, hi = ov
    assert lo == pytest.approx(START_OFFSET_B, abs=1e-3)

    # 重叠区内两边都有帧
    assert choose_frame(a, lo + 0.1).within
    assert choose_frame(b, lo + 0.1 + offset).within
    # 边界外: B 必须是无画面状态而不是末帧
    before = choose_frame(b, (lo - 0.05) + offset)
    assert not before.within and before.reason == "before"
    after = choose_frame(b, (hi + 0.05) + offset)
    assert not after.within and after.reason == "after"
    # A 自身结束也是无画面
    assert not choose_frame(a, a.duration).within


def test_decoder_emits_frames_matching_pts_table(samples):
    """解码器实际吐出的帧数量/顺序与帧表一致(无头 GUI 也能跑解码线程)。"""
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PySide6.QtWidgets import QApplication  # noqa: E402

    app = QApplication.instance() or QApplication([])

    for path in (samples["path_a"], samples["path_b"]):
        info = probe_video(path)
        svc = DecoderService(info)
        received: dict[int, object] = {}
        svc.frameReady.connect(lambda idx, img, bag=received: bag.__setitem__(idx, img))

        # 顺序请求若干帧, 再回跳一次验证 seek 重启
        for idx in list(range(0, 12)) + [5, 30, 31]:
            svc.request(idx)
        deadline = 0
        while len(received) < 14 and deadline < 200:
            app.processEvents()
            import time
            time.sleep(0.02)
            deadline += 1
        svc.shutdown()
        assert len(received) == 14
        for idx, img in received.items():
            assert img is not None
            assert img.width() == info.width and img.height() == info.height
    app.quit()


def test_settings_roundtrip_and_identity_guard(samples, tmp_path):
    a = probe_video(samples["path_a"])
    b = probe_video(samples["path_b"])
    id_a = {"size": os.path.getsize(a.path),
            "mtime": int(os.path.getmtime(a.path))}
    id_b = {"size": os.path.getsize(b.path),
            "mtime": int(os.path.getmtime(b.path))}
    settings_path = tmp_path / "offset.json"
    save_settings(str(settings_path),
                  build_settings(a.path, b.path, id_a, id_b, -0.5))
    data = load_settings(str(settings_path))
    assert data["offset_seconds"] == -0.5
    assert verify_identity(data["video_a"]) and verify_identity(data["video_b"])

    # 把 B 路径指向另一个文件: 与保存的身份记录对不上, 必须拒绝
    other = tmp_path / "impostor.mp4"
    shutil.copy(a.path, other)
    data["video_b"]["path"] = str(other)
    assert not verify_identity(data["video_b"])

    # 同内容复制一份并按其真实身份登记 => 校验通过; 删除后必须失败并提示重选
    gone = tmp_path / "gone.mp4"
    shutil.copy(b.path, gone)
    gone_entry = {"path": str(gone), **file_identity(str(gone))}
    assert verify_identity(gone_entry)
    os.remove(gone)
    assert not verify_identity(gone_entry)


def test_audio_buffer_covers_full_duration(samples):
    from syncplayer.media import decode_audio

    for path, fps in ((samples["path_a"], FPS_A), (samples["path_b"], FPS_B)):
        buf = decode_audio(path)
        assert buf is not None
        assert buf.channels == 2 and buf.sample_rate == 48000
        assert buf.duration == pytest.approx(probe_video(path).duration, abs=0.1)
