import Editor, { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor/editor/editor.api";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import "monaco-editor/languages/definitions/powershell/register";
import "monaco-editor/languages/definitions/shell/register";

(globalThis as typeof globalThis & { MonacoEnvironment?: { getWorker: () => Worker } }).MonacoEnvironment = {
  getWorker: () => new EditorWorker()
};
loader.config({ monaco });

const codeFontFamily = '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

type ScriptEditorProps = {
  value: string;
  language: "powershell" | "bash" | "sh";
  onChange?: (value: string) => void;
  readOnly?: boolean;
  height?: string;
  compactLineNumberGutter?: boolean;
};

export function ScriptEditor({ value, language, onChange, readOnly = false, height = "420px", compactLineNumberGutter = false }: ScriptEditorProps) {
  const monacoLanguage = language === "powershell" ? "powershell" : "shell";
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
      tabSize: 2
    }}
  /></div>;
}
