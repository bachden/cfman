import type { PoolClient } from "pg";
import { pool, withTransaction } from "../database.js";

export type RuleScriptVersion = {
  id: string;
  version: number;
  scriptSource: string;
};

export type SaveRuleScriptResult = {
  versionId: string;
  version: number;
  // False when the script is byte-for-byte what the latest version already
  // holds: saving a renamed or rescheduled rule should not spend a version
  // number on an unchanged script.
  created: boolean;
};

export async function latestRuleVersion(ruleId: string): Promise<RuleScriptVersion | null> {
  const result = await pool.query(
    `SELECT id, version, script_source AS "scriptSource"
       FROM automation_rule_versions
      WHERE rule_id = $1
      ORDER BY version DESC
      LIMIT 1`,
    [ruleId]
  );
  return (result.rows[0] as RuleScriptVersion | undefined) ?? null;
}

export async function insertRuleVersion(
  client: PoolClient,
  input: { ruleId: string; scriptSource: string; createdBy: string | null }
): Promise<{ versionId: string; version: number }> {
  const next = await client.query(
    "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM automation_rule_versions WHERE rule_id = $1",
    [input.ruleId]
  );
  const inserted = await client.query(
    `INSERT INTO automation_rule_versions(rule_id, version, script_source, created_by)
     VALUES ($1, $2, $3, $4)
     RETURNING id, version`,
    [input.ruleId, next.rows[0].version, input.scriptSource, input.createdBy]
  );
  return { versionId: inserted.rows[0].id as string, version: inserted.rows[0].version as number };
}

// Saving an edited script is what creates a version: the rule row is locked
// first so two saves landing together cannot claim the same version number.
export async function saveRuleScript(input: {
  ruleId: string;
  scriptSource: string;
  createdBy: string | null;
}): Promise<SaveRuleScriptResult> {
  return withTransaction(async (client) => {
    await client.query("SELECT id FROM automation_rules WHERE id = $1 FOR UPDATE", [input.ruleId]);
    const current = await client.query(
      `SELECT id, version, script_source AS "scriptSource"
         FROM automation_rule_versions
        WHERE rule_id = $1
        ORDER BY version DESC
        LIMIT 1`,
      [input.ruleId]
    );
    const latest = current.rows[0] as RuleScriptVersion | undefined;
    if (latest && latest.scriptSource === input.scriptSource) {
      return { versionId: latest.id, version: latest.version, created: false };
    }
    const inserted = await insertRuleVersion(client, input);
    return { ...inserted, created: true };
  });
}
