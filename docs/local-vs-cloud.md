# Sam Bot and cloud agents in Slack

Sam Bot is useful when you've already configured Codex or Claude Code on your computer and want to use that setup from Slack. The difference is the execution environment and the setup it can reuse.

## What Sam Bot reuses

| Local setup                               | How it carries over                                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Skills, plugins, and project instructions | The selected native agent loads its supported user and project configuration.                                 |
| Authenticated MCP connections             | The native agent can reuse supported saved credentials for its configured servers.                            |
| Working checkout                          | Tasks run against your selected directory, including uncommitted and ignored files the agent can access.      |
| Development tools and services            | Tools run on the host, with its installed dependencies and reachable services, subject to native permissions. |

Sam Bot uses the configured Codex home and working directory, or Claude's normal local configuration in the selected directory. It doesn't maintain a second copy of your skills, plugins, or MCP configuration. Changes follow the agent's own reload rules; some need a new session or restart. Codex and Claude keep separate Sam Bot conversations, rather than attaching to an arbitrary editor session.

Saved authentication is reusable when the native agent, server identity, credential store, and host permissions support it. It is not a guarantee that every configured server is connected. Desktop-only integrations can differ, and arbitrary environment variables from your terminal are deliberately filtered. Configure credentials through the native agent's supported settings or credential store. Complete expired sign-ins and verification steps locally. See [native setup and operations](operations.md#native-agent-setup).

The implementation uses the existing [Codex profile](../apps/bridge/src/native-main.ts) and ordinary [Claude headless execution](../apps/bridge/src/claude/conversation.ts). Official documentation describes [shared Codex MCP configuration and authentication](https://learn.chatgpt.com/docs/extend/mcp) and [Claude's native discovery of skills, plugins, and MCP](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode). The bundled Codex version's [OAuth implementation](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/rmcp-client/src/oauth.rs#L371-L385) looks up saved credentials in its normal local credential store.

## How hosted workspaces differ

Cloud agents support skills, plugins, and authenticated MCP tools too. They load the configuration and credentials available in their execution environment.

| Product                | Documented behavior                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude hosted sessions | Start from a cloned repository. Committed project skills and MCP configuration can carry over; user-only skills, user plugins, and locally configured MCP servers don't automatically follow. [Carry-over table](https://code.claude.com/docs/en/cloud-environments#what-carries-over-from-your-setup). |
| Replicas               | Environments provision skills, plugins, and MCP connections, including saved OAuth authentication. Slack requests select an environment for the workspace. [Environment configuration](https://docs.replicas.dev/features/environments).                                                                |
| Devin                  | Supports skills, plugins, and MCP connections, including OAuth authorization through its configuration. [MCP setup](https://docs.devin.ai/work-with-devin/mcp), [skills](https://docs.devin.ai/product-guides/skills).                                                                                  |

Cloud execution can be a better fit when you want managed hosts, isolated parallel workspaces, or team administration without keeping a personal computer online. Sam Bot fits a person who wants to keep using their existing local setup and is willing to operate the bot.

Local execution is also available elsewhere. [Devin Outposts](https://docs.devin.ai/cloud/outposts/overview) run on customer-controlled machines, [Devin Local Hands](https://docs.devin.ai/work-with-devin/local-hands) can connect a cloud session to a local checkout, and [Replicas enterprise deployments](https://replicas.dev/enterprise) offer self-hosting. Claude also documents [self-hosted environments](https://code.claude.com/docs/en/cloud-environments). The README comparison describes a typical hosted workspace; exact behavior depends on the product and deployment.

## Verification

Checked against Sam Bot's native process and conversation code, its mocked protocol tests, and official product documentation on October 22, 2026. Configuration reuse is supported by the implementation and upstream documentation; individual MCP sign-ins and plugin tools were not exercised for this comparison. No comparative speed, cost, or security benchmark was run.

Sam Bot executes tools locally, while Slack messages and model requests still use their respective services. Provider usage limits apply. See the [security model](../security.md).
