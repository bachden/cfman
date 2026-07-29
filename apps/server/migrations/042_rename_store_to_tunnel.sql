-- Renames the "store" business entity to "tunnel" throughout the schema.
-- The pre-existing Cloudflare-tunnel-resource columns on this table
-- (tunnel_id/tunnel_name/tunnel_status) are moved to cf_tunnel_* first so
-- they don't collide with the entity's own identity once it is itself
-- called "tunnel".

ALTER TABLE stores RENAME COLUMN tunnel_id TO cf_tunnel_id;
ALTER TABLE stores RENAME COLUMN tunnel_name TO cf_tunnel_name;
ALTER TABLE stores RENAME COLUMN tunnel_status TO cf_tunnel_status;
ALTER TABLE stores RENAME CONSTRAINT stores_tunnel_status_check TO stores_cf_tunnel_status_check;
ALTER INDEX stores_tunnel_status_idx RENAME TO stores_cf_tunnel_status_idx;

ALTER TABLE enrollments RENAME COLUMN unenroll_tunnel_id TO unenroll_cf_tunnel_id;

ALTER TABLE zones RENAME COLUMN soft_store_limit TO soft_tunnel_limit;
ALTER TABLE zones RENAME CONSTRAINT zones_soft_store_limit_check TO zones_soft_tunnel_limit_check;

-- stores -> tunnels
ALTER TABLE stores RENAME COLUMN store_code TO tunnel_code;
ALTER TABLE stores RENAME TO tunnels;
ALTER TABLE tunnels RENAME CONSTRAINT stores_pkey TO tunnels_pkey;
ALTER TABLE tunnels RENAME CONSTRAINT stores_hostname_key TO tunnels_hostname_key;
ALTER TABLE tunnels RENAME CONSTRAINT stores_tenant_code_store_code_key TO tunnels_tenant_code_tunnel_code_key;
ALTER TABLE tunnels RENAME CONSTRAINT stores_execution_variables_object_check TO tunnels_execution_variables_object_check;
ALTER TABLE tunnels RENAME CONSTRAINT stores_onboarding_status_check TO tunnels_onboarding_status_check;
ALTER TABLE tunnels RENAME CONSTRAINT stores_rdp_port_check TO tunnels_rdp_port_check;
ALTER TABLE tunnels RENAME CONSTRAINT stores_rdp_status_check TO tunnels_rdp_status_check;
ALTER TABLE tunnels RENAME CONSTRAINT stores_cf_tunnel_status_check TO tunnels_cf_tunnel_status_check;
ALTER TABLE tunnels RENAME CONSTRAINT stores_account_id_fkey TO tunnels_account_id_fkey;
ALTER TABLE tunnels RENAME CONSTRAINT stores_zone_id_fkey TO tunnels_zone_id_fkey;
ALTER INDEX stores_account_id_idx RENAME TO tunnels_account_id_idx;
ALTER INDEX stores_onboarding_status_idx RENAME TO tunnels_onboarding_status_idx;
ALTER INDEX stores_rdp_status_idx RENAME TO tunnels_rdp_status_idx;
ALTER INDEX stores_cf_tunnel_status_idx RENAME TO tunnels_cf_tunnel_status_idx;
ALTER INDEX stores_zone_id_idx RENAME TO tunnels_zone_id_idx;

-- store_publications -> tunnel_publications
ALTER TABLE store_publications RENAME COLUMN store_id TO tunnel_id;
ALTER TABLE store_publications RENAME TO tunnel_publications;
ALTER TABLE tunnel_publications RENAME CONSTRAINT store_publications_pkey TO tunnel_publications_pkey;
ALTER TABLE tunnel_publications RENAME CONSTRAINT store_publications_hostname_key TO tunnel_publications_hostname_key;
ALTER TABLE tunnel_publications RENAME CONSTRAINT store_publications_status_check TO tunnel_publications_status_check;
ALTER TABLE tunnel_publications RENAME CONSTRAINT store_publications_store_id_fkey TO tunnel_publications_tunnel_id_fkey;
ALTER INDEX store_publications_store_id_idx RENAME TO tunnel_publications_tunnel_id_idx;

-- store_routes -> tunnel_routes
ALTER TABLE store_routes RENAME TO tunnel_routes;
ALTER TABLE tunnel_routes RENAME CONSTRAINT store_routes_pkey TO tunnel_routes_pkey;
ALTER TABLE tunnel_routes RENAME CONSTRAINT store_routes_publication_id_path_key TO tunnel_routes_publication_id_path_key;
ALTER TABLE tunnel_routes RENAME CONSTRAINT store_routes_route_kind_check TO tunnel_routes_route_kind_check;
ALTER TABLE tunnel_routes RENAME CONSTRAINT store_routes_publication_id_fkey TO tunnel_routes_publication_id_fkey;
ALTER INDEX store_routes_command_agent_idx RENAME TO tunnel_routes_command_agent_idx;
ALTER INDEX store_routes_publication_id_idx RENAME TO tunnel_routes_publication_id_idx;
ALTER TRIGGER store_routes_one_command_agent ON tunnel_routes RENAME TO tunnel_routes_one_command_agent;

