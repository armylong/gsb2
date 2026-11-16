"""本地测试数据生成器(无需任何真实数据库服务)。

生成内容
========

- snapshot/: 初始快照(manifest.json + 每表一个 JSONL)
- changes/:  按序号编号的变更文件 NNNNN.jsonl, 每行一个事件:
    行事件   {"seq", "txn_id", "op_order", "kind":"row",
              "table", "op", "payload"}
    提交标记 {"seq", "txn_id", "kind":"commit"}
- config.json: 与数据匹配的同步配置

支持的场景模式 --mode:
  clean        正常数据, 含跨文件事务
  gap          制造序号缺口
  dup_conflict 同一序号重复投递但内容不一致
  dup_same     同一文件原样重复投递(幂等测试)
  missing_row  修改/删除不存在的记录
  overlap      部分变更已被快照包含(不能重复生效)
"""

import json
import os

_MODES = ("clean", "gap", "dup_conflict", "dup_same", "missing_row", "overlap")

_DEFAULT_CONFIG = {
    "snapshot_dir": "snapshot",
    "changes_dir": "changes",
    "target_db": "target/target.db",
    "tables": {
        "customer": {
            "target_table": "customer",
            "key": ["id"],
            "columns": {
                "id": {"target": "id", "type": "INTEGER"},
                "name": {"target": "name", "type": "TEXT"},
                "city": {"target": "city", "type": "TEXT"},
            },
        },
        "order": {
            "target_table": "customer_order",
            "key": ["id"],
            "columns": {
                "id": {"target": "id", "type": "INTEGER"},
                "customer_id": {"target": "customer_id", "type": "INTEGER"},
                "amount": {"target": "amount", "type": "REAL"},
                "status": {"target": "status", "type": "TEXT"},
            },
        },
    },
}


