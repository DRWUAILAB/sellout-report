# -*- coding: utf-8 -*-
"""網頁「從 NS 同步」：GitHub Actions 執行的程式（.github/workflows/ns-sync.yml）。

1. 用 export_sellout_dims.py（--env-secrets，金鑰來自 GitHub Secrets）從 NS 正式區跑 SQL A～C，
   產生 D_Item.csv、D_BOM.csv、D_BOM_補.csv（只讀，不寫入 NS）
2. 三個 CSV 與匯出紀錄打包成 JSON，gzip 後用查看報表的密碼（Secret SELLOUT_PASSWORD）加密，
   格式同 docs/data.enc（PBKDF2-SHA256 25 萬次 → AES-256-GCM）
3. workflow 把加密檔推到 ns-sync 分支；網頁讀回、解密後走「上傳 NS 維度表」同一套流程（預覽差異 → 套用 → 發布）

repo 與 Actions 記錄都是公開的：匯出細節只寫進加密檔，畫面上只印筆數。

本機測試（需要 NS 金鑰環境變數與 SELLOUT_PASSWORD）：
    python ns_sync/run_ns_sync.py --request-id test --out /tmp/ns_sync.enc
"""
import argparse
import base64
import contextlib
import gzip
import io
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

HERE = Path(__file__).resolve().parent
ITER = 250_000                       # 同 build_data.py PBKDF2_ITER，網頁 decrypt() 依檔案裡的 iter 解
FILES = ["D_Item.csv", "D_BOM.csv", "D_BOM_補.csv"]


def encrypt(payload: bytes, password: str):
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(password.encode())
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b64(salt), "iv": b64(iv),
            "ct": b64(AESGCM(key).encrypt(iv, gzip.compress(payload, 9), None))}


def main():
    ap = argparse.ArgumentParser(description="從 NS 匯出維度表並加密（GitHub Actions 用）")
    ap.add_argument("--request-id", required=True, help="網頁產生的識別碼，網頁用來確認讀到的是這一次的結果")
    ap.add_argument("--out", required=True, help="加密檔輸出路徑")
    args = ap.parse_args()
    password = os.environ.get("SELLOUT_PASSWORD", "")
    if not password:
        sys.exit("[錯誤] 缺少 Secret SELLOUT_PASSWORD（查看報表的密碼，用來加密同步結果）")

    sys.path.insert(0, str(HERE))
    import export_sellout_dims as ex

    with tempfile.TemporaryDirectory() as tmp:
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            try:
                rc = ex.main(["--env-secrets", "--sql-dir", str(HERE / "sql"), "--out", tmp])
            except SystemExit as e:          # 程式內的 sys.exit(訊息)
                rc = e.code if isinstance(e.code, int) else 1
                if not isinstance(e.code, int):
                    buf.write(f"\n{e.code}\n")
        log = buf.getvalue()
        if rc:
            # 失敗訊息只含 HTTP 狀態與 NS 的錯誤說明，沒有業務資料，可以印在公開的 Actions 記錄
            print(log[-3000:])
            sys.exit(f"[失敗] NS 匯出沒有完成（代碼 {rc}）")
        files = {}
        for name in FILES:
            f = Path(tmp) / name
            files[name] = f.read_text(encoding="utf-8-sig") if f.exists() else ""

    tw = timezone(timedelta(hours=8))
    payload = {"v": 1, "request_id": args.request_id, "generated": datetime.now(tw).strftime("%Y-%m-%d %H:%M"),
               "files": files, "log": log}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(encrypt(json.dumps(payload, ensure_ascii=False).encode("utf-8"), password)), encoding="utf-8")
    print(f"[完成] {payload['generated']}：D_Item {files['D_Item.csv'].count(chr(10)) - 1} 列、"
          f"D_BOM {files['D_BOM.csv'].count(chr(10)) - 1} 列，已加密輸出")


if __name__ == "__main__":
    main()
