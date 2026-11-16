"""复现包导入: 目录与 zip 两种来源, 全程按不可信数据处理。

安全措施:
- zip 成员路径校验 (拒绝绝对路径/盘符/``..`` 跳转), 防止 zip slip;
- 单文件与整包体量限制 (safety.py), 超限截断而非崩溃;
- 单文件损坏只标记该文件, 其他文件照常导入;
- 整包无法读取时抛 :class:`ImportFatalError`, 由调用方保证现有工程不变。
"""

from __future__ import annotations

import hashlib
import os
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

from . import correlation
from .classifier import classify
from .models import (
    EvidenceFile, Package, Project, new_id,
    PARSE_BINARY, PARSE_TRUNCATED,
)
from .parser import decode_text, parse_file
from .safety import (
    MAX_FILE_BYTES, MAX_PACKAGE_BYTES, MAX_TEXT_STORE_CHARS,
    validate_zip_member_name,
)


class ImportFatalError(Exception):
    """整包无法读取 (不是单文件问题)。"""


@dataclass
class ImportedItem:
    file: EvidenceFile
    warnings: list[str] = field(default_factory=list)


@dataclass
class ImportReport:
    package: Package
    items: list[ImportedItem] = field(default_factory=list)
    duplicates: list[dict[str, str]] = field(default_factory=list)
    fatal_error: str | None = None

    @property
    def ok(self) -> bool:
        return self.fatal_error is None


# ---------------------------------------------------------------------------
# 来源读取: 统一产出 (rel_path, data_bytes, source_path) 迭代器
# ---------------------------------------------------------------------------

def _iter_directory(root: Path):
    total = 0
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames.sort()
        for name in sorted(filenames):
            abs_path = Path(dirpath) / name
            rel_path = str(abs_path.relative_to(root))
            try:
                size = abs_path.stat().st_size
            except OSError as exc:
                yield rel_path, None, str(abs_path), f"文件状态读取失败: {exc}"
                continue
            total += size
            if total > MAX_PACKAGE_BYTES:
                yield rel_path, None, str(abs_path), \
                    f"整包体量超过 {MAX_PACKAGE_BYTES} 字节上限, 跳过后续文件"
                return
            try:
                data = abs_path.read_bytes()
            except OSError as exc:
                yield rel_path, None, str(abs_path), f"文件读取失败: {exc}"
                continue
            yield rel_path, data, str(abs_path), None


def _iter_zip(zip_path: Path):
    try:
        zf = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError) as exc:
        raise ImportFatalError(f"无法打开 zip 复现包: {exc}") from exc
    with zf:
        # 先做整包体量与成员名预检, 不落地解压任何文件
        infos = [i for i in zf.infolist() if not i.is_dir()]
        if sum(i.file_size for i in infos) > MAX_PACKAGE_BYTES:
            raise ImportFatalError(
                f"zip 解压后总体量超过 {MAX_PACKAGE_BYTES} 字节上限")
        total = 0
        for info in infos:
            rel = info.filename
            if not validate_zip_member_name(rel):
                # 危险成员名: 完全跳过, 不读取不入库
                continue
            total += info.file_size
            if total > MAX_PACKAGE_BYTES:
                yield rel, None, f"{zip_path}!{rel}", \
                    "超出整包体量上限, 跳过该文件"
                continue
            try:
                with zf.open(info) as fh:
                    data = fh.read(MAX_FILE_BYTES + 1)
            except (zipfile.BadZipFile, OSError, RuntimeError) as exc:
                # CRC 损坏 / 截断等: 该文件标记失败, 其他成员继续
                yield rel, None, f"{zip_path}!{rel}", f"zip 成员读取失败: {exc}"
                continue
            yield rel, data, f"{zip_path}!{rel}", None


# ---------------------------------------------------------------------------
# 单文件处理
# ---------------------------------------------------------------------------

