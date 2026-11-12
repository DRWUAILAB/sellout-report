-- =====================================================================
-- C. D_BOM_補：沒有 BOM、但有組合單（Assembly Build）的組包
-- ---------------------------------------------------------------------
-- 用最近一張組合單實際耗用的成分，推出每一組的成分與用量：
--   用量＝成分耗用數量合計（組合單上為負數）÷ 組合單產出的組包數量
-- 成分同樣只留有 DR_產品劑型 的品項；分攤比例由匯出程式依 D_Item 售價計算
-- 2026-10-07 實跑 8 列（7 個組包）；其中 6 個 2026 年有 sell-out：
--   29724017（AB-000104）、29826002～29826006（AB-000254～AB-000258），
--   與產品代碼拆解的結果一致。NS 補上正式 BOM 後，這些組包會自動改走 B 段。
-- =====================================================================
WITH b AS (                                   -- 組包、沒有 BOM、但有組合單
  SELECT t.id AS tid, t.tranid AS tranid, t.trandate AS trandate,
         tm.item AS kit_id, tm.quantity AS outq
  FROM transaction t
  JOIN transactionline tm ON tm.transaction = t.id AND tm.mainline = 'T'
  JOIN item k ON k.id = tm.item
  WHERE t.type = 'Build' AND k.custitem_dr_product_type = 5
    AND NOT EXISTS (SELECT 1 FROM assemblyitembom ab WHERE ab.assembly = k.id)
), lastb AS (
  SELECT kit_id, MAX(tid) AS tid FROM b GROUP BY kit_id   -- 取最近一張
)
SELECT k.custitem_dr_itemname1 AS kit_code,
       c.custitem_dr_itemname1 AS comp_code,
       c.custitem_dr_itemname2 AS comp_spec,
       -SUM(tl.quantity) / MAX(b.outq) AS qty_per_kit,
       MAX(b.tranid) AS build_no,
       TO_CHAR(MAX(b.trandate), 'YYYY-MM-DD') AS build_date
FROM lastb l
JOIN b ON b.tid = l.tid
JOIN transactionline tl ON tl.transaction = b.tid AND tl.mainline = 'F'
JOIN item c ON c.id = tl.item
JOIN item k ON k.id = b.kit_id
WHERE c.custitem_dr_dosageform IS NOT NULL
GROUP BY k.custitem_dr_itemname1, c.custitem_dr_itemname1, c.custitem_dr_itemname2
ORDER BY k.custitem_dr_itemname1, c.custitem_dr_itemname1
