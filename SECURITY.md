# Security Policy

## Supported Versions

We support the latest published version of Mux Code (`@agentmuxai/muxcode`).
Older versions may receive security fixes at our discretion.

## Reporting a Vulnerability

**Do not** open public GitHub issues for security vulnerabilities.

Email: **security@agentmux.ai**

Please include:

- A description of the issue and its potential impact
- Steps to reproduce (proof-of-concept welcome)
- The version affected (`muxcode --version`)
- Your operating system and Node.js version
- Any suggested remediation

## Response Expectations

- **Acknowledgement:** within 3 business days
- **Initial assessment:** within 10 business days
- **Coordinated disclosure:** we follow a coordinated disclosure model. Please
  give us reasonable time to investigate and ship a fix before public disclosure.

## Scope

In scope:

- The `muxcode` CLI and the `@agentmuxai/muxcode` npm package
- How it runs tools: shell commands, file edits, MCP servers it starts
- How it downloads and runs models and `llama-server`
- The build and publish workflows in this repository

Out of scope:

- Vulnerabilities in upstream dependencies or in model providers' APIs —
  please report to those projects; we will pick up the fix on the next release.
- The AgentMux desktop app — report through
  [agentmuxai/agentmux](https://github.com/agentmuxai/agentmux/blob/main/SECURITY.md).
- Issues requiring physical access to an unlocked machine

## Credit

We will credit reporters in release notes (with permission) for valid findings.

## Disclaimer

This policy does not create any warranty obligation. Mux Code is provided
"AS IS" — see [LICENSE](./LICENSE).
