import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { STORE_BUILT_IN_VARIABLES, type ArgumentBindings, type ExecutionVariables, type ScriptArgument } from "../types";
import { FieldHelp } from "./FieldHelp";

// Mirrors the server's expansion rule (apps/server/src/lib/execution-variables.ts)
// so the operator sees the value a store will actually receive. The server stays
// the authority: this only previews it. A fresh RegExp per call keeps lastIndex
// from leaking between rows.
const variableReference = () => /\$(?:\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

function expandPreview(value: string, variables: ExecutionVariables): string {
  if (!value.includes("$")) return value;
  return value.replace(variableReference(), (match, braced?: string, bare?: string) => {
    if (match === "$$") return "$";
    const name = (braced ?? bare ?? "").toUpperCase();
    return name in variables ? variables[name] ?? "" : match;
  });
}

function referencedVariableNames(value: string): string[] {
  return [...value.matchAll(variableReference())]
    .filter((match) => match[0] !== "$$")
    .map((match) => (match[1] ?? match[2] ?? "").toUpperCase());
}

export function nextVariableName(variables: ExecutionVariables): string {
  let index = Object.keys(variables).length + 1;
  while (`VARIABLE_${index}` in variables) index += 1;
  return `VARIABLE_${index}`;
}

export function AddVariableButton({ variables, onChange, small = false }: { variables: ExecutionVariables; onChange: (variables: ExecutionVariables) => void; small?: boolean }) {
  return <button className={`button button-secondary${small ? " button-small" : ""}`} type="button" onClick={() => onChange({ ...variables, [nextVariableName(variables)]: "" })}><Plus size={14} />Variable</button>;
}

// A saved variable (one already present in savedVariables, the persisted
// value this editor was opened with) starts collapsed to a read-only label
// with an Edit button, so a long list of already-configured values reads
// cleanly. A variable added this session (not yet saved) has no persisted
// identity to collapse to, so it's always shown as an editable row.
export function ExecutionVariablesEditor({
  variables,
  savedVariables,
  onChange,
  builtIns = []
}: {
  variables: ExecutionVariables;
  savedVariables: ExecutionVariables;
  onChange: (variables: ExecutionVariables) => void;
  builtIns?: string[];
}) {
  const [editingNames, setEditingNames] = useState<Set<string>>(new Set());
  // The value a row held when it was opened, so cancelling can put it back.
  // Keyed by the row's current name, which moves when the row is renamed.
  const [snapshots, setSnapshots] = useState<Map<string, { name: string; value: string }>>(new Map());
  const entries = Object.entries(variables);
  const rename = (oldName: string, nextName: string) => {
    const normalized = nextName.toUpperCase();
    onChange(Object.fromEntries(entries.map(([name, value]) => [name === oldName ? normalized : name, value])));
    setEditingNames((current) => {
      if (!current.has(oldName)) return current;
      const next = new Set(current);
      next.delete(oldName);
      next.add(normalized);
      return next;
    });
    setSnapshots((current) => {
      const snapshot = current.get(oldName);
      if (!snapshot) return current;
      const next = new Map(current);
      next.delete(oldName);
      next.set(normalized, snapshot);
      return next;
    });
  };
  const startEditing = (name: string) => {
    setEditingNames((current) => new Set(current).add(name));
    setSnapshots((current) => new Map(current).set(name, { name, value: variables[name] ?? "" }));
  };
  // Cancel restores the opened value, including a name that was edited. A row
  // that was never saved has nothing to restore to, so cancelling drops it.
  const cancelEditing = (name: string) => {
    const snapshot = snapshots.get(name);
    if (snapshot) {
      onChange(Object.fromEntries(entries.map(([entryName, value]) => entryName === name ? [snapshot.name, snapshot.value] : [entryName, value])));
    } else {
      onChange(Object.fromEntries(entries.filter(([entryName]) => entryName !== name)));
    }
    setEditingNames((current) => {
      const next = new Set(current);
      next.delete(name);
      if (snapshot) next.delete(snapshot.name);
      return next;
    });
    setSnapshots((current) => {
      if (!current.has(name)) return current;
      const next = new Map(current);
      next.delete(name);
      return next;
    });
  };
  const remove = (name: string) => {
    onChange(Object.fromEntries(entries.filter(([entryName]) => entryName !== name)));
    setEditingNames((current) => {
      if (!current.has(name)) return current;
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setSnapshots((current) => {
      if (!current.has(name)) return current;
      const next = new Map(current);
      next.delete(name);
      return next;
    });
  };
  const stopEditing = (name: string) => {
    setEditingNames((current) => {
      if (!current.has(name)) return current;
      const next = new Set(current);
      next.delete(name);
      return next;
    });
    setSnapshots((current) => {
      if (!current.has(name)) return current;
      const next = new Map(current);
      next.delete(name);
      return next;
    });
  };
  if (!entries.length) return <div className="quiet-empty">No variables configured at this scope.</div>;
  return <div className="execution-variable-editor">
    <div className="execution-variable-row execution-variable-row-header" aria-hidden="true"><span>Name</span><span>Value</span><span /></div>
    <div className="execution-variable-list">{entries.map(([name, value], index) => {
      const isBuiltIn = builtIns.includes(name);
      const isSaved = name in savedVariables;
      const isEditing = editingNames.has(name) || !isSaved;
      if (!isEditing) return <div className="execution-variable-row execution-variable-row-display" key={index}>
        <code className="execution-variable-name-label">{name}</code>
        <span className="execution-variable-value-label">{value || "—"}</span>
        <div className="execution-variable-row-actions">
          <button className="icon-button" type="button" title={`Edit ${name}`} aria-label={`Edit ${name}`} onClick={() => startEditing(name)}><Pencil size={14} /></button>
        </div>
      </div>;
      return <div className="execution-variable-row" key={index} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancelEditing(name); } }}>
        <input className="mono-input" value={name} disabled={isBuiltIn} onChange={(event) => rename(name, event.target.value)} aria-label={`Variable name ${name}`} />
        <input value={value} onChange={(event) => onChange({ ...variables, [name]: event.target.value })} aria-label={`Value for ${name}`} />
        <div className="execution-variable-row-actions">
          {isSaved && <button className="icon-button" type="button" title={`Done editing ${name}`} aria-label={`Done editing ${name}`} onClick={() => stopEditing(name)}><Check size={14} /></button>}
          <button className="icon-button" type="button" title={`Cancel editing ${name} (Esc)`} aria-label={`Cancel editing ${name}`} onClick={() => cancelEditing(name)}><X size={14} /></button>
          <button className="icon-button account-delete" type="button" title={`Remove ${name}`} aria-label={`Remove ${name}`} disabled={isBuiltIn} onClick={() => remove(name)}><Trash2 size={15} /></button>
        </div>
      </div>;
    })}</div>
  </div>;
}

