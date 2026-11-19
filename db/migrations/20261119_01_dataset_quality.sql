-- Part W1: the stored data quality result of a dataset (GET /datasets/:id/quality).
-- Computed by the server on the first request and kept here; the server sets it back to null when the dataset is
-- reparsed or a column's meaning or PII flag changes. Keyed by the dataset row, so a cleaned copy (a new dataset in a
-- later part) gets its own. Reads go through the existing datasets_select policy; writes through the service role.

alter table datasets add column quality jsonb;