class _Writer:
    def __init__(self, changes_dir, start_file=1):
        self.changes_dir = changes_dir
        self.file_no = start_file
        self.lines = []

    def emit(self, event):
        self.lines.append(json.dumps(event, ensure_ascii=False))

    def row(self, seq, txn_id, op_order, table, op, payload):
        self.emit(
            {
                "seq": seq,
                "txn_id": txn_id,
                "op_order": op_order,
                "kind": "row",
                "table": table,
                "op": op,
                "payload": payload,
            }
        )

    def commit(self, seq, txn_id):
        self.emit({"seq": seq, "txn_id": txn_id, "kind": "commit"})

    def flush(self):
        path = os.path.join(self.changes_dir, f"{self.file_no:05d}.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(self.lines) + "\n")
        self.file_no += 1
        self.lines = []
        return os.path.basename(path)

    def write_raw_file(self, lines, number=None):
        number = number or self.file_no
        path = os.path.join(self.changes_dir, f"{number:05d}.jsonl")
        with open(path, "w", encoding="utf-8") as fh:
            for event in lines:
                fh.write(json.dumps(event, ensure_ascii=False) + "\n")
        self.file_no = number + 1
        return os.path.basename(path)


def _write_snapshot(root, snapshot_seq, customers, orders):
    snap_dir = os.path.join(root, "snapshot")
    os.makedirs(snap_dir, exist_ok=True)
    with open(os.path.join(snap_dir, "customers.jsonl"), "w", encoding="utf-8") as fh:
        for row in customers:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    with open(os.path.join(snap_dir, "orders.jsonl"), "w", encoding="utf-8") as fh:
        for row in orders:
            fh.write(json.dumps(row, ensure_ascii=False) + "\n")
    manifest = {
        "snapshot_seq": snapshot_seq,
        "tables": {"customer": "customers.jsonl", "order": "orders.jsonl"},
    }
    with open(os.path.join(snap_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, ensure_ascii=False, indent=2)


def _baseline(snapshot_seq=4):
    customers = [
        {"id": 1, "name": "张三", "city": "北京"},
        {"id": 2, "name": "李四", "city": "上海"},
        {"id": 3, "name": "王五", "city": "广州"},
    ]
    orders = [
        {"id": 101, "customer_id": 1, "amount": 100.0, "status": "paid"},
        {"id": 102, "customer_id": 2, "amount": 200.5, "status": "pending"},
    ]
    return customers, orders, snapshot_seq


def generate(root, mode="clean"):
    """在 root 下生成一整套测试数据, 返回生成摘要。"""
    if mode not in _MODES:
        raise ValueError(f"未知模式 {mode}, 可选 {_MODES}")
    root = os.path.abspath(root)
    changes_dir = os.path.join(root, "changes")
    os.makedirs(changes_dir, exist_ok=True)

    # overlap 模式: 快照已经包含到 seq=8 的变更, 变更文件从 seq=5 开始投递
    snapshot_seq = 8 if mode == "overlap" else 4
    customers, orders, snapshot_seq = _baseline(snapshot_seq)
    if mode == "overlap":
        # 把 seq 5..8 对应的变化烘焙进快照: 客户4 已插入、订单101 已改价
        customers.append({"id": 4, "name": "赵六", "city": "杭州"})
        orders[0] = {"id": 101, "customer_id": 1, "amount": 120.0, "status": "paid"}

    _write_snapshot(root, snapshot_seq, customers, orders)
    with open(os.path.join(root, "config.json"), "w", encoding="utf-8") as fh:
        json.dump(_DEFAULT_CONFIG, fh, ensure_ascii=False, indent=2)

    w = _Writer(changes_dir)
    seq = snapshot_seq + 1
    files = []

    def txn(txn_id, ops):
        """ops: [(table, op, payload)], 自动编号 op_order, 返回用掉的序号。"""
        nonlocal seq
        used = []
        for i, (table, op, payload) in enumerate(ops, 1):
            w.row(seq, txn_id, i, table, op, payload)
            used.append(seq)
            seq += 1
        w.commit(seq, txn_id)
        used.append(seq)
        seq += 1
        return used

    if mode == "overlap":
        # 先重放已被快照覆盖的 seq 5..8(内容必须与快照一致),
        # 验证同步器把它们标为 covered 而不是再应用一次
        w.row(5, "T005", 1, "customer", "INSERT",
              {"id": 4, "name": "赵六", "city": "杭州"})
        w.commit(6, "T005")
        w.row(7, "T006", 1, "order", "UPDATE",
              {"id": 101, "customer_id": 1, "amount": 120.0, "status": "paid"})
        w.commit(8, "T006")
        files.append(w.flush())

    # T007: 单文件内的普通事务, 客户+订单一起改
    txn("T007", [
        ("customer", "UPDATE", {"id": 1, "name": "张三", "city": "深圳"}),
        ("order", "INSERT",
         {"id": 103, "customer_id": 1, "amount": 50.0, "status": "pending"}),
    ])
    files.append(w.flush())

    # T008: 跨文件事务 —— 行事件在 00002, 提交标记在 00003
    w.row(seq, "T008", 1, "customer", "DELETE",
          {"id": 3, "name": "王五", "city": "广州"})
    seq += 1
    w.row(seq, "T008", 2, "order", "UPDATE",
          {"id": 102, "customer_id": 2, "amount": 210.0, "status": "paid"})
    seq += 1
    files.append(w.flush())
    w.commit(seq, "T008")
    seq += 1
    # T009 紧跟其后, 保证 00003 里还有别的完整事务
    txn("T009", [
        ("customer", "INSERT", {"id": 5, "name": "钱七", "city": "成都"}),
    ])
    files.append(w.flush())

    # T010: 客户与订单在同一事务里, 验证原子性(异常模式下制造失败)
    txn("T010", [
        ("order", "UPDATE",
         {"id": 103, "customer_id": 1, "amount": 55.0, "status": "paid"}),
        ("customer", "UPDATE",
         {"id": 5, "name": "钱七", "city": "重庆"}),
    ])
    files.append(w.flush())

    anomaly = None
    if mode == "gap":
        # 跳过下一个序号, 直接 +2 制造缺口
        gap_from = seq
        seq += 1
        w.row(seq, "T011", 1, "customer", "INSERT",
              {"id": 6, "name": "孙八", "city": "武汉"})
        seq += 1
        w.commit(seq, "T011")
        files.append(w.flush())
        anomaly = {"reason": "seq_gap", "missing": gap_from}

    elif mode == "dup_conflict":
        # 先正常投递一个事件并提交
        w.row(seq, "T011", 1, "customer", "INSERT",
              {"id": 6, "name": "孙八", "city": "武汉"})
        conflict_seq = seq
        seq += 1
        w.commit(seq, "T011")
        seq += 1
        files.append(w.flush())
        # 下一个文件用相同 seq 但内容不同
        w.row(conflict_seq, "T011-X", 1, "customer", "INSERT",
              {"id": 6, "name": "冒名者", "city": "西安"})
        files.append(w.flush())
        anomaly = {"reason": "duplicate_conflict", "seq": conflict_seq}

    elif mode == "dup_same":
        # 正常事务
        w.row(seq, "T011", 1, "customer", "INSERT",
              {"id": 6, "name": "孙八", "city": "武汉"})
        seq += 1
        w.commit(seq, "T011")
        seq += 1
        dup_lines = list(w.lines)
        files.append(w.flush())
        # 原样再投一份, 文件名编号靠后但内容完全一致
        dup_name = w.write_raw_file(
            [json.loads(line) for line in dup_lines], number=w.file_no
        )
        files.append(dup_name)
        anomaly = {"reason": None, "duplicate_file": dup_name}

    elif mode == "missing_row":
        # 删除一个根本不存在的客户; 同事务里还有一条合法订单变更,
        # 必须整体失败、订单也不能生效
        w.row(seq, "T011", 1, "customer", "DELETE",
              {"id": 999, "name": "幽灵", "city": "虚无"})
        seq += 1
        w.row(seq, "T011", 2, "order", "UPDATE",
              {"id": 103, "customer_id": 1, "amount": 999.0, "status": "paid"})
        seq += 1
        w.commit(seq, "T011")
        files.append(w.flush())
        anomaly = {"reason": "modify_missing", "txn_id": "T011"}

    if mode == "clean":
        # 干净数据再补一笔, 让最终状态更丰富
        txn("T011", [
            ("customer", "INSERT", {"id": 6, "name": "孙八", "city": "武汉"}),
        ])
        files.append(w.flush())

    return {
        "root": root,
        "mode": mode,
        "snapshot_seq": snapshot_seq,
        "files": files,
        "anomaly": anomaly,
        "config": os.path.join(root, "config.json"),
    }


def available_modes():
    return _MODES
