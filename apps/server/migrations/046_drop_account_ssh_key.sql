-- CFMan no longer manages an account-wide SSH keypair or injects it into
-- enrolled Linux machines' authorized_keys. The raw ssh:// route
-- (cloudflared access ssh + a real ssh client) authenticates with whatever
-- key or password the target machine already trusts - that's a property of
-- the machine, not something CFMan needs to own or distribute.
ALTER TABLE cloudflare_accounts
  DROP COLUMN ssh_public_key,
  DROP COLUMN ssh_private_key_encrypted;
