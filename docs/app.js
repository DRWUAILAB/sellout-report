/* Sell-out 網頁報表
 * data.enc：build/build_data.py 產生（gzip JSON → PBKDF2-SHA256 → AES-256-GCM）
 * 事實表 fso（未拆組）：[ym, ch, item, qty, amt]
 * 事實表 fx（拆組）  ：[ym, ch, item, src, orig, mode, qty, amt]；mode 位元 1＝只用 NS BOM、2＝含暫用 BOM
 */
(() => {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const PW_KEY = "sellout.pw";
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* 無痕或封鎖時略過 */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* 略過 */ } },
  };

  // ------------------------------------------------------------ 解密
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function decrypt(enc, password) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      { name: "PBKDF2", hash: "SHA-256", salt: b64(enc.salt), iterations: enc.iter },
      base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
    const gz = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(enc.iv) }, key, b64(enc.ct));
    const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip"));
    return JSON.parse(await new Response(stream).text());
  }

  let ENC = null, RAW = null, PASSWORD = null;
  async function open(password) {
    if (!ENC) ENC = await (await fetch("data.enc", { cache: "no-cache" })).json();
    return decrypt(ENC, password);
  }

  // ------------------------------------------------------------ 格式
  const nf0 = new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 });
  const fmtN = v => (v == null ? "" : nf0.format(Math.round(v) === 0 ? 0 : v));
  const fmtR = v => (v == null || !isFinite(v) ? "" : (v * 100).toFixed(2) + "%");
  const div = (a, b) => (b ? a / b : null);
  const ymLabel = ym => ym.slice(0, 4) + "/" + ym.slice(4);
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ------------------------------------------------------------ 資料
  let D = null;
  const I = { CODE: 0, NAME: 1, SPEC: 2, P3: 3, P6: 4, SERIES: 5, DOSAGE: 6, INV: 7, BRAND: 8, PRICE: 9 };
  const NONE = "(無)";
  const RX = "-Redermx";
  // Redermx 分開顯示的通路（同業務《2026市場綜合折扣率》的拆法；其他通路的 Redermx 商品仍併在原通路）
  // 依通路名稱判斷，通路調整改名後仍用通路對照原本的名稱比對（channels 第 5 欄）
  const RX_SPLIT = new Set(["官網", "BR4/A13", "英爵診所"]);
  // 未分類（系列／代碼 其他、通路類別 未分類、存貨型態／劑型 (無)）一律排在最後；其餘維持原本的排序
  const isUncat = label => /^[（(]?(未分類|無)[)）]?$|^其他$/.test(String(label ?? "").trim());
  const uncatLast = arr => arr.filter(x => !isUncat(x?.label ?? x)).concat(arr.filter(x => isUncat(x?.label ?? x)));

  function prepare(d) {
    d.chName = d.channels.map(c => c[1] || c[0] + "（未對到通路）");
    d.chCat = d.channels.map(c => c[2] || "未分類");
    d.chRegion = d.channels.map(c => c[3] || "");
    d.chRx = d.channels.map((c, i) => RX_SPLIT.has(d.chName[i]) || RX_SPLIT.has(c[4]));
    d.price = d.items.map(it => it[I.PRICE] || 0);
    d.issue = new Set(d.currencyIssues.map(([c, ym]) => (d.chName[d.channels.findIndex(x => x[0] === c)] || c) + "|" + ym));
    d.years = [...new Set(d.yms.map(y => y.slice(0, 4)))];
    const uniq = arr => uncatLast([...new Set(arr)].sort((a, b) => a.localeCompare(b, "zh-Hant")));
    d.allChNames = uniq(d.chName);
    d.allChCats = uniq(d.chCat);
    d.allInv = uniq(d.items.map(it => it[I.INV] || NONE));
    d.allDosage = uniq(d.items.map(it => it[I.DOSAGE] || NONE));
    return d;
  }

  const S = {
    useTemp: false,   // 預設只用 NS BOM（與業務參考值口徑一致）；可在右上切換
    tab: "r1",
    r1: { mode: "單月", pre: null, cur: null, ch: null, brand: "全部", inv: null, splitRx: "合併" },
    r2: { year: null, months: null, ch: null, cat: null, inv: null, dosage: null, basis: "拆組", view: "當月" },
    open: { r1: new Set(), r2: new Set(), r3: new Set(), r4: new Set() },
  };

  // ------------------------------------------------------------ 共用元件
  function multiSelect(label, all, selected, onChange) {
    const el = document.createElement("div");
    el.className = "f";
    const sum = () => (selected.size === all.length ? "全部" : selected.size === 0 ? "（未選）" : [...selected].join("、"));
    el.innerHTML = `<span>${esc(label)}</span><details class="ms"><summary></summary><div class="ms-pop">
      <div class="ms-act"><button type="button" class="ghost sm" data-a="all">全選</button><button type="button" class="ghost sm" data-a="none">清除</button></div>
      ${all.map(v => `<label><input type="checkbox" value="${esc(v)}" ${selected.has(v) ? "checked" : ""}>${esc(v)}</label>`).join("")}
    </div></details>`;
    const summary = $("summary", el);
    summary.textContent = sum();
    el.addEventListener("change", e => {
      if (e.target.type !== "checkbox") return;
      e.target.checked ? selected.add(e.target.value) : selected.delete(e.target.value);
      summary.textContent = sum();
      onChange();
    });
    el.addEventListener("click", e => {
      const a = e.target.dataset?.a;
      if (!a) return;
      selected.clear();
      if (a === "all") all.forEach(v => selected.add(v));
      el.querySelectorAll("input[type=checkbox]").forEach(cb => (cb.checked = a === "all"));
      summary.textContent = sum();
      onChange();
    });
    return el;
  }

  function selectBox(label, options, value, onChange) {
    const el = document.createElement("label");
    el.className = "f";
    el.innerHTML = `<span>${esc(label)}</span><select>${options.map(([v, t]) =>
      `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(t)}</option>`).join("")}</select>`;
    $("select", el).addEventListener("change", e => onChange(e.target.value));
    return el;
  }

  function seg(label, options, value, onChange) {
    const el = document.createElement("div");
    el.className = "f";
    el.innerHTML = `<span>${esc(label)}</span><div class="seg">${options.map(o =>
      `<button type="button" class="${o === value ? "on" : ""}" data-v="${esc(o)}">${esc(o)}</button>`).join("")}</div>`;
    el.addEventListener("click", e => {
      const v = e.target.dataset?.v;
      if (v == null) return;
      el.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
      onChange(v);
    });
    return el;
  }

  function chips(label, options, selected, onChange) {
    const el = document.createElement("div");
    el.className = "f";
    el.innerHTML = `<span>${esc(label)}</span><div class="chips">${options.map(([v, t]) =>
      `<button type="button" class="${selected.has(v) ? "on" : ""}" data-v="${esc(v)}">${esc(t)}</button>`).join("")}</div>`;
    el.addEventListener("click", e => {
      const v = e.target.dataset?.v;
      if (v == null) return;
      selected.has(v) ? selected.delete(v) : selected.add(v);
      e.target.classList.toggle("on", selected.has(v));
      onChange();
    });
    return el;
  }

  // 樹狀表：node = { key, label, sub, v: [...], kids: Map }
  function node(key, label, sub, n) { return { key, label, sub, v: new Array(n).fill(0), c: new Array(n).fill(0), kids: new Map() }; }
  function child(parent, key, label, sub, n) {
    let k = parent.kids.get(key);
    if (!k) { k = node(parent.key + "\u0001" + key, label, sub, n); parent.kids.set(key, k); }
    return k;
  }
  function bump(nodes, i, val) { for (const nd of nodes) { nd.v[i] += val; nd.c[i] += 1; } }

  function treeRows(root, depth, openSet, sortKids, cells, maxDepth) {
    let html = "";
    for (const nd of uncatLast(sortKids([...root.kids.values()], depth))) {
      const hasKids = depth < maxDepth && nd.kids.size > 0;
      const isOpen = openSet.has(nd.key);
      html += `<tr class="lv${depth}"><td class="l ind${depth}${hasKids ? " tg" : ""}" ${hasKids ? `data-k="${esc(nd.key)}"` : ""}>` +
        `<span class="caret">${hasKids ? (isOpen ? "▾" : "▸") : ""}</span>${esc(nd.label)}${nd.sub ? `<span class="name">${esc(nd.sub)}</span>` : ""}</td>` +
        cells(nd) + "</tr>";
      if (hasKids && isOpen) html += treeRows(nd, depth + 1, openSet, sortKids, cells, maxDepth);
    }
    return html;
  }
  function allKeys(root, out = []) { for (const k of root.kids.values()) { out.push(k.key); allKeys(k, out); } return out; }

  // ------------------------------------------------------------ 報表一
  let r1Tree = null, r1Last = null;
  // 期間：單月＝起迄同一個月；累計＝起迄區間（年月索引，含頭尾）
  const perLabel = ([a, b]) => (a === b ? ymLabel(D.yms[a]) : `${ymLabel(D.yms[a])}–${ymLabel(D.yms[b])}`);
  const inPer = (ym, [a, b]) => ym >= a && ym <= b;

  function r1Defaults() {
    const n = D.yms.length, last = n - 1;
    if (S.r1.mode === "單月") {
      S.r1.cur = [last, last];
      S.r1.pre = [Math.max(0, last - 1), Math.max(0, last - 1)];
    } else {
      // 本期＝最新年度 1 月至最新月；前期＝去年同期，沒有去年資料時用「年初至上個月」
      const y = D.yms[last].slice(0, 4);
      const start = D.yms.findIndex(v => v.startsWith(y));
      S.r1.cur = [start, last];
      const ly = String(+y - 1), pa = D.yms.indexOf(ly + D.yms[start].slice(4)), pb = D.yms.indexOf(ly + D.yms[last].slice(4));
      S.r1.pre = pa >= 0 && pb >= 0 ? [pa, pb] : [start, Math.max(start, last - 1)];
    }
  }

  function initR1(keepMode) {
    if (!keepMode) S.r1.mode = "單月";
    r1Defaults();
    S.r1.ch = S.r1.ch && keepMode ? S.r1.ch : new Set(D.allChNames);
    S.r1.inv = S.r1.inv && keepMode ? S.r1.inv : new Set(D.allInv);
    const f = $("#r1Filters");
    f.innerHTML = "";
    const opts = D.yms.map((y, i) => [i, ymLabel(y)]);
    const pick = (label, per, k) => selectBox(label, opts, S.r1[per][k], v => {
      S.r1[per][k] = +v;
      if (S.r1.mode === "單月") S.r1[per][1 - k] = +v;
      else if (S.r1[per][0] > S.r1[per][1]) S.r1[per].reverse();   // 起 > 迄 時自動對調
      initR1Selects(); renderR1();
    });
    const periodBoxes = S.r1.mode === "單月"
      ? [pick("前期期間", "pre", 0), pick("本期期間", "cur", 0)]
      : [pick("前期 起", "pre", 0), pick("前期 迄", "pre", 1), pick("本期 起", "cur", 0), pick("本期 迄", "cur", 1)];
    f.append(
      seg("期間", ["單月", "累計"], S.r1.mode, v => { S.r1.mode = v; initR1(true); renderR1(); }),
      ...periodBoxes,
      multiSelect("通路", D.allChNames, S.r1.ch, renderR1),
      seg("品牌", ["全部", "DR.WU", "Redermx"], S.r1.brand, v => { S.r1.brand = v; renderR1(); }),
      seg("Redermx（官網、A13、英爵）", ["合併", "分開"], S.r1.splitRx, v => { S.r1.splitRx = v; S.open.r1.clear(); renderR1(); }),
      multiSelect("產品分類（暫以存貨型態）", D.allInv, S.r1.inv, renderR1),
    );
    function initR1Selects() {
      const sel = f.querySelectorAll("select");
      const vals = S.r1.mode === "單月" ? [S.r1.pre[0], S.r1.cur[0]] : [S.r1.pre[0], S.r1.pre[1], S.r1.cur[0], S.r1.cur[1]];
      sel.forEach((s, i) => (s.value = vals[i]));
    }
  }

  function renderR1() {
    const bit = S.useTemp ? 2 : 1;
    const { pre, cur, brand, ch, inv } = S.r1;
    const root = node("r1", "", "", 6);
    const side = new Map();
    const tot = new Array(6).fill(0), totC = [0, 0];
    const sideTot = [0, 0, 0, 0];
    for (const r of D.fx) {
      if (!(r[5] & bit)) continue;
      const ym = r[0], inP = inPer(ym, pre), inC = inPer(ym, cur);
      if (!inP && !inC) continue;
      const it = D.items[r[2]];
      if (brand !== "全部" && it[I.BRAND] !== brand) continue;
      if (!inv.has(it[I.INV] || NONE)) continue;
      const qty = r[6], amt = r[7], price = D.price[r[2]], mkt = qty * price;
      const base = D.chName[r[1]];
      // Redermx 分開：同一通路的 Redermx 品牌商品另列一列（例 官網-Redermx），依商品品牌判斷（同業務參考檔）
      const cn = S.r1.splitRx === "分開" && D.chRx[r[1]] && it[I.BRAND] === "Redermx" ? base + RX : base;
      // 側表：不受通路篩選影響
      let s = side.get(cn);
      if (!s) side.set(cn, (s = [0, 0, 0, 0]));
      if (inP) { s[0] += amt; s[1] += mkt; sideTot[0] += amt; sideTot[1] += mkt; }
      if (inC) { s[2] += amt; s[3] += mkt; sideTot[2] += amt; sideTot[3] += mkt; }
      if (!ch.has(base)) continue;
      // 通路 → 前六碼＋售價（售價單獨一欄；同一前六碼有多個售價時各佔一列）
      const n1 = child(root, cn, cn, "", 6);
      const p6 = it[I.P6] || "其他";
      const n2 = child(n1, p6 + "\u0002" + price, p6, "", 6);
      n2.price = price;
      const path = [n1, n2];
      for (const [hit, off] of [[inP, 0], [inC, 3]]) {
        if (!hit) continue;
        bump(path, off, qty); bump(path, off + 1, amt); bump(path, off + 2, mkt);
        tot[off] += qty; tot[off + 1] += amt; tot[off + 2] += mkt; totC[off / 3]++;
      }
    }
    r1Tree = root;
    const pl = perLabel(pre), cl = perLabel(cur);

    // KPI
    const preR = div(tot[1], tot[2]), curR = div(tot[4], tot[5]);
    const delta = (a, b, pct) => {
      if (!b || a == null) return `<span class="muted">前期無資料</span>`;
      const d = pct ? (a - b) * 100 : (a / b - 1) * 100;
      const cls = d >= 0 ? "up" : "down";
      return `<span class="${cls}">${d >= 0 ? "▲" : "▼"} ${Math.abs(d).toFixed(pct ? 2 : 1)}${pct ? " 個百分點" : "%"}</span> <span class="muted">vs 前期</span>`;
    };
    $("#r1Kpis").innerHTML = [
      ["本期銷貨金額", fmtN(tot[4]), delta(tot[4], tot[1])],
      ["本期銷貨數量", fmtN(tot[3]), delta(tot[3], tot[0])],
      ["本期市價", fmtN(tot[5]), delta(tot[5], tot[2])],
      ["本期折扣率", fmtR(curR), delta(curR, preR, true)],
    ].map(([k, v, d]) => `<div class="kpi"><div class="k">${k}（${cl}）</div><div class="v">${v || "—"}</div><div class="d">${d}</div></div>`).join("");

    // 主表
    const has = (nd, off) => nd.c[off] > 0;
    const warn = (label, [a, b]) => {   // label 可能帶「-Redermx」，幣別檢查用原通路名稱
      const cn = label.endsWith(RX) ? label.slice(0, -RX.length) : label;
      for (let i = a; i <= b; i++) if (D.issue.has(cn + "|" + D.yms[i])) return true;
      return false;
    };
    const rateTd = (v, w) => w ? `<td class="hi" title="期間內有月份幣別填 NTD，但該通路其他月份用外幣，疑似未換算">⚠ ${fmtR(v)}</td>` : `<td>${fmtR(v)}</td>`;
    const cells = nd => `<td class="price">${nd.price != null ? nf0.format(nd.price) : ""}</td>` + [0, 3].map(off => has(nd, off)
      ? `<td class="sep">${fmtN(nd.v[off])}</td><td>${fmtN(nd.v[off + 1])}</td><td>${fmtN(nd.v[off + 2])}</td>${rateTd(div(nd.v[off + 1], nd.v[off + 2]), warn(nd.key.split("\u0001")[1], off ? cur : pre))}`
      : `<td class="sep"></td><td></td><td></td><td></td>`).join("");
    const sortKids = (arr, depth) => depth === 0
      ? arr.sort((a, b) => (div(b.v[4], b.v[5]) ?? -1) - (div(a.v[4], a.v[5]) ?? -1))
      : arr.sort((a, b) => a.label.localeCompare(b.label) || a.price - b.price);
    const body = treeRows(root, 0, S.open.r1, sortKids, cells, 1);
    $("#r1Table").innerHTML = `<thead>
      <tr class="grp"><th class="l" rowspan="2">通路名稱 / 前六碼</th><th rowspan="2">售價</th><th colspan="4" class="sep">前期 ${pl}</th><th colspan="4" class="sep">本期 ${cl}</th></tr>
      <tr><th class="sep">銷貨數量</th><th>銷貨金額</th><th>市價</th><th>折扣率</th><th class="sep">銷貨數量</th><th>銷貨金額</th><th>市價</th><th>折扣率</th></tr></thead>
      <tbody>${body || `<tr><td colspan="10" class="empty">沒有符合條件的資料</td></tr>`}</tbody>
      <tfoot><tr class="total"><td class="l">總計</td><td></td>${[0, 3].map(off => totC[off / 3]
        ? `<td class="sep">${fmtN(tot[off])}</td><td>${fmtN(tot[off + 1])}</td><td>${fmtN(tot[off + 2])}</td><td>${fmtR(div(tot[off + 1], tot[off + 2]))}</td>`
        : `<td class="sep"></td><td></td><td></td><td></td>`).join("")}</tr></tfoot>`;

    // 側表
    const sideRows = [...side.entries()].map(([k, s]) => [k, div(s[0], s[1]), div(s[2], s[3])])
      .sort((a, b) => (b[2] ?? -1) - (a[2] ?? -1));
    const maxR = Math.max(1, ...sideRows.map(r => r[2] ?? 0));
    const bar = v => v == null ? "" : `<div class="b" style="width:${Math.min(100, (v / maxR) * 100).toFixed(1)}%"></div>`;
    r1Last = { root, tot, totC, sideRows, sideTot, pl, cl, sortKids, warn, pre, cur };
    $("#r1Side").innerHTML = `<thead><tr><th class="l">通路名稱</th><th>前期<br>${pl}</th><th>本期<br>${cl}</th></tr></thead><tbody>` +
      sideRows.map(([k, p, c]) => `<tr><td class="l">${esc(k)}</td>${rateTd(p, warn(k, pre))}<td class="rate${warn(k, cur) ? " hi" : ""}">${bar(c)}<span>${warn(k, cur) ? "⚠ " : ""}${fmtR(c)}</span></td></tr>`).join("") +
      `</tbody><tfoot><tr class="total"><td class="l">總計</td><td>${fmtR(div(sideTot[0], sideTot[1]))}</td><td>${fmtR(div(sideTot[2], sideTot[3]))}</td></tr></tfoot>`;
  }

  // ------------------------------------------------------------ 報表二
  let r2Trees = null, r2Last = null;
  function initR2() {
    S.r2.year = D.years[D.years.length - 1];
    S.r2.ch = new Set(D.allChNames);
    S.r2.cat = new Set(D.allChCats);
    S.r2.inv = new Set(D.allInv);
    S.r2.dosage = new Set(D.allDosage);
    buildR2Filters();
  }
  function buildR2Filters() {
    const months = D.yms.filter(y => y.startsWith(S.r2.year));
    S.r2.months = new Set(months);
    const f = $("#r2Filters");
    f.innerHTML = "";
    f.append(
      seg("口徑", ["拆組", "未拆組"], S.r2.basis, v => { S.r2.basis = v; renderR2(); }),
      seg("顯示", ["當月", "年累計"], S.r2.view, v => { S.r2.view = v; renderR2(); }),
      selectBox("年度", D.years.map(y => [y, y]), S.r2.year, v => { S.r2.year = v; buildR2Filters(); renderR2(); }),
      chips("月份", months.map(m => [m, +m.slice(4) + "月"]), S.r2.months, renderR2),
      multiSelect("通路", D.allChNames, S.r2.ch, renderR2),
      multiSelect("通路類別", D.allChCats, S.r2.cat, renderR2),
      multiSelect("產品分類（暫以存貨型態）", D.allInv, S.r2.inv, renderR2),
      multiSelect("劑型", D.allDosage, S.r2.dosage, renderR2),
    );
  }

  function renderR2() {
    const bit = S.useTemp ? 2 : 1;
    const { year, months, ch, cat, inv, dosage, basis, view } = S.r2;
    const yearYms = D.yms.map((y, i) => [y, i]).filter(([y]) => y.startsWith(year));
    const cols = yearYms.filter(([y]) => months.has(y)).map(([, i]) => i);
    const nY = yearYms.length;
    const pos = new Map(yearYms.map(([, i], k) => [i, k]));   // ym index → 年內第幾個月
    // 先依品號彙總整年每月（年累計要用全年資料，不受月份篩選影響）
    const byItem = new Map();
    const unsplit = basis === "未拆組";
    const rows = unsplit ? D.fso : D.fx;
    for (const r of rows) {
      if (!unsplit && !(r[5] & bit)) continue;
      const k = pos.get(r[0]);
      if (k === undefined) continue;
      const c = r[1];
      if (!ch.has(D.chName[c]) || !cat.has(D.chCat[c])) continue;
      const it = D.items[r[2]];
      if (!inv.has(it[I.INV] || NONE) || !dosage.has(it[I.DOSAGE] || NONE)) continue;
      let a = byItem.get(r[2]);
      if (!a) byItem.set(r[2], (a = { amt: new Array(nY).fill(0), qty: new Array(nY).fill(0), n: new Array(nY).fill(0) }));
      a.qty[k] += unsplit ? r[3] : r[6];
      a.amt[k] += unsplit ? r[4] : r[7];
      a.n[k]++;
    }
    const nC = cols.length + 1; // 最後一欄＝合計
    const lastSel = cols.length ? pos.get(cols[cols.length - 1]) : -1;
    const series = (arr, n) => {
      // 回傳各欄顯示值（null＝空白）
      const out = new Array(nC).fill(null);
      if (view === "當月") {
        let s = 0, any = false;
        cols.forEach((ci, j) => { const k = pos.get(ci); if (n[k]) { out[j] = arr[k]; s += arr[k]; any = true; } });
        out[nC - 1] = any ? s : null;
      } else {
        const cum = []; let s = 0, any = false;
        for (let k = 0; k < nY; k++) { s += arr[k]; any = any || n[k] > 0; cum.push(any ? s : null); }
        cols.forEach((ci, j) => { out[j] = cum[pos.get(ci)]; });
        out[nC - 1] = lastSel >= 0 ? cum[lastSel] : null;
      }
      return out;
    };

    const mk = () => node("r2", "", "", nC);
    const trees = { amt: mk(), qty: mk() };
    const tot = { amt: new Array(nC).fill(null), qty: new Array(nC).fill(null) };
    for (const [ii, a] of byItem) {
      const it = D.items[ii];
      const p3 = it[I.P3] || "其他", p6 = it[I.P6] || "其他";
      const ser = it[I.SERIES] || "其他";
      for (const m of ["amt", "qty"]) {
        const vals = series(a[m], a.n);
        if (vals.every(v => v == null)) continue;   // 所選月份沒有資料的品號不列出（避免整列空白）
        const n1 = child(trees[m], ser, ser, "", nC), n2 = child(n1, p3, p3, "", nC), n3 = child(n2, p6, p6, "", nC);
        const n4 = child(n3, it[I.CODE], it[I.CODE], it[I.NAME] || "", nC);
        vals.forEach((v, j) => {
          if (v == null) return;
          bump([n1, n2, n3, n4], j, v);
          tot[m][j] = (tot[m][j] || 0) + v;
        });
      }
    }
    r2Trees = trees;
    const lastLbl = view === "當月" ? "合計" : "年累計至 " + (lastSel >= 0 ? ymLabel(yearYms[lastSel][0]) : "");
    const head = `<thead><tr><th class="l">系列 / 前三碼 / 前六碼 / 品號</th>${cols.map(i => `<th>${ymLabel(D.yms[i])}</th>`).join("")}` +
      `<th class="sep">${lastLbl}</th></tr></thead>`;
    const cells = nd => nd.v.map((v, j) => `<td class="${j === nC - 1 ? "sep" : ""}">${nd.c[j] ? fmtN(v) : ""}</td>`).join("");
    const sortKids = (arr, depth) => depth === 0 ? arr.sort((a, b) => b.v[nC - 1] - a.v[nC - 1]) : arr.sort((a, b) => a.label.localeCompare(b.label));
    for (const [m, id] of [["amt", "#r2Amt"], ["qty", "#r2Qty"]]) {
      const body = treeRows(trees[m], 0, S.open.r2, sortKids, cells, 3);
      $(id).innerHTML = head + `<tbody>${body || `<tr><td colspan="${nC + 1}" class="empty">沒有符合條件的資料</td></tr>`}</tbody>` +
        `<tfoot><tr class="total"><td class="l">總計</td>${tot[m].map((v, j) => `<td class="${j === nC - 1 ? "sep" : ""}">${fmtN(v)}</td>`).join("")}</tr></tfoot>`;
    }
    r2Last = { trees, tot, nC, sortKids, cols: cols.map(i => D.yms[i]), lastLbl, basis, view };
    const tag = `${basis}・${view}`;
    $("#r2AmtTitle").innerHTML = `銷售金額（台幣）<span class="tag">${tag}</span>`;
    $("#r2QtyTitle").innerHTML = `銷售數量<span class="tag">${tag}</span>`;
    $("#r2Note").innerHTML = (unsplit
      ? "未拆組：組包以自身的系列、產品代碼計算；促銷組（PB／PA／PT）的前三碼、前六碼顯示「組合包」；NS 沒有 BOM、拆不了的組包（福袋、禮盒、贈品組等）的系列、前三碼、前六碼歸「其他」。"
      : "拆組：組包依 NS BOM 拆成成分，數量 × 用量、金額依「成分售價 × 用量」比例分攤；拆組不改變總金額。") +
      (view === "年累計" ? " 年累計＝該年 1 月至當月（不受月份篩選影響），還沒有資料的月份留空。" : " 合計＝所選月份加總。") +
      ` 部分海外月份幣別與其他月份不一致，含海外時請參考「資料檢核」。`;
  }


  // ------------------------------------------------------------ 報表三：系列別樞紐（仿 Excel 樞紐分析表）
  let r3Grid = null;
  function initR3() {
    S.r3 = { year: "全部", basis: "拆組", metric: "銷貨金額", brand: "全部", ch: new Set(D.allChNames), cat: new Set(D.allChCats) };
    const f = $("#r3Filters");
    f.innerHTML = "";
    f.append(
      seg("口徑", ["拆組", "未拆組"], S.r3.basis, v => { S.r3.basis = v; renderR3(); }),
      seg("值", ["銷貨金額", "銷貨數量"], S.r3.metric, v => { S.r3.metric = v; renderR3(); }),
      selectBox("年度", [["全部", "全部"], ...D.years.map(y => [y, y])], S.r3.year, v => { S.r3.year = v; renderR3(); }),
      seg("品牌", ["全部", "DR.WU", "Redermx"], S.r3.brand, v => { S.r3.brand = v; renderR3(); }),
      multiSelect("通路", D.allChNames, S.r3.ch, renderR3),
      multiSelect("通路類別", D.allChCats, S.r3.cat, renderR3),
    );
  }

  function renderR3() {
    const bit = S.useTemp ? 2 : 1;
    const { year, basis, metric, brand, ch, cat } = S.r3;
    const unsplit = basis === "未拆組", isAmt = metric === "銷貨金額";
    const cols = D.yms.map((y, i) => [y, i]).filter(([y]) => year === "全部" || y.startsWith(year));
    const colPos = new Map(cols.map(([, i], k) => [i, k]));
    const nC = cols.length + 1; // 最後一欄＝總計
    const root = node("r3", "", "", nC);
    const grand = node("g", "", "", nC);
    for (const r of unsplit ? D.fso : D.fx) {
      if (!unsplit && !(r[5] & bit)) continue;
      const k = colPos.get(r[0]);
      if (k === undefined) continue;
      if (!ch.has(D.chName[r[1]]) || !cat.has(D.chCat[r[1]])) continue;
      const it = D.items[r[2]];
      if (brand !== "全部" && it[I.BRAND] !== brand) continue;
      const v = unsplit ? (isAmt ? r[4] : r[3]) : (isAmt ? r[7] : r[6]);
      const ser = it[I.SERIES] || "其他", p3 = it[I.P3] || "其他", p6 = it[I.P6] || "其他";
      const n1 = child(root, ser, ser, "", nC), n2 = child(n1, p3, p3, "", nC), n3 = child(n2, p6, p6, "", nC);
      bump([n1, n2, n3, grand], k, v);
      bump([n1, n2, n3, grand], nC - 1, v);
    }
    // 攤平成列：[A 系列, B 前三碼, C 前六碼, 層級, 值...]
    const byTotal = m => uncatLast([...m.values()].sort((a, b) => b.v[nC - 1] - a.v[nC - 1]));
    const vals = nd => nd.v.map((v, j) => (nd.c[j] ? Math.round(v) : null));
    const grid = [];   // [A, B, C, 層級, 值, key, 上層 keys]
    for (const s of byTotal(root.kids)) {
      grid.push([s.label, "Total", "", 0, vals(s), s.key, []]);
      for (const t of byTotal(s.kids)) {
        grid.push(["", t.label, "Total", 1, vals(t), t.key, [s.key]]);
        for (const u of byTotal(t.kids)) grid.push(["", "", u.label, 2, vals(u), u.key, [s.key, t.key]]);
      }
    }
    const totalRow = ["總計", "", "", -1, vals(grand)];
    r3Grid = { cols: cols.map(([y]) => y), grid, totalRow, metric, root };
    const open3 = S.open.r3;
    const caret = (k, label) => `<span class="tg3" data-k3="${esc(k)}"><span class="caret">${open3.has(k) ? "⊟" : "⊞"}</span>${esc(label)}</span>`;
    const visible = grid.filter(g => g[6].every(k => open3.has(k)));
    const td = (v, j) => `<td class="${j === nC - 1 ? "sep" : ""}">${v == null ? "" : nf0.format(v)}</td>`;
    $("#r3Title").textContent = `系列別 × 規格前三碼 × 規格前六碼 × 銷貨年月（${metric}・${basis}）`;
    $("#r3Table").innerHTML = `<thead>
        <tr class="grp"><th class="l">銷貨年月</th><th class="l"></th><th class="l"></th>${cols.map(([y]) => `<th>${y}</th>`).join("")}<th class="sep">總計</th></tr>
        <tr><th class="l">系列別名稱</th><th class="l">規格前三碼</th><th class="l">規格前六碼</th>${cols.map(() => `<th>${metric}</th>`).join("")}<th class="sep">${metric}</th></tr></thead>
      <tbody>${visible.map(([a, b, c, lv, v, k]) => `<tr class="pv${lv}"><td class="l">${lv === 0 ? caret(k, a) : esc(a)}</td>` +
        `<td class="l">${lv === 1 ? caret(k, b) : esc(b)}</td><td class="l">${esc(c)}</td>${v.map(td).join("")}</tr>`).join("")
        || `<tr><td colspan="${nC + 3}" class="empty">沒有符合條件的資料</td></tr>`}</tbody>
      <tfoot><tr class="total"><td class="l">總計</td><td class="l"></td><td class="l"></td>${totalRow[4].map(td).join("")}</tr></tfoot>`;
  }

  // ------------------------------------------------------------ 匯出 Excel
  // 每張報表一個 build 函式，回傳 { file, sheets, cond }；sheets 交給 SO.downloadXlsx 產生有格式的 Excel：
  //   head＝標題列數、levels＝每列的大綱層級（Excel 群組，可用左上 1/2/3/4 收合）、total＝最後一列是總計、
  //   hi＝要標黃的儲存格 Set("列,欄")、merges＝合併儲存格 [r1, c1, r2, c2]（從 1 起算）
  const NUM = "#,##0", PCT = "0.00%";
  const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`; };
  const bomLbl = () => (S.useTemp ? "含暫用BOM" : "只用NS BOM");
  const setLbl = (set, all) => (set.size === all.length ? "全部" : [...set].join("、"));
  const condRows = pairs => [...pairs, ["BOM", bomLbl()], ["資料更新", D.generated], ["來源", D.source.sellout],
    ["匯出時間", new Date().toLocaleString("zh-TW")]];
  const condSheet = pairs => ({ name: "篩選條件", cols: [14, 90], head: 1, aoa: [["項目", "設定"], ...condRows(pairs)] });

  // 樹 → 攤平：每個節點一列（深度優先，小計列在明細上方），標籤放在自己那一層的欄位
  function flatten(root, depth, sortKids, out = [], lv = 0) {
    for (const nd of uncatLast(sortKids([...root.kids.values()], lv))) {
      out.push({ nd, lv });
      if (lv < depth) flatten(nd, depth, sortKids, out, lv + 1);
    }
    return out;
  }
  const labelRow = (n, lv, label) => Array.from({ length: n }, (_, i) => (i === lv ? label : ""));

  function buildR1() {
    const { root, tot, totC, sideRows, sideTot, pl, cl, sortKids, warn, pre, cur } = r1Last;
    const four = (v, has, off) => (has ? [v[off], v[off + 1], v[off + 2], div(v[off + 1], v[off + 2]) ?? ""] : ["", "", "", ""]);
    const flat = flatten(root, 1, sortKids);
    const hi = new Set();
    const aoa = [
      ["", "", "", `前期 ${pl}`, "", "", "", `本期 ${cl}`, "", "", ""],
      ["通路名稱", "前六碼", "售價", "銷貨數量", "銷貨金額", "市價", "折扣率", "銷貨數量", "銷貨金額", "市價", "折扣率"],
      ...flat.map(({ nd, lv }, i) => {
        const chLabel = nd.key.split("")[1];   // 前六碼列也跟網頁一樣，依所屬通路標黃
        if (warn(chLabel, pre)) hi.add(`${i + 2},6`);
        if (warn(chLabel, cur)) hi.add(`${i + 2},10`);
        return [...labelRow(2, lv, nd.label), nd.price ?? "", ...four(nd.v, nd.c[0] > 0, 0), ...four(nd.v, nd.c[3] > 0, 3)];
      }),
      ["總計", "", "", ...four(tot, totC[0] > 0, 0), ...four(tot, totC[1] > 0, 3)],
    ];
    const sideHi = new Set();
    sideRows.forEach(([k], i) => { if (warn(k, pre)) sideHi.add(`${i + 1},1`); if (warn(k, cur)) sideHi.add(`${i + 1},2`); });
    const cond = [["期間", S.r1.mode], ["前期", pl], ["本期", cl], ["通路", setLbl(S.r1.ch, D.allChNames)], ["品牌", S.r1.brand], ["Redermx", S.r1.splitRx],
      ["產品分類", setLbl(S.r1.inv, D.allInv)]];
    return {
      file: `SellOut_市場綜合折扣率_${cl.replace(/\//g, "")}_${stamp()}.xlsx`, cond,
      sheets: [
        { name: "①市場綜合折扣率", aoa, head: 2, total: true, hi, freeze: 2, freezeCols: 1,
          levels: [null, null, ...flat.map(f => f.lv), null], merges: [[1, 4, 1, 7], [1, 8, 1, 11]],
          fmt: (r, c) => (r < 2 ? null : c === 6 || c === 10 ? PCT : NUM), cols: [14, 10, 8, 10, 14, 14, 9, 10, 14, 14, 9] },
        { name: "①各通路折扣率", head: 1, total: true, hi: sideHi, fmt: r => (r ? PCT : null), cols: [14, 14, 14],
          aoa: [["通路名稱", `前期 ${pl}`, `本期 ${cl}`], ...sideRows.map(([k, p, c]) => [k, p ?? "", c ?? ""]),
            ["總計", div(sideTot[0], sideTot[1]) ?? "", div(sideTot[2], sideTot[3]) ?? ""]] },
      ],
    };
  }

  function buildR2() {
    const { trees, tot, sortKids, cols, lastLbl, basis, view } = r2Last;
    const sheet = (m, name) => {
      const flat = flatten(trees[m], 3, sortKids);
      return {
        name, head: 1, total: true, freeze: 1, freezeCols: 1, fmt: r => (r ? NUM : null), levels: [null, ...flat.map(f => f.lv), null],
        cols: [16, 8, 9, 14, 36, ...cols.map(() => 12), 14],
        aoa: [["系列", "前三碼", "前六碼", "品號", "品名", ...cols.map(ymLabel), lastLbl],
          ...flat.map(({ nd, lv }) => [...labelRow(4, lv, nd.label), lv === 3 ? nd.sub : "", ...nd.v.map((v, j) => (nd.c[j] ? Math.round(v) : ""))]),
          ["總計", "", "", "", "", ...tot[m].map(v => (v == null ? "" : Math.round(v)))]],
      };
    };
    return {
      file: `SellOut_系列別by月_${basis}_${view}_${stamp()}.xlsx`,
      sheets: [sheet("amt", `②銷售金額(${basis}${view})`), sheet("qty", `②銷售數量(${basis}${view})`)],
      cond: [["口徑", basis], ["顯示", view], ["年度", S.r2.year], ["月份", [...S.r2.months].sort().join("、")],
        ["通路", setLbl(S.r2.ch, D.allChNames)], ["通路類別", setLbl(S.r2.cat, D.allChCats)],
        ["產品分類", setLbl(S.r2.inv, D.allInv)], ["劑型", setLbl(S.r2.dosage, D.allDosage)]],
    };
  }

  function buildR3() {
    const { cols, grid, totalRow, metric } = r3Grid;
    const aoa = [
      ["銷貨年月", "", "", ...cols.map(Number), "總計"],
      ["系列別名稱", "規格前三碼", "規格前六碼", ...cols.map(() => metric), metric],
      ...grid.map(([a, b, c, , v]) => [a, b, c, ...v.map(x => x ?? "")]),
      [totalRow[0], "", "", ...totalRow[4].map(x => x ?? "")],
    ];
    return {
      file: `SellOut_系列別樞紐_${metric}_${S.r3.basis}_${stamp()}.xlsx`,
      sheets: [{ name: `③系列別樞紐(${metric})`, aoa, head: 2, total: true, freeze: 2, freezeCols: 1,
        levels: [null, null, ...grid.map(g => g[3]), null], fmt: r => (r > 1 ? NUM : null), cols: [18, 10, 10, ...cols.map(() => 12), 14] }],
      cond: [["口徑", S.r3.basis], ["值", metric], ["年度", S.r3.year], ["品牌", S.r3.brand],
        ["通路", setLbl(S.r3.ch, D.allChNames)], ["通路類別", setLbl(S.r3.cat, D.allChCats)]],
    };
  }

  function buildR4() {
    const { root, tot, calc, sortKids, pl, cl, yl, warnCh } = r4Last;
    const vals = nd => {
      const m = calc(nd), x = v => (v == null ? "" : v);
      const dr = m.dRate == null ? "" : Math.round(m.dRate * 10000) / 100;   // 折扣率增減以百分點表示
      return [x(m.p?.q), x(m.p?.a), x(m.pShare), x(m.p?.r), x(m.c?.q), x(m.c?.a), x(m.cShare), x(m.c?.r),
        x(m.t?.q), x(m.t?.a), x(m.t?.r), x(m.diff), x(m.growth), dr];
    };
    const flat = flatten(root, 3, sortKids);
    const hi = new Set();
    flat.forEach(({ nd }, i) => [[0, 8], [1, 12], [2, 15]].forEach(([k, c]) => { if (warnCh(nd, k)) hi.add(`${i + 2},${c}`); }));
    const PCT_COLS = new Set([7, 8, 11, 12, 15, 17]);
    const aoa = [
      ["", "", "", "", "", `前期（${pl}）`, "", "", "", `本期（${cl}）`, "", "", "", `本年累計（${yl}）`, "", "", "變化（本期 vs 前期）", "", ""],
      ["通路類別", "通路", "系列", "品號", "品名", "銷貨數量", "銷貨金額", "占比", "折扣率", "銷貨數量", "銷貨金額", "占比", "折扣率",
        "銷貨數量", "銷貨金額", "折扣率", "金額差異", "成長率", "折扣率增減(百分點)"],
      ...flat.map(({ nd, lv }) => [...labelRow(4, lv, nd.label), lv === 3 ? nd.sub : "", ...vals(nd)]),
      ["總計", "", "", "", "", ...vals(tot)],
    ];
    return {
      file: `SellOut_通路別_${cl.replace("/", "")}_${S.r4.basis}_${stamp()}.xlsx`,
      sheets: [{ name: "④通路別", aoa, head: 2, total: true, hi, freeze: 2, freezeCols: 2, levels: [null, null, ...flat.map(f => f.lv), null],
        merges: [[1, 6, 1, 9], [1, 10, 1, 13], [1, 14, 1, 16], [1, 17, 1, 19]],
        fmt: (r, c) => (r < 2 ? null : c === 18 ? "0.00" : PCT_COLS.has(c) ? PCT : NUM),
        cols: [12, 10, 14, 14, 40, 9, 13, 7, 8, 9, 13, 7, 8, 10, 14, 8, 13, 8, 10] }],
      cond: [["口徑", S.r4.basis], ["前期", pl], ["本期", cl], ["本年累計", yl], ["品牌", S.r4.brand],
        ["通路類別", setLbl(S.r4.cat, D.allChCats)], ["通路", setLbl(S.r4.ch, D.allChNames)], ["產品分類", setLbl(S.r4.inv, D.allInv)]],
    };
  }

  function buildChk() {
    const tbl = id => [...document.querySelectorAll(`${id} tr`)].map(tr => [...tr.cells].map(td => {
      const t = td.innerText.trim(), n = t.replace(/,/g, "");
      // 金額、數量才轉數字；品號（8 碼以上、沒有千分位）維持文字
      return /^-?\d+(\.\d+)?$/.test(n) && (t.includes(",") || n.length < 8) ? +n : t;
    }));
    const hiOf = id => {   // 頁面上標黃的格子，Excel 也標黃
      const s = new Set();
      [...document.querySelectorAll(`${id} tr`)].forEach((tr, r) => [...tr.cells].forEach((td, c) => { if (td.classList.contains("hi")) s.add(`${r},${c}`); }));
      return s;
    };
    const t = (name, id, fmt, cols) => ({ name, aoa: tbl(id), head: 1, fmt, cols, hi: hiOf(id) });
    return {
      file: `SellOut_資料檢核_${stamp()}.xlsx`, cond: [],
      sheets: [
        { name: "檢核摘要", cols: [16, 16, 40], head: 1, aoa: [["項目", "值", "說明"], ...[...document.querySelectorAll("#chkKpis .kpi")]
          .map(k => [k.querySelector(".k").innerText, k.querySelector(".v").innerText, k.querySelector(".d").innerText])] },
        t("組包未拆", "#chkKits", r => (r ? NUM : null), [14, 50, 10, 14]),
        t("未對到品號", "#chkItems", r => (r ? NUM : null), [14, 50, 10, 14]),
        t("幣別不一致", "#chkCur", null, [12, 10]),
        t("沒有品項明細", "#chkNoDetail", null, [12, 40]),
        t("通路調整", "#chkAdj", null, [12, 24, 28, 16, 28, 40]),
        t("裸瓶對應正貨", "#chkBare", (r, c) => (r && [2, 5, 6, 7].includes(c) ? NUM : null), [14, 36, 9, 14, 36, 9, 10, 12, 34]),
        t("系列歸類不一致", "#chkSeries", (r, c) => (r && c >= 2 ? NUM : null), [8, 16, 8, 14, 60]),
      ],
    };
  }

  // 拆組明細：目前 BOM 設定下的 F_SO_X，帶維度欄位，可自行做樞紐分析（有篩選鈕）
  function buildDetail() {
    const bit = S.useTemp ? 2 : 1;
    const aoa = [["年月", "通路別", "通路名稱", "通路類別", "地區", "原品號", "原品名", "品號", "品名", "產品代碼", "前三碼", "前六碼",
      "系列", "劑型", "存貨型態", "品牌", "售價", "來源", "數量", "台幣金額", "市價"]];
    for (const r of D.fx) {
      if (!(r[5] & bit)) continue;
      const c = D.channels[r[1]], x = D.items[r[2]], o = D.items[r[4]];
      aoa.push([+D.yms[r[0]], c[0], D.chName[r[1]], D.chCat[r[1]], D.chRegion[r[1]], o[0], o[1] || "", x[0], x[1] || "",
        x[2] || "", x[3] || "", x[4] || "", x[5] || "", x[6] || "", x[7] || "", x[8] || "", x[9] ?? "", D.src[r[3]],
        r[6], Math.round(r[7] * 100) / 100, r[6] * D.price[r[2]]]);
    }
    return {
      file: `SellOut_拆組明細_${bomLbl()}_${stamp()}.xlsx`, cond: [],
      sheets: [{ name: "拆組明細", aoa, head: 1, autoFilter: true, freeze: 1, fmt: (r, c) => (r && c >= 16 && c !== 17 ? NUM : null),
        cols: [8, 12, 10, 10, 6, 14, 30, 14, 30, 12, 7, 8, 16, 10, 10, 8, 8, 8, 8, 12, 12] }],
    };
  }

  const BUILDERS = { r1: buildR1, r2: buildR2, r3: buildR3, r4: buildR4, chk: buildChk, upd: buildDetail };

  async function withBusy(btn, fn) {
    const t = btn.textContent;
    btn.disabled = true; btn.textContent = "產生 Excel 中…";
    try { await fn(); }
    catch (err) { console.error(err); alert("Excel 產生失敗：" + err.message); }
    finally { btn.disabled = false; btn.textContent = t; }
  }

  function exportCurrent(e) {
    const btn = e?.currentTarget || $("#xlsx");
    return withBusy(btn, async () => {
      const b = BUILDERS[S.tab]();
      await SO.downloadXlsx(b.file, b.cond.length ? [...b.sheets, condSheet(b.cond)] : b.sheets);
    });
  }

  // 全部報表：①～④ 依目前各頁的篩選條件，加資料檢核，篩選條件彙整成一張
  function exportAll(e) {
    return withBusy(e.currentTarget, async () => {
      const parts = [["① 市場綜合折扣率", buildR1()], ["② 系列別 by 月", buildR2()], ["③ 系列別樞紐", buildR3()],
        ["④ 通路別", buildR4()], ["資料檢核", buildChk()]];
      const cond = [["項目", "設定"]];
      for (const [title, b] of parts) {
        if (!b.cond.length) continue;
        cond.push([title, ""], ...b.cond.map(([k, v]) => ["　" + k, v]));
      }
      cond.push(["共通", ""], ...condRows([]).map(([k, v]) => ["　" + k, v]));
      const sheets = [{ name: "篩選條件", cols: [16, 90], head: 1, aoa: cond, boldRows: new Set(cond.map((r, i) => (r[1] === "" && i ? i : -1))) },
        ...parts.flatMap(([, b]) => b.sheets)];
      await SO.downloadXlsx(`SellOut_全部報表_${D.yms[S.r1.cur[1]]}_${stamp()}.xlsx`, sheets);
    });
  }

  // ------------------------------------------------------------ 報表四：By 通路別（仿 Sell in 405 版面）
  // 列：通路類別 → 通路 → 系列 → 品號；欄：前期、本期、本年累計、變化（本期 vs 前期）
  // 值陣列 9 格：[前期 數量, 金額, 市價, 本期 數量, 金額, 市價, 本年累計 數量, 金額, 市價]
  let r4Last = null;
  function initR4() {
    const n = D.yms.length;
    S.r4 = { basis: "拆組", pre: Math.max(0, n - 2), cur: n - 1, brand: "全部",
      cat: new Set(D.allChCats), ch: new Set(D.allChNames), inv: new Set(D.allInv) };
    const f = $("#r4Filters");
    f.innerHTML = "";
    const opts = D.yms.map((y, i) => [i, ymLabel(y)]);
    f.append(
      seg("口徑", ["拆組", "未拆組"], S.r4.basis, v => { S.r4.basis = v; renderR4(); }),
      selectBox("前期", opts, S.r4.pre, v => { S.r4.pre = +v; renderR4(); }),
      selectBox("本期", opts, S.r4.cur, v => { S.r4.cur = +v; renderR4(); }),
      seg("品牌", ["全部", "DR.WU", "Redermx"], S.r4.brand, v => { S.r4.brand = v; renderR4(); }),
      multiSelect("通路類別", D.allChCats, S.r4.cat, renderR4),
      multiSelect("通路", D.allChNames, S.r4.ch, renderR4),
      multiSelect("產品分類（暫以存貨型態）", D.allInv, S.r4.inv, renderR4),
    );
  }

  function renderR4() {
    const bit = S.useTemp ? 2 : 1;
    const { basis, pre, cur, brand, cat, ch, inv } = S.r4;
    const unsplit = basis === "未拆組";
    const y = D.yms[cur].slice(0, 4);
    const ytd = [D.yms.findIndex(v => v.startsWith(y)), cur];
    const root = node("r4", "", "", 9);
    const tot = node("t", "", "", 9);
    for (const r of unsplit ? D.fso : D.fx) {
      if (!unsplit && !(r[5] & bit)) continue;
      const ym = r[0], hits = [ym === pre, ym === cur, ym >= ytd[0] && ym <= ytd[1]];
      if (!hits.some(Boolean)) continue;
      const c = r[1], cn = D.chName[c], cc = D.chCat[c];
      if (!ch.has(cn) || !cat.has(cc)) continue;
      const it = D.items[r[2]];
      if (brand !== "全部" && it[I.BRAND] !== brand) continue;
      if (!inv.has(it[I.INV] || NONE)) continue;
      const qty = unsplit ? r[3] : r[6], amt = unsplit ? r[4] : r[7], mkt = qty * D.price[r[2]];
      const ser = it[I.SERIES] || "其他";
      const n1 = child(root, cc, cc, "", 9), n2 = child(n1, cn, cn, "", 9), n3 = child(n2, ser, ser, "", 9);
      const n4 = child(n3, it[I.CODE], it[I.CODE], [it[I.NAME], it[I.SPEC]].filter(Boolean).join("　"), 9);
      hits.forEach((h, k) => {
        if (!h) return;
        const path = [n1, n2, n3, n4, tot];
        bump(path, k * 3, qty); bump(path, k * 3 + 1, amt); bump(path, k * 3 + 2, mkt);
      });
    }

    // 各欄計算（null＝空白）
    const calc = nd => {
      const has = k => nd.c[k * 3] > 0;
      const g = k => (has(k) ? { q: nd.v[k * 3], a: nd.v[k * 3 + 1], r: div(nd.v[k * 3 + 1], nd.v[k * 3 + 2]) } : null);
      const p = g(0), c = g(1), t = g(2);
      return {
        p, c, t,
        pShare: p && div(p.a, tot.v[1]), cShare: c && div(c.a, tot.v[4]),
        diff: p || c ? (c?.a || 0) - (p?.a || 0) : null,
        growth: p && c && p.a ? c.a / p.a - 1 : null,
        dRate: p?.r != null && c?.r != null ? c.r - p.r : null,
      };
    };
    const pl = ymLabel(D.yms[pre]), cl = ymLabel(D.yms[cur]), yl = `${ymLabel(D.yms[ytd[0]])}～${ymLabel(D.yms[ytd[1]])}`;
    const issue = (cn, i) => D.issue.has(cn + "|" + D.yms[i]);
    const warnCh = (nd, k) => {   // 通路列（或其通路類別列）、該期間有幣別異常
      const parts = nd.key.split("\u0001");
      if (parts.length === 2) return [...nd.kids.values()].some(kid => warnCh(kid, k));
      if (parts.length !== 3) return false;
      const cn = parts[2];
      if (k === 0) return issue(cn, pre);
      if (k === 1) return issue(cn, cur);
      for (let i = ytd[0]; i <= ytd[1]; i++) if (issue(cn, i)) return true;
      return false;
    };
    const sign = (v, f) => (v == null ? "" : `<span class="${v > 0 ? "up" : v < 0 ? "down" : ""}">${v > 0 ? "+" : ""}${f(v)}</span>`);
    const pp = v => (v * 100).toFixed(2) + "pp";
    const rateTd = (x, w) => `<td class="${w ? "hi" : ""}"${w ? ' title="期間內有月份幣別與其他月份不一致，疑似未換算"' : ""}>${x ? (w ? "⚠ " : "") + fmtR(x.r) : ""}</td>`;
    const cells = nd => {
      const m = calc(nd);
      return `<td class="sep">${m.p ? fmtN(m.p.q) : ""}</td><td>${m.p ? fmtN(m.p.a) : ""}</td><td>${fmtR(m.pShare)}</td>${rateTd(m.p, warnCh(nd, 0))}` +
        `<td class="sep">${m.c ? fmtN(m.c.q) : ""}</td><td class="strong">${m.c ? fmtN(m.c.a) : ""}</td><td>${fmtR(m.cShare)}</td>${rateTd(m.c, warnCh(nd, 1))}` +
        `<td class="sep">${m.t ? fmtN(m.t.q) : ""}</td><td>${m.t ? fmtN(m.t.a) : ""}</td>${rateTd(m.t, warnCh(nd, 2))}` +
        `<td class="sep">${sign(m.diff, fmtN)}</td><td>${sign(m.growth, fmtR)}</td><td>${sign(m.dRate, pp)}</td>`;
    };
    const sortKids = arr => arr.sort((a, b) => (b.v[4] - a.v[4]) || (b.v[7] - a.v[7]));
    const body = treeRows(root, 0, S.open.r4, sortKids, cells, 3);
    $("#r4Table").innerHTML = `<thead>
      <tr class="grp"><th class="l" rowspan="2">通路類別 / 通路 / 系列 / 品號</th><th colspan="4" class="sep">前期（${pl}）</th>
        <th colspan="4" class="sep">本期（${cl}）</th><th colspan="3" class="sep">本年累計（${yl}）</th><th colspan="3" class="sep">變化（本期 vs 前期）</th></tr>
      <tr><th class="sep">銷貨數量</th><th>銷貨金額</th><th>占比</th><th>折扣率</th><th class="sep">銷貨數量</th><th>銷貨金額</th><th>占比</th><th>折扣率</th>
        <th class="sep">銷貨數量</th><th>銷貨金額</th><th>折扣率</th><th class="sep">金額差異</th><th>成長率</th><th>折扣率增減</th></tr></thead>
      <tbody>${body || `<tr><td colspan="15" class="empty">沒有符合條件的資料</td></tr>`}</tbody>
      <tfoot><tr class="total"><td class="l">總計</td>${cells(tot)}</tr></tfoot>`;

    // KPI
    const t = calc(tot);
    const kpi = (k, v, d) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v || "—"}</div><div class="d">${d}</div></div>`;
    $("#r4Kpis").innerHTML =
      kpi(`本期銷貨金額（${cl}）`, t.c && fmtN(t.c.a), t.growth != null ? `${sign(t.growth, fmtR)} <span class="muted">vs 前期 ${pl}</span>` : `<span class="muted">前期無資料</span>`) +
      kpi(`本期折扣率（${cl}）`, t.c && fmtR(t.c.r), t.dRate != null ? `${sign(t.dRate, pp)} <span class="muted">vs 前期</span>` : "") +
      kpi(`本年累計銷貨金額`, t.t && fmtN(t.t.a), `<span class="muted">${yl}</span>`) +
      kpi(`本年累計折扣率`, t.t && fmtR(t.t.r), `<span class="muted">${basis}・${bomLbl()}</span>`);
    r4Last = { root, tot, calc, sortKids, pl, cl, yl, warnCh };
  }

  // ------------------------------------------------------------ 檢核
  function renderChk() {
    const bit = S.useTemp ? 2 : 1;
    let soAmt = 0, xAmt = 0, kitAmt = 0, noItemAmt = 0, noChAmt = 0;
    const kits = new Map(), noItem = new Map();
    for (const r of D.fso) {
      soAmt += r[4];
      if (!D.items[r[2]][I.NAME]) {
        noItemAmt += r[4];
        const a = noItem.get(r[2]) || [0, 0]; a[0] += r[3]; a[1] += r[4]; noItem.set(r[2], a);
      }
      if (!D.channels[r[1]][1]) noChAmt += r[4];
    }
    for (const r of D.fx) {
      if (!(r[5] & bit)) continue;
      xAmt += r[7];
      if (r[3] === 2) {
        kitAmt += r[7];
        const a = kits.get(r[2]) || [0, 0]; a[0] += r[6]; a[1] += r[7]; kits.set(r[2], a);
      }
    }
    const diff = xAmt - soAmt;
    $("#chkKpis").innerHTML = [
      ["拆組前後金額差", Math.abs(diff) < 0.5 ? "0" : fmtN(diff), "應為 0"],
      ["組包未拆金額", fmtN(kitAmt), S.useTemp ? "含暫用 BOM" : "只用 NS BOM"],
      ["未對到品號金額", fmtN(noItemAmt), "多為 NS 尚未建立的 199 周邊贈品"],
      ["未對到通路金額", fmtN(noChAmt), "明細出現新通路時要加到 D_Channel"],
      ["明細總金額", fmtN(soAmt), `${D.yms.length} 個月・${fmtN(D.fso.length)} 筆（彙總後）`],
    ].map(([k, v, d]) => `<div class="kpi"><div class="k">${k}</div><div class="v">${v}</div><div class="d muted">${d}</div></div>`).join("");
    const listTable = (map, empty) => {
      const rows = [...map.entries()].sort((a, b) => b[1][1] - a[1][1]);
      return `<thead><tr><th class="l">品號</th><th class="l">品名</th><th>數量</th><th>台幣金額</th></tr></thead><tbody>` +
        (rows.map(([i, a]) => `<tr><td class="l">${esc(D.items[i][I.CODE])}</td><td class="l">${esc(D.items[i][I.NAME] || "")}</td><td>${fmtN(a[0])}</td><td>${fmtN(a[1])}</td></tr>`).join("")
          || `<tr><td colspan="4" class="empty">${empty}</td></tr>`) + "</tbody>";
    };
    $("#chkKits").innerHTML = listTable(kits, "沒有未拆的組包");
    $("#chkItems").innerHTML = listTable(noItem, "全部對到");
    $("#chkCur").innerHTML = `<thead><tr><th class="l">通路別</th><th class="l">年月</th></tr></thead><tbody>` +
      (D.currencyIssues.map(([c, y]) => `<tr><td class="l">${esc(c)}</td><td class="l">${ymLabel(y)}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">沒有</td></tr>`) + "</tbody>";
    // 裸瓶 → 正貨對應（拆組後）
    const bare = D.bare[bit] || [];
    $("#chkBare").innerHTML = `<thead><tr><th class="l">裸瓶品號</th><th class="l">裸瓶品名</th><th>裸瓶售價</th><th class="l">對應正貨</th>` +
      `<th class="l">正貨品名</th><th>正貨牌價</th><th>拆組數量</th><th>拆組金額</th><th class="l">說明</th></tr></thead><tbody>` +
      (bare.map(r => { const warn = !r[3] || /不同|不在/.test(r[8]);
        return `<tr><td class="l">${esc(r[0])}</td><td class="l">${esc(r[1])}</td><td>${fmtN(r[2])}</td><td class="l">${esc(r[3] || "")}</td>` +
          `<td class="l">${esc(r[4] || "")}</td><td>${fmtN(r[5])}</td><td>${fmtN(r[6])}</td><td>${fmtN(r[7])}</td><td class="l${warn ? " hi" : ""}">${esc(r[8])}</td></tr>`; }).join("")
        || `<tr><td colspan="9" class="empty">拆組後沒有裸瓶</td></tr>`) + "</tbody>";

    // 系列歸類：同一前三碼的品項分散在多個系列
    const mix = new Map(), seriesOk = new Set(RAW.seriesOk || []);   // 已確認系列無誤的品號不提醒
    for (const r of D.fx) {
      if (!(r[5] & bit)) continue;
      const it = D.items[r[2]], p3 = it[I.P3];
      if (!p3 || p3 === "組合包" || !it[I.SERIES] || seriesOk.has(it[I.CODE])) continue;
      if (!mix.has(p3)) mix.set(p3, new Map());
      const m = mix.get(p3), s = m.get(it[I.SERIES]) || { amt: 0, items: new Set() };
      s.amt += r[7]; s.items.add(it[I.CODE]); m.set(it[I.SERIES], s);
    }
    const mixRows = [...mix].filter(([, m]) => m.size > 1).sort((a, b) => a[0].localeCompare(b[0]));
    $("#chkSeries").innerHTML = `<thead><tr><th class="l">前三碼</th><th class="l">系列</th><th>品項數</th><th>台幣金額</th><th class="l">品號</th></tr></thead><tbody>` +
      (mixRows.flatMap(([p3, m]) => {
        const ss = [...m].sort((a, b) => b[1].amt - a[1].amt);
        return ss.map(([ser, s], i) => `<tr><td class="l">${i ? "" : esc(p3)}</td><td class="l${i ? " hi" : ""}">${esc(ser)}</td><td>${s.items.size}</td>` +
          `<td>${fmtN(s.amt)}</td><td class="l small">${i ? esc([...s.items].slice(0, 6).join("、") + (s.items.size > 6 ? " …" : "")) : ""}</td></tr>`);
      }).join("") || `<tr><td colspan="5" class="empty">沒有</td></tr>`) + "</tbody>";
    $("#chkSeriesOk").textContent = seriesOk.size ? `已確認系列無誤、不再提醒的品號 ${seriesOk.size} 個：${[...seriesOk].join("、")}（build/系列確認.csv）` : "";
    $("#chkNoDetail").innerHTML = `<thead><tr><th class="l">通路別</th><th class="l">備註</th></tr></thead><tbody>` +
      (D.noDetailChannels.map(([c, n]) => `<tr><td class="l">${esc(c)}</td><td class="l">${esc(n)}</td></tr>`).join("") || `<tr><td colspan="2" class="empty">沒有</td></tr>`) + "</tbody>";
    // 通路調整：通路對照原值 → 調整後；通路對照沒有的＝新增通路。明細沒有這個通路別（可能打錯）、被同一通路別後面的列覆蓋的標黃
    const chg = (a, b) => (b && b !== a ? `${a || "（空白）"} → ${b}` : a || "");
    $("#chkAdj").innerHTML = `<thead><tr><th class="l">通路別</th><th class="l">通路名稱</th><th class="l">通路類別</th><th class="l">地區</th><th class="l">狀態</th><th class="l">說明</th></tr></thead><tbody>` +
      (D.chAdjust.map(([c, n0, n1, k0, k1, note, ok, ov, g0, g1, used]) => {
        const st = ov ? [`${ov}被後面的列覆蓋`, true]
          : !ok && !used ? ["新增通路，但明細沒有這個通路別（請檢查是否打錯）", true]
          : !ok ? ["新增通路", false]
          : [(n1 && n1 !== n0) || (k1 && k1 !== k0) || (g1 && g1 !== g0) ? "已套用" : "與通路對照相同", false];
        return `<tr><td class="l">${esc(c)}</td><td class="l">${esc(ok ? chg(n0, n1) : n1 || c)}</td><td class="l">${esc(chg(k0, k1))}</td>` +
          `<td class="l">${esc(chg(g0, g1))}</td><td class="l${st[1] ? " hi" : ""}">${esc(st[0])}</td><td class="l">${esc(note || "")}</td></tr>`;
      }).join("") || `<tr><td colspan="6" class="empty">沒有</td></tr>`) + "</tbody>";
  }

  // ------------------------------------------------------------ 資料更新（上傳）
  let PENDING = null;
  const nowStr = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
  const sumBy = (rows, key) => { const m = new Map(); for (const r of rows) m.set(key(r), (m.get(key(r)) || 0) + r[5]); return m; };

  function renderUpdInfo() {
    const byYear = sumBy(RAW.so, r => r[0].slice(0, 4));
    $("#updInfo").innerHTML = `<table class="tbl"><tbody>
      <tr><td class="l">資料更新時間</td><td class="l">${esc(RAW.generated)}${RAW._local ? ` <span class="tag">本機上傳，尚未發布</span>` : ""}</td></tr>
      <tr><td class="l">sell-out 明細</td><td class="l">${esc(RAW.source.sellout)}</td></tr>
      <tr><td class="l">項目主檔</td><td class="l">${esc(RAW.source.item)}・${fmtN(RAW.items.length)} 個品號</td></tr>
      <tr><td class="l">組包 BOM</td><td class="l">NS ${fmtN(new Set(RAW.bom.ns.map(r => r[0])).size)} 個組包・組合單 ${fmtN(new Set(RAW.bom.bu.map(r => r[0])).size)}・暫用 ${fmtN(new Set(RAW.bom.fb.map(r => r[0])).size)}</td></tr>
      <tr><td class="l">補充售價</td><td class="l">${fmtN((RAW.priceExtra || []).length)} 個品號（NS 沒有售價的才套用）</td></tr>
      <tr><td class="l">系列對照</td><td class="l">${fmtN((RAW.seriesMap || []).length)} 筆（名稱統一，去掉「系列」）</td></tr>
      <tr><td class="l">通路對照</td><td class="l">${fmtN(RAW.channels.length)} 個通路別・通路調整 ${fmtN((RAW.chAdjust || []).length)} 筆</td></tr>
      <tr><td class="l">期間</td><td class="l">${ymLabel(D.yms[0])}–${ymLabel(D.yms[D.yms.length - 1])}（${[...byYear].map(([y, a]) => `${y} 年 ${fmtN(a)} 元`).join("、")}）</td></tr>
    </tbody></table>`;
    $("#updReset").hidden = !RAW._local;
  }

  async function readFiles(files) {
    const next = { ...RAW, bom: { ...RAW.bom }, source: { ...RAW.source } };
    const log = [];
    const soNew = [], soYears = new Map(), soFiles = [];   // 年度 → 檔名；所有檔案讀完再一次取代
    for (const f of files) {
      const name = f.name, lower = name.toLowerCase();
      if (/\.(xlsx|xlsm|xls)$/.test(lower)) {
        if (!window.XLSX) throw new Error("Excel 元件還在載入，請稍候再試");
        const wb = XLSX.read(await f.arrayBuffer(), { type: "array" });
        if (wb.SheetNames.some(n => /^\d{4}年度$/.test(n))) {
          const { rows, years, emptyYears } = SO.parseSellout(wb);
          const bad = rows.filter(r => !/^\d{6}$/.test(r[0] || ""));
          if (bad.length) throw new Error(`${name}：有 ${bad.length} 列「日期」不是 YYYYMM（例：${bad[0][0]}）`);
          soNew.push(...rows);
          for (const y of years) soYears.set(y, [...(soYears.get(y) || []), name]);
          soFiles.push(name);
          log.push(`sell-out 明細「${name}」：${years.join("、") || "（無資料）"} 年度共 ${fmtN(rows.length)} 列（這些年度整年取代，其他年度保留）`);
          if (emptyYears.length) log.push(`⚠「${name}」的 ${emptyYears.join("、")}年度 工作表沒有資料列，已略過（該年度維持原資料）`);
          continue;
        }
        const ch = SO.parseChannels(wb);
        if (ch) { next.channels = ch; log.push(`通路對照「${name}」：${ch.length} 個通路別`); continue; }
        throw new Error(`${name}：看不出是哪種檔案（sell-out 明細要有「yyyy年度」工作表；通路對照要有「通路別、通路名稱」欄）`);
      }
      if (lower.endsWith(".csv")) {
        const recs = SO.parseCsv(await f.text());
        const keys = Object.keys(recs[0] || {});
        if (keys.includes("item_code")) {
          next.items = SO.itemsFromCsv(recs); next.source.item = name;
          log.push(`項目主檔「${name}」：${fmtN(next.items.length)} 個品號`);
        } else if (keys.includes("組包品號") && keys.includes("成分品號")) {
          next.bom = { ...next.bom, extra: recs.map(r => [r["組包品號"].trim(), r["成分品號"].trim(), +r["用量"] || 0,
            r["分攤比例"] === "" || r["分攤比例"] == null ? null : +r["分攤比例"]]).filter(r => r[0] && r[1] && r[3] != null) };
          log.push(`補充 BOM「${name}」：${new Set(next.bom.extra.map(r => r[0])).size} 個組包`);
        } else if (keys.includes("kit_code")) {
          const bom = SO.bomFromCsv(recs), kits = new Set(bom.map(r => r[0])).size;
          if (keys.includes("build_no") || name.includes("補")) { next.bom.bu = bom; log.push(`組合單 BOM「${name}」：${kits} 個組包`); }
          else { next.bom.ns = bom; log.push(`NS BOM「${name}」：${kits} 個組包、${fmtN(bom.length)} 列`); }
        } else if (keys.includes("系列確認品號")) {
          next.seriesOk = recs.map(r => r["系列確認品號"].trim()).filter(Boolean);
          log.push(`系列確認「${name}」：${next.seriesOk.length} 個品號不再提醒系列歸類`);
        } else if (keys.includes("裸瓶品號") && keys.includes("正貨品號")) {
          next.bareMap = recs.map(r => [r["裸瓶品號"].trim(), r["正貨品號"].trim()]).filter(r => r[0] && r[1]);
          log.push(`裸瓶對照「${name}」：${next.bareMap.length} 筆手動指定`);
        } else if (keys.includes("原系列名稱") && keys.includes("報表系列名稱")) {
          next.seriesMap = recs.map(r => [r["原系列名稱"].trim(), r["報表系列名稱"].trim()]).filter(r => r[0] && r[1]);
          log.push(`系列對照「${name}」：${next.seriesMap.length} 筆`);
        } else if (keys.includes("品號") && keys.includes("售價")) {
          next.priceExtra = recs.map(r => [r["品號"].trim(), +String(r["售價"]).replace(/,/g, "")]).filter(r => r[0] && r[1] > 0);
          log.push(`補充售價「${name}」：${next.priceExtra.length} 個品號（NS 沒有售價的才套用）`);
        } else if (SO.isChAdjust(recs.header)) {   // 要在通路對照之前判斷（兩者都有通路別、通路名稱）；只有標題列＝清空調整表
          if (!recs.header.includes("通路名稱") && !recs.header.includes("通路類別")) throw new Error(`${name}：通路調整要有「通路名稱」或「通路類別」欄`);
          next.chAdjust = recs.map(r => ["通路別", "通路名稱", "通路類別", "地區", "說明"].map(k => (r[k] || "").trim() || null)).filter(r => r[0]);
          log.push(`通路調整「${name}」：${next.chAdjust.length ? `${next.chAdjust.length} 筆（覆蓋通路名稱、通路類別、地區，留空＝不改；通路對照沒有的通路別＝新增）` : "0 筆（清空調整表）"}`);
        } else if (keys.includes("通路別") && keys.includes("通路名稱")) {
          next.channels = recs.map(r => ["通路別", "通路名稱", "通路類別", "地區", "備註"].map(k => (r[k] || "").trim() || null)).filter(r => r[0]);
          log.push(`通路對照「${name}」：${next.channels.length} 個通路別`);
        } else throw new Error(`${name}：看不出是哪種 CSV（D_Item 要有 item_code 欄、D_BOM 要有 kit_code 欄）`);
        continue;
      }
      throw new Error(`${name}：只接受 .xlsx 或 .csv`);
    }
    if (soYears.size) {
      const agg = new Map();
      for (const r of soNew) {
        const k = r.slice(0, 4).join("\u0001"), v = agg.get(k);
        if (v) { v[4] += r[4]; v[5] += r[5]; } else agg.set(k, [...r]);
      }
      next.so = next.so.filter(r => !soYears.has(r[0].slice(0, 4))).concat([...agg.values()]);
      next.source.sellout = soFiles.join("、");
      for (const [y, fs] of soYears) if (fs.length > 1)
        log.push(`⚠ ${y} 年度出現在 ${fs.length} 個檔案（${fs.join("、")}），已合併加總；如果是同一份資料的重複檔，請只上傳一個`);
    }
    return { next, log };
  }

  async function previewUpload(files) {
    const box = $("#updPreview");
    box.hidden = false;
    box.innerHTML = `<p class="muted">讀取中…</p>`;
    PENDING = null;
    try {
      const { next, log } = await readFiles(files);
      const model = SO.buildModel(next);
      // 拆組後金額應與拆組前相同
      const so = model.fso.reduce((s, r) => s + r[4], 0);
      const x = model.fx.filter(r => r[5] & 2).reduce((s, r) => s + r[7], 0);
      const before = sumBy(RAW.so, r => r[0]), after = sumBy(next.so, r => r[0]);
      const yms = [...new Set([...before.keys(), ...after.keys()])].sort();
      const chKnown = new Set([...next.channels, ...(next.chAdjust || [])].map(c => c[0]));   // 通路調整新增的通路也算對得到
      const newCh = sumBy(next.so.filter(r => !chKnown.has(r[1])), r => r[1]);
      const itemKnown = new Set(next.items.map(i => i[0]));
      const noItem = next.so.filter(r => !itemKnown.has(r[2]));
      const warn = [];
      if (Math.abs(so - x) > 1) warn.push(`拆組前後金額差 ${fmtN(x - so)}，請檢查 BOM`);
      if (newCh.size) warn.push(`明細有 ${newCh.size} 個通路別不在通路對照表：${[...newCh].map(([c, a]) => `${c}（${fmtN(a)} 元）`).join("、")}。報表會顯示「未對到通路」；請下載通路對照表補上後一起上傳`);
      if (noItem.length) warn.push(`${new Set(noItem.map(r => r[2])).size} 個品號在項目主檔找不到（${fmtN(noItem.reduce((s, r) => s + r[5], 0))} 元）`);
      const adjMiss = [...new Set(model.chAdjust.filter(r => !r[6] && !r[10]).map(r => r[0]))];
      if (adjMiss.length) warn.push(`通路調整有 ${adjMiss.length} 個通路別不在通路對照、明細也沒有：${adjMiss.join("、")}（請檢查是否打錯）`);
      if (model.currencyIssues.length) warn.push(`幣別與其他月份不一致：${model.currencyIssues.map(([c, y]) => `${c} ${ymLabel(y)}`).join("、")}`);
      box.innerHTML = `
        <h3>讀到的檔案</h3><ul>${log.map(l => `<li class="${l.startsWith("⚠") ? "err" : ""}">${esc(l)}</li>`).join("")}</ul>
        ${warn.length ? `<div class="warnbox">${warn.map(w => `⚠ ${esc(w)}`).join("<br>")}</div>` : `<p class="ok">✓ 檢查通過：拆組前後金額一致、通路與品號都對得到</p>`}
        <h3>各月台幣金額（未拆組）</h3>
        <div class="tbl-wrap short"><table class="tbl"><thead><tr><th class="l">年月</th><th>目前</th><th>上傳後</th><th>差異</th></tr></thead><tbody>
        ${yms.map(y => { const b = before.get(y), a = after.get(y), d = (a || 0) - (b || 0);
          return `<tr><td class="l">${ymLabel(y)}</td><td>${fmtN(b)}</td><td>${fmtN(a)}</td><td class="${Math.abs(d) >= 1 ? (d > 0 ? "up" : "down") : ""}">${Math.abs(d) >= 1 ? (d > 0 ? "+" : "") + fmtN(d) : ""}</td></tr>`; }).join("")}
        </tbody></table></div>
        <div class="btns-row"><button type="button" id="updApply">套用到報表</button><button type="button" class="ghost" id="updCancel">取消</button></div>`;
      PENDING = next;
      $("#updApply").onclick = () => {
        PENDING.generated = nowStr();
        PENDING._local = true;
        load(PENDING);
        PENDING = null;
        box.innerHTML = `<p class="ok">✓ 已套用。報表已改用上傳的資料（只在這個分頁）。要讓所有人看到，請在下方「發布」下載 data.enc 上傳到 GitHub。</p>`;
      };
      $("#updCancel").onclick = () => { PENDING = null; box.hidden = true; $("#updFile").value = ""; };
    } catch (err) {
      console.error(err);
      box.innerHTML = `<p class="err">讀取失敗：${esc(err.message)}</p>`;
    }
  }

  function download(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function bindUpd() {
    const drop = $("#updDrop"), input = $("#updFile");
    input.addEventListener("change", () => {
      if (!input.files.length) return;
      const files = [...input.files];
      input.value = "";   // 清空，之後選同一個檔案也會觸發
      previewUpload(files);
    });
    drop.addEventListener("dragover", e => { e.preventDefault(); drop.classList.add("over"); });
    drop.addEventListener("dragleave", () => drop.classList.remove("over"));
    drop.addEventListener("drop", e => { e.preventDefault(); drop.classList.remove("over"); e.dataTransfer.files.length && previewUpload([...e.dataTransfer.files]); });
    $("#updEnc").addEventListener("click", async e => {
      const btn = e.currentTarget, t = btn.textContent;
      btn.disabled = true; btn.textContent = "加密中…";
      try {
        const { _local, ...clean } = RAW;
        const enc = await SO.encrypt(clean, PASSWORD);
        download("data.enc", new Blob([JSON.stringify(enc)], { type: "application/octet-stream" }));
      } finally { btn.disabled = false; btn.textContent = t; }
    });
    $("#updSeries").addEventListener("click", () => {
      const rows = [["原系列名稱", "報表系列名稱"], ...(RAW.seriesMap || [])];
      download("系列對照.csv", new Blob(["\uFEFF" + rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n")], { type: "text/csv" }));
    });
    $("#updChannels").addEventListener("click", () => {
      if (!window.XLSX) return;
      SO.downloadXlsx("D_Channel_通路對照.xlsx", [{ name: "D_Channel", cols: [16, 12, 18, 6, 40],
        aoa: [["通路別", "通路名稱", "通路類別", "地區", "備註"], ...RAW.channels.map(c => c.map(v => v ?? ""))] }]);
    });
    $("#updDetail").addEventListener("click", exportCurrent);
    $("#updReset").addEventListener("click", async () => { load(await decrypt(ENC, PASSWORD)); $("#updPreview").hidden = true; });
    window.addEventListener("beforeunload", e => { if (RAW && RAW._local) { e.preventDefault(); e.returnValue = ""; } });
  }

  // ------------------------------------------------------------ 互動
  function renderAll() { renderR1(); renderR2(); renderR3(); renderR4(); renderChk(); }

  function bindApp() {
    document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
      S.tab = b.dataset.tab;
      document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("active", x === b));
      for (const id of ["r1", "r2", "r3", "r4", "chk", "upd"]) $("#" + id).hidden = id !== S.tab;
    }));
    $("#useTemp").addEventListener("change", e => { S.useTemp = e.target.checked; renderAll(); });
    $("#r3Export").addEventListener("click", exportCurrent);
    $("#xlsx").addEventListener("click", exportCurrent);
    $("#xlsxAll").addEventListener("click", exportAll);
    bindUpd();
    $("#logout").addEventListener("click", () => { store.del(PW_KEY); location.reload(); });
    document.addEventListener("click", e => {
      const g3 = e.target.closest(".tg3");
      if (g3) { const k = g3.dataset.k3; S.open.r3.has(k) ? S.open.r3.delete(k) : S.open.r3.add(k); renderR3(); return; }
      const td = e.target.closest("td.tg");
      if (td) {
        const which = td.closest("main").id;
        const set = S.open[which];
        set.has(td.dataset.k) ? set.delete(td.dataset.k) : set.add(td.dataset.k);
        ({ r1: renderR1, r2: renderR2, r4: renderR4 })[which]();
        return;
      }
      const ex = e.target.dataset?.expand, co = e.target.dataset?.collapse;
      if (ex === "r1") { allKeys(r1Tree).forEach(k => S.open.r1.add(k)); renderR1(); }
      if (ex === "r2") { allKeys(r2Trees.amt).forEach(k => S.open.r2.add(k)); renderR2(); }
      if (ex === "r3") { allKeys(r3Grid.root).forEach(k => S.open.r3.add(k)); renderR3(); }
      if (ex === "r3p3") { S.open.r3.clear(); r3Grid.grid.filter(g => g[3] === 0).forEach(g => S.open.r3.add(g[5])); renderR3(); }
      if (ex === "r4") { allKeys(r4Last.root).forEach(k => S.open.r4.add(k)); renderR4(); }
      if (ex === "r4ch") { S.open.r4.clear(); for (const n1 of r4Last.root.kids.values()) S.open.r4.add(n1.key); renderR4(); }
      if (ex === "r4ser") { S.open.r4.clear(); for (const n1 of r4Last.root.kids.values()) { S.open.r4.add(n1.key); for (const n2 of n1.kids.values()) S.open.r4.add(n2.key); } renderR4(); }
      if (co) { S.open[co].clear(); ({ r1: renderR1, r2: renderR2, r3: renderR3, r4: renderR4 })[co](); }
      // 點外面關閉多選
      document.querySelectorAll("details.ms[open]").forEach(d => { if (!d.contains(e.target)) d.open = false; });
    });
  }

  function load(raw) {
    RAW = raw;
    D = prepare(SO.buildModel(raw));
    S.open.r1.clear(); S.open.r2.clear(); S.open.r3.clear(); S.open.r4.clear();
    $("#meta").textContent = `資料期間 ${ymLabel(D.yms[0])}–${ymLabel(D.yms[D.yms.length - 1])}・更新 ${D.generated}・來源 ${D.source.sellout}` +
      (raw._local ? "（本機上傳，尚未發布）" : "");
    initR1(); initR2(); initR3(); initR4(); renderAll(); renderUpdInfo();
  }

  async function start(password, remember) {
    const raw = await open(password);
    PASSWORD = password;
    if (remember) store.set(PW_KEY, password);
    $("#login").hidden = true;
    $("#app").hidden = false;
    bindApp();
    load(raw);
  }

  $("#loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    const btn = $("#loginBtn"), msg = $("#loginMsg");
    btn.disabled = true; msg.textContent = ""; btn.textContent = "解密中…";
    try {
      await start($("#pw").value, $("#remember").checked);
    } catch (err) {
      console.error(err);
      msg.textContent = err instanceof DOMException || err.name === "OperationError" ? "密碼不正確" : "無法載入資料：" + err.message;
    } finally {
      btn.disabled = false; btn.textContent = "開啟報表";
    }
  });

  const saved = store.get(PW_KEY);
  if (saved) start(saved, true).catch(() => store.del(PW_KEY));
})();
