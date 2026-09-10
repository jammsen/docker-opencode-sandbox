---
description: Apply one approved refactor, verify it, and update WORKLOG.md
agent: build
subtask: true
---

Apply only the refactor requested in `$ARGUMENTS`.

If `$ARGUMENTS` is empty or the requested scope is unclear, ask the user to name the approved refactor before editing files.

Workflow:

1. Read `WORKLOG.md` if it exists.
2. Identify the smallest file/symbol scope needed for `$ARGUMENTS`.
3. Keep behavior unchanged.
4. Keep changes focused to the approved files or symbols.
5. Do not include unrelated cleanup.
6. Run the smallest useful verification command available in the project. If none exists, say that explicitly.
7. Append a concise entry to `WORKLOG.md` before finishing.
8. Summarize changed files and verification results.

Use this exact timestamp command for the worklog:

```bash
TZ=Europe/Berlin date "+%d.%m.%Y, %H:%M (%Z)"
```

Append this shape to `WORKLOG.md`:

```markdown
---

## Refactor: <short description>

**Status:** Done
**Date:** <timestamp>

### What Changed

- File: `<path>` — <specific changes>

### Findings

- <concrete findings or observations>
- Verification: <command and result, or "No verification command available">

### Pending

- <remaining follow-up, or "None">
```
