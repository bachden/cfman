-- Mirrors tunnel_command_executions.requested_via at the bulk-run level, so
-- the aggregated bulk run row (shown with a "bulk" tag) can also carry an
-- "AI" tag when the whole run was requested through the MCP server.
ALTER TABLE script_bulk_executions
  ADD COLUMN requested_via text NOT NULL DEFAULT 'web' CHECK (requested_via IN ('web', 'mcp'));
