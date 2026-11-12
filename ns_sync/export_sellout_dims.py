# -*- coding: utf-8 -*-
"""Sell-out BI 報表：NS 維度表匯出（D_Item、D_BOM、D_BOM_補）。

從 NetSuite【正式區】用 SuiteQL 撈 Sell-out 報表要用的三張維度表，存成 CSV（UTF-8 含 BOM），
給 Power BI 的 Power Query（06_程式碼\\PowerQuery\\02、04）讀。全程唯讀，不對 NS 做任何寫入。

連線借用「NS匯入程式」的設定與 SuiteQL 用戶端（core.config、core.netsuite）：
金鑰留在 NS匯入程式 自己的設定檔，本程式不讀、不印、不複製任何金鑰。

SQL 讀同一層 ..\\SQL 的三支 .sql（開發文檔附錄 A、B、C）。要改邏輯只改 .sql 檔；
送出前會拿掉 -- 註解（REST 分頁會把 SQL 包進子查詢，行尾註解可能吃掉括號）。

輸出（預設 SellOut報表\\05_資料包\\NS匯出\\，每次覆蓋，Power BI 的路徑才能固定）：
  D_Item.csv     項目主檔（SQL A）。同一品號有兩筆時保留啟用中、有售價的那筆
  D_BOM.csv      NS 正式 BOM 拆組表（SQL B，分攤比例 SQL 已算好；source＝NS BOM）
  D_BOM_補.csv   沒有 BOM、但有組合單的組包（SQL C）；分攤比例依 D_Item 售價計算
  D_Sellin_通路月.csv  報表三（通路別）的 Sell-in 對照：NS 部門×月的商品淨額（SQL D，選配；
                 SQL 檔不在就略過）
  匯出紀錄.txt   匯出時間、筆數、去重與異常清單

用法：
  python export_sellout_dims.py                 # 一般用法（或直接點 匯出NS維度表_正式區.bat）
  python export_sellout_dims.py --dry-run       # 只檢查路徑與 SQL，不連 NS
  python export_sellout_dims.py --ns-root "D:\\其他位置\\NS匯入程式" --out "D:\\輸出"
"""
import argparse
import csv
import io
import os
import sys
from collections import OrderedDict, defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
SELLOUT_ROOT = HERE.parents[1]                     # ...\SellOut報表
DEFAULT_SQL_DIR = HERE.parent / "SQL"
DEFAULT_OUT_DIR = SELLOUT_ROOT / "05_資料包" / "NS匯出"
DEFAULT_NS_ROOT = Path(r"C:\Users\willisxu\Desktop\02_NS匯入程式\NS匯入程式")

SQL_FILES = OrderedDict([
    ("A", "A_D_Item_項目主檔.sql"),
    ("B", "B_D_BOM_拆組表.sql"),
    ("C", "C_D_BOM補_由組合單推BOM.sql"),
    ("D", "D_Sellin_通路月_報表三選配.sql"),     # 選配：檔案不在就略過
])
OPTIONAL_SQL = {"D"}
ITEM_COLS = ["item_code", "item_name", "spec", "p3", "p6", "series", "dosage",
             "inv_type", "brand", "list_price", "inactive"]
BOM_COLS = ["kit_code", "comp_code", "comp_spec", "qty_per_kit", "comp_price", "share", "source"]
BU_COLS = BOM_COLS + ["build_no", "build_date"]
SI_COLS = ["ym", "dept_id", "dept", "sellin"]


def strip_sql_comments(sql: str) -> str:
    """拿掉 -- 行尾註解（單引號字串裡的 -- 不動）與空行。"""
    out = []
    for line in sql.splitlines():
        in_quote = False
        cut = None
        for i, ch in enumerate(line):
            if ch == "'":
                in_quote = not in_quote
            elif not in_quote and line.startswith("--", i):
                cut = i
                break
        line = (line if cut is None else line[:cut]).rstrip()
        if line.strip():
            out.append(line)
    return "\n".join(out)


