PRAGMA foreign_keys = ON;

INSERT INTO inventory_balances(
 company_id,stock_book_id,item_id,quantity_milliunits,ledger_value_paise,version,updated_at
)
SELECT company_id,stock_book_id,item_id,
 SUM(quantity_in_milliunits-quantity_out_milliunits),
 SUM(CASE movement_type WHEN 'IN' THEN value_paise ELSE -value_paise END),
 1,CURRENT_TIMESTAMP
FROM stock_ledger_entries
WHERE 1=1
GROUP BY company_id,stock_book_id,item_id
ON CONFLICT(company_id,stock_book_id,item_id) DO UPDATE SET
 quantity_milliunits=excluded.quantity_milliunits,
 ledger_value_paise=excluded.ledger_value_paise,
 version=inventory_balances.version+1,
 updated_at=excluded.updated_at;

DELETE FROM inventory_balances
WHERE NOT EXISTS (
 SELECT 1 FROM stock_ledger_entries l
 WHERE l.company_id=inventory_balances.company_id
   AND l.stock_book_id=inventory_balances.stock_book_id
   AND l.item_id=inventory_balances.item_id
);