// Declared arguments are shown read-only until the operator opens a row with the
// pencil, matching how variables are edited. Removing an argument is only
// reachable from that opened row, so a definition the current version's runs
// depend on cannot be dropped with a single stray click.
export function ScriptArgumentsEditor({ argumentsList, onChange }: { argumentsList: ScriptArgument[]; onChange: (argumentsList: ScriptArgument[]) => void }) {
  const [editingIndexes, setEditingIndexes] = useState<Set<number>>(new Set());
  // The definition a row held when it was opened. A row added this session has
  // no earlier state, so it is snapshotted as null and cancelling drops it.
  const [snapshots, setSnapshots] = useState<Map<number, ScriptArgument | null>>(new Map());
  const startEditing = (index: number, snapshot: ScriptArgument | null) => {
    setEditingIndexes((current) => new Set(current).add(index));
    setSnapshots((current) => new Map(current).set(index, snapshot));
  };
  const closeRow = (index: number) => {
    setEditingIndexes((current) => {
      if (!current.has(index)) return current;
      const next = new Set(current);
      next.delete(index);
      return next;
    });
    setSnapshots((current) => {
      if (!current.has(index)) return current;
      const next = new Map(current);
      next.delete(index);
      return next;
    });
  };
  const update = (index: number, patch: Partial<ScriptArgument>) =>
    onChange(argumentsList.map((item, itemIndex) => itemIndex === index ? { ...item, ...patch } : item));
  const add = () => {
    onChange([...argumentsList, { name: `ARGUMENT_${argumentsList.length + 1}`, defaultValue: "", description: "", required: false }]);
    startEditing(argumentsList.length, null);
  };
  // Rows after a removed one shift down, so the open-row set and the snapshots
  // shift with them.
  const shiftAfterRemoval = (index: number) => {
    setEditingIndexes((current) => new Set(
      [...current].filter((entry) => entry !== index).map((entry) => entry > index ? entry - 1 : entry)
    ));
    setSnapshots((current) => new Map(
      [...current].filter(([entry]) => entry !== index).map(([entry, snapshot]) => [entry > index ? entry - 1 : entry, snapshot])
    ));
  };
  const remove = (index: number) => {
    onChange(argumentsList.filter((_, itemIndex) => itemIndex !== index));
    shiftAfterRemoval(index);
  };
  const cancelEditing = (index: number) => {
    const snapshot = snapshots.get(index);
    if (snapshot) {
      onChange(argumentsList.map((item, itemIndex) => itemIndex === index ? snapshot : item));
      closeRow(index);
      return;
    }
    onChange(argumentsList.filter((_, itemIndex) => itemIndex !== index));
    shiftAfterRemoval(index);
  };
  return <section className="script-arguments-editor">
    <header><div><h3>Script arguments</h3><span>Defined per version: saving a change to this list creates a new script version. The default value is used unless an operator maps the argument to a resolved variable or a custom value when preparing a run. Avoid naming an argument after a built-in ({STORE_BUILT_IN_VARIABLES.join(", ")}) - the argument replaces it inside the script. <FieldHelp text="The server injects the store identity built-ins into every execution. If a script declares an argument under one of those names, that argument's mapped value wins and the script no longer sees the store identity value under that name. Pick a different argument name when the script needs both." /></span></div><button className="button button-secondary button-small" type="button" onClick={add}><Plus size={14} />Argument</button></header>
    {argumentsList.length ? <div className="script-argument-list">{argumentsList.map((argument, index) => {
      const shadowsBuiltIn = STORE_BUILT_IN_VARIABLES.includes(argument.name.toUpperCase());
      if (!editingIndexes.has(index)) return <div className="script-argument-row script-argument-row-display" key={index}>
        <code className="script-argument-name-label">{argument.name}{shadowsBuiltIn && <span className="script-argument-shadow-flag" title={`${argument.name} is a built-in store identity variable. This argument replaces it inside the script.`}>shadows built-in</span>}</code>
        <span className="script-argument-value-label">{argument.defaultValue || "—"}</span>
        <span className="script-argument-value-label script-argument-description">{argument.description || "—"}</span>
        <span className="script-argument-required-label">{argument.required ? "Required" : ""}</span>
        <button className="icon-button" type="button" title={`Edit ${argument.name}`} aria-label={`Edit ${argument.name}`} onClick={() => startEditing(index, argument)}><Pencil size={14} /></button>
      </div>;
      return <div className="script-argument-row" key={index} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); cancelEditing(index); } }}>
        <label className="field"><span className="field-label">Name{shadowsBuiltIn && <span className="script-argument-shadow-flag">shadows built-in</span>}</span><input className={`mono-input${shadowsBuiltIn ? " input-warning" : ""}`} value={argument.name} onChange={(event) => update(index, { name: event.target.value.toUpperCase() })} /></label>
        <label className="field"><span className="field-label">Default value</span><input value={argument.defaultValue} onChange={(event) => update(index, { defaultValue: event.target.value })} /></label>
        <label className="field script-argument-description"><span className="field-label">Description</span><input value={argument.description} placeholder="Optional operator context" onChange={(event) => update(index, { description: event.target.value })} /></label>
        <div className="field script-argument-required-field"><span className="field-label" aria-hidden="true">&nbsp;</span><label className="script-argument-required"><input type="checkbox" checked={argument.required} onChange={(event) => update(index, { required: event.target.checked })} />Required</label></div>
        <div className="field script-argument-delete-field"><span className="field-label" aria-hidden="true">&nbsp;</span><div className="script-argument-row-actions">
          <button className="icon-button" type="button" title={`Done editing ${argument.name}`} aria-label={`Done editing ${argument.name}`} onClick={() => closeRow(index)}><Check size={14} /></button>
          <button className="icon-button" type="button" title={`Cancel editing ${argument.name} (Esc)`} aria-label={`Cancel editing ${argument.name}`} onClick={() => cancelEditing(index)}><X size={14} /></button>
          <button className="icon-button account-delete" type="button" title={`Remove ${argument.name}`} aria-label={`Remove ${argument.name}`} onClick={() => remove(index)}><Trash2 size={15} /></button>
        </div></div>
      </div>;
    })}</div> : <div className="quiet-empty">This script has no declared arguments.</div>}
  </section>;
}

