"""
Sell-out 網頁報表：設定「網頁直接發布」用的 GitHub 金鑰

網頁「資料更新 → 發布到網站」用 GitHub 金鑰把 data.enc 與中繼表 commit 到 repo。金鑰以「更新密碼」加密
（PBKDF2-SHA256 60 萬次 → AES-256-GCM，格式同 data.enc）存成 docs/publish_key.enc；網頁上輸入更新密碼才解得開。
更新密碼和查看報表的密碼分開，只給負責更新的人。

金鑰請用 GitHub fine-grained personal access token：
    Settings → Developer settings → Fine-grained tokens → Generate new token
    Resource owner：DRWUAILAB；Repository access：Only select repositories → sellout-report
    Repository permissions：Contents → Read and write（其他都不用）
金鑰到期、換更新密碼、或懷疑外流時，重新產生金鑰再執行一次（舊金鑰請在 GitHub 上 Revoke：repo 是公開的，
舊的 publish_key.enc 留在 git 歷史裡，用舊更新密碼仍解得開）。

用法：
    python build/set_publish_key.py            # 依提示輸入金鑰與更新密碼，產生 docs/publish_key.enc
    python build/set_publish_key.py --publish  # 產生後直接 commit 並 push
"""
import argparse
import base64
import getpass
import gzip
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

WEB = Path(__file__).resolve().parent.parent
OUT = WEB / "docs" / "publish_key.enc"
ITER = 600_000
MIN_LEN = 12


def encrypt(payload: bytes, password: str):
    salt, iv = os.urandom(16), os.urandom(12)
    key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=ITER).derive(password.encode())
    b64 = lambda b: base64.b64encode(b).decode()
    return {"v": 1, "kdf": "PBKDF2-SHA256", "iter": ITER, "salt": b64(salt), "iv": b64(iv),
            "ct": b64(AESGCM(key).encrypt(iv, gzip.compress(payload, 9), None))}


def check_token(token, repo, branch):
    """確認金鑰能讀到 repo 與分支；寫入權限要等第一次發布才知道（GitHub 沒有不寫入就能驗證的方法）。"""
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/git/ref/heads/{branch}",
                                 headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit(f"[錯誤] 金鑰無法讀取 {repo} 的 {branch} 分支（HTTP {e.code}）：請確認金鑰沒打錯、有選到這個 repo")
    except urllib.error.URLError as e:
        sys.exit(f"[錯誤] 連不上 GitHub：{e.reason}")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default="DRWUAILAB/sellout-report")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--publish", action="store_true", help="產生後直接 commit 並 push")
    args = ap.parse_args()

    token = getpass.getpass("GitHub 金鑰（輸入時不會顯示）：").strip()
    if not token:
        sys.exit("沒有輸入金鑰")
    check_token(token, args.repo, args.branch)
    view_pw = os.environ.get("SELLOUT_PASSWORD")
    pwf = WEB / "build" / "password.txt"
    if not view_pw and pwf.exists():
        view_pw = pwf.read_text(encoding="utf-8-sig").strip()
    while True:
        pw = getpass.getpass(f"更新密碼（至少 {MIN_LEN} 個字元，和查看報表的密碼不同）：")
        if len(pw) < MIN_LEN:
            print(f"太短：repo 是公開的，金鑰檔任何人都下載得到，更新密碼要夠長才猜不到")
        elif view_pw and pw == view_pw:
            print("不能和查看報表的密碼相同")
        elif getpass.getpass("再輸入一次：") != pw:
            print("兩次輸入不同")
        else:
            break
    payload = json.dumps({"token": token, "repo": args.repo, "branch": args.branch}).encode()
    OUT.write_text(json.dumps(encrypt(payload, pw)), encoding="utf-8")
    print(f"已輸出 {OUT.relative_to(WEB)}")
    if args.publish:
        git = lambda *a: subprocess.run(["git", *a], cwd=WEB).returncode
        if git("add", "--", str(OUT.relative_to(WEB))) or git("commit", "-m", "設定網頁發布金鑰", "--", str(OUT.relative_to(WEB))) or git("push"):
            sys.exit("[失敗] commit／push 沒有完成，請看上方訊息")
        print("已發布，約 1 分鐘後網頁「發布到網站」就能使用")
    else:
        print("用 --publish 參數或 git commit／push docs/publish_key.enc 後，網頁就能直接發布")


if __name__ == "__main__":
    main()
