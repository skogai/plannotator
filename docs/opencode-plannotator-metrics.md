# OpenCode Plannotator Cache Metrics

This is a manual test for OpenCode/Plannotator token and cache behavior.

The question is not "does Plannotator add work?" It does. The question is:

- does Plannotator reset the OpenCode session?
- does cache read drop to zero after Plannotator feedback/approval?
- does the follow-up message stay in the same OpenCode session?
- are there separate wasteful retries, such as invalid tool calls?

## Setup

Use the same:

- OpenCode version
- model/provider
- working directory shape
- plan mode
- permission settings
- final requested plan shape

Disable Plannotator for the baseline run. Enable Plannotator for the Plannotator run.

The cleanup helper removes Plannotator OpenCode commands and caches:

```sh
scripts/remove-opencode-plannotator.sh --dry-run
scripts/remove-opencode-plannotator.sh
```

## Prompts

Baseline prompt:

```text
[METRIC_RUN_YYYYMMDD_PAIRN_BASELINE]
Create a plan to create a simple one-page website about cats. Include an image. Do not ask clarifying questions. Keep this in plan mode only. Do not implement.
```

Baseline follow-up after the plan:

```text
Are we ready? No mistakes?
```

Plannotator prompt:

```text
[METRIC_RUN_YYYYMMDD_PAIRN_PLANNOTATOR]
Create a plan to create a simple one-page website about cats. Do not ask clarifying questions. Keep this in plan mode only. Do not implement.
```

Plannotator denial feedback:

```text
Add image.
```

Approve the revised plan with **No switch**, then send:

```text
Are we ready? No mistakes?
```

## Find Sessions

List recent sessions:

```sh
bun run metrics:opencode -- --list
```

Search by marker:

```sh
bun run metrics:opencode -- --find METRIC_RUN_YYYYMMDD_PAIRN
```

If the script cannot find the DB:

```sh
opencode db path
bun run metrics:opencode -- --db /path/from/opencode/db/path --list
```

## Compare Sessions

```sh
bun run metrics:opencode -- baseline=ses_xxx plannotator=ses_yyy
```

The report goes to:

```text
debug/opencode-session-metrics/
```

This directory is ignored because it contains local session IDs and local machine paths.

## Metrics Captured

The collector reads OpenCode's SQLite DB and records:

- session cost
- input/output/reasoning tokens
- cache read/cache write tokens
- assistant call count
- tool call count
- `submit_plan` call count
- per-assistant-call token/cost rows
- per-tool-call rows

## Pair 2 Result

OpenCode 1.15.10, DeepSeek V4 Flash, Plannotator 0.19.21.

Baseline:

- session: `ses_1a7eef96effe4WHVps6Ze0gSYL`
- cost: `$0.004107`
- input: `25,514`
- output: `1,035`
- reasoning: `635`
- cache read: `24,192`
- assistant calls: `4`
- tool calls: `2`

Plannotator:

- session: `ses_1a7ebc755ffeIG2ewnz16Di7R5`
- cost: `$0.006731`
- input: `39,396`
- output: `2,769`
- reasoning: `795`
- cache read: `77,824`
- assistant calls: `7`
- tool calls: `5`
- `submit_plan` calls: `2`

Observed:

- Plannotator did not reset the OpenCode session.
- The follow-up message stayed in the same session.
- Cache read did not drop to zero after approval/follow-up.
- One invalid tool call happened during revision.

Invalid tool call row:

- cost: `$0.0008022672`
- input: `3,998`
- output: `455`
- reasoning: `273`
- cache read: `13,824`

## Limits

This uses OpenCode's local DB. It may not include background provider calls that OpenCode does not store as assistant messages.

For billing-grade proof, also capture OpenCode Go/provider request rows by session/request ID.

If cache read is `0`, that alone does not prove session reset. It can also mean provider reporting, OpenCode Go reporting, or UI aggregation did not expose cache-read tokens for that call.
