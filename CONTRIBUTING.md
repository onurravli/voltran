# Contributing to Voltran

Bug reports, fixes and new features are welcome. For anything bigger than a small fix, open an
issue first so the approach is agreed on before you spend time on it.

## Security issues

Voltran runs a local server that starts processes, so do not report a vulnerability in a public
issue. Email onur@onurravli.com instead, with the steps to reproduce it. A change must keep every
guarantee listed under [Security](README.md#security) in the README.

## Setting up

You need macOS or Linux and Node.js 22.18 or newer; on Windows, work inside WSL2. On Linux,
`npm install` compiles node-pty, which needs Python 3, make and a C++ compiler.

```bash
npm install
```

The daemon you use day to day listens on port 4747 and keeps its data in `~/.voltran`. Run a
development copy with a folder and a port of its own, the same two values in every command, so
neither touches your real sessions:

```bash
VOLTRAN_HOME=/tmp/voltran-dev VOLTRAN_PORT=4950 npm run dev:daemon   # daemon with --watch
VOLTRAN_PORT=4950 npm run dev:web                                    # Vite on http://localhost:5173
VOLTRAN_HOME=/tmp/voltran-dev VOLTRAN_PORT=4950 VOLTRAN_DEV=1 node bin/voltran.mjs up   # signed-in window
```

[CLAUDE.md](CLAUDE.md) describes the architecture and the parts that are easy to get wrong, such as
terminal sizes, hooks and the notes lock. Read the section for the area you change, whether you or
an agent writes the code.

## Checks

```bash
npm run typecheck
npm test
npx vitest run packages/daemon/src/panes.test.ts -t "persists scrollback"   # one file or test
npm run build        # the UI the daemon serves
```

CI runs the typecheck and the tests on Ubuntu with Node 22, and both must pass.

- Tests run in Node, so web logic that needs a test goes in a module without DOM access, such as
  `packages/web/src/usage.ts`, and the component only renders it.
- Daemon tests spawn real terminals. `server.test.ts` builds a whole daemon on a free port with a
  fake `claude` that runs the real hook command.
- The daemon takes its `PATH` from a login shell, so a fake agent binary must come first there:
  point `SHELL` at a wrapper that runs `zsh -f` with your `PATH`, or your real agent starts instead.
- There are no UI tests. Check a UI change in a browser against a development copy, in a dark and a
  light theme, and add a screenshot to the pull request.

## Code style

There is no linter or formatter; match the code around your change:

- 4-space indent, single quotes, and every file ends with a newline.
- No comments, except for a constraint the code cannot show. The reasoning goes in the commit
  message or the pull request.
- Node runs the daemon's TypeScript directly, so only syntax it can strip is allowed: no enums,
  namespaces or parameter properties, `import type` for type-only imports, and a `.ts` extension in
  every relative import. `npm run typecheck` enforces this.
- Voltran runs on macOS and Linux. Hooks are POSIX shell, and keyboard labels go through `keys()`, so
  Linux shows Ctrl+Shift where a Mac shows ⌘.

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`,
`fix:`, `docs:`, `ci:` or `chore:`, with a scope when the change stays in one part (`fix(web):`,
`fix(daemon):`, `feat(cli):`). The subject says what changes for the user, such as
`feat: show the account's usage limits in the sidebar`; the body says why, when that is not obvious.

- Keep a pull request to one change. A behaviour change updates the README, and a change to how
  things work updates CLAUDE.md; both can go in a `docs:` commit of their own.
- Say how you checked the change: the tests you added, and what you tried by hand.

## License

Voltran is licensed under the [Apache License 2.0](LICENSE.md). As section 5 of the license says,
a contribution you submit for inclusion is licensed under the same terms.
