---
description: Review, document, and commit approved changes using Conventional Commits
agent: build
subtask: true
---

Commit the current approved changes using Conventional Commits.

Workflow:

1. Review `git status --short`.
2. Inspect the staged and unstaged diff for the files that will be committed.
3. Do not commit credentials, secrets, generated caches, local editor files, or unrelated changes.
4. If unrelated changes are present, ask the user whether to include or exclude them before committing.
5. If `CHANGELOG.md` already exists and the change is user-facing, update it before committing. Do not create a new changelog unless the user explicitly asks for one.
6. Read `WORKLOG.md` if it exists.
7. Run the smallest useful verification command available in the project. If no verification command exists, say that explicitly.
8. Stage only approved files.  
9. Use a concise Conventional Commit message, for example `feat: add sandbox commands` or `fix: preserve opencode home path`.  
10. Commit the changes.  
11. Append a concise entry to `WORKLOG.md` including the commit hash/subject.  
+12. Show the commit hash and final `git status --short`.  

Use this exact timestamp command for the worklog:

```bash
TZ=Europe/Berlin date "+%d.%m.%Y, %H:%M (%Z)"
```

Append this shape to `WORKLOG.md`:

```markdown
---

## Commit: <short description>

**Status:** Done
**Date:** <timestamp>

### What Changed

- File: `<path>` — <specific changes included in the commit>

### Findings

- Verification: <command and result, or "No verification command available">
- Commit: `<hash>` <subject>

### Pending

- <remaining follow-up, or "None">
```
