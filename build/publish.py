"""
Sell-out 網頁報表：重建加密資料並發布到 GitHub（更新報表資料.bat 呼叫這支）

步驟：同步 GitHub → build_data.py → commit（建置產物與 build/ 的對照表 CSV）→ push。
任何一步失敗都會停下來並說明原因，不會顯示「完成」。

- 只 commit 兩種檔案。建置產物：docs/data.enc、docs/api 的 .enc 與 index.json，每次都會重建；
  對照表：build/ 的系列對照、裸瓶對照、系列確認、補充BOM、補充售價、通路類別調整，有修改時一起 commit，換電腦也不會遺失。
  其他檔案（程式、docs/api 的說明頁、openapi.yaml、sellout_api.py）要自己 commit、push，發布不會帶上也不會還原。
- .enc 每次加密都用新的隨機值，所以比「解密後的內容」（不含建置時間）：data.enc 與中繼表都和 GitHub 上相同才算沒有變化，
  此時還原建置產物、不發布；只有一個不同就全部發布。
- 同步時先丟掉本機未 commit 的建置產物，變化才是和 GitHub 上的版本比，不是和本機先建置過的版本比。
- 本機還沒推上去的 commit（例如上次推送失敗）：只動到建置產物與對照表時，捨棄 commit、對照表的修改留著，這次重建後重新 commit；
  含其他檔案時停下來，不發布，也不動那些 commit（不把別人還在改的東西推上線）。
- data.enc 由本機的原始資料重建；有人在網頁「資料更新」上傳發布過的版本會被這次的結果取代。
"""
import base64
import gzip
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
BRANCH = "main"   # 網站只看 main
UPSTREAM = f"origin/{BRANCH}"
DATA = "docs/data.enc"
API = "docs/api"
INDEX = f"{API}/index.json"
CONFIG_CSV = ["build/系列對照.csv", "build/裸瓶對照.csv", "build/系列確認.csv", "build/補充BOM.csv", "build/補充售價.csv", "build/通路類別調整.csv"]


def is_generated(path):
    """建置產物：每次發布都會重建，可以放心丟掉。"""
    return path in (DATA, INDEX) or (path.startswith(f"{API}/") and path.endswith(".enc"))


def git(*args, quiet=False):
    return subprocess.run(["git", *args], cwd=WEB, capture_output=quiet, text=True, encoding="utf-8")


def git_files(*args):
    """回傳 git 列出的檔名（中文檔名不跳脫）；git 失敗回傳 None。"""
    r = git("-c", "core.quotepath=off", *args, quiet=True)
    return None if r.returncode else [f for f in dict.fromkeys(r.stdout.splitlines()) if f]


def step(title):
    print(f"\n== {title}")


def fail(msg):
    print(f"\n[失敗] {msg}")
    sys.exit(1)


def generated_paths():
    """磁碟上的建置產物（第一次產生、還沒進版控的也算）。"""
    found = [p.relative_to(WEB).as_posix() for p in (WEB / API).glob("*.enc")]
    found += [p for p in (DATA, INDEX) if (WEB / p).exists()]
    return sorted(found)


def restore_generated():
    """把版控中的建置產物還原成目前 commit 的版本。"""
    files = git_files("ls-files", "--", DATA, API)
    if files is None:
        fail("無法列出建置產物，沒有發布。")
    tracked = [f for f in files if is_generated(f)]
    if tracked and git("restore", "--source=HEAD", "--staged", "--worktree", "--", *tracked).returncode:
        fail("無法還原建置產物（檔案被其他程式開著？），沒有發布。")


def file_digest(path):
    """建置產物解密後的內容指紋（不含建置時間）；讀不到或解不開（例如換了密碼）回傳 None，視為有變化。"""
    try:
        f = WEB / path
        if path == INDEX:
            obj = json.loads(f.read_text(encoding="utf-8"))
            obj.pop("generated", None)
            return hashlib.sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
        pw = os.environ.get("SELLOUT_PASSWORD") or (WEB / "build" / "password.txt").read_text(encoding="utf-8-sig").strip()
        enc = json.loads(f.read_text(encoding="utf-8"))
        b = lambda s: base64.b64decode(s)
        key = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=b(enc["salt"]), iterations=enc["iter"]).derive(pw.encode())
        plain = gzip.decompress(AESGCM(key).decrypt(b(enc["iv"]), b(enc["ct"]), None))
        if path == DATA:
            obj = json.loads(plain)
            obj.pop("generated", None)
            plain = json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")
        return hashlib.sha256(plain).hexdigest()
    except Exception:
        return None


def digests():
    return {p: file_digest(p) for p in generated_paths()}


