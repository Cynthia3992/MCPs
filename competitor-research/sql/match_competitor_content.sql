-- Run this in Supabase SQL Editor to update the match_competitor_content RPC
-- Adds platform filter support alongside existing creator filter

CREATE OR REPLACE FUNCTION match_competitor_content(
  query_embedding vector(1536),
  match_threshold float,
  match_count int,
  filter jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  content text,
  metadata jsonb,
  similarity float,
  created_at timestamptz,
  creator text,
  platform text,
  source_type text,
  chunk_type text,
  topic text,
  pth_angle text,
  article_title text
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    competitor_content.content,
    competitor_content.metadata,
    1 - (competitor_content.embedding <=> query_embedding) AS similarity,
    competitor_content.created_at,
    competitor_content.creator,
    competitor_content.platform,
    competitor_content.source_type,
    competitor_content.chunk_type,
    competitor_content.topic,
    competitor_content.pth_angle,
    competitor_content.article_title
  FROM competitor_content
  WHERE 1 - (competitor_content.embedding <=> query_embedding) > match_threshold
    AND competitor_content.archived = false
    AND (
      filter = '{}'::jsonb
      OR (
        (filter->>'creator' IS NULL OR
          competitor_content.creator ILIKE '%' || (filter->>'creator') || '%' OR
          competitor_content.metadata->>'creator' ILIKE '%' || (filter->>'creator') || '%')
        AND
        (filter->>'platform' IS NULL OR
          competitor_content.platform ILIKE '%' || (filter->>'platform') || '%')
      )
    )
  ORDER BY competitor_content.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;
