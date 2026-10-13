import React from "react";
import Editor from "@monaco-editor/react";

/**
 * Read-only file preview. The agent is what edits files; this is for
 * inspecting them, so there is no save action.
 */
export function FileViewer({ activeFile, content, onClose, theme = "light" }) {
  if (!activeFile) {
    return (
      <div className="k-viewer-empty">
        <p>Select a file to preview it.</p>
      </div>
    );
  }

  const language = (() => {
    const p = activeFile.toLowerCase();
    if (p.endsWith(".py")) return "python";
    if (p.endsWith(".js") || p.endsWith(".jsx")) return "javascript";
    if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
    if (p.endsWith(".json")) return "json";
    if (p.endsWith(".html")) return "html";
    if (p.endsWith(".css")) return "css";
    if (p.endsWith(".md")) return "markdown";
    return "plaintext";
  })();

  return (
    <div className="k-viewer">
      <div className="k-viewer-head">
        <span className="k-viewer-path" title={activeFile}>
          {activeFile}
        </span>
        <span className="k-viewer-actions">
          <span className="k-viewer-tag">read-only</span>
          <button
            type="button"
            className="k-viewer-close"
            onClick={onClose}
            title="Close preview"
            aria-label="Close preview"
          >
            ✕
          </button>
        </span>
      </div>
      <div className="k-viewer-body">
        <Editor
          height="100%"
          language={language}
          value={content}
          theme={theme === "dark" ? "vs-dark" : "light"}
          options={{
            readOnly: true,
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            automaticLayout: true,
            lineNumbers: "on",
            wordWrap: "on",
            renderLineHighlight: "none",
            domReadOnly: true,
          }}
        />
      </div>
    </div>
  );
}
