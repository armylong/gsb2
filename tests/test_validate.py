from extractor.validate import validate_amount, validate_date, validate_id


def test_date_formats():
    assert validate_date("2026年3月15日") == (True, "2026-03-15")
    assert validate_date("2026-03-15") == (True, "2026-03-15")
    assert validate_date("2026/3/5") == (True, "2026-03-05")
    assert validate_date("2026.03.15") == (True, "2026-03-15")


def test_date_invalid():
    ok, _ = validate_date("2026年13月40日")
    assert not ok
    ok, _ = validate_date("2026-02-30")
    assert not ok
    ok, _ = validate_date("昨天")
    assert not ok


def test_amount():
    assert validate_amount("¥128,500.00") == (True, "128500.00")
    assert validate_amount("人民币 128,500.00 元") == (True, "128500.00")
    assert validate_amount("￥1000") == (True, "1000.00")
    ok, _ = validate_amount("一百万元")
    assert not ok
    ok, _ = validate_amount("abc")
    assert not ok


def test_id():
    assert validate_id("HT-2026-018")[0]
    assert validate_id("ABC_123/45")[0]
    assert not validate_id("")[0]
    assert not validate_id("编号 带空格")[0]
    # 自定义规则
    assert validate_id("HT-2026-018", r"[A-Z]{2}-\d{4}-\d{3}")[0]
    assert not validate_id("HT2026018", r"[A-Z]{2}-\d{4}-\d{3}")[0]
