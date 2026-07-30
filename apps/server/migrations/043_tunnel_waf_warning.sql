-- A route's WAF rule can fail to apply (e.g. the zone's custom firewall
-- ruleset is already at Cloudflare's rule-count limit) without that being
-- fatal to onboarding: the tunnel/DNS/ingress still provision fine, just
-- without that route's WAF protection. This column surfaces that as a
-- non-blocking warning instead of failing the whole tunnel.
ALTER TABLE tunnels ADD COLUMN waf_warning text;