// Lets an operator decide, per declared argument, how it gets its value for
// one run: a literal custom value, or a mapping to one of the store's
// resolved environment variables. Script arguments and environment variables
// are otherwise independent - this mapping only exists here, for this run.
export function ArgumentBindingsEditor({
  argumentsList,
  bindings,
  onChange,
  availableVariables,
  sources,
  variesPerStoreNames = []
}: {
  argumentsList: ScriptArgument[];
  bindings: ArgumentBindings;
  onChange: (bindings: ArgumentBindings) => void;
  availableVariables: ExecutionVariables;
  sources?: Record<string, string>;
  variesPerStoreNames?: string[];
}) {
  const variableNames = Object.keys(availableVariables).sort();
  if (!argumentsList.length) return <div className="quiet-empty">This script has no declared arguments.</div>;
  return <section className="argument-bindings-editor">
    <header>
      <h3>Script arguments</h3>
      <span>
        Fill each argument with a custom value, or map it to one of the store's resolved environment variables.
        A custom value may embed variables as <code>$NAME</code> or <code>{"${NAME}"}</code> - for example <code>hello from $STORE_NAME</code>.
        {" "}<FieldHelp text="Variables are resolved per store at execution time, so one bulk run gives each store its own value. Variables may reference other variables; a reference cycle is rejected and the run fails instead of executing. An unknown name is left as literal text rather than becoming empty. Write $$ for a literal dollar sign. Values are always passed as inert text: a value can never turn into executable script." />
      </span>
    </header>
    <div className="argument-binding-list">{argumentsList.map((argument) => {
      const binding = bindings[argument.name] ?? { type: "custom" as const, value: argument.defaultValue };
      const variesPerStore = binding.type === "variable"
        ? variesPerStoreNames.includes(binding.variable)
        : referencedVariableNames(binding.value).some((name) => variesPerStoreNames.includes(name));
      const effectiveValue = binding.type === "variable"
        ? availableVariables[binding.variable] ?? ""
        : expandPreview(binding.value, availableVariables);
      return <div className="argument-binding-row" key={argument.name}>
        <span className="field-label argument-binding-label">{argument.name}{argument.required && <small> · required</small>}</span>
        <div className="argument-binding-type" role="radiogroup" aria-label={`Value source for ${argument.name}`}>
          <label><input type="radio" name={`argument-binding-type-${argument.name}`} checked={binding.type === "custom"} onChange={() => onChange({ ...bindings, [argument.name]: { type: "custom", value: argument.defaultValue } })} />Custom</label>
          <label><input type="radio" name={`argument-binding-type-${argument.name}`} checked={binding.type === "variable"} disabled={!variableNames.length} onChange={() => onChange({ ...bindings, [argument.name]: { type: "variable", variable: variableNames[0] ?? "" } })} />Variable</label>
        </div>
        {binding.type === "variable"
          ? <select value={binding.variable} onChange={(event) => onChange({ ...bindings, [argument.name]: { type: "variable", variable: event.target.value } })} aria-label={`Variable for ${argument.name}`}>
              {variableNames.map((name) => <option key={name} value={name}>{name}{sources?.[name] ? ` · ${sources[name]}` : ""}</option>)}
            </select>
          : <input value={binding.value} placeholder={argument.description || undefined} onChange={(event) => onChange({ ...bindings, [argument.name]: { type: "custom", value: event.target.value } })} aria-label={`Custom value for ${argument.name}`} />}
        {variesPerStore
          ? <span className="argument-binding-preview argument-binding-preview-hint">Resolved per store</span>
          : <code className="argument-binding-preview mono" title="Effective value at execution time">{effectiveValue || "—"}</code>}
      </div>;
    })}</div>
  </section>;
}
