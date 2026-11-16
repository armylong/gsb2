"""生成不含真实隐私信息的多页样例合同（全部为虚构主体与虚构数据）。

用法: python -m sample_data.make_samples [输出目录]
覆盖场景:
- layoutA: 标准版式（文本 PDF，2 页）
- layoutB: 版式变化（标签措辞、字段顺序、日期/金额写法不同）
- layoutC: 重复候选（每页页眉都有合同编号 + 正文一处）
- scan:    扫描图片（走本地 OCR）
- corrupt: 损坏文件（读取失败）
- txt:     纯文本合同
"""

import os
import sys

# 虚构数据
PARTY_A = "云溪示例科技有限公司"
PARTY_B = "青崖演示设备有限公司"
CONTRACT_NO = "HT-2026-018"
AMOUNT = "¥128,500.00"
SIGN_DATE = "2026年3月15日"


def _new_pdf():
    import fitz
    doc = fitz.open()
    return doc


def _write_page(doc, lines, header=None):
    page = doc.new_page(width=595, height=842)  # A4
    y = 60
    if header:
        page.insert_text((50, 35), header, fontname="china-s", fontsize=9)
    for text, size in lines:
        page.insert_text((50, y), text, fontname="china-s", fontsize=size)
        y += int(size * 2.2)
    return page


def make_layout_a(outdir):
    doc = _new_pdf()
    _write_page(doc, [
        ("采 购 合 同", 18),
        (f"合同编号：{CONTRACT_NO}", 12),
        (f"甲方（采购方）：{PARTY_A}", 12),
        (f"乙方（供应方）：{PARTY_B}", 12),
        ("第一条 标的物", 13),
        ("乙方向甲方提供演示用设备一批，详见附件清单。", 11),
        ("第二条 合同金额", 13),
        (f"合同总金额：{AMOUNT}（含税）", 11),
    ], header=None)
    _write_page(doc, [
        ("第三条 付款方式", 13),
        ("付款批次：第一期 合同生效后支付 50%", 11),
        ("付款批次：第二期 验收合格后支付 50%", 11),
        ("第四条 其他", 13),
        (f"签订日期：{SIGN_DATE}", 11),
        ("本合同一式两份，双方各执一份。", 11),
    ])
    path = os.path.join(outdir, "contract_layoutA.pdf")
    doc.save(path)
    doc.close()
    return path


def make_layout_b(outdir):
    """版式变化：标签措辞不同、顺序不同、日期金额写法不同。"""
    doc = _new_pdf()
    _write_page(doc, [
        ("设 备 采 购 协 议", 18),
        (f"甲方：{PARTY_A}", 12),
        (f"乙方：{PARTY_B}", 12),
        (f"协议编号：{CONTRACT_NO}", 12),
        ("一、供货内容", 13),
        ("乙方提供演示设备，清单见附件。", 11),
        ("二、价款", 13),
        ("合同金额：人民币 128,500.00 元（含税）", 11),
        ("三、付款", 13),
        ("付款批次：第一期 50%；第二期 50%。", 11),
    ])
    _write_page(doc, [
        ("四、生效", 13),
        ("本协议自双方盖章之日起生效。", 11),
        ("签署日期 2026-03-15", 11),
    ])
    path = os.path.join(outdir, "contract_layoutB.pdf")
    doc.save(path)
    doc.close()
    return path


def make_layout_c(outdir):
    """重复候选：每页页眉都有合同编号，正文还有一处 -> 多候选。"""
    doc = _new_pdf()
    _write_page(doc, [
        ("采 购 合 同", 18),
        (f"合同编号：{CONTRACT_NO}", 12),
        (f"甲方：{PARTY_A}    乙方：{PARTY_B}", 12),
        (f"合同总金额：{AMOUNT}", 11),
    ], header=f"合同编号：{CONTRACT_NO}")
    _write_page(doc, [
        ("付款批次：第一期 50%", 11),
        (f"签订日期：{SIGN_DATE}", 11),
    ], header=f"合同编号：{CONTRACT_NO}")
    path = os.path.join(outdir, "contract_layoutC.pdf")
    doc.save(path)
    doc.close()
    return path


def make_scan(outdir):
    """扫描件样例：把文字渲染成图片，走 OCR 路径。"""
    from PIL import Image, ImageDraw, ImageFont
    font_path = "/System/Library/Fonts/STHeiti Medium.ttc"
    font = ImageFont.truetype(font_path, 28)
    small = ImageFont.truetype(font_path, 22)
    img = Image.new("RGB", (1000, 700), "white")
    d = ImageDraw.Draw(img)
    d.text((60, 40), "采 购 合 同（扫描件）", font=font, fill="black")
    lines = [
        f"合同编号：{CONTRACT_NO}",
        f"甲方：{PARTY_A}",
        f"乙方：{PARTY_B}",
        f"合同总金额：{AMOUNT}",
        f"签订日期：{SIGN_DATE}",
    ]
    y = 120
    for t in lines:
        d.text((60, y), t, font=small, fill="black")
        y += 48
    path = os.path.join(outdir, "contract_scan.png")
    img.save(path)
    return path


def make_txt(outdir):
    path = os.path.join(outdir, "contract_text.txt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join([
            "采购合同",
            f"合同编号：{CONTRACT_NO}",
            f"甲方：{PARTY_A}",
            f"乙方：{PARTY_B}",
            f"合同总金额：{AMOUNT}",
            "付款批次：第一期 50%",
            "付款批次：第二期 50%",
            f"签订日期：{SIGN_DATE}",
        ]))
    return path


def make_corrupt(outdir):
    path = os.path.join(outdir, "corrupt.pdf")
    with open(path, "wb") as f:
        f.write(b"%PDF-1.4 corrupted-truncated\x00\x01\x02 not a real pdf")
    return path


def generate(outdir):
    os.makedirs(outdir, exist_ok=True)
    return {
        "layoutA": make_layout_a(outdir),
        "layoutB": make_layout_b(outdir),
        "layoutC": make_layout_c(outdir),
        "scan": make_scan(outdir),
        "txt": make_txt(outdir),
        "corrupt": make_corrupt(outdir),
    }


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "generated")
    for name, path in generate(out).items():
        print(f"{name}: {path}")
