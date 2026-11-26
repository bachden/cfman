-- A message may now carry files out of the file store. What is recorded here
-- is which storage paths went with it - the path, the name the chat received,
-- the size, and the content type - never the bytes themselves: the file stays
-- in storage, and the log is read by anyone who can see the channel.
ALTER TABLE notification_messages
  ADD COLUMN attachments jsonb NOT NULL DEFAULT '[]'::jsonb;

-- A message with files needs no text of its own, so the body is no longer
-- required to be non-empty. It stays NOT NULL: an empty string is the honest
-- record of a caption nobody wrote.
ALTER TABLE notification_messages
  ALTER COLUMN body SET DEFAULT '';
