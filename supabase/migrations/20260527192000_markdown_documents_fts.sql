-- Add a stored tsvector column with title weighted higher (A) than content (B).
-- This lets the GIN index be used directly without recomputing the expression per row,
-- and allows ts_rank to reflect title vs body relevance.
ALTER TABLE public.markdown_documents
  ADD COLUMN search_vector tsvector
    GENERATED ALWAYS AS (
      setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
      setweight(to_tsvector('english', coalesce(content, '')), 'B')
    ) STORED;

-- GIN index on the stored column (replaces the old expression-based index).
CREATE INDEX idx_markdown_documents_search_vector
  ON public.markdown_documents USING GIN (search_vector);

-- Drop the old expression-based GIN index.
DROP INDEX IF EXISTS idx_markdown_documents_search;

-- Full-text search function using websearch_to_tsquery so callers get natural
-- query syntax: multi-word AND, quoted phrases, minus exclusions, prefix*.
-- Results are ranked by relevance (ts_rank) then recency.
-- Returns nothing if the query reduces to only stopwords (tsq IS NULL).
CREATE OR REPLACE FUNCTION search_markdown_notes(uid uuid, q text)
RETURNS TABLE(title text, content text, updated_at timestamptz)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  tsq tsquery;
BEGIN
  tsq := websearch_to_tsquery('english', q);
  IF tsq IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
    SELECT md.title, md.content, md.updated_at
    FROM public.markdown_documents md
    WHERE md.user_id = uid
      AND md.search_vector @@ tsq
    ORDER BY ts_rank(md.search_vector, tsq) DESC, md.updated_at DESC
    LIMIT 10;
END;
$$;
