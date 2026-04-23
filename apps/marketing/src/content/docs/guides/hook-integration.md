---
title: "Hook Integration"
description: "Use plannotator annotate and annotate-last as review gates from agent hooks — spec-driven workflows, turn-by-turn review, and more."
sidebar:
  order: 27
section: "Guides"
---

The `--gate` and `--json` flags on `plannotator annotate` and `plannotator annotate-last` turn annotation into a structured review decision. This guide shows how to wire them into agent hooks so a human can gate the agent at specific points in a workflow.

See [Annotate → Flags](/docs/commands/annotate/#flags) for the full stdout matrix. The short version:

- `--gate` adds a three-button UX (Approve / Send Annotations / Close).
- Without `--json`: Approve and Close emit empty stdout; Send Annotations emits the feedback markdown. Matches Claude Code's natural PostToolUse / Stop hook convention (empty = allow, non-empty = block).
- With `--json`: every decision emits a structured `{ "decision": "approved" | "annotated" | "dismissed", "feedback": "..." }` object.

## Recipe 1: PostToolUse spec gate

Spec-driven frameworks (spec-kit, kiro, openspec) generate multiple markdown artifacts per feature — spec.md, plan.md, tasks.md, and so on — each needing human review before the agent builds from it. A PostToolUse hook on Write turns plannotator into a reviewer in the loop.

### Plaintext (naive)

Add to `.claude/hooks.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator annotate \"$CLAUDE_TOOL_INPUT_file_path\" --gate",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

Behavior:

- **Approve** → empty stdout → Claude Code proceeds as normal.
- **Send Annotations** → feedback on stdout → Claude Code blocks the turn with the feedback as the reason.
- **Close** → empty stdout → Claude Code proceeds.

No parsing needed. Approve and Close are equivalent from the agent's perspective; the human distinction is preserved in the UI.

### Structured (`--json`)

If you want to route on decision type explicitly — for example, only re-prompt on `annotated` and log `approved` vs `dismissed` separately — pipe through `jq` or a small shell wrapper:

```bash
#!/usr/bin/env bash
# .claude/hooks/spec-gate.sh
result=$(plannotator annotate "$CLAUDE_TOOL_INPUT_file_path" --gate --json)
decision=$(echo "$result" | jq -r '.decision')
feedback=$(echo "$result" | jq -r '.feedback // ""')

case "$decision" in
  approved|dismissed) exit 0 ;;
  annotated)          echo "$feedback" ; exit 2 ;;
esac
```

## Recipe 2: Stop-hook turn gate

Wire `annotate-last` to Claude Code's Stop hook to pause every agent turn for human review.

### Plaintext

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator annotate-last --gate",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

Behavior:

- **Approve** → empty stdout → the turn ends normally, control returns to the user.
- **Send Annotations** → feedback on stdout → Claude Code re-prompts with the feedback.
- **Close** → empty stdout → turn ends.

### Structured

Same pattern as the PostToolUse recipe — pipe `--gate --json` through a shell wrapper if you want distinct handling per decision.

## OpenCode and Pi

The same `--gate` flag works in OpenCode's `/plannotator-annotate` and Pi's `/plannotator-annotate` slash commands:

```
/plannotator-annotate spec.md --gate
```

On those harnesses there is no stdout channel back to the agent — the plugin writes back via `session.prompt` (OpenCode) or `sendUserMessage` (Pi). Approve and Close both result in no session injection; Send Annotations injects the feedback. `--json` is accepted silently on these harnesses so recipes stay portable.

Third-party Pi or OpenCode plugins that want explicit decision routing can read `approved` directly from the server's decision object:

- OpenCode plugin: `server.waitForDecision()` returns `{ feedback, annotations, exit?, approved? }`.
- Pi: `openMarkdownAnnotation()` and `openLastMessageAnnotation()` return `{ feedback, exit?, approved? }`.

## Notes

- Exit code is always `0`. Gate decisions are signaled via stdout, not exit code.
- Folder annotation with `--gate` applies one decision to the whole session (not per-file). The user navigates the file browser inside the UI, annotates across files, and submits once.
- The `--gate` UX is fully opt-in. Users running `/plannotator-annotate README.md` interactively without the flag still see the 2-button experience.
