import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
// The "language/typescript/monaco.contribution" entry only re-exports this
// module and ships no declarations, so the typed path is used directly.
import { javascriptDefaults, ModuleKind, ScriptTarget } from "monaco-editor/languages/features/typescript/register";
import TypeScriptWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";
// editor.api ships the editor's API and its core, but none of the widgets
// that surface what a language provider returns: without these four
// contributions the TypeScript service still answers, and nothing is ever
// shown. editor.main would bring them along with every bundled language, so
// only the ones this editor actually uses are imported.
import "monaco-editor/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/languages/definitions/powershell/register";
import "monaco-editor/languages/definitions/shell/register";
import "monaco-editor/languages/definitions/javascript/register";
import { ShieldAlert } from "lucide-react";
import { useEffect, useMemo } from "react";

const NON_ASCII_PATTERN = /[^\x00-\x7F]/;

(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: (moduleId: string, label: string) => Worker } }).MonacoEnvironment = {
  // JavaScript completions come from the TypeScript language service, which
  // runs in its own worker; every other language only needs the plain editor
  // worker, so the big one is never loaded for a PowerShell or shell script.
  getWorker: (_moduleId, label) => (label === "javascript" || label === "typescript" ? new TypeScriptWorker() : new EditorWorker())
};
loader.config({ monaco });

javascriptDefaults.setCompilerOptions({
  target: ScriptTarget.ESNext,
  module: ModuleKind.ESNext,
  allowNonTsExtensions: true,
  allowJs: true,
  // The sandbox is a worker with no DOM and no Node globals, so the editor
  // offers the language built-ins only - never fetch, window, or require.
  lib: ["esnext"]
});

javascriptDefaults.setDiagnosticsOptions({
  // What an editor holds is a function body the server wraps, not a complete
  // program, and several bodies (a rule's script and condition, or two open
  // rules) share one language service. Error reporting would therefore flag
  // valid code - a top-level return, or the same variable name used in two
  // rules - so the service is used for completions and hovers only.
  noSemanticValidation: true,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: [
    1108, // 'return' statement outside a function
    1375, // top-level await needs a module
    1378 // top-level await only allowed with certain module targets
  ]
});

const AUTOMATION_LIB_PATH = "ts:cfman-automation.d.ts";
let appliedTypeDefinitions = "";

const codeFontFamily = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

type ScriptEditorProps = {
  value: string;
  language: "powershell" | "bash" | "sh" | "javascript";
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  compactLineNumberGutter?: boolean;
  // Declarations describing the globals available to this script, loaded into
  // the JavaScript language service so `cfman.` completes to the real calls.
  typeDefinitions?: string | undefined;
};

export function ScriptEditor({ value, language, onChange, readOnly = false, height = "420px", compactLineNumberGutter = false, typeDefinitions }: ScriptEditorProps) {
  const monacoLanguage = language === "powershell" ? "powershell" : language === "javascript" ? "javascript" : "shell";
  const hasEncodingRisk = useMemo(() => language === "powershell" && NON_ASCII_PATTERN.test(value), [language, value]);

  useEffect(() => {
    // One shared library for every JavaScript editor: adding it per editor
    // would redeclare `cfman` once per open drawer.
    if (!typeDefinitions || typeDefinitions === appliedTypeDefinitions) return;
    appliedTypeDefinitions = typeDefinitions;
    javascriptDefaults.setExtraLibs([{ content: typeDefinitions, filePath: AUTOMATION_LIB_PATH }]);
  }, [typeDefinitions]);

  return <div className="script-editor"><Editor
    height={height}
    language={monacoLanguage}
    theme="vs-dark"
    value={value}
    onChange={(next) => onChange?.(next ?? "")}
    options={{
      readOnly,
      minimap: { enabled: false },
      fontFamily: codeFontFamily,
      fontSize: 13,
      fontWeight: "400",
      lineHeight: 20,
      fontLigatures: false,
      lineNumbers: "on",
      lineNumbersMinChars: compactLineNumberGutter ? 4 : 5,
      lineDecorationsWidth: compactLineNumberGutter ? 8 : 10,
      scrollBeyondLastLine: false,
      wordWrap: "on",
      padding: { top: 12, bottom: 12 },
      automaticLayout: true,
      tabSize: 2,
      quickSuggestions: { other: true, comments: false, strings: false },
      suggestOnTriggerCharacters: true,
      parameterHints: { enabled: true }
    }}
  />
    {hasEncodingRisk && <div className="command-note script-editor-encoding-note"><ShieldAlert size={14} />This script contains non-ASCII characters (accents, symbols, emoji). On a Windows PowerShell target, these may print as "?" in captured output. Prefer plain ASCII where exact rendering matters.</div>}
  </div>;
}
