ALTER TABLE store_publications ADD COLUMN custom_label text;

-- A store may now have several publications that share the same (blank)
-- suffix as long as each carries a distinct custom_label - suffix alone is
-- no longer a reliable proxy for hostname identity. The store_publications
-- hostname UNIQUE constraint already guards against real collisions.
ALTER TABLE store_publications DROP CONSTRAINT store_publications_store_id_suffix_key;