-- store_command_agents -> tunnel_command_agents
ALTER TABLE store_command_agents RENAME COLUMN store_id TO tunnel_id;
ALTER TABLE store_command_agents RENAME TO tunnel_command_agents;
ALTER TABLE tunnel_command_agents RENAME CONSTRAINT store_command_agents_pkey TO tunnel_command_agents_pkey;
ALTER TABLE tunnel_command_agents RENAME CONSTRAINT store_command_agents_status_check TO tunnel_command_agents_status_check;
ALTER TABLE tunnel_command_agents RENAME CONSTRAINT store_command_agents_store_id_fkey TO tunnel_command_agents_tunnel_id_fkey;

-- store_command_executions -> tunnel_command_executions
ALTER TABLE store_command_executions RENAME COLUMN store_id TO tunnel_id;
ALTER TABLE store_command_executions RENAME TO tunnel_command_executions;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_pkey TO tunnel_command_executions_pkey;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_argument_sources_object_check TO tunnel_command_executions_argument_sources_object_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_environment_variables_object_check TO tunnel_command_executions_environment_variables_object_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_saved_script_pair_check TO tunnel_command_executions_saved_script_pair_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_script_language_check TO tunnel_command_executions_script_language_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_script_platform_check TO tunnel_command_executions_script_platform_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_script_type_check TO tunnel_command_executions_script_type_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_script_version_number_check TO tunnel_command_executions_script_version_number_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_status_check TO tunnel_command_executions_status_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_timeout_ms_check TO tunnel_command_executions_timeout_ms_check;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_bulk_execution_id_fkey TO tunnel_command_executions_bulk_execution_id_fkey;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_enrollment_id_fkey TO tunnel_command_executions_enrollment_id_fkey;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_requested_by_fkey TO tunnel_command_executions_requested_by_fkey;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_saved_script_id_fkey TO tunnel_command_executions_saved_script_id_fkey;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_saved_script_version_id_fkey TO tunnel_command_executions_saved_script_version_id_fkey;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_script_version_id_fkey TO tunnel_command_executions_script_version_id_fkey;
ALTER TABLE tunnel_command_executions RENAME CONSTRAINT store_command_executions_store_id_fkey TO tunnel_command_executions_tunnel_id_fkey;
ALTER INDEX store_command_executions_active_idx RENAME TO tunnel_command_executions_active_idx;
ALTER INDEX store_command_executions_bulk_idx RENAME TO tunnel_command_executions_bulk_idx;
ALTER INDEX store_command_executions_enrollment_idx RENAME TO tunnel_command_executions_enrollment_idx;
ALTER INDEX store_command_executions_report_token_idx RENAME TO tunnel_command_executions_report_token_idx;
ALTER INDEX store_command_executions_saved_script_idx RENAME TO tunnel_command_executions_saved_script_idx;
ALTER INDEX store_command_executions_store_idx RENAME TO tunnel_command_executions_tunnel_idx;

-- store_command_execution_logs -> tunnel_command_execution_logs
ALTER SEQUENCE store_command_execution_logs_id_seq RENAME TO tunnel_command_execution_logs_id_seq;
ALTER TABLE store_command_execution_logs RENAME TO tunnel_command_execution_logs;
ALTER TABLE tunnel_command_execution_logs RENAME CONSTRAINT store_command_execution_logs_pkey TO tunnel_command_execution_logs_pkey;
ALTER TABLE tunnel_command_execution_logs RENAME CONSTRAINT store_command_execution_logs_stream_check TO tunnel_command_execution_logs_stream_check;
ALTER TABLE tunnel_command_execution_logs RENAME CONSTRAINT store_command_execution_logs_execution_id_fkey TO tunnel_command_execution_logs_execution_id_fkey;
ALTER INDEX store_command_execution_logs_execution_idx RENAME TO tunnel_command_execution_logs_execution_idx;
ALTER INDEX store_command_execution_logs_sequence_idx RENAME TO tunnel_command_execution_logs_sequence_idx;

-- enrollments.store_id -> tunnel_id
ALTER TABLE enrollments RENAME COLUMN store_id TO tunnel_id;
ALTER TABLE enrollments RENAME CONSTRAINT enrollments_store_id_fkey TO enrollments_tunnel_id_fkey;
ALTER INDEX enrollments_store_id_idx RENAME TO enrollments_tunnel_id_idx;
ALTER INDEX enrollments_store_deleted_idx RENAME TO enrollments_tunnel_deleted_idx;

-- Renaming a table does not rewrite the SQL text inside a PL/pgSQL function
-- body, so this trigger function (introduced in
-- 012_one_command_agent_per_store.sql) still referenced the old
-- store_publications/store_routes/store_id names and needs to be redefined
-- against the renamed tables.
CREATE OR REPLACE FUNCTION prevent_duplicate_command_agent_route()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_tunnel_id uuid;
BEGIN
  IF NEW.route_kind <> 'command_agent' THEN
    RETURN NEW;
  END IF;

  SELECT tunnel_id
    INTO target_tunnel_id
    FROM tunnel_publications
   WHERE id = NEW.publication_id;

  IF EXISTS (
    SELECT 1
      FROM tunnel_routes existing_route
      JOIN tunnel_publications publication ON publication.id = existing_route.publication_id
     WHERE publication.tunnel_id = target_tunnel_id
       AND existing_route.route_kind = 'command_agent'
       AND existing_route.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Only one command agent route is allowed per tunnel';
  END IF;

  RETURN NEW;
END;
$$;
