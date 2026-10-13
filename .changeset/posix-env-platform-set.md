---
'agent-do': minor
---

The host sandbox's `exec()` now adds the Windows-only environment set (`SystemRoot`, `SystemDrive`, `windir`,
`COMSPEC`, `PATHEXT`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`,
`NUMBER_OF_PROCESSORS`, `PROCESSOR_ARCHITECTURE`) **only for Windows environment blocks**. Those names were
merged into the allowlist unconditionally after 0.8, so a POSIX parent that happened to define `APPDATA`,
`COMSPEC` or `TEMP` — a user-set variable, a wrapper script, a CI runner — forwarded them into every
model-initiated command, which is wider than the policy `docs/sandbox.md` states ("a small platform set is
added on top" on Windows). The Windows set and case-insensitive matching are both selected by the same
`caseInsensitive` flag in `pickExecEnv`, which defaults to `process.platform === 'win32'`, so POSIX children
now receive exactly the documented allowlist.

`llms.txt` also names the default allowlist and the `envPassthrough` / `inheritEnv` / `cwd` options for
`createHostSandbox`, which the 0.8 change added to the API without updating that summary.
