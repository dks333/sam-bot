# Security model

This bridge accepts Slack messages from one configured owner and forwards them to a local Codex or Claude Code process. Slack is an untrusted transport, and content the agent reads can contain hostile instructions.

## Reporting a vulnerability

When available, use GitHub's [private vulnerability reporting form](https://github.com/dks333/sam-bot/security/advisories/new). If the form is unavailable, open an issue asking the maintainer for a private reporting channel without including vulnerability details, credentials, logs, or other sensitive information. Do not disclose an unpatched vulnerability in a public issue.

## Authorization and transport

- Exact team, user, and optional enterprise IDs are checked before dispatch, file downloads, or approval handling.
- Channels require an exact configured ID unless the owner explicitly configures the workspace-wide `"*"` policy. Bot DMs require the same owner and team authorization.
- Socket Mode requires no public HTTP endpoint. The bot does not subscribe to ordinary channel messages. An authorized request can load its thread history and forwarded threads from allowed channels.
- Supported images are downloaded only after authorization, limited by count, size, and signature, and removed after their turn.
- Local Slack credentials stay in `~/.slack-codex/secrets.env` with mode 0600. Agent subprocesses receive a limited environment.

## Native agent permissions

Codex inherits its local model, reasoning, sandbox, approval policy, memory, skills, plugins, and tools. The bridge does not impose a separate read-only tool catalogue, command sandbox, privileged-intent classifier, or publication policy.

Claude Code uses the owner's subscription through its unmodified local CLI. The bridge verifies subscription authentication and rejects supported API/provider overrides. Claude inherits local permission settings, including auto mode. The bridge does not enable permission bypass or establish operating-system sandbox isolation.

Native command, file, and permission prompts are forwarded through single-use Slack controls bound to the configured owner, conversation, request, and turn. Controls expire when their request resolves or the bridge's deadline passes. Ordinary messages and answers to questions do not approve tool use. One-time approvals do not become persistent permissions.

Approval cards show the complete scope as literal text, including absolute paths, only to the configured owner. Requests containing credentials, hidden display characters, or more text than the card can hold require local review; the bridge never approves a shortened or redacted action.

Slack output filters known credential formats and the configured Slack tokens. Complete final responses are filtered before splitting into messages. This reduces accidental disclosure but cannot identify every password, encoded secret, or proprietary value. Keep sensitive tasks and secret input local. Previously prepared delivery parts cannot be rewritten silently when the output policy changes; a mismatch requires local reconciliation.

Unsupported native interactions fail closed. Secret questions, connector authentication, and verification challenges require local completion. Authentication and tool access remain subject to the native agent and connected service.

## Persistence and recovery

Each provider has a separate conversation ledger. Dispatched work with an uncertain outcome is retained and is never automatically replayed. Cancellation requires terminal evidence; an acknowledgement alone does not prove that execution stopped.

Claude recovery requires the operator to stop the bridge and independently confirm that Claude and its tools have stopped. It preserves the original evidence and unknown outcome, cancels queued follow-ups, and does not replay the prompt or prove success.

Final delivery uses durable identities and actual Slack receipts. Ambiguous Slack sends are reconciled before another send is attempted. Delivery failure does not rerun the agent turn.

One runtime owns the local database through a process-bound lease. Managed activation checks both provider ledgers and preserved historical execution records. Active work, unresolved execution, and ambiguous delivery block replacement. A known failed final from an idle inactive provider may remain saved without blocking an upgrade when provider ownership is verified.

Removing an owner, team, or allowed channel from the saved configuration revokes access to its retained requests when the bridge next starts. Resuming those requests and delivering their pending replies are permanently suppressed, including if access is later restored. New requests can be accepted after access is restored. Records are retained and uncertain work is never replayed. This cannot recall messages already delivered or prove that detached tools stopped.

Historical database tables and migrations remain for data preservation and release compatibility. The old task controller, routing system, browser dashboard, and their execution restrictions are no longer part of this source.

## Local trust boundary

The bridge and native agents run as the signed-in local user. Protect their configuration, authentication, tools, and project files accordingly. A parent process exit does not prove that independently detached tools stopped.

Configured native settings determine filesystem, network, and connector access. Approval cards do not add sandbox isolation. Review inherited settings before granting Slack access to a project, and restrict channel membership to people permitted to see the results.

Keep credentials, local databases, logs, and conversation state out of source control. Rotate Slack credentials if the account or workstation is compromised. Review source and history before public distribution.
