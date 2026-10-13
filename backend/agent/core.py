"""
agent/core.py — Autonomous Debugging Agent Engine.

Executes the observe → diagnose → plan → patch → verify state machine.
Uses Groq LLM tool calling to inspect code, apply patches, run commands, and verify fixes.

Memory-aware: reads from and writes to the project's .zen/ directory
to remember past fixes and skip redundant analysis.
"""
import asyncio
import json
import logging
import subprocess
import time
from pathlib import Path
from typing import Dict, Any, Optional, List

from codebase.scanner import scan_project, update_codebase_model
from codebase.search import correlation_search, search_code, find_symbol
from terminal.executor import execute_command
from terminal.model import extract_failing_location
from tools.filesystem import list_files, read_file, write_file
from tools.patch import apply_patch
from tools.git import create_checkpoint, rollback_checkpoint, get_git_diff
from tools.checkpoint import FileCheckpoint
from llm.client import get_groq_client, chat_completion
from llm.prompts import SYSTEM_PROMPT_AGENT, DEBUGGER_TOOLS
from llm.context import build_agent_context
from agent.session import ActiveSession
from memory.store import (
    init_memory, has_memory, load_memory, save_memory,
    load_fixes, save_fix, find_similar_fix,
    save_project_map, update_tech_stack, add_context_note,
    get_memory_summary,
)
import crud
from database import SessionLocal

logger = logging.getLogger(__name__)


