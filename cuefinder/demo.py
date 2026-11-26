"""内置样例：合成提示音并落盘，供界面一键载入。"""
from __future__ import annotations

import argparse
from pathlib import Path

from .audio import TARGET_SR, write_wav
from .synth import CASE_QUERIES, build_query, build_reference_set

BUILTIN_DIR_NAME = "samples"


def project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def default_sample_dir() -> Path:
    return project_root() / BUILTIN_DIR_NAME


def generate(out_dir: str | Path, seed: int = 0) -> dict[str, Path]:
    """写出参考、查询与一个坏文件；返回 {名字: 路径}。"""
    out = Path(out_dir)
    ref_dir = out / "references"
    q_dir = out / "queries"
    ref_dir.mkdir(parents=True, exist_ok=True)
    q_dir.mkdir(parents=True, exist_ok=True)

    refs = build_reference_set()
    paths: dict[str, Path] = {}
    for name, sig in refs.items():
        p = ref_dir / f"{name}.wav"
        write_wav(p, sig, TARGET_SR)
        paths[name] = p
    for name in CASE_QUERIES:
        p = q_dir / f"{name}.wav"
        write_wav(p, build_query(name, refs, TARGET_SR, seed=seed), TARGET_SR)
        paths[name] = p
    broken = out / "broken_ref.wav"
    broken.write_bytes(b"NOT A WAVE FILE\x00\x01\x02")
    paths["broken"] = broken
    return paths


def builtin_reference_paths(out_dir: str | Path | None = None) -> list[Path]:
    base = Path(out_dir) if out_dir else default_sample_dir()
    refs = base / "references"
    if not refs.is_dir():
        generate(base)
    return sorted(refs.glob("*.wav"))


def builtin_query_path(name: str, out_dir: str | Path | None = None) -> Path | None:
    base = Path(out_dir) if out_dir else default_sample_dir()
    q_dir = base / "queries"
    path = q_dir / f"{name}.wav"
    if not path.exists():
        generate(base)
    return path if path.exists() else None


def query_case_labels() -> list[tuple[str, str]]:
    return [(name, spec["desc"]) for name, spec in CASE_QUERIES.items()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="生成本地检索用的样例提示音")
    ap.add_argument("--out", default=str(default_sample_dir()),
                    help="输出目录，默认仓库内 samples/")
    ap.add_argument("--seed", type=int, default=0, help="噪声随机种子")
    args = ap.parse_args(argv)
    paths = generate(args.out, args.seed)
    print(f"已生成到 {Path(args.out).resolve()}")
    for name, p in sorted(paths.items()):
        print(f"  {name:20s} {p}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
