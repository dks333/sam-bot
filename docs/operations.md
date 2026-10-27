# Operations

## Native agent setup

Sam Bot requires Node 22.14+ in the 22.x line or Node 23.6 and newer. Its SQLite binding requires Node-API 10; Node 22.13 and Node 23.0 through 23.5 cannot load it. Use the declared pnpm 11.9.0 version.

Codex uses the bundled `@openai/codex` CLI unless `codex.executablePath` selects an installed executable. Set `codex.home` to your existing profile, normally `~/.codex`, to share its settings. The native configuration supplies model, reasoning effort, tools, memory, sandbox, and approval policy. Desktop host integrations may differ even with the same profile.

Claude uses the locally installed `claude` CLI. It requires version 2.1.306 or newer within the 2.1 release line and a local Pro, Max, Team, or Enterprise subscription sign-in. Run `claude auth login` and `claude auth status` locally. Claude mode checks the subscription without copying OAuth tokens or falling back to API billing. Model access and usage limits come from the account. Optional `claude.executablePath` selects an absolute executable path; `claude.model` selects an available model.

A workspace can be a repository or a parent directory containing several repositories. Agent tools execute on your computer, which must stay online. Model requests still use the agent's provider.

## Settings and state

Sam Bot uses `~/.slack-codex/`. These compatibility names do not mean it runs Codex when Claude is selected.

| File                                 | Purpose                                                         |
| ------------------------------------ | --------------------------------------------------------------- |
| `config.json`                        | Slack authorization, workspaces, provider, and executable paths |
| `secrets.env`                        | Slack credentials, saved with mode 0600                         |
| `native-conversations.sqlite`        | Codex conversations and delivery receipts                       |
| `native-conversations-claude.sqlite` | Claude conversations and delivery receipts                      |
| `claude/`                            | Claude session and recovery evidence                            |
| `bridge.sqlite`                      | Historical records and runtime ownership                        |
| `runtime-health.json`                | Runtime readiness and Slack connection status                   |
| `logs/`, `releases/`                 | Service logs and managed releases                               |

The `SLACK_CODEX_HOME` override and existing service identifiers retain their names. `pnpm codex-slack` remains a CLI alias. Existing records and schema migrations remain for compatibility.

Live settings are outside the checkout. Setup can import an optional repository `.env` based on [the example](../.env.example). The running service reads the saved configuration and secrets. See [product-config.example.json](../config/product-config.example.json) for supported settings and [product.ts](../apps/bridge/src/config/product.ts) for setup defaults. Codex and Claude read their native settings separately. Keep tokens, databases, logs, and conversation state out of Git.

Interactive setup hides Slack token entry and never displays saved token values. Press Enter at a token prompt to keep an existing saved value. Restart the bridge after changing the saved owner, team, or allowed channels. On startup, retained requests that no longer pass that policy are permanently barred from resuming or delivering pending replies, even if access is later restored. Their records remain available for local inspection; uncertain work is never replayed. Already delivered messages cannot be recalled, and revocation does not prove that detached tools stopped. Restoring access allows new requests.

The first startup of this version upgrades both native conversation ledgers to schema 2. Releases that support only schema 1 cannot reopen those ledgers. Managed activation checks schema compatibility and retains unresolved execution evidence before allowing a switch.

## Conversations and permissions

Each configured owner and Slack thread maps to a persistent session for the selected provider. A new top-level message starts a conversation. Channel replies must mention the bot. Codex follow-ups steer an active turn; images wait for that turn to finish. Claude follow-ups queue until the current turn ends.

Slack receives a working indicator and the final response, without intermediate commentary. Long answers arrive in ordered parts. Durable delivery records and Slack receipts let the bridge reconcile ambiguous sends before retrying. A delivery failure does not rerun the task.

Native settings decide when approval is required. Claude inherits its permission mode and allow rules, including auto mode. The bridge does not enable permission bypass or add operating-system sandbox isolation. Approvals bind to the owner, conversation, request, and turn. They expire when the request resolves. A one-time approval never becomes a persistent grant, and an ordinary follow-up does not grant permission.

Claude supports permission prompts for Bash, Edit, Write, and NotebookEdit, plus AskUserQuestion. Other permission requests are denied. Use a regular local session for unsupported tools. The bridge's Claude subprocess has no attachable local approval screen. Secret entry, connector login, and verification must happen locally. Read the [security model](../security.md) before connecting a project.

Reply `stop` in the active thread to request an interruption. Sam Bot confirms cancellation only after the native turn stops. The legacy text controls `/codex stop` and `/codex status` remain accepted.

## Switch providers

`pnpm sam-bot agent status` reports the saved selection. Use `pnpm sam-bot agent use claude` or `pnpm sam-bot agent use codex` to change it.

The setting is `runtime.agentProvider`; an absent value means Codex. Saving it does not restart the running bridge. Finish or stop current work, stop the existing runtime, then start it again. Each provider keeps separate history for the same Slack thread. Switching back restores that provider's mapping.

## Managed service

On macOS, stage a release from a clean, committed checkout:

```sh
pnpm sam-bot service stage
pnpm sam-bot service activate <release-id>
pnpm sam-bot service status
pnpm sam-bot logs
```

Activation checks both provider ledgers and historical records before replacing a runtime. Active or uncertain work, pending selected-provider finals, and ambiguous deliveries block activation. A known failed final in an idle inactive provider can remain saved without blocking an upgrade when runtime ownership is verified.

Release manifests track historical and native schemas separately. A schema upgrade prevents automatic rollback to an incompatible release. Codex readiness checks the configured model and inherited settings; Claude readiness checks its version and subscription sign-in. Slack connection readiness does not prove that an agent task succeeded.

## Recover uncertain work

A restart never automatically replays a dispatched turn with an unknown outcome. Inspect the project before asking the agent to continue. An uncertain mapped turn must reach a confirmed terminal state before the conversation accepts more work.

For an uncertain Claude session, stop the bridge and independently confirm that Claude and its tools have stopped. A parent process exiting does not prove that detached tools stopped. Find the session UUID under `~/.slack-codex/claude/`, then run:

```sh
pnpm sam-bot agent recover SESSION_UUID --confirm-stopped
```

Recovery preserves the original evidence and unknown outcome and cancels queued follow-ups. It does not kill independent processes, prove success, or replay the task. Restart the bridge and send a new instruction after recovery.

## Source layout

[`index.ts`](../apps/bridge/src/index.ts) starts the runtime. [`native-main.ts`](../apps/bridge/src/native-main.ts) selects the Codex App Server adapter or local Claude CLI adapter. Both use the same Slack authorization, interaction controls, persistence, and final delivery. Socket Mode connects without a public HTTP endpoint. The `cli/` directory handles setup, diagnostics, logs, provider selection, recovery, and managed releases.

Run `pnpm type`, `pnpm lint`, `pnpm format`, `pnpm test`, and `pnpm build` for development checks. Tests cover native protocols, authorization, interruption, execution uncertainty, delivery, and compatibility with existing state.
