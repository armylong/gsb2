"""文档读取：把原始文件解析成"页 + 行（含位置）"，原始文件本身不被修改。

- 文本型 PDF：直接取文字与坐标
- 扫描型 PDF / 图片：本地 tesseract OCR（不依赖任何在线服务）
- txt / docx：按行解析
- 无法识别：状态置 failed 并写明原因
"""

import os

SUPPORTED = {".pdf", ".txt", ".md", ".docx", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"}

OCR_LANG = os.environ.get("EXTRACTOR_OCR_LANG", "chi_sim+eng")


class IngestError(Exception):
    pass


def _lines_from_words(words):
    """把 [(x0,y0,x1,y1,word,block,line), ...] 聚合成行。"""
    lines = {}
    for w in words:
        key = (w[5], w[6])
        lines.setdefault(key, []).append(w)
    out = []
    for i, key in enumerate(sorted(lines), start=1):
        ws = sorted(lines[key], key=lambda w: w[0])
        text = " ".join(w[4] for w in ws)
        bbox = [
            min(w[0] for w in ws), min(w[1] for w in ws),
            max(w[2] for w in ws), max(w[3] for w in ws),
        ]
        out.append({"line_no": i, "text": text, "bbox": bbox})
    return out


def _ocr_image(img, image_path):
    """对 PIL 图像做本地 OCR，返回行列表。tesseract 缺失时抛 IngestError。"""
    try:
        import pytesseract
        from pytesseract import Output
    except ImportError as e:
        raise IngestError("未安装 pytesseract，无法识别扫描件") from e
    try:
        data = pytesseract.image_to_data(img, lang=OCR_LANG, output_type=Output.DICT)
    except pytesseract.TesseractNotFoundError as e:
        raise IngestError("未找到本地 tesseract 程序，无法识别扫描件") from e
    except Exception as e:  # 语言包缺失等
        raise IngestError(f"OCR 失败: {e}") from e
    words = []
    n = len(data["text"])
    for i in range(n):
        text = (data["text"][i] or "").strip()
        if not text or int(data["conf"][i]) < 0:
            continue
        x, y, w, h = (data[k][i] for k in ("left", "top", "width", "height"))
        words.append((x, y, x + w, y + h, text,
                      data["block_num"][i] * 1000 + data["par_num"][i],
                      data["line_num"][i]))
    lines = _lines_from_words(words)
    if not lines:
        raise IngestError("OCR 未识别出任何文字（可能是空白或图像质量过低）")
    return lines


def _ingest_pdf(path, pages_dir, doc_id):
    import fitz  # pymupdf

    try:
        doc = fitz.open(path)
    except Exception as e:
        raise IngestError(f"PDF 无法打开（文件可能损坏）: {e}") from e
    if doc.needs_pass:
        raise IngestError("PDF 已加密，无法读取")
    pages = []
    for pno in range(doc.page_count):
        page = doc[pno]
        words = page.get_text("words")
        if sum(len(w[4].strip()) for w in words) >= 10:
            lines = _lines_from_words(words)
            pages.append({
                "page_no": pno + 1, "source": "text",
                "text": page.get_text("text"), "lines": lines,
                "image_path": None, "width": page.rect.width, "height": page.rect.height,
            })
        else:
            # 扫描页：渲染成图片后本地 OCR
            from PIL import Image
            import io
            pix = page.get_pixmap(dpi=200)
            img_bytes = pix.tobytes("png")
            os.makedirs(pages_dir, exist_ok=True)
            img_path = os.path.join(pages_dir, f"doc{doc_id}_p{pno + 1}.png")
            with open(img_path, "wb") as f:
                f.write(img_bytes)
            img = Image.open(io.BytesIO(img_bytes))
            lines = _ocr_image(img, img_path)
            pages.append({
                "page_no": pno + 1, "source": "ocr",
                "text": "\n".join(l["text"] for l in lines), "lines": lines,
                "image_path": img_path, "width": img.width, "height": img.height,
            })
    doc.close()
    if not pages:
        raise IngestError("PDF 没有任何页面")
    return pages


def _ingest_image(path, pages_dir, doc_id):
    from PIL import Image
    try:
        img = Image.open(path)
        img.load()
    except Exception as e:
        raise IngestError(f"图片无法打开（文件可能损坏）: {e}") from e
    os.makedirs(pages_dir, exist_ok=True)
    img_path = os.path.join(pages_dir, f"doc{doc_id}_p1.png")
    if img_path != path:
        img.convert("RGB").save(img_path)
    lines = _ocr_image(img, img_path)
    return [{
        "page_no": 1, "source": "ocr",
        "text": "\n".join(l["text"] for l in lines), "lines": lines,
        "image_path": img_path, "width": img.width, "height": img.height,
    }]


def _ingest_txt(path):
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except UnicodeDecodeError:
        with open(path, encoding="gb18030", errors="replace") as f:
            text = f.read()
    raw_lines = text.splitlines()
    if not any(l.strip() for l in raw_lines):
        raise IngestError("文本文件为空")
    # 每 50 行模拟一页，保证页码回溯能力
    pages, per = [], 50
    for i in range(0, len(raw_lines), per):
        chunk = raw_lines[i:i + per]
        pages.append({
            "page_no": i // per + 1, "source": "text",
            "text": "\n".join(chunk),
            "lines": [{"line_no": j + 1, "text": t, "bbox": None}
                      for j, t in enumerate(chunk)],
            "image_path": None, "width": None, "height": None,
        })
    return pages


def _ingest_docx(path):
    import docx
    try:
        d = docx.Document(path)
    except Exception as e:
        raise IngestError(f"DOCX 无法打开（文件可能损坏）: {e}") from e
    paras = [p.text for p in d.paragraphs]
    for table in d.tables:
        for row in table.rows:
            paras.append(" | ".join(c.text for c in row.cells))
    if not any(p.strip() for p in paras):
        raise IngestError("DOCX 中没有文字内容")
    return [{
        "page_no": 1, "source": "text", "text": "\n".join(paras),
        "lines": [{"line_no": i + 1, "text": t, "bbox": None} for i, t in enumerate(paras)],
        "image_path": None, "width": None, "height": None,
    }]


def ingest_document(conn, storage_dir, doc_id):
    """读取文档并写入 pages 表；失败时记录原因。返回 (ok, error)。"""
    from . import storage as st

    doc = conn.execute("SELECT * FROM documents WHERE id=?", (doc_id,)).fetchone()
    if not doc:
        return False, "文档不存在"
    path = doc["stored_path"]
    ext = doc["file_type"].lower()
    pages_dir = os.path.join(storage_dir, "pages")
    try:
        if ext not in SUPPORTED:
            raise IngestError(f"不支持的文件类型 {ext or '(无扩展名)'}，支持: {sorted(SUPPORTED)}")
        if not os.path.exists(path):
            raise IngestError("文件不存在或已被移动")
        if ext == ".pdf":
            pages = _ingest_pdf(path, pages_dir, doc_id)
        elif ext in (".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"):
            pages = _ingest_image(path, pages_dir, doc_id)
        elif ext in (".txt", ".md"):
            pages = _ingest_txt(path)
        elif ext == ".docx":
            pages = _ingest_docx(path)
        st.replace_pages(conn, doc_id, pages)
        st.set_document_status(conn, doc_id, "ok", None, len(pages))
        conn.commit()
        return True, None
    except IngestError as e:
        st.set_document_status(conn, doc_id, "failed", str(e), 0)
        conn.commit()
        return False, str(e)
    except Exception as e:  # 兜底：任何异常都要落到状态上，不能静默
        st.set_document_status(conn, doc_id, "failed", f"读取异常: {e}", 0)
        conn.commit()
        return False, str(e)