def to_float(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fmt_num(v):
    """數字輸出成 CSV 字串：整數不帶 .0，小數保留完整精度；空值輸出空字串。"""
    f = to_float(v)
    if f is None:
        return ""
    return str(int(f)) if f.is_integer() else repr(f)


def clean_rows(rows):
    """REST SuiteQL 每列會帶 links，NULL 欄位會整個不出現；統一成 dict 並拿掉 links。"""
    return [{k: v for k, v in r.items() if k != "links"} for r in rows]


def dedupe_items(rows, log):
    """同一 item_code 有多筆時：品號來自 DR_料號 的優先（SQL A 的 code_src），其次啟用中（inactive≠T）、
    有售價，最後照 SQL 的排序。DR_料號空白、用項目編號補上的品號另外列出，提醒到 NS 補 DR_料號。"""
    groups = OrderedDict()
    for r in rows:
        groups.setdefault(str(r.get("item_code") or "").strip(), []).append(r)
    out, dups = [], []
    for code, rs in groups.items():
        if not code:
            continue
        if len(rs) > 1:
            rs = sorted(rs, key=lambda r: (r.get("code_src") == "項目編號",
                                           r.get("inactive") == "T",
                                           to_float(r.get("list_price")) is None))
            dups.append(f"{code}（{len(rs)} 筆，保留 {rs[0].get('item_name') or ''}"
                        f"／售價 {fmt_num(rs[0].get('list_price')) or '空白'}）")
        out.append(rs[0])
    if dups:
        log(f"  品號重複 {len(dups)} 個：" + "；".join(dups[:20]) + (" …" if len(dups) > 20 else ""))
    fb = [r for r in out if r.get("code_src") == "項目編號" and r.get("inactive") != "T"]
    if fb:
        log(f"  DR_料號空白、改用項目編號的啟用中品項 {len(fb)} 個（多為原料、包材；sell-out 有賣的應到 NS 補 DR_料號）")
    return out


def check_bom_shares(rows, log, label):
    """每個組包的分攤比例合計應為 1；列出不是的（例：BOM 用量為 0）。"""
    s = defaultdict(float)
    has_null = set()
    for r in rows:
        f = to_float(r.get("share"))
        if f is None:
            has_null.add(r["kit_code"])
        else:
            s[r["kit_code"]] += f
    bad = sorted(k for k in set(s) | has_null if k in has_null or abs(s[k] - 1) > 1e-6)
    if bad:
        log(f"  {label} 分攤比例合計不是 1 的組包 {len(bad)} 個：{'、'.join(bad[:20])}"
            f"{' …' if len(bad) > 20 else ''}（多半是 BOM 用量為 0，請到 NS 檢查）")
    return bad


def build_bu(rows_c, price, bom_kits, log):
    """SQL C 的組合單 BOM：依 D_Item 售價算分攤比例（同 SQL B 的規則）。"""
    by_kit = OrderedDict()
    for r in rows_c:
        k = str(r.get("kit_code") or "").strip()
        if not k or k in bom_kits:
            continue
        by_kit.setdefault(k, []).append(r)
    out = []
    for k, rs in by_kit.items():
        qtys = [to_float(r.get("qty_per_kit")) or 0.0 for r in rs]
        prices = [price.get(str(r.get("comp_code") or "").strip()) for r in rs]
        w = [q * (p or 0.0) for q, p in zip(qtys, prices)]
        tw, tq = sum(w), sum(qtys)
        for r, q, p, wi in zip(rs, qtys, prices, w):
            share = (wi / tw) if tw > 0 else ((q / tq) if tq > 0 else None)
            out.append({
                "kit_code": k,
                "comp_code": r.get("comp_code") or "",
                "comp_spec": r.get("comp_spec") or "",
                "qty_per_kit": fmt_num(q),
                "comp_price": fmt_num(p),
                "share": fmt_num(share),
                "source": f"NS 組合單 {r.get('build_no') or ''}（{r.get('build_date') or ''}）",
                "build_no": r.get("build_no") or "",
                "build_date": r.get("build_date") or "",
            })
    log(f"  組合單推出 BOM 的組包 {len(by_kit)} 個：{'、'.join(by_kit)}")
    if not rows_c:
        # 2026-10-08：整合角色查 transaction 完全看不到 type＝Build，可能是組合單已刪除或角色沒有組合單檢視權限
        log("  [注意] SQL C 沒有回傳任何組合單：整合角色可能沒有「組合單（Build Assembly）」檢視權限，或組合單已刪除。"
            "缺 BOM 組包仍由資料包 D_BOM_暫用 補上（UseTempBOM＝true），報表不受影響")
    return out


def write_csv(path: Path, cols, rows):
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(cols)
        for r in rows:
            w.writerow(["" if r.get(c) is None else r.get(c) for c in cols])
    try:
        os.replace(tmp, path)      # 寫完才換掉舊檔，中途失敗不會留下半個檔
    except PermissionError:
        tmp.unlink(missing_ok=True)
        sys.exit(f"[錯誤] {path.name} 正被其他程式開著（Excel／Power BI？），關掉後再執行一次")


def build_parser():
    p = argparse.ArgumentParser(
        description="Sell-out BI 報表：從 NS 正式區匯出 D_Item、D_BOM、D_BOM_補（唯讀）")
    p.add_argument("--ns-root", default=os.environ.get("NSIMP_ROOT", str(DEFAULT_NS_ROOT)),
                   help="NS匯入程式 資料夾（內含 core\\），預設 %(default)s，也可設環境變數 NSIMP_ROOT")
    p.add_argument("--sql-dir", default=str(DEFAULT_SQL_DIR), help="三支 .sql 的資料夾，預設 %(default)s")
    p.add_argument("--out", default=str(DEFAULT_OUT_DIR), help="輸出資料夾，預設 %(default)s")
    p.add_argument("--limit", type=int, default=100000, help="每段 SQL 最多取幾列（預設 100000）")
    p.add_argument("--dry-run", action="store_true", help="只檢查路徑與 SQL，不連線 NS")
    p.add_argument("--env-secrets", action="store_true",
                   help="不用 NS匯入程式，改從環境變數 NS_ACCOUNT_ID 等讀金鑰（GitHub Actions 用，見 ns_client.py）")
    return p


def main(argv=None):
    # 換成 UTF-8 輸出，cp950 主控台的中文才不會變亂碼（要在 parse_args 之前，-h 也要用）
    if hasattr(sys.stdout, "buffer"):
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", line_buffering=True)
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", line_buffering=True)
    args = build_parser().parse_args(argv)

    def as_path(s):        # 去掉前後空白與引號（cmd 傳參數時結尾的 \" 會留下引號）
        return Path(str(s).strip().strip('"').strip()).expanduser()

    ns_root = as_path(args.ns_root)
    sql_dir = as_path(args.sql_dir)
    out_dir = as_path(args.out)
    if not args.env_secrets and not (ns_root / "core" / "netsuite.py").exists():
        sys.exit(f"[錯誤] 找不到 NS匯入程式：{ns_root}\\core\\netsuite.py\n"
                 f"       請用 --ns-root 指定 NS匯入程式 資料夾，或設環境變數 NSIMP_ROOT")

    sqls = OrderedDict()
    for key, name in SQL_FILES.items():
        f = sql_dir / name
        if not f.exists():
            if key in OPTIONAL_SQL:
                continue                      # 選配的 SQL 沒放就不跑
            sys.exit(f"[錯誤] 找不到 SQL 檔：{f}")
        sqls[key] = strip_sql_comments(f.read_text(encoding="utf-8"))

    lines = []

    def log(msg=""):
        print(msg)
        lines.append(msg)

    log(f"Sell-out 維度表匯出  {datetime.now():%Y-%m-%d %H:%M:%S}")
    log(f"  NS 連線：{'環境變數（ns_client.py）' if args.env_secrets else ns_root}")
    log(f"  SQL：{sql_dir}")
    log(f"  輸出：{out_dir}")
    if args.dry_run:
        for key, sql in sqls.items():
            log(f"\n--- SQL {key}（{SQL_FILES[key]}，已去註解，{len(sql)} 字）---\n{sql}")
        log("\n[DRY-RUN] 路徑與 SQL 檢查完成，未連線 NS。")
        return 0

    if args.env_secrets:
        # GitHub Actions：金鑰由 GitHub Secrets 以環境變數帶入（正式區帳號）
        sys.path.insert(0, str(HERE))
        from ns_client import EnvSuiteQLClient
        client = EnvSuiteQLClient.from_env()
    else:
        # 這支只跑正式區；借用 NS匯入程式 的設定（金鑰由它自己讀取）
        os.environ["NSIMP_ENV"] = "prod"
        sys.path.insert(0, str(ns_root))
        from core.config import load_config
        from core.netsuite import NetSuiteClient

        cfg = load_config()
        if cfg.get("_env") != "prod":
            sys.exit(f"[錯誤] 這支只跑正式區，但實際載到 {cfg.get('_env')} 設定，請檢查 NSIMP_ENV")
        client = NetSuiteClient(cfg)

    results = {}
    for key, sql in sqls.items():
        log(f"\n執行 SQL {key}：{SQL_FILES[key]} …")
        ok, rows, err = client.suiteql(sql, limit=args.limit)
        if not ok:
            log(f"  [失敗] {err}")
            if key in ("A", "B"):
                Path(out_dir).mkdir(parents=True, exist_ok=True)
                (out_dir / "匯出紀錄.txt").write_text("\n".join(lines), encoding="utf-8-sig")
                return 1
            rows = []
        rows = clean_rows(rows)
        if len(rows) >= args.limit:
            log(f"  [警告] 回傳 {len(rows)} 列＝上限，資料可能沒拿完，請加大 --limit")
        log(f"  {len(rows):,} 列")
        results[key] = rows

    out_dir.mkdir(parents=True, exist_ok=True)

    # A → D_Item
    for r in results["A"]:
        r["inactive"] = "T" if str(r.get("inactive") or "").strip().upper() in ("T", "TRUE") else "F"
    items = dedupe_items(results["A"], log)
    for r in items:
        r["list_price"] = fmt_num(r.get("list_price"))
    write_csv(out_dir / "D_Item.csv", ITEM_COLS, items)
    price = {str(r["item_code"]).strip(): to_float(r.get("list_price")) for r in items}
    log(f"D_Item.csv：{len(items):,} 個品號")

    # B → D_BOM
    bom = []
    for r in results["B"]:
        bom.append({
            "kit_code": str(r.get("kit_code") or "").strip(),
            "comp_code": r.get("comp_code") or "",
            "comp_spec": r.get("comp_spec") or "",
            "qty_per_kit": fmt_num(r.get("qty_per_kit")),
            "comp_price": fmt_num(r.get("comp_price")),
            "share": fmt_num(r.get("share")),
            "source": "NS BOM",
        })
    bom_kits = {r["kit_code"] for r in bom}
    check_bom_shares(bom, log, "D_BOM")
    write_csv(out_dir / "D_BOM.csv", BOM_COLS, bom)
    log(f"D_BOM.csv：{len(bom):,} 列、{len(bom_kits):,} 個組包")

    # C → D_BOM_補
    bu = build_bu(results.get("C", []), price, bom_kits, log)
    check_bom_shares(bu, log, "D_BOM_補")
    write_csv(out_dir / "D_BOM_補.csv", BU_COLS, bu)
    log(f"D_BOM_補.csv：{len(bu):,} 列")

    # D → D_Sellin_通路月（選配）
    if "D" in results:
        si = [{"ym": r.get("ym") or "", "dept_id": r.get("dept_id") or "", "dept": r.get("dept") or "",
               "sellin": fmt_num(r.get("sellin"))} for r in results["D"]]
        write_csv(out_dir / "D_Sellin_通路月.csv", SI_COLS, si)
        tot = defaultdict(float)
        for r in si:
            tot[r["ym"]] += to_float(r["sellin"]) or 0.0
        log(f"D_Sellin_通路月.csv：{len(si):,} 列；各月合計 " +
            "、".join(f"{k} {v:,.0f}" for k, v in sorted(tot.items())))

    (out_dir / "匯出紀錄.txt").write_text("\n".join(lines), encoding="utf-8-sig")
    log(f"\n[完成] 已輸出到 {out_dir}，Power BI 重新整理即可。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
