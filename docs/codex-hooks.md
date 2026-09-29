# Codex Stop verification gate

This is a Codex adaptation of `bin/gstack-verify-gate`, not a default
part of `./setup`. It uses the native `Stop` hook supported by Codex CLI
0.156.1. `SessionEnd` is advisory and cannot keep a turn open; do not use it
for verification.

## Global installation

Register the adapter once in `~/.codex/hooks.json` using an absolute path to
this checkout and the `--global` argument:

```json
{
  "hooks": {
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "/absolute/path/to/gstack/hosts/codex/hooks/stop-verify --global",
        "timeout": 60
      }]
    }]
  }
}
```

Merge with existing global hooks rather than replacing them. Review and trust
the new entry in Codex `/hooks`, then start a new session. To uninstall,
remove only this handler from `~/.codex/hooks.json`; keep other hooks and
plugin trust settings. Do not also register the project-local handler below
for the same repository, or its check can run twice.

Global registration makes the hook available in every Codex session. It
**enforces verification only in Git repositories whose root `AGENTS.md`
contains a `gstack:verify:` declaration**. It silently skips projectless
sessions and repositories without a declaration. A skip is not verification
success. Once a declaration exists, an empty or untrusted command is a
failure, not a skip. Each declared command still needs explicit per-repository
trust with `bin/gstack-verify-gate --codex --trust`.

## Project-local installation and contract

1. At the Git repository root, declare one verification command in `AGENTS.md`:
   `<!-- gstack:verify: bun test -->`. No declaration is **unverified**, never
   a pass. The hook does not guess a command.
2. From that repository, explicitly trust the exact command with
   `path/to/gstack/bin/gstack-verify-gate --codex --trust`. A changed command
   requires trust again. The trust store and grant audit are shared with the
   existing gate; neither Codex nor gstack runs an untrusted declaration.
3. Add this entry to the project's `.codex/hooks.json` (merge with existing
   hooks; do not replace them), using an absolute path to this checkout:

   ```json
   {
     "hooks": {
       "Stop": [{
         "hooks": [{
           "type": "command",
           "command": "/absolute/path/to/gstack/hosts/codex/hooks/stop-verify",
           "timeout": 60
         }]
       }]
     }
   }
   ```

   Review and trust the hook in Codex `/hooks`, then start a new session.
   To remove it, delete only this handler from `.codex/hooks.json` and revoke
   its Codex hook trust in `/hooks`; keep unrelated handlers.

On every `Stop`, the adapter runs the declared check from the Git root. A
passing check allows completion. A failed, missing, untrusted, timed-out, or
errored check continues the turn with the reason and log path. The adapter
retains full local logs under `${GSTACK_HOME:-~/.gstack}/verify-gate-codex/`.
Each session/repository failure episode allows at most three automatic
continuations. A further failure ends that episode with a visible **RED,
unverified** warning, not a success claim; it cannot force an agent to give a
truthful final answer. A new user turn starts a new episode. Checks are rerun
at every stop, so a code change cannot reuse an earlier pass.

The hook command has a 60-second Codex timeout; the adapter gives the check
50 seconds to finish so it can report a timeout as a failure. Do not put
secrets in the declared command or its output: logs are local and private to
the user but contain the command's stdout and stderr.

## Validation

Run `bun test test/verify-gate.test.ts test/codex-stop-verify.test.ts` for
trusted pass, failure/re-entry, missing/untrusted configuration, timeout, and
bounded failure. A live Codex session must separately demonstrate that a
trusted project hook actually fires, continues after failure, and completes
only after a corrected check. Unit tests alone do not prove hook trust or
runtime behavior.

### User-style acceptance scenario

In a disposable Git repository, put `<!-- gstack:verify: ./check.sh -->` in
`AGENTS.md`, register the hook above, and trust both the declared command and
the project hook. Let `check.sh` fail when `READY` is absent and pass when it
exists. Ask Codex: "Finish without changing files. If the Stop check fails,
create `READY` and recheck." The first Stop must block, the next must pass,
and there must be two adapter logs with exit codes 2 and 0. Then make the
check always fail and ask Codex to report status without editing: after three
continuations it must stop and report **RED/unverified**, not success.

On macOS with Codex CLI 0.156.1, the fail → continue → fix → pass cycle was
reproduced in an isolated fixture both before and after normal `/hooks` trust.
The first automated run bypassed hook trust solely for that vetted fixture;
the second used normal trust with no bypass flag. The persistent-failure run
also stopped after three continuations and reported RED. Those initial runs
used only the project-local hook.

The global variant was then registered and trusted in `~/.codex/hooks.json`.
With the fixture's project-local hook removed, a fresh Codex session again
failed, continued, fixed `READY`, and passed using the global hook alone. A
fresh session in a Git repository without any declaration finished normally
and created no verification state or log. Other Codex versions remain
unverified.
