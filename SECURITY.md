# Security Policy

Codezal runs an AI agent that can read and write files, execute shell commands and reach the
network on your machine, and it stores provider credentials locally. We take reports about these
boundaries seriously.

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://github.com/esmworks/codezal/security/advisories/new)
(Security tab > Report a vulnerability). Include:

- the affected version (Settings > Account) and OS,
- a description of the issue and its impact,
- steps or a proof of concept to reproduce it.

We aim to acknowledge reports within 5 business days and will keep you updated while we work on a
fix. Once a fix is released we are happy to credit you in the advisory, unless you prefer to stay
anonymous.

## Supported versions

Security fixes are released for the latest published version only. The app updates itself from
`updates.codezal.com`; please make sure you are on the latest release before reporting.

## Scope

In scope, for example:

- credentials leaking to the renderer, logs, crash reports or other processes,
- the permission gate being bypassed (a tool running without the approval its mode requires),
- path traversal or writes outside the project and Codezal data folders,
- the update channel accepting unsigned or tampered builds,
- IPC channels reachable without validation from untrusted content.

Out of scope:

- actions the agent takes with permissions the user explicitly granted (for example in the most
  permissive mode),
- prompt injection that only results in actions the user then approves,
- vulnerabilities in model providers or third-party MCP servers themselves.
