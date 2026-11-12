-- =====================================================================
-- B. D_BOM 拆組表（組包 → 成分、用量、分攤比例）
-- ---------------------------------------------------------------------
-- 邏輯同 Sell in 報表（script 405）的 kitAllocMap：
--   組包＝DR_存貨型態 id 5；BOM 取目前版本 MAX(currentrevision)
--   成分只留有 DR_產品劑型 的品項（含正貨、裸瓶），包材、加工費、內料不進來
--   分攤比例＝成分售價 × 用量 ÷ 整包合計；整包售價合計為 0 時改用 用量 ÷ 用量合計
-- 與 405 的差別：itemprice 加上 currencypage = 1 只取台幣。405 串 pricing 少了
--   currency = 1，成分有外幣售價時 BOM 行會被複製（例：20124008 的 HHT150A 用量變 5）
-- 執行：NS「SuiteQL Query Tool」（script 398）或 ..\匯出NS維度表\ 的匯出程式
-- 實跑：2026-10-07 NS 正式區 3,158 列（1,635 個組包）
-- 注意：NS 有 4,514 個組包，只有 1,679 個有 BOM；沒有 BOM 的組包見 C 段（組合單）
-- =====================================================================
SELECT b.kit_code, b.comp_code, b.comp_spec, b.qty_per_kit,
       ROUND(b.comp_price, 0) AS comp_price,
       CASE WHEN SUM(b.qty_per_kit * NVL(b.comp_price, 0)) OVER (PARTITION BY b.kit_code) > 0
            THEN b.qty_per_kit * NVL(b.comp_price, 0)
                 / SUM(b.qty_per_kit * NVL(b.comp_price, 0)) OVER (PARTITION BY b.kit_code)
            ELSE b.qty_per_kit / NULLIF(SUM(b.qty_per_kit) OVER (PARTITION BY b.kit_code), 0)
       END AS share
FROM (
  WITH kitrev AS (
    SELECT ab.assembly AS asm, MAX(ab.currentrevision) AS rev
    FROM assemblyitembom ab
    JOIN item ka ON ka.id = ab.assembly
    WHERE ka.custitem_dr_product_type = 5                     -- 5＝組包
    GROUP BY ab.assembly
  )
  SELECT ka.custitem_dr_itemname1 AS kit_code,
         ci.custitem_dr_itemname1 AS comp_code,
         ci.custitem_dr_itemname2 AS comp_spec,
         SUM(bc.quantity)         AS qty_per_kit,
         MAX(ip.price) * 1.05     AS comp_price
  FROM kitrev kr
  JOIN item ka ON ka.id = kr.asm
  JOIN bomrevisioncomponent bc ON bc.bomrevision = kr.rev
  JOIN item ci ON ci.id = bc.item
  LEFT JOIN itemprice ip ON ip.item = ci.id AND ip.pricelevel = 1
                        AND ip.currencypage = 1             -- 只取台幣，避免 BOM 行被複製
  WHERE ci.custitem_dr_dosageform IS NOT NULL                -- 排除包材、加工費、內料
  GROUP BY ka.custitem_dr_itemname1, ci.custitem_dr_itemname1, ci.custitem_dr_itemname2
) b
ORDER BY b.kit_code, b.comp_code
