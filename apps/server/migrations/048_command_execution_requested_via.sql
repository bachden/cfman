-- Distinguishes executions requested through the MCP server (an AI agent
-- acting on the operator's behalf) from ordinary web UI/API requests, so
-- execution history can show an "AI" tag the same way it shows "inline".
ALTER TABLE tunnel_command_executions
  ADD COLUMN requested_via text NOT NULL DEFAULT 'web' CHECK (requested_via IN ('web', 'mcp'));
