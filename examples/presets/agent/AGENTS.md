# Prowl for agents

This project uses [Prowl](https://prowl.tools) for end-to-end tests. Prowl runs
declarative YAML "hunts" against web apps (and native macOS apps). This file
documents the machine-readable surface an AI agent or script should use to drive
Prowl programmatically. Everything here is a stable contract: prefer `--json`
output and exit codes over parsing human-formatted text.

The CLI (with `--json`) and the MCP server described below are the primary,
documented surfaces. The `prowl-tools` package also exports a Node API
(`import { runHunt, runSuite, listHunts } from "prowl-tools"`) for embedding
Prowl in a script; it is typed but not yet documented, so prefer the CLI/MCP
contract where either works.

## Commands with JSON output

### `prowl list --json`
Lists the hunts in `.prowl/hunts/`, in run order, as a JSON array. Use it to
discover what can be run.

### `prowl run <hunt> --json`
Runs a single hunt and prints its full result object as JSON to stdout. `<hunt>`
is the file name under `.prowl/hunts/` (e.g. `hello` for `.prowl/hunts/hello.yml`).
On an internal error it prints `{ "status": "fail", "exitCode": 1, "hunt": "<name>", "error": "<message>" }`.

```bash
prowl run hello --json
```

### `prowl ci --json`
Runs every hunt and prints an aggregate `CiResult` object (per-hunt statuses,
counts, duration) as JSON to stdout. Supports `--include-tags` / `--exclude-tags`
to filter and `--parallel <n>` to run hunts concurrently. Add `--junit` to also
write JUnit XML.

```bash
prowl ci --json
prowl ci --json --include-tags smoke
```

## Exit codes

Check the process exit code — it is the reliable pass/fail signal for scripts.

| Command | Exit 0 | Exit 1 | Exit 2 |
|---|---|---|---|
| `prowl run <hunt>` | hunt passed | hunt failed or errored | — |
| `prowl ci` | all hunts passed | one or more hunts failed | no hunts found, or all hunts skipped by tag filters |

## MCP server (`prowl mcp`)

`prowl mcp` starts a [Model Context Protocol](https://modelcontextprotocol.io)
server over stdio, exposing Prowl as a fixed set of tools so an agent never has
to choose shell commands. By default it operates on the current directory's
`.prowl/` project.

```bash
prowl mcp
prowl mcp --projects <registry.yml>   # target multiple repos by name
```

Tools exposed:

- **`list_hunts`** — list all hunts in the target project, in run order.
- **`run_hunt`** — run a single hunt by `hunt` name and return its full result.
- **`run_suite`** — run all hunts and (by default) log failures as deduplicated
  bug tickets in the project backlog; returns pass/fail/skip counts and any
  `QA-NNN` ticket ids created. Accepts `includeTags`, `excludeTags`, `parallel`,
  and `logBugs`.
- **`list_projects`** — list projects registered with the server (empty unless
  started with `--projects`).

When a registry is configured via `--projects`, every tool accepts an optional
`project` argument to target a registered repo instead of the current directory.

## Secrets

Hunts interpolate secrets with `{{VAR}}`. Put values in `.prowl/.env` (copy
`.prowl/.env.example`); they are git-ignored and redacted from all reports and
JSON output.
