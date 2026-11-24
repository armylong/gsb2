from __future__ import annotations

import csv
import json
from dataclasses import asdict
from datetime import datetime
from pathlib import Path
from typing import Iterable

from .models import Annotation, json_safe


def confirmed_annotations(annotations: Iterable[Annotation]) -> list[Annotation]:
    return [a for a in annotations if a.status == "confirmed"]


def export_json(
    path: str | Path,
    annotations: Iterable[Annotation],
    *,
    audio_path: str | None,
    sample_rate: int,
    n_channels: int,
    duration: float,
    analysis_config: dict | None = None,
    bands: list[dict] | None = None,
    reference: dict | None = None,
) -> Path:
    items = confirmed_annotations(annotations)
    payload = {
        "schema": "audio-integrity-confirmations/v1",
        "exported_at": datetime.now().isoformat(timespec="seconds"),
        "audio": {
            "path": audio_path,
            "sample_rate": sample_rate,
            "channels": n_channels,
            "duration_seconds": duration,
        },
        "reference": reference or {},
        "analysis_config_at_export": analysis_config or {},
        "bands": bands or [],
        "count": len(items),
        "annotations": [a.to_dict() for a in items],
        "notice": "仅导出人工确认区间；本工具不生成或替换音频内容。",
    }
    path = Path(path)
    path.write_text(json.dumps(json_safe(payload), ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def export_csv(path: str | Path, annotations: Iterable[Annotation], *, sample_rate: int) -> Path:
    items = confirmed_annotations(annotations)
    path = Path(path)
    fieldnames = [
        "id", "kind", "kind_label", "status", "start_seconds", "end_seconds",
        "duration_seconds", "start_sample", "end_sample", "channels", "bands",
        "label", "note", "confidence", "metrics_json",
    ]
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for a in items:
            writer.writerow({
                "id": a.id,
                "kind": a.kind,
                "kind_label": a.to_dict().get("kind_label", a.kind),
                "status": a.status,
                "start_seconds": f"{a.start:.6f}",
                "end_seconds": f"{a.end:.6f}",
                "duration_seconds": f"{a.duration:.6f}",
                "start_sample": int(round(a.start * sample_rate)),
                "end_sample": int(round(a.end * sample_rate)),
                "channels": "|".join(map(str, a.channels)),
                "bands": "|".join(a.bands),
                "label": a.label,
                "note": a.note,
                "confidence": "" if a.confidence is None else f"{a.confidence:.3f}",
                "metrics_json": json.dumps(json_safe(a.metrics), ensure_ascii=False),
            })
    return path


def save_sidecar(path: str | Path, payload: dict) -> Path:
    path = Path(path)
    path.write_text(json.dumps(json_safe(payload), ensure_ascii=False, indent=2), encoding="utf-8")
    return path
