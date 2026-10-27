# Open-source release

Before publishing a release, run the repository's CI checks with the declared Node and pnpm versions, including a frozen dependency install and an audit of production and development dependencies. The workflow at `.github/workflows/ci.yml` runs these checks on pull requests, pushes to `main`, and weekly.

After the repository becomes public, enable GitHub private vulnerability reporting in **Settings → Advanced Security → Private vulnerability reporting**. Verify that [the private report form](https://github.com/dks333/sam-bot/security/advisories/new) is available to a reporter. GitHub does not offer this feature for private repositories; the link in the security policy remains conditional until reporting has been enabled and verified.

Development tests use synthetic data. The CLI token-entry regression uses `python3` and a POSIX pseudo-terminal on macOS and Linux; it is skipped on Windows. A passing mocked test suite does not establish a successful Slack task. Complete the README's local setup and verify an actual Slack reply before announcing an end-to-end installation result.
