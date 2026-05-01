# Security Policy

## Supported Versions

Only the latest published release of `@prmaat/mcp` is supported.
There is no LTS branch — new releases supersede older ones.

## Reporting a Vulnerability

**Do not open a public issue for security reports.** Instead:

1. Email **support@prmaat.com** with:
   - A clear description of the vulnerability
   - Steps to reproduce (ideally a minimal PoC)
   - The commit hash or release version you tested against
   - Your name/handle if you want credit in the disclosure
2. **Triage flow.** Reports are first-passed by **Blanco**, our internal
   security-policy agent (you'll see Blanco in the repo's contributor
   graph). Blanco classifies severity (CVSS), reproduces locally if
   feasible, and routes critical issues to the human maintainer within
   **72 hours**. Aim for a fix within **14 days** for critical issues.
3. Please give us a reasonable window to patch before public disclosure
   — we follow a **90-day coordinated disclosure** policy by default,
   shortened by mutual agreement for actively exploited issues.

## How AI agents on this project handle security

This is an AI-agent-native project — the platform is built BY a small
team of cryptographically-identified AI agents working alongside the
human maintainer. Each agent has a defined scope:

| Agent | Scope on security work |
|---|---|
| **Blanco** | First-pass triage of incoming reports, severity classification, reproduction attempts. |
| **Maat** | Audit-chain integrity reviews; verifies that fixes don't break the cryptographic guarantees. |
| **Police** | Token / credential / authentication boundary reviews. |
| **UX Agent** | Reviews user-facing messaging on advisories — clarity, no leaked details. |
| **Claude** | General code review + patch authoring. |

You'll see commits in the repository with multiple `Co-Authored-By:`
trailers naming these agents — that's not decoration, it reflects which
agents actually reviewed or worked on the change. Each agent's identity
is a cryptographic passport on prmaat.com (`did:prmaat:*`); their
authorship is verifiable.

## Scope

This repository ships the `@prmaat/mcp` server — a Model Context
Protocol bridge that exposes PrMaat passport, room, and audit-proof
endpoints as LLM-callable tools.

In scope for security reports:
- Token leakage paths (`PRMAAT_APT` / `MYCLAW_APT`) through stdout,
  logs, or error messages
- MCP frame-injection or response-tampering vulnerabilities
- Tool-call argument validation bypasses
- Dependency vulnerabilities with a clear exploitation path through
  this server

Out of scope:
- Server-side issues on `prmaat.com` (report separately — see the main
  project's `/.well-known/security.txt`)
- Issues in third-party MCP clients (Claude Desktop, Cursor, etc.) —
  report to those vendors directly
- Social-engineering of the user (e.g., convincing them to paste their
  `apt_` into a phishing form)

## Hardening Defaults

This server defaults to **off** for anything dangerous:
- All requests log to stderr only; stdout is reserved for JSON-RPC
  frames (and never echoes the token)
- The token is never cached; every tool call hits the live API fresh
- If `PRMAAT_APT` is unset, every tool call returns a clear error
  rather than crashing the MCP client

## Acknowledgments

We will list reporters (with their consent) in release notes and on a
public hall-of-fame page once the server has a stable public release.
