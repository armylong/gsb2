import json

import numpy as np
import pytest

from ambi_rotate.dsp import MODE_OMNI, YawMarkers
from ambi_rotate.exporter import export_stereo, verify_export
from ambi_rotate.synth import make_sample, source_azimuth_b
from ambi_rotate.wavio import read_wav, write_wav


def test_export_and_verify(tmp_path):
    sr = 48000
    b = make_sample(sr, duration=2.0)
    src = str(tmp_path / "src.wav")
    write_wav(src, b, sr, subtype="float32")
    wav_path = str(tmp_path / "out.wav")
    json_path = str(tmp_path / "out.json")

    auto = YawMarkers([(0.0, 0.0), (1.0, 120.0)], "ccw")
    settings = export_stereo(
        wav_path, json_path, b, sr,
        start_time=0.1, end_time=1.5, speaker_angle_deg=80.0,
        mode=MODE_OMNI, automation=auto, lr_order="RL",
        subtype="pcm24", source_wav_path=src)

    payload = json.loads(open(json_path, encoding="utf-8").read())
    assert payload["lr_order"] == "RL"
    assert payload["start_time"] == pytest.approx(0.1)
    assert payload["end_time"] == pytest.approx(1.5)
    assert payload["frames"] == int(round(1.4 * sr))
    assert len(payload["wav_sha256"]) == 64

    report = verify_export(json_path, b, sr, wav_path)
    assert report["ok"], report["reasons"]
    assert report["expected_frames"] == settings.frames
    assert report["actual_frames"] == read_wav(wav_path).data.shape[0]
    assert report["expected_order"] == "RL"


def test_verify_detects_tampering(tmp_path):
    sr = 24000
    b = make_sample(sr, duration=1.0)
    wav_path = str(tmp_path / "o.wav")
    json_path = str(tmp_path / "o.json")
    export_stereo(wav_path, json_path, b, sr,
                  start_time=0.0, end_time=1.0,
                  speaker_angle_deg=90.0, fixed_yaw_deg=10.0)
    # 篡改 JSON 中的起止时间 -> 帧数对不上
    payload = json.loads(open(json_path, encoding="utf-8").read())
    payload["end_time"] = 0.5
    json_path2 = str(tmp_path / "tampered.json")
    open(json_path2, "w", encoding="utf-8").write(json.dumps(payload))
    report = verify_export(json_path2, b, sr, wav_path)
    assert not report["ok"]
    assert any("帧" in r or "误差" in r for r in report["reasons"])


def test_sample_orbiting_source():
    sr = 48000
    b = make_sample(sr, duration=8.0)
    assert b.shape == (8 * sr, 4)
    # Z 恒为 0 (纯水平)
    assert np.all(b[:, 2] == 0.0)
    # 绕圈声源: 4 秒一圈, t=1s 时理论 +90°; 取该时刻短窗, Y 应明显强于 X
    s = int(1.0 * sr)
    win = b[s:s + sr // 50]
    y_power = np.mean(win[:, 1] ** 2)
    x_power = np.mean(win[:, 3] ** 2)
    assert y_power > 4 * x_power
    assert source_azimuth_b(1.0) == pytest.approx(90.0)
    assert source_azimuth_b(4.0) == pytest.approx(0.0)
