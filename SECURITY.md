# Security

AgentHotel runs with access to the Docker socket and, for its server console,
the host's namespaces: whoever controls the panel controls the server. Reports
of anything that could let someone else reach that control are very welcome.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting instead:
**Security → Report a vulnerability** on this repository. You will get a reply,
and a fix will be credited to you unless you prefer otherwise.

Useful in a report: what an attacker needs (network position, an agent of their
own on the hotel, a panel login), what they can then do, and the steps to
reproduce it.

## What is in scope

- The panel and its API, including the MCP endpoint and WebSockets
- The installer, the upgrade path and the Caddy configuration it manages
- Isolation between guests, and between a guest and the panel
- Templates in `templates/`, including secrets they generate

The security model — what the panel trusts and what it does not — is described
in the README under **Security model**.