def _process_one(rel_path: str, data: bytes | None, source_path: str,
                 read_error: str | None, package_id: str,
                 existing_hashes: dict[str, str]) -> ImportedItem:
    warnings: list[str] = []
    if read_error:
        warnings.append(read_error)

    sha = hashlib.sha256()
    md5 = hashlib.md5()
    if data is not None:
        sha.update(data)
        md5.update(data)
    digest_sha = sha.hexdigest()
    digest_md5 = md5.hexdigest()

    truncated = False
    if data is not None and len(data) > MAX_FILE_BYTES:
        data = data[:MAX_FILE_BYTES]
        truncated = True
        warnings.append(
            f"文件超过 {MAX_FILE_BYTES} 字节, 仅解析前 {MAX_FILE_BYTES} 字节")

    text: str | None = None
    binary = False
    if data is None:
        # 读取失败: 保留元数据, 正文为空
        parse = parse_file("other", None, rel_path, binary=True)
        if read_error:
            parse.error = read_error
        binary = True
    else:
        text, decode_err = decode_text(data)
        if decode_err:
            warnings.append(decode_err)
        binary = text is None
        kind = classify(rel_path, text)
        parse = parse_file(kind, text, rel_path, binary)
        if decode_err and parse.status == "ok":
            parse.status = "fallback"
            parse.error = decode_err
        if truncated:
            parse.truncated = True
            # 截断本身就是一种需要显式标识的状态, 即使结构仍可解析
            parse.status = PARSE_TRUNCATED
        if text is not None and len(text) > MAX_TEXT_STORE_CHARS:
            text = text[:MAX_TEXT_STORE_CHARS]
            warnings.append(
                f"工程内文本超过 {MAX_TEXT_STORE_CHARS} 字符, 已截断保存")

    kind = classify(rel_path, text) if data is not None else "other"
    ev = EvidenceFile(
        id=new_id("f"),
        package_id=package_id,
        rel_path=rel_path,
        source_path=source_path,
        kind=kind,
        size_bytes=len(data) if data is not None else 0,
        sha256=digest_sha,
        md5=digest_md5,
        parse=parse,
        text=text,
        text_truncated=truncated,
    )
    if data is not None and digest_sha in existing_hashes:
        ev.duplicate_of = existing_hashes[digest_sha]
        ev.duplicate_reason = f"sha256 与已导入文件 {ev.duplicate_of} 完全一致"
        warnings.append(ev.duplicate_reason + "; 已保留两份证据, 未静默覆盖")
    return ImportedItem(file=ev, warnings=warnings)


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def import_package(project: Project, path: str | Path) -> ImportReport:
    """把一个复现包导入工程 (就地修改 project)。

    整包致命错误抛 :class:`ImportFatalError`, 此时不会改动 project。
    """
    root = Path(path).expanduser().resolve()
    if not root.exists():
        raise ImportFatalError(f"路径不存在: {root}")

    # 按扩展名/目录判定来源, 截断/损坏的 .zip 也进入 zip 流程,
    # 由 _iter_zip 抛出准确的 BadZipFile 错误 (而不是被误判成普通文件)
    if root.is_dir():
        source_type = "directory"
    elif root.is_file() and root.suffix.lower() == ".zip":
        source_type = "zip"
    elif root.is_file() and zipfile.is_zipfile(root):
        source_type = "zip"
    else:
        raise ImportFatalError(
            f"既不是受支持的 zip 文件也不是目录: {root}")

    package = Package(
        id=new_id("pkg"),
        name=root.name,
        source_path=str(root),
        source_type=source_type,
    )
    report = ImportReport(package=package)

    # 用预扫描拿到的条目先构建对象, 全部成功后再提交到工程,
    # 保证迭代中途的致命错误不会污染当前工程。
    existing_hashes = {f.sha256: f.id for f in project.files
                       if f.sha256}
    pending: list[ImportedItem] = []
    try:
        iterator = _iter_zip(root) if source_type == "zip" else _iter_directory(root)
        for rel_path, data, source_path, read_error in iterator:
            item = _process_one(
                rel_path, data, source_path, read_error,
                package.id, existing_hashes)
            pending.append(item)
            if item.file.sha256 and not read_error:
                # 同一包内重复也要标识
                existing_hashes.setdefault(item.file.sha256, item.file.id)
    except ImportFatalError:
        raise
    except Exception as exc:  # 防御: 未预期错误按整包失败处理, 不动工程
        raise ImportFatalError(
            f"导入过程中发生未预期错误: {type(exc).__name__}: {exc}") from exc

    # ---- 提交阶段: 只有走到这里才修改工程 ----
    project.packages.append(package)
    for item in pending:
        project.files.append(item.file)
        package.file_ids.append(item.file.id)
        report.items.append(item)
        if item.file.duplicate_of:
            report.duplicates.append({
                "file_id": item.file.id,
                "rel_path": item.file.rel_path,
                "duplicate_of": item.file.duplicate_of,
                "reason": item.file.duplicate_reason or "",
            })
    correlation.rebuild(project)
    project.log_op(
        "import_package",
        f"导入 {source_type} 包 {root.name}: {len(pending)} 个文件, "
        f"{len(report.duplicates)} 个重复证据",
    )
    return report
