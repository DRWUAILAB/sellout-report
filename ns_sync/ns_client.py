# -*- coding: utf-8 -*-
"""最小的 NetSuite SuiteQL 用戶端（OAuth 1.0 TBA，HMAC-SHA256），金鑰從環境變數讀取。

給 GitHub Actions（網頁「從 NS 同步」按鈕）用：Actions 上沒有 NS匯入程式，金鑰放在 repo 的 GitHub Secrets，
由 workflow 以環境變數帶進來。簽章與 NS匯入程式 core/netsuite.py 相同（已在正式區實測）。只送 SuiteQL 查詢，不寫入 NS。

環境變數：NS_ACCOUNT_ID、NS_CONSUMER_KEY、NS_CONSUMER_SECRET、NS_TOKEN_ID、NS_TOKEN_SECRET
本機一般仍用 NS匯入程式 的設定（export_sellout_dims.py 預設）；加 --env-secrets 才用這支。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import secrets
import time
import urllib.parse

import requests

ENV_KEYS = ("NS_ACCOUNT_ID", "NS_CONSUMER_KEY", "NS_CONSUMER_SECRET", "NS_TOKEN_ID", "NS_TOKEN_SECRET")


def _pct(s) -> str:
    return urllib.parse.quote(str(s), safe="~-._")


class EnvSuiteQLClient:
    def __init__(self, account, ck, cs, tk, ts):
        self.account, self.ck, self.cs, self.tk, self.ts_ = account, ck, cs, tk, ts

    @classmethod
    def from_env(cls):
        miss = [k for k in ENV_KEYS if not os.environ.get(k, "").strip()]
        if miss:
            raise SystemExit(f"[錯誤] 缺少環境變數：{'、'.join(miss)}（GitHub → Settings → Secrets and variables → Actions）")
        return cls(*(os.environ[k].strip() for k in ENV_KEYS))

    @property
    def rest_host(self) -> str:
        return self.account.lower().replace("_", "-")

    def _auth_header(self, method: str, url: str) -> str:
        base_url, _, query = url.partition("?")
        oauth = {
            "oauth_consumer_key": self.ck,
            "oauth_token": self.tk,
            "oauth_signature_method": "HMAC-SHA256",
            "oauth_timestamp": str(int(time.time())),
            "oauth_nonce": secrets.token_hex(16),
            "oauth_version": "1.0",
        }
        params = dict(urllib.parse.parse_qsl(query, keep_blank_values=True))
        params.update(oauth)
        norm = "&".join(f"{k}={v}" for k, v in sorted((_pct(k), _pct(v)) for k, v in params.items()))
        base_string = "&".join([method.upper(), _pct(base_url), _pct(norm)])
        key = f"{_pct(self.cs)}&{_pct(self.ts_)}".encode()
        oauth["oauth_signature"] = base64.b64encode(hmac.new(key, base_string.encode(), hashlib.sha256).digest()).decode()
        header = ", ".join(f'{k}="{_pct(v)}"' for k, v in sorted(oauth.items()))
        return f'OAuth realm="{self.account}", {header}'

    def suiteql(self, query: str, limit: int = 1000) -> tuple:
        """執行 SuiteQL，自動翻頁。回傳 (是否成功, 列 list, 錯誤訊息)；介面同 NS匯入程式 NetSuiteClient.suiteql。"""
        url = (f"https://{self.rest_host}.suitetalk.api.netsuite.com"
               f"/services/rest/query/v1/suiteql?limit={min(limit, 1000)}")
        out: list = []
        body = json.dumps({"q": query}).encode("utf-8")
        try:
            while url:
                r = requests.post(url, data=body, timeout=120, headers={
                    "Authorization": self._auth_header("POST", url),
                    "Content-Type": "application/json",
                    "Prefer": "transient",
                })
                if r.status_code != 200:
                    return False, out, f"HTTP {r.status_code}\n{r.text[:1000]}"
                j = r.json()
                out.extend(j.get("items", []))
                nxt = [l.get("href") for l in j.get("links", []) if l.get("rel") == "next"]
                url = nxt[0] if (j.get("hasMore") and nxt) else None
                if len(out) >= limit:
                    break
            return True, out[:limit], ""
        except requests.RequestException as e:
            return False, out, f"連線失敗：{e}"
