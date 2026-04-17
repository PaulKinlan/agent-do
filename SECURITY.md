# Security Policy

agent-do runs autonomous LLM-driven agents with filesystem access, so the
threat model matters. We treat security reports seriously and want to
make it easy to send one.

## Supported Versions

agent-do is pre-1.0. Only the **latest published patch of the latest
minor** receives security fixes; older versions get fixes by
upgrading. The table updates on every minor release.

| Version | Supported                       |
| ------- | ------------------------------- |
| 0.1.x   | :white_check_mark: latest patch |
| < 0.1   | :x:                             |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security reports.**

Preferred channel — GitHub Private Vulnerability Reporting:

1. Go to the [Security tab](https://github.com/PaulKinlan/agent-do/security).
2. Click **Report a vulnerability**.
3. Fill in the form. You can attach proof-of-concept files and CVSS scores.

Reports arrive as a private security advisory visible only to maintainers
and, once you accept, a shared working thread where we can coordinate a
fix, credit, and disclosure timing.

If you can't use the GitHub flow, email
[paul.kinlan@gmail.com](mailto:paul.kinlan@gmail.com) with a subject
starting with `[agent-do security]`. If your report is particularly
sensitive and you want to encrypt it, request a PGP key in your first
message — we'll reply with one.

### What to include

Whatever you have — we'd rather you send early than wait until it's
polished. Useful ingredients:

- a short description of the issue and the affected version;
- a reproduction (a minimal script, a `vitest` case, or just the
  commands you ran);
- the expected vs. observed behaviour;
- impact you can demonstrate (what an attacker gains);
- any suggested mitigations you've already considered.

### What to expect from us

| Stage | Target                                                         |
|-------|----------------------------------------------------------------|
| Acknowledgement | Within **72 hours** of your report.                  |
| Initial assessment + severity | Within **7 days**.                     |
| Fix or mitigation | Critical/High: within **14 days**. Medium: best effort in the next release. Low/Informational: tracked in the issue backlog. |
| Public disclosure | Coordinated with you, typically 7–30 days after the fix ships, depending on upstream impact. |

If we decline a report, we'll explain why — usually this is because
the behaviour is an intended tradeoff (for example, `--no-tools` is
the documented way to keep agents away from the filesystem entirely;
choosing not to pass it isn't a vulnerability) or it requires an
attacker capability that already implies game-over.

### Credit

We credit reporters in the published advisory unless they ask to stay
anonymous. First names, handles, or company names — whatever you'd like
to see — are all fine.

## Scope

Likely in-scope:

- Path traversal, sandbox escape, or privilege escalation in the file
  or memory tools (anything that lets the agent reach files outside
  its configured working / memory directory).
- Prompt-injection paths where untrusted content (file bodies, tool
  output, skill content) flows into the LLM in a way that lets it
  override the system prompt or escalate its capabilities.
- Secret-exfiltration paths through the `ProgressEvent` stream,
  `--verbose` logs, or any other observable side channel.
- Bypasses of the permission / hook layer
  (`config.permissions`, `config.hooks.onPreToolUse`,
  `FilesystemMemoryStore`'s `onBeforeWrite`, `--read-only`,
  `--no-tools`).
- Validation gaps in saved-agent configs (`.agent-do/agents/*.json`)
  that let a planted file steer a future run.
- Supply-chain concerns with the bundled provider SDKs or their
  transitive dependencies.
- Any path where the LLM can persist arbitrary instructions for future
  sessions (skills, saved agents, memory).

Likely out-of-scope:

- The LLM making mistakes within its permitted sandbox — that's a
  capability-planning problem, not a security bug.
- Denial-of-service from a user handing the agent an unbounded task.
  agent-do enforces iteration limits (`maxIterations`) and supports
  per-run / per-day spending limits (`config.usage.limits`), but it
  is not a sandboxing system for hostile local users.
- Issues that require the user to explicitly opt out of a security
  control — for example, calling `createAgent({ permissions: { mode:
  'accept-all' } })`, passing `--read-only` and being surprised that
  reads still happen, or running with `--no-tools` disabled and then
  finding the agent touched files. Document the surprise as a
  usability issue if you'd like, but it isn't a vulnerability.
- Bugs in third-party model providers or LLMs themselves. If the
  issue is in how agent-do *handles* their output, that's in scope;
  if it's a bug in the upstream API, please report it there first.

## Working with us

We welcome good-faith security research and want to make it easy. If
you stick to the spirit of this policy — test against your own
installs, give us reasonable time before public disclosure, don't
damage other people's data — we're happy to credit you and work with
you to land a fix.

agent-do is a library, not a hosted service, and it's maintained by an
individual rather than an organisation, so we can't grant legal
exemptions on behalf of anyone else and we have no standing to bring
or threaten legal action ourselves. We won't pursue any complaint we
have control over against researchers who follow this policy.

We'll publicly thank researchers who help us improve agent-do's
security — on the advisory, in release notes, and (if desired) in the
README.
