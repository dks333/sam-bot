# Sam Bot

**Your coding agent in Slack.**

Sam Bot connects Slack to Codex or Claude Code running on your computer. Send a task in a DM or mention, and your agent works in your project with its existing account, tools, and settings. Keep the conversation going in the same thread.

Agent tools run on your computer. Model requests still go to the agent's provider, and your computer must stay online for Sam Bot to work.

## Get started

You need Node.js 22.13 or newer, pnpm 11.9.0, a Slack workspace where you can install an app, and a local Codex or Claude Code sign-in.

Create a Slack app using [slack-app-manifest.yaml](slack-app-manifest.yaml). Install it in your workspace and obtain a bot token and an app-level Socket Mode token. Setup asks for these tokens, your Slack team and user IDs, an allowed channel, and the project directory where your agent should work.

```sh
git clone https://github.com/dks333/sam-bot.git
cd sam-bot
corepack enable
pnpm install --frozen-lockfile
pnpm sam-bot setup
pnpm sam-bot doctor
pnpm sam-bot run
```

Codex is the default. To start with Claude Code, replace the setup command with `pnpm sam-bot setup --agent claude`. Claude requires version 2.1.306 or newer within the supported 2.1 release line and a local Pro, Max, Team, or Enterprise subscription sign-in:

```sh
claude auth login
claude auth status
```

Claude mode uses that subscription sign-in without copying its OAuth tokens or falling back to API billing. Your account's model access and usage limits still apply.

For Codex, Sam Bot uses the bundled `@openai/codex` CLI unless you set `codex.executablePath` to an installed executable. Set `codex.home` to your existing profile, normally `~/.codex`, to share its settings. A project directory can be a repository or a parent directory containing several repositories.

## Use it in Slack

DM Sam Bot or mention it in an allowed channel. A new top-level message starts a conversation; replies in its thread keep the selected agent's history.

- Ask for work in ordinary language, such as “find the cause of this failing test.”
- Follow-ups steer an active Codex turn. Claude follow-ups wait for its current turn to finish.
- Reply with `stop` in the same thread to request an interruption. The agent confirms when its turn has stopped.
- Answer native questions and approve requested actions through the owner-bound Slack controls.

Slack shows a working indicator and the final response. Sam Bot does not post intermediate agent commentary. Long answers arrive in ordered parts, and delivery recovery checks existing receipts before retrying an ambiguous send.

The configured owner, team, and channel policy control who can dispatch work. Native settings decide which actions need approval. Codex inherits its sandbox and approval settings; Claude inherits its permission mode and allow rules, including auto mode. Sam Bot does not turn on permission bypass or add an operating-system sandbox. Unsupported interactions are rejected; secret entry, connector sign-in, and verification happen locally. See [security.md](security.md).

## Choose an agent

```sh
pnpm sam-bot agent status
pnpm sam-bot agent use claude
pnpm sam-bot agent use codex
```

`agent use` saves the selection; it does not restart a running bridge. Finish or stop current work, stop the existing runtime, then start it again. Each provider has separate conversation history. Switching back restores that provider's mapping for the Slack thread.

## Settings and local state

Sam Bot keeps the existing `~/.slack-codex/` directory for compatibility:

| File                                 | Purpose                                                             |
| ------------------------------------ | ------------------------------------------------------------------- |
| `config.json`                        | Slack authorization, projects, selected agent, and executable paths |
| `secrets.env`                        | Slack credentials, saved with mode 0600                             |
| `native-conversations.sqlite`        | Codex conversations and delivery receipts                           |
| `native-conversations-claude.sqlite` | Claude conversations and delivery receipts                          |
| `claude/`                            | Claude session and recovery evidence                                |
| `runtime-health.json`                | Runtime readiness and Slack connection status                       |
| `logs/`, `releases/`                 | Service logs and managed releases                                   |

`bridge.sqlite` retains historical records and runtime ownership. Existing state, service identifiers, and the `SLACK_CODEX_HOME` override retain their names. The `pnpm codex-slack` command remains an alias for existing installs.

Live settings are outside this checkout. Setup can import an optional repository `.env` based on [.env.example](.env.example); the running service reads the saved configuration and secrets. [product-config.example.json](config/product-config.example.json) shows supported settings, and built-in setup defaults live in [product.ts](apps/bridge/src/config/product.ts). Codex and Claude read their own native settings.

## Service and recovery

On macOS, stage and activate a managed release from a clean, committed checkout:

```sh
pnpm sam-bot service stage
pnpm sam-bot service activate <release-id>
pnpm sam-bot service status
pnpm sam-bot logs
```

Activation checks for active or uncertain work before replacing a runtime. A restart does not automatically replay dispatched work with an unknown outcome. Inspect the project before asking the agent to continue.

For an uncertain Claude session, stop the bridge and independently confirm that Claude and its tools have stopped. Then use the session UUID recorded under `~/.slack-codex/claude/`:

```sh
pnpm sam-bot agent recover SESSION_UUID --confirm-stopped
```

Recovery preserves the original evidence and unknown outcome and cancels queued follow-ups. It does not kill independent processes, prove success, or replay the task. Restart the bridge and send a new instruction after recovery.

## How it works

`apps/bridge/src/index.ts` starts the runtime. `native-main.ts` selects the Codex App Server adapter or the local Claude CLI adapter. Both share Slack authorization, interaction controls, persistence, and final delivery. Socket Mode connects without a public HTTP endpoint.

Sam Bot is the connection to your agent. Model behavior, available tools, and native permissions come from the selected agent and its configuration. Desktop-only host integrations may differ.

## Development

```sh
pnpm type
pnpm lint
pnpm format
pnpm test
pnpm build
```

Tests cover native protocol behavior, authorization, interruption, uncertain execution, durable delivery, and compatibility with existing state.

## License

[MIT](license). Third-party dependencies retain their own licenses.
