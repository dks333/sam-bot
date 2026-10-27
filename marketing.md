# Sam Bot launch copy

## GitHub description

Your coding agent in Slack. Connect Codex or Claude Code running on your computer, with your existing account, projects, tools, and settings. Open source under MIT.

## Launch post

I built Sam Bot to talk to my coding agent from Slack.

It connects to Codex or Claude Code on your computer. You keep your existing account, project setup, and native settings. Send a task in a DM or mention, answer the agent's questions, and get the final response in the thread.

Follow-ups steer Codex while it works. Claude follow-ups wait for the current turn. You can approve or deny supported native permission requests in Slack.

Your computer needs to stay online. Tools run there; model requests still go to the agent's provider.

Sam Bot is open source under MIT: https://github.com/dks333/sam-bot

## Demo sequence

1. Show Sam Bot connected to a synthetic demo repository and one selected agent.
2. DM: “Find why the date formatter test fails. Fix it and run that test.”
3. Show the Slack working indicator while the local agent works. Do not imply a live commentary stream.
4. If a native permission request appears, show its exact action and the Approve once / Deny controls. Do not stage a prompt that the selected native settings would skip.
5. Show the final response and verify the changed file and test result in the local repository.
6. Reply in the same thread with a follow-up. If demonstrating a message during execution, label it accurately: Codex steering or Claude queued follow-up.

End card: **Sam Bot — Your coding agent in Slack.**