def execute_agent_tool(project_path: str, codebase: Any, func_name: str, args: dict) -> Dict[str, Any]:
    """Execute a tool called by the LLM and return structured result."""
    try:
        if func_name == "read_file":
            path = args.get("path") or args.get("file_path", "")
            content = read_file(project_path, path)
            return {"success": True, "content": content}
            
        elif func_name == "list_files":
            path = args.get("path", ".")
            files = list_files(project_path, path)
            return {"success": True, "files": files}

        elif func_name == "search_code":
            query = args.get("query", "")
            matches = search_code(codebase, query)
            return {"success": True, "results": [m.to_dict() for m in matches]}

        elif func_name == "find_symbol":
            name = args.get("name", "")
            syms = find_symbol(codebase, name)
            return {"success": True, "symbols": syms}

        elif func_name == "apply_patch":
            rel_path = args.get("file_path") or args.get("path", "")
            search = args.get("search", "")
            replace = args.get("replace", "")
            return apply_patch(project_path, rel_path, search, replace)

        elif func_name == "create_file":
            rel_path = args.get("path") or args.get("file_path", "")
            content = args.get("content", "")
            msg = write_file(project_path, rel_path, content)
            return {"success": True, "message": msg, "file_path": rel_path}

        elif func_name == "run_command":
            cmd = args.get("command", "")
            completed = subprocess.run(
                cmd,
                shell=True,
                cwd=project_path,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
            return {
                "success": completed.returncode == 0,
                "stdout": completed.stdout,
                "stderr": completed.stderr,
                "exit_code": completed.returncode,
            }

        elif func_name == "get_git_diff":
            return {"success": True, "diff": get_git_diff(project_path)}

        else:
            return {"success": False, "error": f"Unknown tool: {func_name}"}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


def generate_plain_english_explanation(error_type: str, error_message: str, diagnosis: str, modified_files: list) -> dict:
    """Generate clear, non-technical plain English explanations of why code failed and how it was fixed."""
    err_str = f"{error_type}: {error_message}"
    if "No module named" in err_str or "ModuleNotFoundError" in err_str:
        if ".py" in err_str:
            why = "Python Import Syntax Error: The code wrote `from <module>.py import ...`. Python treats `.py` as a sub-package instead of a file name. In Python, you must omit `.py` from import statements."
            fix = f"Removed the `.py` extension from the import statement in `{', '.join(modified_files) if modified_files else 'the source file'}`."
        else:
            why = f"Module Not Found: Python could not locate the imported module: {error_message.strip()}."
            fix = f"Corrected the import statement and aligned file paths in `{', '.join(modified_files) if modified_files else 'the source file'}`."
    elif "SyntaxError" in err_str:
        why = f"Syntax Error: The code contains invalid language syntax: {error_message.strip()}."
        fix = f"Corrected the syntax structure in `{', '.join(modified_files) if modified_files else 'the source file'}`."
    elif "ZeroDivisionError" in err_str:
        why = "Division by Zero: Code attempted to divide a number by 0, which is invalid."
        fix = f"Added safety checks / default fallbacks in `{', '.join(modified_files) if modified_files else 'the source file'}`."
    elif "TypeError" in err_str:
        why = f"Type Error: Unexpected data types or incorrect argument count: {error_message.strip()}."
        fix = f"Aligned argument types and parameters in `{', '.join(modified_files) if modified_files else 'the source file'}`."
    elif "NameError" in err_str:
        why = f"Undefined Variable/Function: {error_message.strip()}."
        fix = f"Defined the missing variable or imported the required definition in `{', '.join(modified_files) if modified_files else 'the source file'}`."
    elif "AssertionError" in err_str:
        why = f"Assertion Failed: A test expectation was not met. {error_message.strip()}."
        fix = f"Fixed the logic in `{', '.join(modified_files) if modified_files else 'the source file'}` so the assertion passes."
    else:
        why = diagnosis if diagnosis else f"Execution failed with {error_type}: {error_message.strip()}"
        fix = f"Applied targeted patch in `{', '.join(modified_files) if modified_files else 'the codebase'}` to eliminate the error."

    return {
        "why_failed": why,
        "what_fixed": fix,
        "files_modified": modified_files,
        "error_type": error_type,
        "error_message": error_message,
    }


def _is_tool_generation_failure(err_text: str) -> bool:
    """True when Groq rejected the model's own tool-call output.

    These are `tool_use_failed` 400s ("Failed to parse tool call arguments as
    JSON" / "Parsing failed. The model generated ..."). The model emitted
    malformed JSON, so nothing was executed — retrying usually resamples into a
    valid call, unlike a genuine semantic failure.
    """
    t = (err_text or "").lower()
    return (
        "tool_use_failed" in t
        or "failed to parse tool call arguments" in t
        or "parsing failed" in t
        or "failed_generation" in t
    )


def _annotate_last_fix(project_path: str, extra: dict) -> None:
    """Merge readable summary fields into the fix record just appended.

    `.zen/fixes.json` is append-only elsewhere; this only enriches the final
    entry with the fields the workspace UI displays.
    """
    fixes = load_fixes(project_path)
    if not fixes:
        return
    fixes[-1].update({k: v for k, v in extra.items() if v is not None})
    zen = Path(project_path) / ".zen"
    zen.mkdir(exist_ok=True)
    (zen / "fixes.json").write_text(
        json.dumps(fixes, indent=2, default=str), encoding="utf-8"
    )


async def _chat_with_retry(client, messages, tools=None, attempts: int = 3):
    """Call the LLM, retrying malformed-tool-call failures.

    Without this, one bad sample aborts the attempt, gets classified as
    LLM error, and the cycle detector escalates the whole session.
    """
    response = await chat_completion(client, messages, tools=tools or DEBUGGER_TOOLS)
    tries = 1
    while (
        response.get("error")
        and _is_tool_generation_failure(str(response["error"]))
        and tries < attempts
    ):
        await asyncio.sleep(0.5 * tries)
        tries += 1
        response = await chat_completion(client, messages, tools=tools or DEBUGGER_TOOLS)
    if tries > 1 and not response.get("error"):
        logger.info("Recovered from tool-generation failure on attempt %d", tries)
    return response


class DebugAgentEngine:
    def __init__(self, session: ActiveSession):
        self.session = session

    async def run_debugging_loop(self):
        """Main autonomous loop with .zen/ memory integration."""
        try:
            return await self._run_debugging_loop()
        except Exception as exc:
            logger.exception("Debugging loop crashed")
            self.session.status = "failed"
            self.session.state = "failure"
            await self.session.broadcast("failed", {"error": str(exc)})
            return self.session.status

    async def _run_debugging_loop(self):
        session = self.session
        await session.broadcast("agent_started", {"initial_command": session.initial_command})

        # ─── MEMORY: Initialize .zen/ and load project memory ─────────────
        init_memory(session.project_path)
        memory_summary = get_memory_summary(session.project_path)

        if memory_summary["has_memory"] and memory_summary["total_fixes"] > 0:
            await session.broadcast("memory_loaded", {
                "message": "Loading .zen/ memory...",
                "tech_stack": memory_summary.get("tech_stack", {}),
                "total_fixes": memory_summary["total_fixes"],
                "successful_fixes": memory_summary["successful_fixes"],
                "recent_fixes": memory_summary.get("recent_fixes", []),
                "context_notes": memory_summary.get("context_notes", []),
            })
        else:
            await session.broadcast("memory_loaded", {
                "message": "No prior memory found. Building fresh project context...",
                "tech_stack": {},
                "total_fixes": 0,
                "successful_fixes": 0,
                "recent_fixes": [],
                "context_notes": [],
            })

        # Step 0: Initial codebase scan
        scan_project(session.project_path, session.codebase)
        await session.broadcast("codebase_scanned", {"summary": session.codebase.get_summary()})

        # Save project map to .zen/ for faster future loads
        save_project_map(session.project_path, session.codebase.to_dict())
        update_tech_stack(
            session.project_path,
            session.codebase.primary_language,
            session.codebase.frameworks,
        )

        # Run initial command to capture error
        await session.broadcast("state_change", {"state": "observe", "msg": "Running initial command..."})
        cmd_result = await execute_command(session.initial_command, cwd=session.project_path)
        session.execution.add_result(cmd_result)

        if cmd_result.exit_code == 0:
            session.status = "success"
            session.state = "success"
            await session.broadcast("completed", {"message": "Initial command succeeded! No error detected."})
            return

        while session.status == "active":
            session.current_attempt_number += 1
            attempt_num = session.current_attempt_number

            # Check safety limits
            exceeded, limit_msg = session.safety.check_attempt_limit(attempt_num)
            if exceeded:
                session.status = "failed"
                session.state = "failure"
                await session.broadcast("failed", {"error": limit_msg})
                break

            last_result = session.execution.command_history[-1]
            exec_summary = session.execution.to_summary()
            error_type = exec_summary.get("last_error_type") or "RuntimeError"
            error_msg = exec_summary.get("last_error_message") or last_result.stderr[:200]

            # Check for repeating cycles
            # Fingerprint of the error BEFORE this attempt patches anything,
            # used after verification to tell "still stuck" from "made progress".
            error_signature_before = session.safety.compute_error_signature(
                error_type, error_msg, last_result.stderr
            )
            is_cycle, cycle_msg = session.safety.check_cycle(error_type, error_msg, last_result.stderr)
            if is_cycle:
                session.status = "escalated"
                session.state = "failure"
                await session.broadcast("escalated", {"error": cycle_msg})
                break

            # ─── MEMORY: Check for similar past fixes ─────────────────────
            similar_fix = find_similar_fix(session.project_path, error_type, error_msg)
            if similar_fix:
                await session.broadcast("strategy", {
                    "type": "memory_match",
                    "message": f"Found a similar past fix for '{error_type}'",
                    "past_fix": {
                        "error_type": similar_fix.get("error_type", ""),
                        "error_message": similar_fix.get("error_message", "")[:100],
                        "diagnosis": similar_fix.get("diagnosis", "")[:200],
                        "files_modified": similar_fix.get("files_modified", []),
                        "timestamp": similar_fix.get("timestamp", ""),
                    },
                    "strategy": f"I've seen this error before. Previously fixed by: {similar_fix.get('diagnosis', 'unknown')[:150]}. Will try a similar approach.",
                })
            else:
                await session.broadcast("strategy", {
                    "type": "fresh_analysis",
                    "message": f"New error type '{error_type}' — performing full analysis",
                    "strategy": "No matching fix in memory. I will read the error trace, correlate to source files, diagnose the root cause, and apply a targeted patch.",
                })

            # ─── STATE 1: OBSERVE ─────────────────────────────────────────────
            session.state = "observe"
            await session.broadcast("state_change", {
                "state": "observe",
                "attempt": attempt_num,
                "error_type": error_type,
                "error_message": error_msg,
                "stderr": last_result.stderr,
            })

            # Correlate error to files
            correlated_files = correlation_search(session.project_path, last_result.stderr, session.codebase)

            # The traceback names the file that actually failed. State it
            # explicitly: without this the agent can patch an unrelated file
            # forever while a SyntaxError blocks the script from ever running.
            failing = extract_failing_location(
                last_result.stderr or last_result.stdout, session.project_path
            )

            # Build context payload
            context_data = build_agent_context(
                session.codebase, session.execution, session.attempts, "diagnose"
            )
            context_data["correlated_files"] = correlated_files
            if failing:
                context_data["failing_location"] = failing

            # Inject memory context if available
            if similar_fix:
                context_data["memory_hint"] = {
                    "similar_past_fix": similar_fix.get("diagnosis", ""),
                    "files_previously_modified": similar_fix.get("files_modified", []),
                }

            # ─── STATE 2: DIAGNOSE ──────────────────────────────────────────────
            session.state = "diagnose"
            await session.broadcast("state_change", {
                "state": "diagnose",
                "attempt": attempt_num,
                "correlated_files": [f["path"] for f in correlated_files],
                "failing_file": failing["file"] if failing else None,
                "failing_line": failing["line"] if failing else None,
                "error_type": error_type,
                "error_message": (error_msg or "")[:300],
            })

            # Build prompt with optional memory context
            memory_hint_text = ""
            if similar_fix:
                memory_hint_text = f"\n\n**Memory Hint**: A similar error was fixed before. Previous diagnosis: '{similar_fix.get('diagnosis', '')}'. Files modified: {similar_fix.get('files_modified', [])}. Consider a similar approach, but verify the current state first."

            location_text = ""
            if failing:
                location_text = (
                    f"\n\n**The traceback points at `{failing['file']}` line "
                    f"{failing['line']}.** Fix the error in THAT file first. A "
                    f"syntax error there stops the whole program before any other "
                    f"file runs, so patches elsewhere cannot be verified."
                )

            messages = [
                {"role": "system", "content": SYSTEM_PROMPT_AGENT},
                {
                    "role": "user",
                    "content": f"Context:\n```json\n{json.dumps(context_data, indent=2)}\n```\nAnalyze the error, inspect relevant files using read_file or search_code if needed, and apply a targeted patch using apply_patch.{location_text}{memory_hint_text}",
                },
            ]

            client = get_groq_client()
            # Snapshot every file this attempt modifies, so a patch that fails
            # verification can be undone instead of compounding.
            checkpoint = FileCheckpoint(session.project_path, session.session_id)

            patch_applied = False
            modified_files = []
            patch_diff_text = ""
            diagnosis_text = ""
            plan_text = ""
            llm_failures = 0
            last_search = None
            last_replace = None

            # Multi-turn tool loop (read → patch). Duplicate assistant
            # messages break Groq tool-calling, so append exactly once.
            for turn in range(8):
                response = await _chat_with_retry(client, messages)
                assistant_msg = response["message"]

                if response.get("error"):
                    err_text = str(response["error"])
                    llm_failures += 1
                    await session.broadcast("llm_error", {"error": err_text})
                    diagnosis_text = diagnosis_text or f"LLM error: {err_text}"

                    if _is_tool_generation_failure(err_text):
                        # The model emitted malformed tool-call JSON. This is a
                        # sampling failure, not a code problem — retrying in
                        # _chat_with_retry often succeeds. If it keeps failing,
                        # stop burning turns and say so plainly.
                        if llm_failures >= 2:
                            diagnosis_text = (
                                "The model repeatedly produced a malformed tool call "
                                "(Groq tool_use_failed). This usually happens when it "
                                "tries to write a very large file in one call. "
                                "No code was changed."
                            )
                            await session.broadcast("strategy", {
                                "type": "llm_failure",
                                "message": diagnosis_text,
                            })
                            break
                        # Nudge it toward a smaller, surgical edit and try again.
                        messages.append({
                            "role": "user",
                            "content": (
                                "Your previous tool call could not be parsed. Do not "
                                "rewrite whole files or emit large content blocks. "
                                "Use apply_patch with a SHORT `search` and `replace` "
                                "that changes only the buggy lines."
                            ),
                        })
                        continue
                    break

                llm_failures = 0

                # Capture diagnosis/plan from the model. gpt-oss returns empty
                # `content` alongside tool calls and puts its reasoning in a
                # separate field, so fall back to that instead of recording "".
                if assistant_msg.get("content"):
                    diagnosis_text = assistant_msg["content"]
                elif assistant_msg.get("reasoning") and not diagnosis_text:
                    diagnosis_text = assistant_msg["reasoning"]

                tool_calls = assistant_msg.get("tool_calls", []) or []

                if not tool_calls:
                    break

                # ─── STATE 3: PLAN ─────────────────────────────────────────────
                session.state = "plan"
                await session.broadcast("state_change", {
                    "state": "plan",
                    "attempt": attempt_num,
                    "diagnosis": diagnosis_text,
                    "tool_calls_count": len(tool_calls),
                })

                # ─── STATE 4: PATCH ─────────────────────────────────────────────
                session.state = "patch"
                await session.broadcast("state_change", {
                    "state": "patch",
                    "attempt": attempt_num,
                    "diagnosis": diagnosis_text,
                    "tool_calls_count": len(tool_calls),
                })

                messages.append({
                    "role": "assistant",
                    "content": assistant_msg.get("content", "") or None,
                    "tool_calls": [
                        {
                            "id": tc.get("id", f"call_{i}"),
                            "type": "function",
                            "function": {
                                "name": tc.get("name") or tc.get("function", {}).get("name"),
                                "arguments": json.dumps(tc.get("arguments", {})) if isinstance(tc.get("arguments"), dict) else (tc.get("arguments") or "{}"),
                            },
                        }
                        for i, tc in enumerate(tool_calls)
                    ],
                })

                for tc in tool_calls:
                    func_name = tc.get("name") or tc.get("function", {}).get("name")
                    raw_args = tc.get("arguments") or tc.get("function", {}).get("arguments", {})
                    if isinstance(raw_args, dict):
                        args = raw_args
                    else:
                        try:
                            args = json.loads(raw_args or "{}")
                        except json.JSONDecodeError:
                            args = {}

                    await session.broadcast("tool_call", {
                        "tool": func_name,
                        "file": args.get("file_path") or args.get("path", ""),
                    })

                    # Capture original contents BEFORE the write, so it can be undone.
                    if func_name in ("apply_patch", "create_file"):
                        target = args.get("file_path") or args.get("path")
                        if target:
                            checkpoint.capture([target])

                    tool_res = execute_agent_tool(session.project_path, session.codebase, func_name, args)

                    if func_name in ("apply_patch", "create_file"):
                        if tool_res.get("success"):
                            patch_applied = True
                            rel_path = args.get("file_path") or args.get("path")
                            if rel_path and rel_path not in modified_files:
                                modified_files.append(rel_path)
                            # Remember the winning edit so the UI can show the
                            # exact before/after that fixed it.
                            if args.get("search"):
                                last_search = args.get("search")
                                last_replace = args.get("replace")
                            await session.broadcast("patch_applied", {
                                "file": rel_path,
                                "search": args.get("search"),
                                "replace": args.get("replace"),
                            })
                        else:
                            await session.broadcast("patch_failed", {
                                "file": args.get("file_path") or args.get("path"),
                                "error": tool_res.get("error"),
                            })

                    # Append tool result to messages for next LLM turn
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.get("id", "call_0"),
                        "content": json.dumps(tool_res),
                    })

                if patch_applied:
                    break

            if patch_applied:
                patch_diff_text = get_git_diff(session.project_path)
                update_codebase_model(session.project_path, session.codebase, modified_files)

            # ─── STATE 5: VERIFY ───────────────────────────────────────────────
            session.state = "verify"
            await session.broadcast("state_change", {
                "state": "verify",
                "attempt": attempt_num,
                "command": session.initial_command,
            })

            start_t = time.time()
            verify_res = await execute_command(session.initial_command, cwd=session.project_path)
            duration = (time.time() - start_t) * 1000
            session.execution.add_result(verify_res)

            # Log attempt to database
            attempt_record = {
                "attempt_number": attempt_num,
                "state": "success" if verify_res.exit_code == 0 else "verify",
                "error_type": error_type,
                "error_message": error_msg,
                "diagnosis": diagnosis_text,
                "plan": "Apply targeted patch and rerun verification command",
                "patch_diff": patch_diff_text,
                "files_modified": modified_files,
                "command_run": session.initial_command,
                "stdout": verify_res.stdout,
                "stderr": verify_res.stderr,
                "exit_code": verify_res.exit_code,
                "duration_ms": duration,
                "llm_reasoning": diagnosis_text,
            }
            session.attempts.append(attempt_record)

            async with SessionLocal() as db:
                await crud.create_debug_attempt(
                    db,
                    session_id=session.session_id,
                    **attempt_record
                )
                await crud.increment_session_attempts(db, session.session_id)

            # ─── MEMORY: Save fix result to .zen/ ─────────────────────────
            explanation = generate_plain_english_explanation(error_type, error_msg, diagnosis_text, modified_files)
            fix_record = {
                "error_type": error_type,
                "error_message": error_msg,
                "diagnosis": diagnosis_text,
                "why_failed": explanation["why_failed"],
                "what_fixed": explanation["what_fixed"],
                "files_modified": modified_files,
                "patch_diff": patch_diff_text,
                "command": session.initial_command,
                "was_successful": verify_res.exit_code == 0,
                "attempt_number": attempt_num,
            }
            save_fix(session.project_path, fix_record)

            # Keep the readable summary in project memory too, so the workspace
            # can show a real root cause on later visits (not just live).
            try:
                _annotate_last_fix(session.project_path, {
                    "error_type": error_type,
                    "failing_file": failing["file"] if failing else None,
                    "failing_line": failing["line"] if failing else None,
                    "diagnosis": (diagnosis_text or "")[:600],
                    "why_failed": explanation["why_failed"],
                    "what_fixed": explanation["what_fixed"],
                    "search": last_search,
                    "replace": last_replace,
                })
            except Exception as exc:
                # Warning, not debug: silently swallowing this is what hid a
                # missing import and left the UI without a root cause.
                logger.warning("Could not annotate fix record: %s: %s",
                               type(exc).__name__, exc)

            if verify_res.exit_code == 0:
                # Save a context note about what we learned
                add_context_note(
                    session.project_path,
                    f"Fixed {error_type} in {', '.join(modified_files) if modified_files else 'unknown files'}: {explanation['what_fixed']}"
                )

                session.status = "success"
                session.state = "success"
                async with SessionLocal() as db:
                    await crud.update_debug_session_status(db, session.session_id, "success")

                # Broadcast completion with explanation & memory save confirmation
                await session.broadcast("memory_saved", {
                    "message": "Fix saved to .zen/ memory for future reference.",
                    "fix_summary": {
                        "error_type": error_type,
                        "diagnosis": diagnosis_text[:150],
                        "why_failed": explanation["why_failed"],
                        "what_fixed": explanation["what_fixed"],
                        "files_modified": modified_files,
                    },
                })

                await session.broadcast("completed", {
                    "attempt": attempt_num,
                    "message": "Bug fixed! Verification command passed with exit code 0.",
                    "patch_diff": patch_diff_text,
                    "why_failed": explanation["why_failed"],
                    "what_fixed": explanation["what_fixed"],
                    "files_modified": modified_files,
                    "verified_output": verify_res.stdout.strip() if verify_res.stdout else "Exit code 0 (Clean run)",
                    "error_type": error_type,
                    "error_message": error_msg,
                    "failing_file": failing["file"] if failing else None,
                    "failing_line": failing["line"] if failing else None,
                    "diagnosis": (diagnosis_text or "")[:600],
                    "command": session.initial_command,
                    "patch": {
                        "file": modified_files[0] if modified_files else None,
                        "search": last_search,
                        "replace": last_replace,
                    },
                })
                break
            else:
                # Only undo this attempt's changes if it made NO progress.
                # Reverting a patch that fixed one of several bugs just forces
                # the next attempt to redo it — and guarantees the identical
                # stderr, which trips the cycle detector into escalating.
                new_sig = session.safety.compute_error_signature(
                    error_type, error_msg, verify_res.stderr
                )
                if new_sig != error_signature_before:
                    await session.broadcast("patch_kept", {
                        "attempt": attempt_num,
                        "files": checkpoint.touched,
                        "reason": "error changed — keeping partial progress",
                    })
                    restored = []
                else:
                    restored = checkpoint.restore()
                    if restored:
                        await session.broadcast("patch_rolled_back", {
                            "attempt": attempt_num,
                            "files": restored,
                            "reason": "verification failed with the same error",
                        })
                        update_codebase_model(session.project_path, session.codebase, restored)

                await session.broadcast("verification_failed", {
                    "attempt": attempt_num,
                    "exit_code": verify_res.exit_code,
                    "why_failed": explanation["why_failed"],
                    "stderr": verify_res.stderr,
                    "rolled_back": restored,
                })

        return session.status
