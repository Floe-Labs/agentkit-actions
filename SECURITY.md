# Security Policy

## Reporting Vulnerabilities

If you discover a security vulnerability in any Floe Labs repository, **do not open a public issue.** Instead:

1. **Email:** [security@floelabs.xyz](mailto:security@floelabs.xyz)
2. **Include:** description of the vulnerability, steps to reproduce, and potential impact
3. **Response time:** We will acknowledge receipt within 48 hours and provide a detailed response within 7 business days

## Audit

Floe's smart contracts have been audited by **Omniscia**:

- **[Floe Labs — Modular Lending Security Audit Report (November 2025)](https://3943501408-files.gitbook.io/~/files/v0/b/gitbook-x-prod.appspot.com/o/spaces%2FSx66dLmFDN8JXfNTlkAK%2Fuploads%2F6Auz3nQPwsMLLnASBqrN%2FFloe%20Labs%20-%20Modular%20Lending%20Security%20Audit%20Audit%20Report%201125.pdf?alt=media&token=eeea2f21-7f40-4881-8a04-e0fadd7984e0)**

Additional internal security reviews have been conducted for the operator delegation pattern (Upgrade #12) and the x402 facilitator (SSRF hardening, reservation state machine).

## Supported Versions

| Component | Version | Supported |
|-----------|---------|-----------|
| Smart contracts (Base mainnet) | Upgrade #12 | ✅ |
| Credit API | 0.1.x | ✅ |
| AgentKit (npm `floe-agent`) | 0.2.x | ✅ |
| AgentKit (PyPI `floe-agentkit-actions`) | 0.2.x | ✅ |
| MCP Server (`@floelabs/mcp-server`) | 0.1.x | ✅ |

## Responsible Disclosure

We follow responsible disclosure practices. We ask that you:

- Give us reasonable time to fix the issue before public disclosure
- Make a good-faith effort to avoid privacy violations, data destruction, and service interruption
- Do not access or modify other users' data

We will not pursue legal action against researchers who follow this policy.
