# Contributing to Voltran

Bug reports, fixes and new features are welcome. For anything bigger than a small fix, open an
issue first so the approach is agreed on before you spend time on it. Questions, and ideas you would
like to talk through, go to [Discussions](https://github.com/onurravli/voltran/discussions).

## Security issues

Do not report a vulnerability in a public issue; [SECURITY.md](SECURITY.md) says how to report one
and what Voltran does and does not protect against. A change must keep every guarantee listed under
[Security](README.md#security) in the README.

## Setting up

You need macOS or Linux and Node.js 22.18 or newer; on Windows, work inside WSL2. On Linux,
`npm install` compiles node-pty, which needs Python 3, make and a C++ compiler.

```bash
npm install
```

`npm install` also points `core.hooksPath` at `.githooks`, unless it is already set to something
else. The hooks need nothing beyond Node:

- `pre-commit` refuses trailing whitespace, conflict markers and a file without a final newline in
  what you stage, runs Biome on the staged files, and runs `npm run typecheck` when the commit
  touches TypeScript, JavaScript, a `tsconfig` or a `package.json`.
- `commit-msg` checks the message against the rules under
  [Commits and pull requests](#commits-and-pull-requests).
- `pre-push` runs `npm run typecheck` and `npm test`.

`git commit --no-verify` and `git push --no-verify` skip them when you need to.

The daemon you use day to day listens on port 4747 and keeps its data in `~/.voltran`. Run a
development copy with a folder and a port of its own, the same two values in every command, so
neither touches your real sessions:

```bash
VOLTRAN_HOME=/tmp/voltran-dev VOLTRAN_PORT=4950 npm run dev:daemon   # daemon with --watch
VOLTRAN_PORT=4950 npm run dev:web                                    # Vite on http://localhost:4774
VOLTRAN_HOME=/tmp/voltran-dev VOLTRAN_PORT=4950 VOLTRAN_DEV=1 node bin/voltran.mjs up   # signed-in window
```

[CLAUDE.md](CLAUDE.md) describes the architecture and the parts that are easy to get wrong, such as
terminal sizes, hooks and the notes lock. Read the section for the area you change, whether you or
an agent writes the code.

## Checks

```bash
npm run lint         # Biome: formatting and lint rules; npm run format fixes most of what it finds
npm run typecheck
npm test
npm run test:e2e     # builds the UI and drives it in headless Chrome
npx vitest run packages/daemon/src/panes.test.ts -t "persists scrollback"   # one file or test
npm run build        # the UI the daemon serves
```

CI runs the lint, the typecheck and the tests on Ubuntu and macOS with Node 22 and 24, and the browser tests on
Ubuntu and macOS with Node 24; every run must pass.

- Tests run in Node, so web logic that needs a test goes in a module without DOM access, such as
  `packages/web/src/usage.ts`, and the component only renders it.
- Daemon tests spawn real terminals. `server.test.ts` builds a whole daemon on a free port with a
  fake `claude` that runs the real hook command.
- The daemon takes its `PATH` from a login shell, so a fake agent binary must come first there:
  point `SHELL` at a wrapper that runs `zsh -f` with your `PATH`, or your real agent starts instead.
- The browser tests in `e2e/` cover the workflows that break unseen: typing and terminal sizes,
  splitting, dragging and resizing panes, workspaces, sidebar menus and reconnecting after a restart.
  A change to one of them gets a test there. They find Chrome on their own, or take its path from
  `VOLTRAN_E2E_CHROME`.
- Check how a UI change looks in a browser against a development copy, in a dark and a light theme,
  and add a screenshot to the pull request.

## Code style

[Biome](https://biomejs.dev/) formats and lints the code with the settings in `biome.json`;
`npm run format` rewrites your files to match, and the editor integration can do it on save. Beyond
what it checks, match the code around your change:

- 4-space indent, single quotes, at most 140 columns, and every file ends with a newline.
- A rule that does not fit one place gets a `biome-ignore` comment that says why, rather than being
  turned off for everyone.
- A commit that only reformats goes into `.git-blame-ignore-revs`, which GitHub's blame view skips;
  `git config blame.ignoreRevsFile .git-blame-ignore-revs` makes `git blame` skip it too.
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

- The types are `feat`, `fix`, `perf`, `refactor`, `style`, `test`, `docs`, `build`, `ci`, `chore`,
  `revert` and `release`; a `!` after the type or scope (`feat!:`) marks a breaking change.
- A scope is lowercase letters, digits and dashes. The first line is at most 100 characters and does
  not end with a period, and a blank line separates it from the body.
- Git's own merge, revert, `fixup!` and `squash!` messages pass as they are.
- The `commit-msg` hook checks each commit, and the `commits` workflow checks a pull request's commits
  and its title, which becomes the commit message when the pull request is squashed.

- Keep a pull request to one change. A behaviour change updates the README, and a change to how
  things work updates CLAUDE.md; both can go in a `docs:` commit of their own.
- Say how you checked the change: the tests you added, and what you tried by hand.

## Releasing

Bump the version with `npm version <version> --no-git-tag-version`, move the changelog's
**Unreleased** items under the new version, commit that as `release: <version>`, tag it
`v<version>` and push both. Publishing a GitHub release for the tag runs
`.github/workflows/release.yml`, which checks that the tag matches `package.json`, runs the checks,
publishes the package to npm and points the formula in
[onurravli/homebrew-tap](https://github.com/onurravli/homebrew-tap) at it.

## License

Voltran is licensed under the [Apache License 2.0](LICENSE.md). As section 5 of the license says,
a contribution you submit for inclusion is licensed under the same terms.
