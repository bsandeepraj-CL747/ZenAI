import React from "react";

/**
 * ProjectSidebar — the reference layout's left rail: brand at the top, the
 * project identity in a labelled group, then the folder/file list.
 */

function FileIcon({ language, isTest, isEntry }) {
  if (isEntry) return <span className="k-ficon k-ficon-entry" title="entry point">▶</span>;
  if (isTest) return <span className="k-ficon k-ficon-test" title="test">✓</span>;
  const map = {
    Python: "py", JavaScript: "js", TypeScript: "ts", HTML: "html",
    CSS: "css", JSON: "{}", Markdown: "md",
  };
  const label = map[language] || "•";
  return <span className={`k-ficon k-ficon-${(language || "x").toLowerCase()}`}>{label}</span>;
}

export function ProjectSidebar({
  codebase,
  activeFile,
  onSelectFile,
  onRefresh,
  onBackToChat,
}) {
  const files = codebase && codebase.files ? Object.values(codebase.files) : [];
  const loading = !codebase;

  return (
    <aside className="k-side">
      <div className="k-side-top">
        <button
          type="button"
          className="k-side-back"
          onClick={onBackToChat}
          title="Back to chat"
          aria-label="Back to chat"
        >
          ←
        </button>
        <span className="k-side-brand">Zen Workspace</span>
      </div>

      <div className="k-side-group">
        <div className="k-group-label">
          <span>Project</span>
          <button
            type="button"
            className="k-side-refresh"
            onClick={() => onRefresh()}
            title="Refresh files"
            aria-label="Refresh files"
          >
            ⟳
          </button>
        </div>

        <div className="k-project">
          <span className="k-project-name" title={codebase ? codebase.project_root : ""}>
            {codebase ? codebase.project_name || "project" : "…"}
          </span>
          {codebase && (
            <span className="k-project-meta">
              {codebase.primary_language || "Polyglot"}
              {codebase.total_files ? ` · ${codebase.total_files} files` : ""}
            </span>
          )}
        </div>
      </div>

      <div className="k-side-group k-side-files">
        <div className="k-group-label">
          <span>Files</span>
          {files.length > 0 && <span className="k-group-count">{files.length}</span>}
        </div>

        {loading && <p className="k-side-note">Scanning…</p>}
        {!loading && files.length === 0 && (
          <p className="k-side-note">No files found in this project.</p>
        )}

        <ul className="k-file-list">
          {files.map((file) => (
            <li key={file.relative_path}>
              <button
                type="button"
                className={`k-file${activeFile === file.relative_path ? " is-active" : ""}`}
                onClick={() => onSelectFile(file.relative_path)}
                title={file.relative_path}
              >
                <FileIcon
                  language={file.language}
                  isTest={file.is_test}
                  isEntry={file.is_entry_point}
                />
                <span className="k-file-name">{file.relative_path}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
