import { Check, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { ArgumentBindings, ExecutionVariables, ScriptArgument } from "../types";

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
  };
  const remove = (name: string) => {
    onChange(Object.fromEntries(entries.filter(([entryName]) => entryName !== name)));
    setEditingNames((current) => {
      if (!current.has(name)) return current;
      const next = new Set(current);
      next.delete(name);
      return next;
    });
  };
  const stopEditing = (name: string) => setEditingNames((current) => {
    if (!current.has(name)) return current;
    const next = new Set(current);
    next.delete(name);
    return next;
  });
  if (!entries.length) return <div className="quiet-empty">No variables configured at this scope.</div>;
  return <div className="execution-variable-editor">
    <div className="execution-variable-row execution-variable-row-header" aria-hidden="true"><span>Name</span><span>Value</span><span /></div>
    <div className="execution-variable-list">{entries.map(([name, value]) => {
      const isBuiltIn = builtIns.includes(name);
      const isSaved = name in savedVariables;
      const isEditing = editingNames.has(name) || !isSaved;
      if (!isEditing) return <div className="execution-variable-row execution-variable-row-display" key={name}>
        <code className="execution-variable-name-label">{name}</code>
        <span className="execution-variable-value-label">{value || "—"}</span>
        <div className="execution-variable-row-actions">
          <button className="icon-button" type="button" title={`Edit ${name}`} aria-label={`Edit ${name}`} onClick={() => setEditingNames((current) => new Set(current).add(name))}><Pencil size={14} /></button>
        </div>
      </div>;
      return <div className="execution-variable-row" key={name}>
        <input className="mono-input" value={name} disabled={isBuiltIn} onChange={(event) => rename(name, event.target.value)} aria-label={`Variable name ${name}`} />
        <input value={value} onChange={(event) => onChange({ ...variables, [name]: event.target.value })} aria-label={`Value for ${name}`} />
        <div className="execution-variable-row-actions">
          {isSaved && <button className="icon-button" type="button" title={`Done editing ${name}`} aria-label={`Done editing ${name}`} onClick={() => stopEditing(name)}><Check size={14} /></button>}
          <button className="icon-button account-delete" type="button" title={`Remove ${name}`} aria-label={`Remove ${name}`} disabled={isBuiltIn} onClick={() => remove(name)}><Trash2 size={15} /></button>
        </div>
      </div>;
    })}</div>
  </div>;
}

export function ScriptArgumentsEditor({ argumentsList, onChange }: { argumentsList: ScriptArgument[]; onChange: (argumentsList: ScriptArgument[]) => void }) {
  return <section className="script-arguments-editor">
    <header><div><h3>Script arguments</h3><span>The default value is used unless an operator maps this argument to a resolved variable or a custom value when preparing a run.</span></div><button className="button button-secondary button-small" type="button" onClick={() => onChange([...argumentsList, { name: `ARGUMENT_${argumentsList.length + 1}`, defaultValue: "", description: "", required: false }])}><Plus size={14} />Argument</button></header>
    {argumentsList.length ? <div className="script-argument-list">{argumentsList.map((argument, index) => <div className="script-argument-row" key={`${index}-${argument.name}`}>
      <label className="field"><span className="field-label">Name</span><input className="mono-input" value={argument.name} onChange={(event) => onChange(argumentsList.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value.toUpperCase() } : item))} /></label>
      <label className="field"><span className="field-label">Default value</span><input value={argument.defaultValue} onChange={(event) => onChange(argumentsList.map((item, itemIndex) => itemIndex === index ? { ...item, defaultValue: event.target.value } : item))} /></label>
      <label className="field script-argument-description"><span className="field-label">Description</span><input value={argument.description} placeholder="Optional operator context" onChange={(event) => onChange(argumentsList.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} /></label>
      <div className="field script-argument-required-field"><span className="field-label" aria-hidden="true">&nbsp;</span><label className="script-argument-required"><input type="checkbox" checked={argument.required} onChange={(event) => onChange(argumentsList.map((item, itemIndex) => itemIndex === index ? { ...item, required: event.target.checked } : item))} />Required</label></div>
      <button className="icon-button account-delete" type="button" title={`Remove ${argument.name}`} aria-label={`Remove ${argument.name}`} onClick={() => onChange(argumentsList.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button>
    </div>)}</div> : <div className="quiet-empty">This script has no declared arguments.</div>}
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
    <header><h3>Script arguments</h3><span>Fill each argument with a custom value, or map it to one of the store's resolved environment variables.</span></header>
    <div className="argument-binding-list">{argumentsList.map((argument) => {
      const binding = bindings[argument.name] ?? { type: "custom" as const, value: argument.defaultValue };
      const variesPerStore = binding.type === "variable" && variesPerStoreNames.includes(binding.variable);
      const effectiveValue = binding.type === "variable" ? availableVariables[binding.variable] ?? "" : binding.value;
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
          : <code className="argument-binding-preview" title="Effective value at execution time">{effectiveValue || "—"}</code>}
      </div>;
    })}</div>
  </section>;
}
