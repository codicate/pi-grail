# pi-grail

Minimal extension bootstrap for the **released Pi CLI** and TypeSafe Jev. Uses
the official `@typesafe-ai/sdk` directly. It does not depend on `pi-jev`, review
workers automatically, select signals, intercept tools, or modify either Pi or
pi-subagents. API calls happen only when explicitly requested.

## Setup

Requires Node.js 22.19+ and a production Pi install:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.87.1
npm ci --ignore-scripts
npm run link
pi install npm:pi-subagents@0.71.0
```

`npm run link` registers this checkout's absolute path in Pi's personal settings.
Pi reads source files from here rather than a copied package. After editing,
use `/reload` in an interactive Pi session or restart it. TypeScript extensions
load directly, without a build step. `npm run dev`, `npm run pi:status`, and the
CLI smoke test resolve the **global production binary**, bypassing npm's local
`node_modules/.bin/pi`. The dev dependency is the same released version and is
present for types, not a Pi fork.

Project trust: `npm run dev` approves this checkout's project resources for that
invocation, including `.pi/agents/grail-reviewer.md`. Ordinary `pi` prompts for
trust when needed. The reviewer persona is available to pi-subagents but is not
automatically dispatched. It uses your normal configured subagent model.

## Configure Jev

Create a key at <https://console.typesafe.ai/settings/keys>, then run in your own
terminal:

```sh
npm run jev:auth
npm run jev:models
npm run jev:test
```

Input is hidden. The key is stored at
`~/.pi/agent/secrets/typesafe_api_key` with mode `0600`, outside the repository.
The command will not overwrite an existing key. For a password-manager pipe,
use `npm run jev:auth -- --stdin`. Do not put a key in chat or a command argument.

`TYPESAFE_API_KEY` takes precedence over the key file. `PI_GRAIL_API_KEY_FILE`
overrides its location; `PI_CODING_AGENT_DIR` changes the default Pi config root.
Optional `TYPESAFE_BASE_URL` is the API root **without `/v1`**. Model selection is
`PI_GRAIL_JEV_MODEL`, then `TYPESAFE_DEFAULT_MODEL`, then `jev-latest`.
Configuration is read on each call, so saving a key does not require restarting.
`.env.example` is documentation; `.env` files are not automatically loaded.

## Use

```sh
npm run dev
```

Inside Pi:

```text
/jev status
/jev models
/jev test
/reload
```

Status is local and makes no API call. `models` lists your available TypeSafe
models. `test` sends a single small connectivity fixture and returns native API
answers. Requests have a 10-second timeout, support cancellation, and do not
automatically retry. Missing credentials and HTTP failures stay explicit errors.

The model-callable `jev_evaluate` tool accepts a raw `state`, a `questions` map
containing Choice, Noul, or Score questions, and an optional model. It returns
the SDK response unchanged, including probabilities, confidence, and usage.
No thresholds or Grail invocation decisions exist in this bootstrap.

The `/jev` commands work even before Pi's main LLM is authenticated. To use Pi
for ordinary agent work, start `npm run dev` and run `/login` for your preferred
provider (or configure that provider's API key). TypeSafe authentication is
separate from the generative model used by Pi and the reviewer.

## Verify and iterate

```sh
npm run typecheck
npm test
npm run test:pi
npm run pi:status
```

`test:pi` launches the actual global Pi CLI in RPC mode with the linked package
and installed pi-subagents. It uses a local HTTP fixture, not a paid model, and
verifies registration, no startup API calls, Jev requests, secret-free status,
and clean shutdown. It does not claim to test real Jev model quality or a real
generative worker. `npm run test:pi -- --isolated` loads this extension explicitly
against temporary Pi settings for diagnosis. `npm run jev:test` is the real
TypeSafe connectivity test and requires a real key.

Reference checkouts under `/tmp` are not used by these commands.

## Development references

- [Pi extensions](https://pi.dev/docs/latest/extensions)
- [Local Pi packages](https://pi.dev/docs/latest/packages)
- [pi-subagents integration](https://github.com/nicobailon/pi-subagents/blob/main/docs/extension-api.md)
- [TypeSafe SDK](https://docs.typesafe.ai/sdk/javascript)
- [TypeSafe skill](https://github.com/typesafe-ai/skills/tree/main/skills/typesafe-ai)
- [Pi extension development skill](https://github.com/Dwsy/pi-extensions-skill)

The development skills are installed outside this repository and are available
to both Codex and production Pi. Their examples
inform setup; the installed Pi 0.87.1 types take precedence when an older example
uses the previous `@sinclair/typebox` package name.
