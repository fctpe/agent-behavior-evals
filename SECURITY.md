# Security

## What the judge reads

- A trace is a recording of an agent doing real work, so it can carry whatever that agent handled: customer messages, retrieved documents, tool arguments, tokens pasted into a prompt. This tool does not classify or redact any of it — `readTrace` maps fields and does not interpret (`src/trace.ts`). **Redact before judging, not after.**
- Judging sends trace content to the Anthropic API. The judge pulls events through its tools rather than receiving the whole trace up front, so what leaves the machine is what it actually asked for — previews capped at 300 characters, full events at 4 000 (`src/judge.ts`) — but it is still the trace, and every event it inspects lands in a model context. Behavior specs travel with it, so a spec is a public document, not a place for internal detail.
- `behaveval validate` parses and structurally checks specs with no model call and no API key. It is the safe command to run against material you have not cleared.
- Trace files and spec directories are read from the paths given on the command line; nothing is discovered, fetched or written outside them.

## What the judge can and cannot do

The judge is constrained deliberately — a judge that could read the repository it is judging could read the answer, and a judge whose verdicts depend on whose laptop it runs on is not a judge:

- **Tools:** `allowedTools` is exactly the three trace tools (`list_events`, `get_event`, `search_events`), served by an in-process MCP server that closes over the parsed trace object. `disallowedTools` names the built-ins — `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebFetch`, `WebSearch` — so they are removed from its context rather than merely unused.
- **Permissions:** `permissionMode: 'dontAsk'` denies anything not pre-approved instead of prompting, which is what makes the allowlist meaningful in a non-interactive CI run.
- **Configuration:** `settingSources: []` ignores the host's `CLAUDE.md` and settings files.

What that does **not** give you:

- **It is not an OS sandbox.** There is no container, no seccomp profile, no separate user. The restriction is over which tools the judge is offered, not over what the process could reach; it runs on your host with your environment, including `ANTHROPIC_API_KEY`. Treat `behaveval judge` as code you are choosing to run, and put the isolation at the layer that provides isolation.
- **It does not make `settingSources: []` a containment control.** Ignoring host config buys reproducibility — the same trace and the same spec should produce the same judgment on a laptop and in CI. It is not a defence against anything.
- **It does not neutralise the trace.** Trace content is untrusted input by construction: if the agent under test consumed attacker-controlled text, that text is now inside the evidence the judge is reading, and it can address the judge directly. Three things blunt it and none of them close it: the overall verdict is folded in code rather than asked of the model (`src/fold.ts`), a verdict citing no trace events is downgraded to `na` in code regardless of how confident the model was, and a `false` must quote a verbatim clause from the spec. A green result on a trace you do not control is worth what that trace is worth.

The failure path is closed by default. An unusable judge response is recorded as `na` with reason `judge_error`, never folded in as a pass, and an empty trace resolves to `na` without spending a model call.

## Outputs

- JUnit XML escapes `&`, `<`, `>` and `"` before writing judge reasoning into the report (`escapeXml`, `src/report.ts`). That matters because reasoning quotes the trace, and the trace is untrusted: unescaped, a crafted event could close a tag and forge test cases in whatever reads the XML.
- The console renderer writes that same reasoning to stderr unescaped, as terminal output is meant to be. Trace content containing terminal control sequences will reach your terminal — pipe to a file if that is a concern in your environment.
- The committed baseline holds spec names and verdicts only (`toBaseline`, `src/gate.ts`). No trace content is written into it, so a baseline is safe to commit to a public repository.

## Reporting

Open a GitHub security advisory or email the address on the profile of [@fctpe](https://github.com/fctpe). Please do not open public issues for vulnerabilities.
