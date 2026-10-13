import React from "react";
import { useNavigate } from "react-router-dom";
import { useAgent } from "../hooks/useAgent";
import { ProjectSidebar } from "../components/ProjectSidebar";
import { FileViewer } from "../components/FileViewer";
import { AgentFlow } from "../components/AgentFlow";

/**
 * Workspace layout: files on the left, the code in the middle, and the agent's
 * progress + conclusions on the right.
 */
export default function WorkspacePage() {
  const navigate = useNavigate();

  const {
    codebase,
    refreshCodebase,
    agentState,
    agentStatus,
    activeSession,
    attempts,
    activeFile,
    fileContent,
    memory,
    explanation,
    fixSummary,
    openFile,
  } = useAgent(".");

  // Closing the preview clears the selection so the pane shows its empty state
  // rather than a stale file.
  const handleClosePreview = () => {
    openFile(null);
  };

  return (
    <div className="k-app k-surface">
      <ProjectSidebar
        codebase={codebase}
        activeFile={activeFile}
        onSelectFile={openFile}
        onRefresh={refreshCodebase}
        onBackToChat={() => navigate("/")}
      />

      <div className="k-content">
        {/* middle: the code itself */}
        <section className="k-viewer-pane">
          <FileViewer
            activeFile={activeFile}
            content={fileContent}
            onClose={handleClosePreview}
          />
        </section>

        {/* right: what the agent is doing and concluded */}
        <AgentFlow
          agentState={agentState}
          agentStatus={agentStatus}
          activeSession={activeSession}
          attempts={attempts}
          codebase={codebase}
          memory={memory}
          explanation={explanation}
          fixSummary={fixSummary}
        />
      </div>
    </div>
  );
}
