# Agent roles

A role gives a thread a standing brief, such as "you are the engineer: build, then ask the reviewer".
Roles live in your repository, so everyone who opens the project gets the same team.

## Define roles

Add one markdown file per role in `.agents/roles/` at the project root. The file name is the role's
name: `.agents/roles/engineer.md` is `@engineer`. Names use lowercase letters, digits, `-`, and `_`.

```markdown
---
title: Engineer
description: Builds features and fixes bugs
provider: codex
model: gpt-6.2-sol
runtime_mode: auto-accept-edits
allow: [reviewer, qa]
---

You build the app. Before you reply "done", ask @reviewer for a review and @qa to test it.
```

Every frontmatter field is optional:

- `title` and `description` show in pickers and help agents choose a role.
- `provider` (a provider instance or driver, such as `codex` or `claudeAgent`) and `model` are the
  defaults a new thread or task in the role starts with.
- `runtime_mode` is the permission mode for work an agent hands to the role. It never goes above the
  mode of the thread that hands it over. Threads you start yourself keep the mode you pick.
- `allow` lists the roles this role may hand work to. Leave it out to allow every role. Use `[]` to
  allow none.
- `skills` lists the only skills the agent sees, which keeps its context small. Claude and Codex
  hide the rest; the files stay readable, so a brief can still point at one by path. Other
  providers show every skill.
- `tools` lists the only T3 Code tools the agent sees, by name or with a trailing `*`, such as
  `t3_thread_*`. It works on every provider. Leave it out to keep every tool.

A new `skills` or `tools` list reaches a thread when its provider session next starts. Switching a
thread to another role starts a new session right away, and the conversation carries on.

Fields T3 Code doesn't know are ignored, so the same file can also carry another tool's settings.

## Give a thread a role

When the project has roles, the composer shows a role picker. Pick a role before the first message
to start the thread in it, or change or clear it on an existing thread. The agent gets the brief
with its next message. Edits to the role file reach the agent with the next message too.

## Roles hand work to each other

An agent in a role delegates with `delegate_task` and a `role`. The child starts in that role and
reports back to the thread that asked. `orchestrator_capabilities` lists the roles the agent may use.
A request outside the role's `allow` list is refused.