def discard_unpushed(ahead):
    """處理還沒推上去的 commit：只動到建置產物與對照表才捨棄，對照表的修改留在工作區；其他情況停下來、什麼都不動。"""
    base = git("merge-base", UPSTREAM, "HEAD", quiet=True)
    if base.returncode:
        fail(f"本機和 GitHub 的歷史接不起來（GitHub 的歷史可能被改寫過），本機 {len(ahead)} 個 commit 都沒有動，沒有發布。請找維護的人處理。")
    files = git_files("log", "--name-only", "--format=", f"{UPSTREAM}..HEAD")
    if files is None:
        fail("無法列出還沒推上去的 commit 改了哪些檔案，沒有發布。")
    other = [f for f in files if not is_generated(f) and f not in CONFIG_CSV]
    if other or not files:
        fail(f"本機有 {len(ahead)} 個還沒推上去的 commit，改到建置產物與對照表以外的東西：{'、'.join(other) or '（沒有改任何檔案）'}。"
             f"這些不會跟著發布，請先自己 push 或處理後再執行，沒有發布。")
    keep = [f for f in files if not is_generated(f)]
    if keep:
        conflict = git_files("diff", "--name-only", base.stdout.strip(), UPSTREAM, "--", *keep)
        if conflict is None:
            fail("無法比對對照表和 GitHub 上的版本，沒有發布。")
        if conflict:
            fail(f"對照表 {'、'.join(conflict)} 本機和 GitHub 上都有修改，本機 commit 都沒有動，沒有發布。請找維護的人處理。")
    saved = {f: (WEB / f).read_bytes() if (WEB / f).exists() else None for f in keep}

    def put_back():
        for f, content in saved.items():
            if content is None:
                (WEB / f).unlink(missing_ok=True)
            else:
                (WEB / f).write_bytes(content)

    tracked = git_files("ls-files", "--", *keep) if keep else []
    if tracked is None or (tracked and git("restore", "--source=HEAD", "--staged", "--worktree", "--", *tracked).returncode):
        put_back()
        fail("無法暫存對照表的修改（檔案被其他程式開著？），沒有發布。")
    if git("reset", "--keep", UPSTREAM).returncode:
        put_back()
        fail("本機未 commit 的修改和 GitHub 上的版本衝突，本機 commit 都沒有動，沒有發布。請先 commit 或還原那些修改。")
    put_back()
    print(f"本機有 {len(ahead)} 個還沒推上去的 commit，只改建置產物與對照表，這次會重建，先捨棄" +
          (f"（對照表的修改留著：{'、'.join(keep)}）。" if keep else "。"))


def sync():
    """檢查分支、丟掉本機的建置產物與上次沒推上去的發布 commit，再同步 GitHub。"""
    r = git("rev-parse", "--abbrev-ref", "HEAD", quiet=True)
    if r.returncode:
        fail(f"無法確認目前的 git 分支：{r.stderr.strip()}")
    cur = r.stdout.strip()
    if cur != BRANCH:
        fail(f"目前在 {'（非分支）' if cur == 'HEAD' else cur}，網站只看 {BRANCH}，請先 git checkout {BRANCH} 再執行，沒有發布。")
    if git("fetch", "origin").returncode:
        fail("無法連上 GitHub（網路或登入問題？），沒有發布。")
    restore_generated()
    r = git("log", "--format=%H", f"{UPSTREAM}..HEAD", quiet=True)
    if r.returncode:
        fail(f"無法比對本機和 GitHub 的版本：{r.stderr.strip()}")
    ahead = r.stdout.split()
    if ahead:
        discard_unpushed(ahead)
    stashes = len(git("stash", "list", quiet=True).stdout.splitlines())
    if git("pull", "--rebase", "--autostash").returncode:
        fail("無法從 GitHub 取得最新版本（網路或登入問題？），沒有發布。")
    # autostash 放回本機修改時衝突，git 仍回傳成功、把修改留在 stash：停下來，不要在缺修改的狀態下發布
    if len(git("stash", "list", quiet=True).stdout.splitlines()) > stashes:
        fail("本機未 commit 的修改和 GitHub 上的版本衝突，修改已暫存在 git stash（用 git stash list 查看），沒有發布。請找維護的人處理。")


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    step("[1/4] 取得 GitHub 上的最新版本")
    sync()
    before = digests()
    step("[2/4] 重建加密資料（docs/data.enc、docs/api 中繼表）")
    if subprocess.run([sys.executable, str(WEB / "build" / "build_data.py")], cwd=WEB).returncode:
        fail("建置失敗，請看上方訊息，沒有發布。")
    step("[3/4] 建立 commit（建置產物、build/ 對照表）")
    after = digests()
    paths = [p for p in CONFIG_CSV if (WEB / p).exists()]
    if before == after and None not in after.values():
        restore_generated()   # 內容沒變：還原成原本的檔案，不產生沒有意義的 commit
        print("報表資料與中繼表內容沒有變化。")
    else:
        paths += generated_paths()
    if not paths or git("add", "--", *paths).returncode:
        fail("git add 失敗，沒有發布。")
    if git("diff", "--cached", "--quiet", "--", *paths).returncode == 0:
        print("\n資料與對照表都沒有變化，不需要發布。")
        return
    changed = git_files("diff", "--cached", "--name-only", "--", *paths)
    print("這次發布：" + "、".join(changed or []))
    if git("commit", "-m", "更新 sell-out 資料", "--", *paths).returncode:
        fail("git commit 失敗，請看上方訊息，沒有發布。")
    step("[4/4] 推送到 GitHub")
    if git("push", "origin", BRANCH).returncode:
        fail("推送到 GitHub 失敗（網路、登入或有人同時更新），報表還沒更新。排除問題後再執行一次即可（會自動處理這次沒推上去的 commit）。")
    print("\n完成，約 1 分鐘後 GitHub Pages 會更新。")


if __name__ == "__main__":
    main()
