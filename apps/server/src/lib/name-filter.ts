import { z } from "zod";

export const nameMatchSchema = z.enum(["exact", "ilike", "regex"]);

export const nameFilterFields = {
  name: z.string().trim().min(1).max(160).optional(),
  nameMatch: nameMatchSchema.default("ilike")
};

export type NameFilter = {
  name?: string | undefined;
  nameMatch: z.infer<typeof nameMatchSchema>;
};

export function validateNameFilter(filter: NameFilter, context: z.RefinementCtx): void {
  if (!filter.name || filter.nameMatch !== "regex") return;
  try {
    new RegExp(filter.name, "i");
  } catch {
    context.addIssue({ code: "custom", path: ["name"], message: "Name is not a valid regular expression" });
  }
}

export function appendNameFilter(
  conditions: string[],
  values: unknown[],
  column: string | string[],
  filter: NameFilter
): void {
  if (!filter.name) return;
  const value = filter.nameMatch === "ilike" ? `%${filter.name}%` : filter.name;
  values.push(value);
  const parameter = `$${values.length}`;
  const columns = Array.isArray(column) ? column : [column];
  const clause = columns
    .map((col) => filter.nameMatch === "exact" ? `lower(${col}) = lower(${parameter})` : filter.nameMatch === "regex" ? `${col} ~* ${parameter}` : `${col} ILIKE ${parameter}`)
    .join(" OR ");
  conditions.push(columns.length > 1 ? `(${clause})` : clause);
}
