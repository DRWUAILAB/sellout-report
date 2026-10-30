/* Sell-out 網頁報表：資料模型（拆組、上傳解析、加密、Excel 匯出）
 * 原始資料（RAW，data.enc v2）：
 *   items    [品號, 品名, 產品代碼, 前三碼, 前六碼, 系列, 劑型, 存貨型態, 品牌, 售價]
 *   bom      { ns: NS BOM, bu: 組合單推 BOM, fb: 代碼拆解暫用, extra: 補充 BOM（業務指定，兩種模式都用） }，
 *            每列 [組包品號, 成分品號, 用量, 分攤比例]
 *   channels [通路別, 通路名稱, 通路類別, 地區, 備註]（資料包 D_Channel 原值）
 *   chAdjust [通路別, 通路名稱, 通路類別, 地區, 說明]（通路調整，build/通路類別調整.csv：覆蓋通路名稱、通路類別、地區，
 *            留空＝不改；通路對照沒有的通路別＝新增通路，通路名稱留空＝用通路別）
 *   so       [年月, 通路別, 品號, 幣別, 數量, 台幣金額]（未拆組明細，依前四欄彙總）
 *   seriesMap [原系列名稱, 報表系列名稱]（系列名稱統一）
 *   bareMap  [裸瓶品號, 正貨品號]（手動指定裸瓶對應的正貨；沒指定的自動對應）
 *   priceExtra [品號, 售價]（補充售價，build/補充售價.csv：NS 沒有售價的品項才套用）
 * items 第 11 欄（索引 10）＝非作用中（T／F）
 * buildModel() 把 RAW 拆組成報表用的索引化事實表（邏輯同 Power Query 01–05 與 build_data.py）。
 */
