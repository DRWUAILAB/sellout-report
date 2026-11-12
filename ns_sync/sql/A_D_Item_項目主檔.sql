-- =====================================================================
-- A. D_Item 項目主檔（Sell-out 報表的品項維度）
-- ---------------------------------------------------------------------
-- 用途：品號 → 品名、產品代碼、前三碼／前六碼、系列、劑型、存貨型態、品牌、售價
-- 串接：sell-out 明細「DRWU品號」＝ custitem_dr_itemname1（DR_料號），不用另做品號對照
-- 售價：Base Price（pricelevel 1）× 1.05 四捨五入到元；currencypage = 1 只取台幣
-- 品牌：custitem_dr_brand 目前全空；過渡期用「產品代碼 X 開頭＝Redermx，其餘 DR.WU」
-- 執行：NS「SuiteQL Query Tool」（script 398）超過一頁 5,000 列，要選回傳全部列；
--       或執行 ..\匯出NS維度表\匯出NS維度表_正式區.bat 一次匯出 D_Item.csv、D_BOM.csv（2026-10-07 起約 13,000 列）
-- 實跑：2026-10-07 NS 正式區 6,894 列
-- 注意：品號 29926131 在 NS 有兩筆 item，匯入前依 item_code 去重（匯出程式會自動處理）
-- 2026-10-07：DR_料號空白的庫存／組裝項目改用項目編號（itemid）當品號，例 199991010055（贈品，DR_料號未填）。
--            code_src 標來源；同品號時匯出程式以 DR_料號 那筆優先。根本解法仍是在 NS 補 DR_料號
-- =====================================================================
SELECT COALESCE(i.custitem_dr_itemname1, i.itemid) AS item_code,   -- 品號（DR_料號，空白時用項目編號）
       CASE WHEN i.custitem_dr_itemname1 IS NULL THEN '項目編號' ELSE 'DR_料號' END AS code_src,
       i.displayname                          AS item_name,
       i.custitem_dr_itemname2                AS spec,        -- DR_產品代碼
       SUBSTR(i.custitem_dr_itemname2, 1, 3)  AS p3,
       SUBSTR(i.custitem_dr_itemname2, 1, 6)  AS p6,
       BUILTIN.DF(i.cseg2)                    AS series,      -- DR_產品系列
       BUILTIN.DF(i.custitem_dr_dosageform)   AS dosage,      -- DR_產品劑型
       BUILTIN.DF(i.custitem_dr_product_type) AS inv_type,    -- DR_存貨型態
       BUILTIN.DF(i.custitem_dr_brand)        AS brand,       -- 目前全空
       ROUND(ip.price * 1.05, 0)              AS list_price,  -- 售價（含稅）
       i.isinactive                           AS inactive
FROM item i
LEFT JOIN itemprice ip ON ip.item = i.id AND ip.pricelevel = 1
                      AND ip.currencypage = 1               -- Base Price、台幣
WHERE i.custitem_dr_itemname1 IS NOT NULL
   OR i.itemtype IN ('InvtPart', 'Assembly', 'Kit')         -- DR_料號空白的庫存／組裝／套件項目
ORDER BY i.custitem_dr_itemname1, i.id
