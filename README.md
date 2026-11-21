# stewie

Bounded task-graph runner for OpenCode. It gives an OpenCode setup the things that
make Claude Code / Codex CLI / Grok CLI feel "robust" — planning, durable runs,
parallel workers, verification gates, resume-after-crash — while refusing to let
those workers swap or freeze the machine.

```
stewie serve             # local dashboard: goal box, live workers, logs, stop
stewie plan "<goal>"     # planner agent writes .stewie/graph.json
stewie run               # execute the graph, 2 workers at a time, guard on
stewie status            # per-node state, always on disk
stewie resume            # pick up after a crash or Ctrl-C
```

## Why

Agent CLIs differ less in the model than in the harness around it:

| Capability | Claude Code | Codex CLI | Grok CLI | OpenCode (before) | Here |
| --- | --- | --- | --- | --- | --- |
| Plan before edit | plan mode | plan/ask mode | yes | `plan` agent exists | `stewie plan` writes a graph + `planner` agent |
| Parallel workers | Task subagents | yes | yes | subagent tool | graph nodes, bounded concurrency |
| Durable / resumable run | sessions | `resume` | sessions | session only | `state.json` per node, `stewie resume` |
| Verify before "done" | hooks / tests | approvals + tests | tests | manual | `verify` per node, failure = retry then fail |
| Crash safety | checkpoints | sandbox | sandbox | snapshots | atomic state, process groups, timeouts |
| Resource discipline | — | sandbox | — | none | RAM/load guard + heavy lane + nice |
| Undo / inspect | `/rewind` | diff | diff | snapshots | per-run logs + per-node logs |

## Mac apps

`scripts/build-app.sh` installs two one-click launchers to `/Applications`:

| App | Opens |
| --- | --- |
| **Ok Stewie.app** | your web app at `127.0.0.1:8093` (starts `serve-web.mjs` if it is down) — uses the real Ok Stewie icon |
| **Stewie Console.app** | the agent dashboard at `127.0.0.1:4321` — generated mark, dev tool |

`STEWIE_REPO=/path/to/repo open -a "Stewie Console"` skips the folder picker.

Icons: `scripts/make-icns.py` masks any square PNG into a macOS squircle and builds the `.icns`;
`scripts/make-icon.mjs` draws the console mark from scratch with no dependencies.

## Commands

| Command | What it does |
| --- | --- |
| `stewie init [--goal "…"]` | create `.stewie/graph.json`, add `.stewie/` to `.gitignore` |
| `stewie plan "<goal>"` | run the `planner` agent, validate its JSON, write the graph |
| `stewie run [graph.json]` | execute the graph |
| `stewie resume [runId]` | continue the latest (or named) run; rewinds `running` nodes |
| `stewie status [runId]` | node table for a run |
| `stewie logs <node> [runId]` | full log of one node |
| `stewie graph [graph.json]` | dependency listing |
| `stewie verify [cmd]` | run detected `typecheck`/`lint`/`test` once |
| `stewie doctor` | machine + repo readiness |
| `stewie serve [--port]` | local dashboard at `127.0.0.1` (loopback only, no deps, no watchers) |

`run` flags: `--concurrency N`, `--model`, `--agent`, `--budget-min N`,
`--max-nodes N`, `--fail-fast`, `--dry-run`, `--force`.

## Graph format

```json
{
  "goal": "Add passkey re-auth to the settings screen",
  "concurrency": 2,
  "nodes": [
    { "id": "explore", "task": "Map the auth code and list the test commands." },
    { "id": "implement", "deps": ["explore"], "task": "Implement it.", "verify": ["pnpm typecheck"] },
    { "id": "check", "deps": ["implement"], "kind": "shell", "command": "pnpm test -- auth" }
  ]
}
```

- `kind: "agent"` (default when `task` is set) runs a headless `opencode run` in a child session.
- `kind: "shell"` runs a command in `zsh -lc`.
- `deps` gate start; completed nodes hand their `SUMMARY:` block to dependants.
- `verify` commands run after a node and decide success — not the model's opinion.
- Commands matching test/typecheck/lint/build, and any node with `verify`, run in
  the single `heavy` lane so two test suites never fight for the CPU.

## The guard (why it won't crash the machine)

Before every start, `stewie` checks free RAM (via `vm_stat` on macOS, not the
lying `os.freemem()`) and 1-minute load. If either is over the line it holds —
logging once a minute — and resumes when the machine frees up. A 3-minute stall
timer lets exactly one node through so a permanently busy machine cannot
deadlock the run.

Defaults: concurrency `min(3, floor(cores / 4))` (2 on an 8-core box), minimum
free RAM `max(1.5 GB, 10% of RAM)`, max load `cores × 1.0`, node timeout 15 min,
workers started with `nice -n 10`, one heavy job at a time.

## Layout of a run

```
.stewie/
  graph.json
  latest
  runs/<runId>/
    graph.json          # frozen copy — resume uses this, not the current file
    state.json          # node status, attempts, verify results
    logs/<node>.log
    logs/<node>.summary.txt
    diffs/<node>.stat    # git diff --stat captured when the node finished
    diffs/<node>.patch   # full diff (fuzzy attribution when nodes run in parallel)
```

## Safety

- Children get their own process group; timeouts kill the group (`SIGTERM`, then `SIGKILL`).
- State is written atomically (`state.json.tmp` → rename), so a hard kill never corrupts a run.
- `verify` failure is a failure even when the model says it succeeded.
- Graph nodes never commit, push, or deploy — the prompt forbids it and the
  global permission rules block the catastrophic cases.
