"""无头生成全部自带素材并跑通两个示例，可用于自查/CI：

    .venv/bin/python -m mosaic_studio.demo

产物：
- sample_assets/tiles/**.png         60 块程序样块（含 9 块同色异纹）
- sample_assets/base/poster_demo.png 示例海报底图
- examples/quota_conflict/           配额冲突例子（素材 + scenario.json + output/）
- tmp/demo_preview.png               普通示例预览图（不进交付目录）
"""
from __future__ import annotations

from pathlib import Path

from . import generator, projectio, render, report
from .session import MosaicSession

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    paths = generator.ensure_bundled_assets(ROOT)
    print(f"[1/3] 内置素材就绪：{paths['tiles']}")

    # 常规示例：载入 60 块样块 + 海报底图，出一张预览。
    s = MosaicSession()
    s.params.cell_size = 40
    s.params.seed = 20261126
    s.load_base(paths["base"])
    s.load_tile_folder(paths["tiles"])
    res = s.solve()
    print(f"[2/3] 常规示例：{s.grid.cols}x{s.grid.rows}="
          f"{s.grid.count} 格，匹配 {res.assigned_count}，"
          f"未匹配 {res.unmatched_count}，{res.elapsed_ms}ms")
    tmp = ROOT / "tmp"
    tmp.mkdir(exist_ok=True)
    img, px = render.render_mosaic(s)
    img.save(tmp / "demo_preview.png")

    # 配额冲突例子：从 scenario.json 完整重建并导出。
    qc_dir = paths["quota_conflict"]
    qc = MosaicSession()
    projectio.apply_project(qc, qc_dir / "scenario.json", solve=True)
    qc_res = qc.result
    assert qc_res is not None
    out_png = qc_dir / "output" / "quota_conflict.png"
    render.export_final_image(qc, out_png, long_edge=1600)
    records = report.export_records(qc, out_png)
    print(f"[3/3] 配额冲突例子：{qc_res.cell_count} 格，"
          f"匹配 {qc_res.assigned_count}，未匹配 {qc_res.unmatched_count}，"
          f"配额缺口 {qc_res.free_deficit}")
    for kind, p in records.items():
        print(f"      {kind}: {p.relative_to(ROOT)}")
    print("demo 完成。")


if __name__ == "__main__":
    main()
