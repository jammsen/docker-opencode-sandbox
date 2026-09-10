---
description: Audit refactor opportunities without editing files
agent: plan
subtask: true
---

Analyze the target given in `$ARGUMENTS` for code smells, duplicate code, unnecessary complexity, security risks, and technical debt.

If `$ARGUMENTS` is empty, inspect the current git diff first and then the smallest relevant surrounding files.

Do not edit files. Do not update `WORKLOG.md`; this is a read-only planning command unless the user explicitly asks you to document the audit.

Produce a concise audit with:

1. Findings ordered by impact
2. Exact files and symbols involved
3. Suggested refactor steps
4. Security risks, behavioral risks, and verification needed

Ask the user which items should be implemented before making changes.
