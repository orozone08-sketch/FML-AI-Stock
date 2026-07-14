#!/usr/bin/env python3
"""Export a consistent, read-only MySQL snapshot as strict D1 SQL parts."""
from __future__ import annotations

import argparse, datetime as dt, decimal, hashlib, json, os, pathlib, re, sys
from typing import Any

TABLES = [
    ("company", "companies"), ("user", "users"), ("permission_override", "permission_overrides"),
    ("stock_book", "stock_books"), ("item", "items"), ("supplier", "suppliers"), ("customer", "customers"),
    ("payment_mode", "payment_modes"), ("opening_stock", "opening_stocks"), ("opening_stock_line", "opening_stock_lines"),
    ("purchase", "purchases"), ("purchase_line", "purchase_lines"), ("sale", "sales"), ("sale_line", "sale_lines"),
    ("inter_company_transfer", "inter_company_transfers"), ("transfer_line", "transfer_lines"), ("fifo_layer", "fifo_layers"),
    ("fifo_consumption", "fifo_consumptions"), ("stock_ledger_entry", "stock_ledger_entries"), ("receivable", "receivables"),
    ("payable", "payables"), ("payment", "payments"), ("payment_allocation", "payment_allocations"),
    ("inter_company_ledger_entry", "inter_company_ledger_entries"), ("audit_log", "audit_logs"), ("alert", "alerts"),
]
SCALES = {
    "gst_percent": ("gst_basis_points", 100), "minimum_stock": ("minimum_stock_milliunits", 1000),
    "quantity": ("quantity_milliunits", 1000), "original_quantity": ("original_quantity_milliunits", 1000),
    "available_quantity": ("available_quantity_milliunits", 1000), "quantity_in": ("quantity_in_milliunits", 1000),
    "quantity_out": ("quantity_out_milliunits", 1000), "rate": ("rate_ten_thousandths", 10000),
    "sale_rate": ("sale_rate_ten_thousandths", 10000), "unit_cost": ("unit_cost_ten_thousandths", 10000),
}
MONEY = {"value", "subtotal", "gst_amount", "line_total", "gst_total", "grand_total", "fifo_cost", "fifo_value", "gross_profit",
         "paid_amount", "balance_amount", "total_fifo_value", "original_value", "available_value", "total_amount",
         "allocated_amount", "unallocated_amount", "amount", "amount_owed", "settled_amount", "ledger_value"}
BOOLS = {"active","force_password_change","allow_gst_purchase","allow_cash_purchase","allow_gst_sale","allow_cash_sale",
         "is_void","is_opening","mismatch_approved","resolved","can_view","can_create","can_edit","can_approve","can_export","can_deactivate"}

def destination_column(name: str) -> tuple[str, int | None]:
    if name in SCALES: return SCALES[name]
    if name in MONEY: return f"{name}_paise", 100
    return name, None

def scaled(value: Any, scale: int) -> int | None:
    if value is None: return None
    number = decimal.Decimal(str(value)) * scale
    integral = number.quantize(decimal.Decimal("1"), rounding=decimal.ROUND_HALF_UP)
    if number != integral: raise ValueError(f"value {value!r} is not exactly representable at scale {scale}")
    result = int(integral)
    if not -(2**53 - 1) <= result <= 2**53 - 1: raise OverflowError(f"scaled integer outside JavaScript safe range: {value!r}")
    return result

def sql_literal(value: Any) -> str:
    if value is None: return "NULL"
    if isinstance(value, bool): return "1" if value else "0"
    if isinstance(value, (int, decimal.Decimal)): return str(value)
    if isinstance(value, dt.datetime): value = value.isoformat(timespec="milliseconds") + ("Z" if value.tzinfo is None else "")
    elif isinstance(value, dt.date): value = value.isoformat()
    if isinstance(value, (bytes, bytearray)): return "X'" + bytes(value).hex() + "'"
    return "'" + str(value).replace("'", "''") + "'"

def safe_output(path: pathlib.Path, repo: pathlib.Path) -> pathlib.Path:
    resolved = path.resolve()
    if resolved == repo or repo in resolved.parents: raise ValueError("export output must be outside the repository")
    if any(part.lower() in {"onedrive", "dropbox", "google drive", "icloud drive"} for part in resolved.parts):
        raise ValueError("export output must not be in a cloud-synced directory")
    resolved.mkdir(parents=True, exist_ok=False)
    return resolved

