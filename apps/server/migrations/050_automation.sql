-- Communication hub + event-condition-action automation.
--
-- Both domains are addressed by a stable lowercase `key` rather than their
-- surrogate id: rules reference channels by key, so a channel can be renamed
-- for humans without rewriting every rule that sends through it.
CREATE TABLE communication_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('telegram')),
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  -- Non-secret per-type settings (chat id, parse mode, ...). Secret fields of
  -- the same config live in `secrets`, each value encrypted individually with
  -- the same AES-GCM key used for Cloudflare tokens and agent tokens.
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secrets jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_used_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE automation_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE CHECK (key ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  -- 'timer' is the only event source today; the type/config split is what lets
  -- a later source (webhook, execution finished, tunnel unhealthy) join without
  -- reshaping the table or the runner.
  event_type text NOT NULL CHECK (event_type IN ('timer')),
  event_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  script_source text NOT NULL,
  script_timeout_ms integer NOT NULL DEFAULT 30000 CHECK (script_timeout_ms BETWEEN 1000 AND 600000),
  condition_source text NOT NULL DEFAULT '',
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_run_status text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automation_rules_due_idx ON automation_rules(next_run_at) WHERE enabled;

CREATE TABLE automation_rule_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  action_type text NOT NULL CHECK (action_type IN ('send_message')),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX automation_rule_actions_rule_idx ON automation_rule_actions(rule_id, sort_order, created_at);

CREATE TABLE automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  trigger_source text NOT NULL CHECK (trigger_source IN ('timer', 'manual', 'mcp')),
  triggered_by uuid REFERENCES users(id) ON DELETE SET NULL,
  -- 'matched' means the condition was true and every enabled action ran;
  -- 'skipped' means the script succeeded but the condition was false, which is
  -- an ordinary outcome rather than a failure.
  status text NOT NULL CHECK (status IN ('running', 'matched', 'skipped', 'failed', 'timed_out')),
  failed_stage text CHECK (failed_stage IN ('script', 'condition', 'action')),
  event_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_body text NOT NULL DEFAULT '',
  output_mime_type text,
  output_truncated boolean NOT NULL DEFAULT false,
  condition_result boolean,
  action_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  logs jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  dry_run boolean NOT NULL DEFAULT false,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  elapsed_ms integer
);

CREATE INDEX automation_runs_rule_idx ON automation_runs(rule_id, started_at DESC);

CREATE TABLE communication_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES communication_channels(id) ON DELETE CASCADE,
  automation_run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL,
  body text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  error text,
  provider_message_id text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_via text NOT NULL DEFAULT 'web' CHECK (requested_via IN ('web', 'mcp', 'automation')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX communication_messages_channel_idx ON communication_messages(channel_id, created_at DESC);
CREATE INDEX communication_messages_run_idx ON communication_messages(automation_run_id);

-- A script dispatched by an automation rule is neither a web request nor an
-- MCP one, and execution history already shows that provenance as a tag.
ALTER TABLE tunnel_command_executions
  DROP CONSTRAINT IF EXISTS tunnel_command_executions_requested_via_check,
  ADD CONSTRAINT tunnel_command_executions_requested_via_check
    CHECK (requested_via IN ('web', 'mcp', 'automation'));

ALTER TABLE script_bulk_executions
  DROP CONSTRAINT IF EXISTS script_bulk_executions_requested_via_check,
  ADD CONSTRAINT script_bulk_executions_requested_via_check
    CHECK (requested_via IN ('web', 'mcp', 'automation'));