window.SO = (() => {
  "use strict";
  const SRC = ["單品", "拆組", "組包未拆"];

  // ------------------------------------------------------------ 拆組
  function bomMap(rows) {
    const m = new Map();
    for (const [kit, comp, q, s] of rows) {
      if (!kit || !comp || s == null) continue;
      if (!m.has(kit)) m.set(kit, []);
      m.get(kit).push([comp, +q || 0, +s]);
    }
    return m;
  }

  // 系列名稱統一：先查系列對照（含改名，例 潤透光美白系列 → 超微C美白），沒有的去掉結尾「系列」
  function seriesNormalizer(map) {
    const m = new Map((map || []).map(([a, b]) => [a, b]));
    return s => (s == null ? s : m.get(s) ?? s.replace(/系列$/, ""));
  }

  // 裸瓶 → 正貨：拆組拆到裸瓶（半成品）時，改用對應的正貨品號顯示（品名、系列等跟正貨），
  // 市價仍用裸瓶（BOM 成分）售價——與業務的《2026市場綜合折扣率》、舊報表口徑一致（2026-10-08 起）
  // 自動對應＝同前六碼、存貨型態＝正貨、啟用中、有售價，且品名（去掉空白與「-裸瓶／裸包」）相同或開頭相同；
  // 多個候選時依序取：品名完全相同 → 規格版本相同（例 (2024)）→ 代碼 A 款 → 品號較大（較新）。
  // 品名對不到的不對應（保留裸瓶並列在資料檢核），避免同前六碼的不同商品被對錯（例 AAT050X 前導精華露 ≠ AAT050A 超彈力精華露）
  const OFF = v => ["t", "true", "yes", "y", "是", "1"].includes(String(v ?? "").trim().toLowerCase());
  const isBareInv = inv => /裸瓶|裸包/.test(inv || "");
  function bareMapper(items, overrides) {
    const byCode = new Map(items.map(it => [it[0], it]));
    const byP6 = new Map();
    for (const it of items) {
      if (it[7] !== "正貨" || OFF(it[10]) || it[9] == null || !it[4]) continue;
      if (!byP6.has(it[4])) byP6.set(it[4], []);
      byP6.get(it[4]).push(it);
    }
    const norm = s => (s || "").replace(/[\s　]+/g, "");
    const ver = s => ((s || "").match(/\(([^)]*)\)\s*$/) || [])[1] || "";
    const letter = it => (it[2] || "").slice((it[4] || "").length, (it[4] || "").length + 1).toUpperCase();
    const better = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
    const ov = new Map((overrides || []).filter(([a, b]) => a && b));
    const cache = new Map();
    return code => {
      if (cache.has(code)) return cache.get(code);
      const it = byCode.get(code);
      let res = null;
      if (it && isBareInv(it[7])) {
        if (ov.has(code)) {
          res = byCode.has(ov.get(code)) ? { to: ov.get(code), note: "手動指定" } : { to: null, note: `手動指定的正貨 ${ov.get(code)} 不在項目主檔` };
        } else {
          const bn = norm(it[1]).replace(/[-－]?(裸瓶|裸包).*$/, "");
          let best = null, bs = null;
          for (const c of byP6.get(it[4]) || []) {
            const cn = norm(c[1]);
            const nm = cn === bn ? 2 : bn && cn.startsWith(bn) ? 1 : 0;
            if (!nm) continue;
            const s = [nm, ver(c[2]) === ver(it[2]) ? 1 : 0, letter(c) === "A" ? 1 : 0, c[0]];
            if (!bs || better(s, bs)) { best = c; bs = s; }
          }
          res = best ? { to: best[0], note: (bs[0] === 2 ? "品名相同" : "品名開頭相同") + (bs[1] ? "" : "、規格版本不同（請確認）") }
            : { to: null, note: "找不到品名相同的正貨，保留裸瓶" };
        }
      }
      cache.set(code, res);
      return res;
    };
  }

  function buildModel(raw) {
    const normS = seriesNormalizer(raw.seriesMap);
    const itemMap = new Map(raw.items.map(it => { const c = it.slice(); c[5] = normS(c[5]); return [c[0], c]; }));
    // 補充售價：NS 沒有售價（空白或 0）的品項才套用；NS 補上售價後以 NS 為準
    for (const [code, price] of raw.priceExtra || []) { const it = itemMap.get(code); if (it && !it[9]) it[9] = price; }
    const isKit = code => itemMap.get(code)?.[7] === "組包";
    const ns = bomMap(raw.bom.ns);
    for (const [k, v] of bomMap(raw.bom.extra || [])) if (!ns.has(k)) ns.set(k, v);   // 補充 BOM：兩種模式都用
    const tmp = new Map(ns);
    for (const [k, v] of bomMap(raw.bom.bu)) if (!tmp.has(k)) tmp.set(k, v);
    const nsBu = new Set(tmp.keys());
    for (const [k, v] of bomMap(raw.bom.fb)) if (!nsBu.has(k)) tmp.set(k, v);
    // NS／補充 BOM 都沒有、預設模式拆不了的組包（福袋、禮盒、贈品組、刷具組…）：系列歸「其他」；前三碼、前六碼也歸「其他」，但沒有產品代碼的留空（報表前三碼歸「其他」、前六碼顯示商品名稱）
    for (const [code, it] of itemMap) {
      if (it[7] !== "組包" || ns.has(code)) continue;
      it[5] = "其他";
      if (it[3]) it[3] = "其他";
      if (it[4]) it[4] = "其他";
    }

    // 未拆組：依 年月、通路、品號 彙總
    const yms = [...new Set(raw.so.map(r => r[0]))].sort();
    const chList = [...new Set(raw.so.map(r => r[1]))].sort();
    const ymIx = new Map(yms.map((y, i) => [y, i]));
    const chIx = new Map(chList.map((c, i) => [c, i]));
    const items = [], itemIx = new Map();
    const ix = code => {
      let i = itemIx.get(code);
      if (i === undefined) {
        i = items.length;
        itemIx.set(code, i);
        let it = itemMap.get(code);
        if (!it) {
          // 項目主檔沒有的品號：品名留空（資料檢核算「未對到品號」），顯示用銷售明細的品名
          it = [code, null, null, null, null, null, null, null, null, null];
          it.soName = (raw.soNames || {})[code] || null;
        }
        items.push(it);
      }
      return i;
    };
    const soAgg = new Map();
    for (const [ym, ch, item, , q, a] of raw.so) {
      const k = ym + "\u0001" + ch + "\u0001" + item;
      const v = soAgg.get(k);
      if (v) { v[3] += q; v[4] += a; } else soAgg.set(k, [ym, ch, item, q, a]);
    }
    const fso = [], fsoRaw = [...soAgg.values()];
    for (const [ym, ch, item, q, a] of fsoRaw) fso.push([ymIx.get(ym), chIx.get(ch), ix(item), q, a]);

    // 拆組：兩種 BOM 各拆一次，值相同的列合併（mode 位元 1＝只用 NS BOM、2＝含暫用 BOM）
    const mapBare = bareMapper(raw.items, raw.bareMap);
    // 正貨售價和裸瓶不同時，建一筆「正貨品號＋裸瓶售價」的變體（同品號、同品名，只有售價不同）
    const asMapped = (to, bare) => {
      const t = itemMap.get(to), b = itemMap.get(bare);
      if (!t || !b || b[9] == null || b[9] === t[9]) return to;
      const key = to + "\u0002" + b[9];
      if (!itemMap.has(key)) { const v = t.slice(); v[9] = b[9]; itemMap.set(key, v); }
      return key;
    };
    const explodeAll = (bom, bareStat) => {
      const out = new Map();
      for (const [ym, ch, item, q, a] of fsoRaw) {
        let cur = [[item, q, a, false]];
        for (let lv = 0; lv < 2; lv++) {
          const nxt = [];
          for (const [it, qq, aa, hit] of cur) {
            const comps = bom.get(it);
            if (!comps) nxt.push([it, qq, aa, hit]);
            else for (const [c, u, s] of comps) nxt.push([c, qq * u, aa * s, true]);
          }
          cur = nxt;
        }
        for (const [it, qq, aa, hit] of cur) {
          const src = isKit(it) ? 2 : hit ? 1 : 0;
          const m = mapBare(it);
          if (m) { const b = bareStat.get(it) || [0, 0]; b[0] += qq; b[1] += aa; bareStat.set(it, b); }
          const k = [ymIx.get(ym), chIx.get(ch), ix(m?.to ? asMapped(m.to, it) : it), src, ix(item)].join(",");
          const v = out.get(k);
          if (v) { v[0] += qq; v[1] += aa; } else out.set(k, [qq, aa]);
        }
      }
      return out;
    };
    const bareNs = new Map(), bareTmp = new Map();
    const xNs = explodeAll(ns, bareNs), xTmp = explodeAll(tmp, bareTmp);
    // 資料檢核用：[裸瓶品號, 品名, 售價, 正貨品號, 品名, 售價, 數量, 金額, 說明]
    const bareRows = stat => [...stat].map(([code, [q, a]]) => {
      const b = itemMap.get(code), m = mapBare(code), t = m.to ? itemMap.get(m.to) : null;
      return [code, b[1], b[9], m.to, t?.[1] ?? null, t?.[9] ?? null, q, a, m.note];
    }).sort((x, y) => y[7] - x[7]);
    const fx = [];
    const same = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-4;
    for (const [k, v] of xNs) {
      const t = xTmp.get(k);
      const key = k.split(",").map(Number);
      if (t && same(v, t)) { fx.push([...key, 3, v[0], v[1]]); xTmp.delete(k); }
      else fx.push([...key, 1, v[0], v[1]]);
    }
    for (const [k, v] of xTmp) fx.push([...k.split(",").map(Number), 2, v[0], v[1]]);

    // 幣別異常：同一通路其他月份用外幣、這個月卻填 NTD
    const foreign = new Set(raw.so.filter(r => r[3] && r[3] !== "NTD").map(r => r[1]));
    const issues = new Set(raw.so.filter(r => r[3] === "NTD" && foreign.has(r[1])).map(r => r[1] + "\u0001" + r[0]));
    const chRaw = new Map(raw.channels.map(c => [c[0], c]));
    // 通路調整：同一通路別多列時逐欄合併（後面的列優先）；通路對照沒有的通路別＝新增通路（通路名稱留空＝用通路別）
    const chAdj = new Map();
    for (const [ch, name, cat, region] of raw.chAdjust || []) {
      if (!ch) continue;
      const p = chAdj.get(ch);
      chAdj.set(ch, [name || p?.[0] || null, cat || p?.[1] || null, region || p?.[2] || null]);
    }
    const soCh = new Set(chList);
    return {
      generated: raw.generated, source: raw.source, yms, items, src: SRC, fso, fx,
      // [通路別, 通路名稱, 通路類別, 地區, 通路對照原本的通路名稱（Redermx 分開判斷用，改名後照樣分開）]
      channels: chList.map(c => { const r = chRaw.get(c), a = chAdj.get(c);
        return [c, a?.[0] || r?.[1] || (a && !r ? c : null), a?.[1] || r?.[2] || null, a?.[2] || r?.[3] || null, r?.[1] || null]; }),
      // 資料檢核用：[通路別, 原通路名稱, 調整通路名稱, 原通路類別, 調整通路類別, 說明, 通路對照有這個通路別, 被後面的列覆蓋的欄位,
      //              原地區, 調整地區, 明細有這個通路別]
      chAdjust: (raw.chAdjust || []).filter(r => r[0]).map(([ch, name, cat, region, note]) => {
        const r = chRaw.get(ch), a = chAdj.get(ch);
        const ov = [name && name !== a[0] && "通路名稱", cat && cat !== a[1] && "通路類別", region && region !== a[2] && "地區"]
          .filter(Boolean).join("、");
        return [ch, r?.[1] ?? null, name || null, r?.[2] ?? null, cat || null, note || null, !!r, ov || null,
          r?.[3] ?? null, region || null, soCh.has(ch)];
      }),
      currencyIssues: [...issues].map(s => s.split("\u0001")).sort((a, b) => (a[1] + a[0]).localeCompare(b[1] + b[0])),
      noDetailChannels: raw.channels.filter(c => (c[4] || "").includes("沒有品項明細")).map(c => [c[0], c[4]]),
      bare: { 1: bareRows(bareNs), 2: bareRows(bareTmp) },
    };
  }

  // ------------------------------------------------------------ 上傳解析
  const txt = v => {
    if (v == null) return null;
    const s = String(typeof v === "number" && Number.isInteger(v) ? v : v).trim();
    return s || null;
  };
  const num = v => (v == null || v === "" ? 0 : +String(v).replace(/,/g, "") || 0);   // 文字格式的「1,234」也能讀

  // sell-out 明細：所有「yyyy年度」工作表，第 1 列小計、第 2 列標題（同 Power Query 01）
  function parseSellout(wb) {
    const rows = [], years = [], emptyYears = [], names = {};
    for (const name of [...wb.SheetNames].sort()) {   // 年度由舊到新：同品號取最新年度的品名
      if (!/^\d{4}年度$/.test(name)) continue;
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
      const hdr = (aoa[1] || []).map(h => txt(h));
      const c = n => hdr.indexOf(n);
      const need = ["通路別", "日期", "DRWU品號", "銷售數量", "台幣金額"];
      const miss = need.filter(n => c(n) < 0);
      if (miss.length) throw new Error(`工作表「${name}」第 2 列缺少欄位：${miss.join("、")}`);
      const before = rows.length;
      for (const r of aoa.slice(2)) {
        const item = txt(r[c("DRWU品號")]);
        if (!item) continue;
        if (c("DRWU品名") >= 0 && txt(r[c("DRWU品名")])) names[item] = txt(r[c("DRWU品名")]);
        rows.push([txt(r[c("日期")]), txt(r[c("通路別")]), item, c("幣別") >= 0 ? txt(r[c("幣別")]) || "" : "",
          num(r[c("銷售數量")]), num(r[c("台幣金額")])]);
      }
      // 只有標題、沒有資料列的年度不算（避免上傳空白範本把整年清掉）
      (rows.length > before ? years : emptyYears).push(name.slice(0, 4));
    }
    return { rows, years, emptyYears, names };
  }

  // 通路調整表（通路別,通路名稱,通路類別,地區,說明）也有「通路別、通路名稱」，用「說明」且沒有「備註」來區分
  // （通路對照是 通路別,通路名稱,通路類別,地區,備註），避免被當成整份通路對照（會把其他通路全部變成未對到通路）
  const isChAdjust = hdr => hdr.includes("通路別") && hdr.includes("說明") && !hdr.includes("備註");

  // 通路對照：第一張有「通路別、通路名稱」標題的工作表（通路調整表除外）
  function parseChannels(wb) {
    for (const name of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null });
      const h = aoa.findIndex(r => r && r.includes("通路別") && r.includes("通路名稱"));
      if (h < 0 || isChAdjust(aoa[h].map(x => txt(x)))) continue;
      const hdr = aoa[h].map(x => txt(x));
      const g = (r, n) => (hdr.indexOf(n) >= 0 ? txt(r[hdr.indexOf(n)]) : null);
      return aoa.slice(h + 1).filter(r => g(r, "通路別"))
        .map(r => [g(r, "通路別"), g(r, "通路名稱"), g(r, "通路類別"), g(r, "地區"), g(r, "備註")]);
    }
    return null;
  }

  function parseCsv(text) {
    text = text.replace(/^﻿/, "");
    const rows = [];
    let row = [], f = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
        else f += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") { row.push(f); f = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        row.push(f); f = ""; rows.push(row); row = [];
      } else f += ch;
    }
    if (f !== "" || row.length) { row.push(f); rows.push(row); }
    const hdr = (rows.shift() || []).map(h => h.trim());
    const out = rows.filter(r => r.some(v => v !== "")).map(r => Object.fromEntries(hdr.map((h, i) => [h, r[i] ?? ""])));
    out.header = hdr;   // 只有標題列、沒有資料時用來判斷檔案種類（通路調整：只有標題＝清空調整表）
    return out;
  }

  // NS 匯出 D_Item.csv → items（品牌、促銷組規則同 Power Query 04）
  function itemsFromCsv(recs) {
    const out = new Map();
    const off = v => ["t", "true", "yes", "y", "是", "1"].includes(String(v ?? "").trim().toLowerCase());
    const sorted = recs.map(r => ({ ...r, _p: r.list_price === "" ? null : +r.list_price, _off: off(r.inactive) }))
      .sort((a, b) => (a.item_code || "").localeCompare(b.item_code || "") ||
        (a._off - b._off) || ((b._p ?? -1) - (a._p ?? -1)));
    for (const r of sorted) {
      const code = txt(r.item_code);
      if (!code || out.has(code)) continue;
      const spec = (r.spec || "").trim(), inv = txt(r.inv_type);
      let p3 = txt(r.p3), p6 = txt(r.p6);
      const core = spec.replace(/^[xX]+/, "").toUpperCase();
      if (inv === "組包" && spec && ["PB", "PA", "PT"].includes(core.slice(0, 2))) p3 = p6 = "組合包";
      out.set(code, [code, txt(r.item_name), txt(spec), p3, p6, txt(r.series), txt(r.dosage), inv,
        txt(r.brand) || (spec.startsWith("X") ? "Redermx" : "DR.WU"), r._p == null ? null : Math.round(r._p), r._off ? "T" : "F"]);
    }
    return [...out.values()];
  }
  const bomFromCsv = recs => recs.map(r => [txt(r.kit_code), txt(r.comp_code), +r.qty_per_kit || 0,
    r.share === "" || r.share == null ? null : +r.share]).filter(r => r[0] && r[1] && r[3] != null);

  // ------------------------------------------------------------ 加密（與 build_data.py 相同格式）
  const b64e = buf => { let s = ""; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
  const encrypt = (obj, password, iter) => encryptText(JSON.stringify(obj), password, iter);
  async function encryptText(text, password, iter = 250000) {
    const gz = await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iter },
      base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, gz);
    return { v: 1, kdf: "PBKDF2-SHA256", iter, salt: b64e(salt), iv: b64e(iv), ct: b64e(ct) };
  }

  // ------------------------------------------------------------ 中繼表（同 build_data.py intermediate_tables／write_intermediate）
  // 網頁發布時與 data.enc 一起產生 docs/api 的加密檔，API 取數的內容才會和網站一致
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);   // 依字碼排序（同 Python sorted）
  const cmpRow = (a, b) => { for (let i = 0; i < Math.min(a.length, b.length); i++) { const c = cmp(a[i] ?? "", b[i] ?? ""); if (c) return c; } return a.length - b.length; };
  function intermediateTables(raw) {
    const normS = seriesNormalizer(raw.seriesMap);
    const nsKits = new Set([...raw.bom.ns, ...(raw.bom.extra || [])].map(r => r[0]));
    const extraPrice = new Map(raw.priceExtra || []);
    const items = new Map();
    for (let [c, name, spec, p3, p6, series, dosage, inv, brand, price, inactive] of raw.items) {
      let src = price ? "NS" : null, s;
      if (!price && extraPrice.has(c)) { price = extraPrice.get(c); src = "補充售價"; }
      if (inv === "組包" && !nsKits.has(c)) { s = "其他"; p3 = p3 ? "其他" : p3; p6 = p6 ? "其他" : p6; }
      else s = normS(series);
      items.set(c, [c, name, spec, p3, p6, s, series, dosage, inv, brand, price, src, inactive]);
    }
    const chs = new Map();
    for (const [ch, name, cat, region, note] of raw.channels) chs.set(ch, [ch, name, cat, region, note, null]);
    for (const [ch, name, cat, region, desc] of raw.chAdjust || []) {   // 同一通路別多列時逐欄合併、後面的列優先
      if (!chs.has(ch)) chs.set(ch, [ch, null, null, null, null, "新增通路"]);
      const r = chs.get(ch);
      r[1] = name || r[1] || (r[5] === "新增通路" ? ch : null);
      r[2] = cat || r[2]; r[3] = region || r[3];
      r[5] = [r[5], desc].filter(Boolean).join("；") || null;
    }
    const r4 = v => Math.round(v * 1e4) / 1e4;
    const so = [...raw.so].sort(cmpRow).map(([ym, ch, it, cur, q, a]) => {
      const c = chs.get(ch) || [ch, `${ch}（未對到通路）`, null, null], i = items.get(it);
      return i ? [ym, ch, c[1], c[2], c[3], it, i[1], ...i.slice(2, 6), i[7], i[8], i[9], i[10], cur || null, r4(q), r4(a), "Y"]
        : [ym, ch, c[1], c[2], c[3], it, (raw.soNames || {})[it] ?? null, null, null, null, null, null, null, null, null, cur || null, r4(q), r4(a), "N"];
    });
    // BOM：照網頁的優先順序只留實際使用的列（NS → 補充 → 組合單推 → 代碼拆解暫用，前面已有的組包不再用後面的）
    const bom = [], used = new Set();
    for (const [key, label, mode] of [["ns", "NS BOM", "預設"], ["extra", "補充BOM", "預設"], ["bu", "組合單推BOM", "含暫用BOM"], ["fb", "代碼拆解暫用", "含暫用BOM"]]) {
      const rows = (raw.bom[key] || []).filter(r => !used.has(r[0]));
      for (const r of rows) used.add(r[0]);
      bom.push(...rows.map(r => [...r, label, mode]));
    }
    return {
      so: ["未拆組明細", ["年月", "通路別", "通路名稱", "通路類別", "地區", "品號", "品名", "產品代碼", "前三碼", "前六碼", "系列",
        "劑型", "存貨型態", "品牌", "售價", "幣別", "數量", "台幣金額", "對到品號"], so],
      item: ["品項主檔", ["品號", "品名", "產品代碼", "前三碼", "前六碼", "系列", "NS系列", "劑型", "存貨型態", "品牌",
        "售價", "售價來源", "非作用中"], [...items.values()].sort(cmpRow)],
      channel: ["通路對照", ["通路別", "通路名稱", "通路類別", "地區", "備註", "調整說明"], [...chs.values()].sort((a, b) => cmp(a[0] || "", b[0] || ""))],
      bom: ["拆組表", ["組包品號", "成分品號", "用量", "分攤比例", "來源", "使用模式"], bom],
    };
  }
  const NUM_COLS = new Set(["售價", "數量", "台幣金額", "用量", "分攤比例"]);
  const csvText = (cols, rows) => [cols, ...rows].map(r => r.map(v => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(",")).join("\n") + "\n";

  // 發布用的檔案：{ 路徑: 內容（文字）}，data.enc 與 docs/api 中繼表（格式同 build_data.py）
  async function publishFiles(raw, password) {
    const files = { "docs/data.enc": JSON.stringify(await encrypt(raw, password)) };
    const index = { v: 1, generated: raw.generated, source: raw.source, format: "gzip CSV（UTF-8）→ AES-256-GCM，同 data.enc", tables: [] };
    for (const [key, [title, cols, rows]] of Object.entries(intermediateTables(raw))) {
      files[`docs/api/${key}.enc`] = JSON.stringify(await encryptText(csvText(cols, rows), password));
      index.tables.push({ name: key, title, file: `${key}.enc`, rows: rows.length, columns: cols, numeric: cols.filter(c => NUM_COLS.has(c)) });
    }
    files["docs/api/index.json"] = JSON.stringify(index, null, 1);
    return files;
  }

  // ------------------------------------------------------------ 發布到 GitHub（Git Data API，所有檔案一個 commit）
  // git 的 blob sha（sha1("blob <位元組數>\0" + 內容)），用來確認線上的 data.enc 還是這個頁面載入的那一版
  async function gitBlobSha(buf) {
    const bytes = new Uint8Array(buf), head = new TextEncoder().encode(`blob ${bytes.length}\0`);
    const all = new Uint8Array(head.length + bytes.length);
    all.set(head); all.set(bytes, head.length);
    return [...new Uint8Array(await crypto.subtle.digest("SHA-1", all))].map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // key＝{ token, repo: "owner/name", branch }，由 docs/publish_key.enc 以「更新密碼」解出（build/set_publish_key.py 產生）
  function githubApi(key) {
    return async (path, opt = {}) => {
      const res = await fetch(`https://api.github.com/repos/${key.repo}/${path}`, {
        ...opt, headers: { Authorization: `Bearer ${key.token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
          ...(opt.body ? { "Content-Type": "application/json" } : {}) } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        const limited = res.status === 429 || (res.status === 403 && (res.headers.get("retry-after")
          || res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(body.message || "")));
        const err = new Error(limited ? "GitHub 暫時限制請求次數，請等幾分鐘後再發布"
          : res.status === 401 ? "GitHub 金鑰無效或已過期，請找維護的人重新設定（build/set_publish_key.py）"
          : res.status === 403 || res.status === 404 ? "GitHub 金鑰沒有這個 repo 的寫入權限，請找維護的人重新設定"
          : `GitHub 回應 ${res.status}：${body.message || res.statusText}`);
        err.status = res.status;
        err.ghMessage = body.message || "";
        throw err;
      }
      return body;
    };
  }

  // baseSha＝頁面載入的 data.enc 的 blob sha：GitHub 上的 data.enc 已經不是這一版（有人在這之後發布過、或換過查看密碼）就停止，
  // 不覆蓋別人的版本。回傳目前的 head commit
  async function checkPublishBase(key, baseSha, api = githubApi(key)) {
    const ref = await api(`git/ref/heads/${key.branch}`);
    const head = await api(`git/commits/${ref.object.sha}`);
    const live = (await api(`contents/docs?ref=${head.sha}`)).find(f => f.name === "data.enc");
    if (live?.sha !== baseSha) {
      const err = new Error("線上資料和你開啟這個頁面時載入的版本不同：可能有人剛發布、換了查看密碼，或網站快取還沒更新"
        + "（每次發布後最多約 10 分鐘）。為避免覆蓋別人的版本，這次沒有發布：請約 10 分鐘後重新整理頁面、重新上傳，確認數字後再發布");
      err.status = "conflict";
      throw err;
    }
    return head;
  }

  // 只有其他檔案（程式）變動造成的「不是快轉」才重試
  async function publishToGitHub(key, files, message, baseSha, onStep = () => {}) {
    const api = githubApi(key);
    onStep("確認線上版本…");
    await checkPublishBase(key, baseSha, api);   // 先擋掉衝突，免得上傳完全部檔案才失敗
    const blobs = [];
    for (const [path, text] of Object.entries(files)) {   // 逐一上傳，避免同時大量請求觸發 GitHub 的流量限制
      onStep(`上傳檔案到 GitHub（${blobs.length + 1}/${Object.keys(files).length}）…`);
      const { sha } = await api("git/blobs", { method: "POST", body: JSON.stringify({ content: text, encoding: "utf-8" }) });
      blobs.push({ path, mode: "100644", type: "blob", sha });
    }
    for (let attempt = 0; ; attempt++) {
      onStep("建立 commit…");
      const head = await checkPublishBase(key, baseSha, api);
      const tree = await api("git/trees", { method: "POST", body: JSON.stringify({ base_tree: head.tree.sha, tree: blobs }) });
      const commit = await api("git/commits", { method: "POST", body: JSON.stringify({ message, tree: tree.sha, parents: [head.sha] }) });
      try {
        await api(`git/refs/heads/${key.branch}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha, force: false }) });
        return { sha: commit.sha, url: `https://github.com/${key.repo}/commit/${commit.sha}`,
          dataSha: blobs.find(b => b.path === "docs/data.enc").sha };
      } catch (e) {
        if (e.status !== 422 || !/fast.forward/i.test(e.ghMessage) || attempt >= 2) throw e;
      }
    }
  }

  // ------------------------------------------------------------ Excel
  // 有格式的 Excel（ExcelJS，按下載時才載入；載入失敗退回 SheetJS 無格式版本）
  // sheets: [{ name, aoa, fmt(r,c,v)→格式字串, cols:[寬度], head:標題列數, freeze:凍結列數, freezeCols:凍結欄數,
  //            levels:[每列大綱層級|null], total:最後一列是總計, hi:Set("列,欄") 標黃, merges:[[r1,c1,r2,c2]], autoFilter, boldRows:Set(列) }]
  const EXCELJS = { src: "https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js",
    sri: "sha512-dlPw+ytv/6JyepmelABrgeYgHI0O+frEwgfnPdXDTOIZz+eDgfW07QXG02/O8COfivBdGNINy+Vex+lYmJ5rxw==" };
  let excelJsLoading = null;
  function loadExcelJS() {
    if (window.ExcelJS) return Promise.resolve(true);
    excelJsLoading ||= new Promise(resolve => {
      const s = document.createElement("script");
      s.src = EXCELJS.src; s.integrity = EXCELJS.sri; s.crossOrigin = "anonymous"; s.referrerPolicy = "no-referrer";
      s.onload = () => resolve(!!window.ExcelJS);
      s.onerror = () => { excelJsLoading = null; resolve(false); };
      document.head.appendChild(s);
    });
    return excelJsLoading;
  }

  const C = { headFill: "FFDCE6F2", headFont: "FF1F2937", lv0Fill: "FFEEF3FA", totalFill: "FFE5E7EB", hiFill: "FFFFF2CC", border: "FFC9D1DC" };
  const fill = argb => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

  async function downloadXlsx(filename, sheets) {
    if (!(await loadExcelJS())) return downloadXlsxBasic(filename, sheets);
    const wb = new ExcelJS.Workbook();
    wb.creator = "Sell-out 報表";
    wb.created = new Date();
    const used = new Set();
    for (const s of sheets) {
      let name = s.name.replace(/[\\/*?:[\]]/g, "_").slice(0, 31);
      for (let i = 2; used.has(name); i++) name = `${s.name.slice(0, 28)}_${i}`;
      used.add(name);
      const ws = wb.addWorksheet(name, {
        views: [{ state: "frozen", ySplit: s.freeze || 0, xSplit: s.freezeCols || 0 }],
        properties: { outlineProperties: { summaryBelow: false, summaryRight: false } },
      });
      // 用 reduce（不用 Math.max(...陣列)），列數很多時也不會超過函式參數上限
      const head = s.head ?? 0, nCols = s.aoa.reduce((m, r) => Math.max(m, r.length), 0), last = s.aoa.length - 1;
      const maxLv = (s.levels || []).reduce((m, v) => (v != null && v > m ? v : m), -1);
      s.aoa.forEach((row, r) => {
        const xr = ws.addRow(row.map(v => (v === "" ? null : v)));
        row.forEach((v, c) => {
          if (typeof v !== "number" || !s.fmt) return;
          const z = s.fmt(r, c, v);
          if (z) xr.getCell(c + 1).numFmt = z;
        });
        const lv = s.levels?.[r];
        const isHead = r < head, isTotal = s.total && r === last;
        if (lv != null && lv > 0) xr.outlineLevel = lv;
        if (isHead || isTotal || (lv != null && lv < maxLv) || s.boldRows?.has(r)) xr.font = { bold: true, color: isHead ? { argb: C.headFont } : undefined };
        for (let c = 1; c <= nCols; c++) {
          const cell = xr.getCell(c);
          if (isHead) {
            cell.fill = fill(C.headFill);
            cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            cell.border = { bottom: { style: "thin", color: { argb: C.border } } };
          } else if (isTotal) {
            cell.fill = fill(C.totalFill);
            cell.border = { top: { style: "thin", color: { argb: "FF6B7280" } } };
          } else if (lv === 0 && maxLv > 0) {
            cell.fill = fill(C.lv0Fill);
          }
          if (s.hi?.has(`${r},${c - 1}`)) cell.fill = fill(C.hiFill);
        }
      });
      (s.cols || []).forEach((w, i) => { ws.getColumn(i + 1).width = w; });
      for (const m of s.merges || []) ws.mergeCells(...m);
      if (s.autoFilter && head) ws.autoFilter = { from: { row: head, column: 1 }, to: { row: head, column: nCols } };
    }
    const buf = await wb.xlsx.writeBuffer();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 3000);
  }

  // 備用：SheetJS 無格式版本（只有數字格式、欄寬、凍結）
  function downloadXlsxBasic(filename, sheets) {
    const wb = XLSX.utils.book_new();
    const used = new Set();
    for (const s of sheets) {
      const ws = XLSX.utils.aoa_to_sheet(s.aoa);
      if (s.fmt) for (let r = 0; r < s.aoa.length; r++) for (let c = 0; c < (s.aoa[r] || []).length; c++) {
        const v = s.aoa[r][c];
        if (typeof v !== "number") continue;
        const z = s.fmt(r, c, v);
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (z && cell) cell.z = z;
      }
      if (s.cols) ws["!cols"] = s.cols.map(w => ({ wch: w }));
      let name = s.name.replace(/[\\/*?:[\]]/g, "_").slice(0, 31);
      for (let i = 2; used.has(name); i++) name = `${s.name.slice(0, 28)}_${i}`;
      used.add(name);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }
    XLSX.writeFile(wb, filename);
  }

  return { SRC, buildModel, parseSellout, parseChannels, isChAdjust, parseCsv, itemsFromCsv, bomFromCsv, encrypt,
    intermediateTables, publishFiles, publishToGitHub, checkPublishBase, gitBlobSha, downloadXlsx };
})();