def transform_row(columns: list[str], row: tuple[Any, ...]) -> tuple[list[str], list[Any]]:
    names, values = [], []
    for name, value in zip(columns, row, strict=True):
        target, scale = destination_column(name)
        names.append(target)
        if scale: value = scaled(value, scale)
        elif name in BOOLS and value is not None: value = int(bool(value))
        values.append(value)
    return names, values

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--chunk-rows", type=int, default=250)
    parser.add_argument("--allow-insecure-transport", action="store_true")
    args = parser.parse_args()
    if args.chunk_rows < 1 or args.chunk_rows > 500: parser.error("--chunk-rows must be 1..500")
    required = ["MYSQL_HOST","MYSQL_PORT","MYSQL_DATABASE","MYSQL_USER","MYSQL_PASSWORD"]
    missing = [key for key in required if not os.environ.get(key)]
    if missing: parser.error("missing environment variables: " + ", ".join(missing))
    repo = pathlib.Path(__file__).resolve().parents[2]
    output = safe_output(args.output, repo)
    try:
        import pymysql
        ssl = None if args.allow_insecure_transport else {"check_hostname": True}
        conn = pymysql.connect(host=os.environ["MYSQL_HOST"], port=int(os.environ["MYSQL_PORT"]), database=os.environ["MYSQL_DATABASE"],
            user=os.environ["MYSQL_USER"], password=os.environ["MYSQL_PASSWORD"], ssl=ssl,
            ssl_verify_cert=not args.allow_insecure_transport, ssl_verify_identity=not args.allow_insecure_transport,
            autocommit=False, read_timeout=60)
        manifest: dict[str, Any] = {"format_version": 1, "source_database_sha256": hashlib.sha256(os.environ["MYSQL_DATABASE"].encode()).hexdigest(),
            "snapshot_at": dt.datetime.now(dt.timezone.utc).isoformat(), "tables": {}, "parts": [], "control_totals": {}}
        with conn.cursor() as cursor:
            cursor.execute("SHOW GRANTS FOR CURRENT_USER")
            grants = " ".join(str(row[0]).upper() for row in cursor.fetchall())
            forbidden = {"INSERT", "UPDATE", "DELETE", "CREATE", "ALTER", "DROP", "TRIGGER", "EXECUTE", "ALL PRIVILEGES"}
            if any(re.search(rf"\b{re.escape(privilege)}\b", grants) for privilege in forbidden):
                raise PermissionError("export account has write/DDL privileges; use a SELECT-only MySQL user")
            cursor.execute("SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            cursor.execute("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
            part_number = 0
            for source, destination in TABLES:
                cursor.execute(f"SELECT * FROM `{source}` ORDER BY id")
                columns = [item[0] for item in cursor.description]
                count = 0
                while True:
                    rows = cursor.fetchmany(args.chunk_rows)
                    if not rows: break
                    part_number += 1; count += len(rows)
                    lines = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"]
                    for row in rows:
                        names, values = transform_row(columns, row)
                        totals = manifest["control_totals"].setdefault(destination, {})
                        for name, value in zip(names, values, strict=True):
                            if value is not None and isinstance(value, int) and (name.endswith("_paise") or name.endswith("_milliunits")):
                                totals[name] = totals.get(name, 0) + value
                        lines.append(f"INSERT INTO {destination} ({','.join(names)}) VALUES ({','.join(sql_literal(v) for v in values)});")
                    lines.append("COMMIT;")
                    payload = ("\n".join(lines) + "\n").encode()
                    filename = f"{part_number:04d}-{destination}.sql"
                    (output / filename).write_bytes(payload)
                    manifest["parts"].append({"file": filename, "sha256": hashlib.sha256(payload).hexdigest(), "rows": len(rows), "table": destination})
                manifest["tables"][destination] = count
            conn.rollback()
        conn.close()
        canonical = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode()
        manifest["snapshot_id"] = hashlib.sha256(canonical).hexdigest()
        (output / "manifest.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"Exported snapshot {manifest['snapshot_id']} to {output}")
        return 0
    except Exception:
        for child in output.glob("*"): child.unlink(missing_ok=True)
        output.rmdir()
        raise

if __name__ == "__main__": raise SystemExit(main())
