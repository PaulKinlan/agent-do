# Security Policy

agent-do runs autonomous LLM-driven agents with filesystem access, so the
threat model matters. We treat security reports seriously and want to
make it easy to send one.

## Supported Versions

agent-do is pre-1.0. Only the **latest published minor** is supported
with security fixes. Older versions receive fixes only via upgrade.

| Version | Supported                |
| ------- | ------------------------ |
| 0.1.x   | :white_check_mark: latest patch |
| < 0.1   | :x:                      |

Once we cut a 0.2.x or later line, this table will be updated and the
previous minor will enter a 30-day maintenance window for critical fixes
only.

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

If we decline a report, we'll explain why — usually this is because the
behaviour is an intended tradeoff (for example, `--include-sensitive`
deliberately disables the deny list) or it requires an attacker
capability that already implies game-over.

### Credit

We credit reporters in the published advisory unless they ask to stay
anonymous. First names, handles, or company names — whatever you'd like
to see — are all fine.

## Scope

Likely in-scope:

- Path traversal, sandbox escape, or privilege escalation in the
  file / memory tools.
- Prompt-injection surfaces we haven't already bounded (see
  `wrapForModel` in `src/tools/content-guards.ts`).
- Secret-exfiltration paths through the ProgressEvent stream,
  `--verbose` logs, or telemetry hooks.
- Deny-list bypasses (including via `..`, symlinks, or case-folding
  tricks).
- Supply-chain concerns with bundled provider SDKs or transitive
  dependencies.
- Any path where the LLM can persist arbitrary instructions for future
  sessions (skills, saved-agent configs, etc.).

Likely out-of-scope:

- The LLM itself making mistakes within its permitted sandbox — that's
  a capability-planning problem, not a security bug.
- Denial-of-service caused by a user handing the agent a literally
  unbounded task. We do enforce iteration / cost / size caps, but the
  agent is not a sandboxing system for hostile local users.
- Issues that require the user to explicitly opt out of a security
  control (`--include-sensitive`, `--yes`, explicit
  `permissions: 'accept-all'`, etc.) and then be surprised.
- Bugs in third-party model providers or LLMs themselves. If the issue
  is in how agent-do *handles* their output, that's in scope; if it's
  an issue with the upstream API, please report it there first.

## Safe Harbor

We won't pursue legal action against you for good-faith security
research conducted under this policy, provided you:

- make a good-faith effort to avoid privacy violations, destruction of
  data, and interruption of service;
- only test against systems you own or have explicit permission to test;
- give us reasonable time to respond before any public disclosure;
- don't exploit the finding beyond what's necessary to demonstrate the
  issue.

We will publicly thank researchers who help us improve agent-do's
security — on the advisory, in release notes, and (if desired) in the
README.
