PRAGMA foreign_keys = ON;

ALTER TABLE audit_logs ADD COLUMN company_id INTEGER REFERENCES companies(id);

UPDATE audit_logs
SET company_id=CASE entity_type
  WHEN 'Purchase' THEN (SELECT company_id FROM purchases WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'Sale' THEN (SELECT company_id FROM sales WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'Payment' THEN (SELECT company_id FROM payments WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'OpeningAdvance' THEN (SELECT company_id FROM payments WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'OpeningStock' THEN (SELECT company_id FROM opening_stocks WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'OpeningReceivable' THEN (SELECT company_id FROM receivables WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'OpeningPayable' THEN (SELECT company_id FROM payables WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'InterCompanyTransfer' THEN (SELECT from_company_id FROM inter_company_transfers WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'OpeningPendingStock' THEN (SELECT from_company_id FROM inter_company_transfers WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'Stock Book' THEN (SELECT company_id FROM stock_books WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  WHEN 'User' THEN (SELECT company_id FROM users WHERE id=CAST(audit_logs.entity_id AS INTEGER))
  ELSE (SELECT company_id FROM users WHERE id=audit_logs.user_id)
END;

-- Deleted rows can no longer be joined to their source tables, but the legacy
-- delete audit payload retains the company. Recover that scope first, then
-- propagate it to earlier create/edit audit entries for the same entity.
UPDATE audit_logs
SET company_id=CAST(COALESCE(
  json_extract(before_values,'$.company_id'),
  json_extract(after_values,'$.company_id')
) AS INTEGER)
WHERE company_id IS NULL
  AND COALESCE(
    json_extract(before_values,'$.company_id'),
    json_extract(after_values,'$.company_id')
  ) IS NOT NULL;

UPDATE audit_logs
SET company_id=(
  SELECT scoped.company_id
  FROM audit_logs scoped
  WHERE scoped.entity_type=audit_logs.entity_type
    AND scoped.entity_id=audit_logs.entity_id
    AND scoped.company_id IS NOT NULL
  ORDER BY scoped.id DESC
  LIMIT 1
)
WHERE company_id IS NULL
  AND entity_id IS NOT NULL;

CREATE INDEX idx_audit_logs_company_created ON audit_logs(company_id,created_at DESC,id DESC);
