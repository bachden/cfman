-- A prompt is a message that asks for an answer: a script sends it with a set
-- of buttons and waits, a person in the chat presses one, and the press comes
-- back as the script's return value. The row outlives the waiting script, so
-- what was asked, who answered, and whether it timed out stay readable after
-- the run has finished.
CREATE TABLE notification_prompts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  automation_run_id uuid REFERENCES automation_runs(id) ON DELETE SET NULL,
  body text NOT NULL,
  -- [{ "label": "Approve", "value": "approve" }, ...] in the order they were
  -- shown, which is also the order the buttons appear in the chat.
  buttons jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(buttons) = 'array'),
  status text NOT NULL CHECK (status IN ('pending', 'answered', 'timed_out', 'failed')),
  answer_value text,
  answer_label text,
  -- Whoever pressed the button, as the chat platform names them; a chat is not
  -- a CFMan account, so this is a label, never a user id.
  answered_by text,
  answered_at timestamptz,
  error text,
  provider_message_id text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  requested_via text NOT NULL DEFAULT 'automation' CHECK (requested_via IN ('web', 'mcp', 'automation')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX notification_prompts_channel_idx ON notification_prompts(channel_id, created_at DESC);
CREATE INDEX notification_prompts_run_idx ON notification_prompts(automation_run_id);
-- The poller only runs while something is waiting, and this is how it asks.
CREATE INDEX notification_prompts_pending_idx ON notification_prompts(expires_at) WHERE status = 'pending';
