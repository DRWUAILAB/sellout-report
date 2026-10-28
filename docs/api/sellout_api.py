"""
Sell-out 中繼表取數（API）

中繼表由 build/build_data.py 產生，加密後放在 GitHub Pages：
    https://drwuailab.github.io/sellout-report/api/index.json   表清單（不含資料、不用密碼）
    https://drwuailab.github.io/sellout-report/api/<表代號>.enc  加密資料（密碼同網頁報表）

表代號：so＝未拆組明細（年月×通路×品號×幣別，附通路與品項維度）、item＝品項主檔、channel＝通路對照、bom＝拆組表

Python：
    from sellout_api import fetch, fetch_df, tables
    tables()                                    # 表清單
    rows = fetch("so", password="...")           # list[dict]，數值欄已轉 float
    df = fetch_df("so")                          # pandas DataFrame（需安裝 pandas）
命令列：
    python sellout_api.py --list
    python sellout_api.py so -o 未拆組明細.csv
密碼依序取：參數 password → 環境變數 SELLOUT_PASSWORD → 執行時詢問。
--base（或環境變數 SELLOUT_API_BASE）可改用別的網址或本機資料夾（例 docs/api）。
需求：Python 3.8+、cryptography。
"""
import argparse
import base64
import csv
import getpass
import gzip
import io
import json
import os
import sys
import urllib.request
from pathlib import Path

BASE = os.environ.get("SELLOUT_API_BASE", "https://drwuailab.github.io/sellout-report/api")


def _get(name, base):
    base = base or BASE
    if base.startswith(("http://", "https://")):
        req = urllib.request.Request(f"{base.rstrip('/')}/{name}", headers={"Cache-Control": "no-cache"})
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.read()
    return (Path(base) / name).read_bytes()


def tables(base=None):
    """表清單：[{name, title, rows, columns, numeric}, ...]，另含 generated（建置時間）。"""
    return json.loads(_get("index.json", base))


def _decrypt(enc, password):
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    b = base64.b64decode
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b(enc["salt"]), iterations=enc["iter"]).derive(password.encode())
    try:
        return gzip.decompress(AESGCM(key).decrypt(b(enc["iv"]), b(enc["ct"]), None))
    except InvalidTag:
        raise ValueError("密碼錯誤，無法解密") from None


def fetch_csv(name, password=None, base=None):
    """回傳中繼表的 CSV 文字（UTF-8，第一列為欄名）。"""
    password = password or os.environ.get("SELLOUT_PASSWORD") or getpass.getpass("Sell-out 報表密碼：")
    return _decrypt(json.loads(_get(f"{name}.enc", base)), password).decode("utf-8")


def fetch(name, password=None, base=None):
    """回傳 list[dict]；空白＝None，數值欄（售價、數量、台幣金額、用量、分攤比例）轉 float。"""
    meta = next((t for t in tables(base)["tables"] if t["name"] == name), None)
    if not meta:
        raise KeyError(f"沒有中繼表 {name}")
    numeric = set(meta["numeric"])
    rows = []
    for r in csv.DictReader(io.StringIO(fetch_csv(name, password, base))):
        rows.append({k: (None if v == "" else float(v) if k in numeric else v) for k, v in r.items()})
    return rows


def fetch_df(name, password=None, base=None):
    """回傳 pandas DataFrame；代碼欄（品號、通路別、年月…）保持文字，不會掉前導 0。"""
    import pandas as pd
    meta = next(t for t in tables(base)["tables"] if t["name"] == name)
    dtype = {c: (float if c in meta["numeric"] else str) for c in meta["columns"]}
    return pd.read_csv(io.StringIO(fetch_csv(name, password, base)), dtype=dtype, keep_default_na=False, na_values=[""])


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description="Sell-out 中繼表取數")
    ap.add_argument("table", nargs="?", help="表代號：so、item、channel、bom")
    ap.add_argument("-o", "--out", help="輸出 CSV 檔（含 BOM，Excel 可直接開）；省略＝印到畫面")
    ap.add_argument("--list", action="store_true", help="列出中繼表")
    ap.add_argument("--base", default=None, help=f"API 網址或本機資料夾（預設 {BASE}）")
    args = ap.parse_args()
    if args.list or not args.table:
        idx = tables(args.base)
        print(f"建置時間 {idx['generated']}")
        for t in idx["tables"]:
            print(f"  {t['name']:<8} {t['title']:<8} {t['rows']:>8,} 列  {'、'.join(t['columns'])}")
        return
    text = fetch_csv(args.table, base=args.base)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8-sig")
        print(f"已輸出 {args.out}（{text.count(chr(10)) - 1:,} 列）")
    else:
        sys.stdout.write(text)


if __name__ == "__main__":
    main()
