import React from "react";

/**
 * AgentFlow — the workspace's main column.
 *
 * Kimi-style: a calm, centred, single-column flow. Progress first, then the
 * conclusion (root cause + fix), then what the project remembers.
 */

const STEPS = [
  { id: "observe", label: "Observe" },
  { id: "diagnose", label: "Diagnose" },
  { id: "plan", label: "Plan" },
  { id: "patch", label: "Patch" },
  { id: "verify", label: "Verify" },
  { id: "success", label: "Success" },
];

const ORDER = STEPS.map((s) => s.id);

function currentIndex(agentState, agentStatus) {
  if (agentStatus === "success" || agentState === "success") return ORDER.length - 1;
  if (
    agentState === "failure" ||
    agentStatus === "failed" ||
    agentStatus === "escalated"
  ) {
    return ORDER.length - 1;
  }
  const i = ORDER.indexOf(agentState);
  return i === -1 ? 0 : i;
}

function useRunState(agentState, agentStatus) {
  const isSuccess = agentStatus === "success" || agentState === "success";
  const isFailure =
    agentStatus === "failed" || agentStatus === "escalated" || agentState === "failure";
  const isRunning =
    !isSuccess && !isFailure && (agentStatus === "active" || (agentState && agentState !== "idle"));
  const isIdle = !isSuccess && !isFailure && !isRunning;
  return { isSuccess, isFailure, isRunning, isIdle };
}

