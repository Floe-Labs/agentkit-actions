# Contributing to floe-agent

Thanks for your interest in contributing to Floe's AgentKit ActionProvider.

## Getting Started

```bash
git clone https://github.com/Floe-Labs/agentkit-actions.git
cd agentkit-actions
pnpm install
pnpm build
```

## Development

```bash
pnpm dev        # Watch mode
pnpm build      # Build
pnpm typecheck  # Type check
```

## Pull Requests

1. Fork the repo and create your branch from `main`
2. If you've added code, add tests
3. Ensure `pnpm build` and `pnpm typecheck` pass
4. Write a clear PR description explaining the change

## Code Style

- TypeScript strict mode
- No `any` types without justification
- All public functions need JSDoc comments

## Reporting Bugs

Open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## Security Issues

See [SECURITY.md](SECURITY.md) — do **not** open a public issue for security vulnerabilities.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
