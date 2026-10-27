# Sam Bot

Your coding setup, one Slack message away.

Send work to Codex or Claude Code running on your computer. Sam Bot uses your local checkout and agent configuration, then brings replies, questions, and supported approvals back to Slack.

## Why Sam Bot?

Your local agent already has skills, plugins, and tools you've signed in to. Sam Bot lets you use that setup from Slack, including on your phone.

| What you keep                  | Sam Bot on your computer                                          | Typical hosted agent in Slack                                         |
| ------------------------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Skills and plugins             | Uses what your native agent already loads locally.                | Repository skills and workspace/platform installs.                    |
| Authenticated MCP connections  | Reuses supported saved sign-ins in your native profile.           | Connections and credentials configured for that workspace.            |
| Working files                  | Your current branch, uncommitted changes, and local files.        | A separate clone or uploaded snapshot.                                |
| Tools and services             | Installed CLIs, dependencies, and reachable local services.       | Tools and services provisioned in that workspace.                     |
| Availability and parallel work | Your host stays online; tasks use your configured local checkout. | Managed execution, with isolated parallel workspaces where supported. |

Tool access follows your native agent's permissions and credential support. Sign-in steps stay local. This compares the usual hosted setup; local and self-hosted options also exist. [Comparison details and sources](docs/local-vs-cloud.md).

> "Reproduce this bug on my current branch and run the tests."

Built for one person operating their own bot. Your computer must stay online. Messages pass through Slack; model requests still go to your agent's provider.

## Set it up with your agent

Copy this into your local coding agent:

```text
Set up https://github.com/dks333/sam-bot on this computer.
Read the README and repo instructions; use the declared Node/pnpm versions.
Ask which agent (Codex or Claude Code), project, and Slack team, owner user ID,
and allowed channel IDs I want.
Inspect configuration/runtime. Reuse existing state; ask before replacing it.
Never start a second runtime against the same state.
Guide me through Slack app creation from the manifest and native agent login.
Have me enter tokens locally in setup; keep them out of chat and commits.
Run pnpm sam-bot setup only if needed, with its connectivity checks.
Run pnpm sam-bot doctor. If stopped, use pnpm sam-bot run in the foreground.
Ask me to send a Slack test message. Verify the actual reply before claiming success.
Report any remaining input or failed step.
```

## What you need

Choose either Codex or Claude Code.

| Requirement   | Details                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| Node and pnpm | Node 22.14+ in the 22.x line or Node 23.6+, pnpm 11.9.0                  |
| Slack         | Permission to install an app, plus bot and Socket Mode tokens            |
| Codex         | A local Codex sign-in                                                    |
| Claude Code   | Version 2.1.306+ within 2.1; local Pro, Max, Team, or Enterprise sign-in |

Your computer must stay online. Agent tools run there; model requests still go to the agent's provider. Claude mode uses your subscription rather than an API key. Account limits still apply.

## In Slack

DM Sam Bot or mention it in an allowed channel. Replies in the same thread keep the conversation going; a new top-level message starts a conversation. Mention the bot on each channel reply.

| Action                                     | What happens                                              |
| ------------------------------------------ | --------------------------------------------------------- |
| Send a task                                | Slack shows a working indicator, then the final response  |
| Follow up during Codex work                | Steers the active turn                                    |
| Follow up during Claude work               | Waits for the current turn to finish                      |
| Reply `stop` (mention the bot in channels) | Requests an interruption; the agent confirms when stopped |
| Agent asks a question or permission        | Answer or use the approval controls in Slack              |

Sam Bot accepts work from your configured owner and channels. Your agent's settings determine when approval is required. Complete secret entry and sign-in steps locally. See the [security model](security.md).

## Commands

| Command                         | Purpose                                   |
| ------------------------------- | ----------------------------------------- |
| `pnpm sam-bot doctor`           | Check local configuration and connections |
| `pnpm sam-bot run`              | Run in the foreground                     |
| `pnpm sam-bot agent status`     | Show the saved provider                   |
| `pnpm sam-bot agent use claude` | Select Claude Code; restart separately    |
| `pnpm sam-bot agent use codex`  | Select Codex; restart separately          |

<details>
<summary>Manual setup</summary>

Create and install a Slack app using [the manifest](slack-app-manifest.yaml), get its tokens, and sign in to your chosen agent locally. Then run:

```sh
git clone https://github.com/dks333/sam-bot.git
cd sam-bot
pnpm install --frozen-lockfile
pnpm sam-bot setup
pnpm sam-bot doctor
pnpm sam-bot run
```

Codex is the default. For Claude, use `pnpm sam-bot setup --agent claude` instead. Its login commands are `claude auth login` and `claude auth status`. Setup preserves existing configuration unless you explicitly choose replacement.

</details>

Read [operations](docs/operations.md) for settings, background service, switching agents, and recovery. Development checks: `pnpm type`, `pnpm lint`, `pnpm format`, `pnpm test`, `pnpm build`.

[MIT license](license).