function Stepper({ idx, isSuccess, isFailure, attemptsDone }) {
  return (
    <ol className="k-steps">
      {STEPS.map((step, i) => {
        let state = "pending";
        if (isSuccess || attemptsDone) state = "done";
        else if (isFailure) state = i <= idx ? "bad" : "pending";
        else if (i < idx) state = "done";
        else if (i === idx) state = "active";
        return (
          <li key={step.id} className={`k-step k-step--${state}`}>
            <span className="k-step-mark" aria-hidden="true" />
            <span className="k-step-text">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function Hero({ isSuccess, isFailure, isRunning, attempts, codebase }) {
  let title = "Ready to debug";
  let sub = "Launch a run with `zen fix <file>` and this workspace will follow along.";

  if (isSuccess) {
    title = "Fixed and verified";
    sub = attempts && attempts.length > 1
      ? `Resolved after ${attempts.length} attempts.`
      : "Resolved on the first attempt.";
  } else if (isFailure) {
    title = "Stopped without a verified fix";
    sub = "The agent ran out of attempts or hit a repeated error. Your code was left unchanged.";
  } else if (isRunning) {
    title = "Working on it…";
    sub = codebase ? `Inspecting ${codebase.project_name || "the project"}.` : "Inspecting the project.";
  }

  return (
    <div className="k-hero">
      <h1 className="k-hero-title">
        {isSuccess && <span className="k-hero-mark k-hero-mark--ok">✓</span>}
        {isFailure && <span className="k-hero-mark k-hero-mark--bad">✕</span>}
        {isRunning && <span className="k-hero-mark k-hero-mark--busy" />}
        {title}
      </h1>
      <p className="k-hero-sub">{sub}</p>
    </div>
  );
}

function Summary({ summary, explanation, attempts }) {
  const latest = attempts && attempts.length ? attempts[attempts.length - 1] : {};
  const why =
    (summary && summary.why_failed) ||
    (explanation && explanation.why_failed) ||
    (summary && summary.diagnosis) ||
    latest.diagnosis ||
    "";
  const what =
    (summary && summary.what_fixed) || (explanation && explanation.what_fixed) || "";
  const files =
    (summary && summary.files_modified) ||
    (explanation && explanation.files_modified) ||
    latest.files_modified ||
    [];
  const type = (summary && summary.error_type) || latest.error_type || "";
  const file = summary && summary.failing_file;
  const line = summary && summary.failing_line;
  const errorMessage = (summary && summary.error_message) || latest.error_message || "";
  const verified = (summary && summary.verified_output) || "";
  const patch = (summary && summary.patch) || null;
  const command = (summary && summary.command) || "";

  if (!why && !what && !errorMessage) return null;

  return (
    <section className="k-card">
      <h2 className="k-card-title">Root cause &amp; fix</h2>

      {(type || file || command) && (
        <div className="k-chips">
          {type && <span className="k-chip k-chip--type">{type}</span>}
          {file && (
            <span className="k-chip k-chip--mono">
              {file}
              {line ? `:${line}` : ""}
            </span>
          )}
          {command && <span className="k-chip k-chip--mono">{command}</span>}
        </div>
      )}

      {errorMessage && <pre className="k-code k-code--error">{errorMessage}</pre>}

      {why && (
        <div className="k-field">
          <span className="k-field-label">Why it failed</span>
          <p className="k-field-body">{why}</p>
        </div>
      )}

      {what && (
        <div className="k-field">
          <span className="k-field-label">What changed</span>
          <p className="k-field-body">{what}</p>
        </div>
      )}

      {patch && patch.search && (
        <div className="k-diff">
          <div className="k-diff-side k-diff-side--before">
            <span className="k-diff-tag">before</span>
            <pre>{patch.search}</pre>
          </div>
          <div className="k-diff-side k-diff-side--after">
            <span className="k-diff-tag">after</span>
            <pre>{patch.replace}</pre>
          </div>
        </div>
      )}

      {files && files.length > 0 && (
        <div className="k-chips">
          {files.map((f, i) => (
            <span key={i} className="k-chip k-chip--file">
              {f}
            </span>
          ))}
        </div>
      )}

      {verified && (
        <div className="k-verified">
          <span className="k-field-label">Verified output</span>
          <code>{verified}</code>
        </div>
      )}
    </section>
  );
}

function ProjectMemory({ memory }) {
  if (!memory) return null;
  const tech = memory.tech_stack || {};
  const total = memory.total_fixes || 0;
  const notes = memory.context_notes || [];
  const recent = (memory.recent_fixes || []).slice(-3).reverse();
  if (!total && !tech.primary_language && !notes.length) return null;

  return (
    <section className="k-card">
      <h2 className="k-card-title">Project memory</h2>

      <div className="k-chips">
        {tech.primary_language && (
          <span className="k-chip k-chip--type">{tech.primary_language}</span>
        )}
        {(tech.frameworks || []).map((f, i) => (
          <span key={i} className="k-chip">{f}</span>
        ))}
        {total > 0 && (
          <span className="k-chip k-chip--ok">
            {memory.successful_fixes || 0}/{total} verified
          </span>
        )}
      </div>

      {recent.length > 0 && (
        <ul className="k-mem">
          {recent.map((fix, i) => (
            <li key={i} className="k-mem-row">
              <span className="k-mem-type">{fix.error_type || "Error"}</span>
              <span className="k-mem-text">
                {(fix.what_fixed || fix.diagnosis || "").slice(0, 120)}
              </span>
            </li>
          ))}
        </ul>
      )}

      {notes.length > 0 && (
        <ul className="k-mem k-mem--notes">
          {notes.slice(-3).reverse().map((n, i) => (
            <li key={i} className="k-mem-row">
              <span className="k-mem-text">{typeof n === "string" ? n : n.note}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AgentFlow({
  agentState,
  agentStatus,
  activeSession,
  attempts,
  codebase,
  memory,
  explanation,
  fixSummary,
}) {
  const { isSuccess, isFailure, isRunning, isIdle } = useRunState(agentState, agentStatus);
  const idx = currentIndex(agentState, agentStatus);
  // A finished attempt means the first five phases completed, even while the
  // loop is still working later attempts.
  const attemptsDone = attempts && attempts.length > 0;

  return (
    <div className="k-main">
      <div className="k-main-inner">
        <Hero
          isSuccess={isSuccess}
          isFailure={isFailure}
          isRunning={isRunning}
          attempts={attempts}
          codebase={codebase}
        />

        <Stepper
          idx={idx}
          isSuccess={isSuccess}
          isFailure={isFailure}
          attemptsDone={attemptsDone && !isIdle}
        />

        {isIdle && !activeSession ? null : (
          <>
            <Summary
              summary={fixSummary}
              explanation={explanation}
              attempts={attempts}
            />
            <ProjectMemory memory={memory} />
          </>
        )}
      </div>
    </div>
  );
}
