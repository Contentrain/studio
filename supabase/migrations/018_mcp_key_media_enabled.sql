-- MCP Cloud key media opt-in.
--
-- @contentrain/mcp 1.10.0 adds five media tools. On the API-key surface an
-- empty `allowed_tools` means "unrestricted", so without this flag every
-- existing key would silently gain URL ingest + destructive delete the day
-- the media facet ships. The proxy denies media tools unless a key either
-- lists them explicitly or carries this opt-in.
--
-- Existing keys default to false = media denied. Shared lineage (the table
-- lives on both provider pairs); mirrors the 010_cdn_key_scopes.sql pattern
-- of a default-safe additive column.

ALTER TABLE public.mcp_cloud_keys
  ADD COLUMN media_enabled boolean NOT NULL DEFAULT false;
