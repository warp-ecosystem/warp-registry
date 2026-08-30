# Contributing to Warp Registry

Thank you for considering contributing to Warp Registry! It's people
like you who make open source such a wonderful thing.

Contributions are welcome, and are greatly appreciated. Following these
guidelines helps communicate that you respect the time of the maintainers and
the community, and makes the process smoother for everyone.

## Code of Conduct

This project and everyone participating in it is governed by the
[Code of Conduct](../CODE_OF_CONDUCT.md). By participating, you are expected to
uphold this code. Please report unacceptable behavior to the maintainers.

## Ways to contribute

- **Report bugs** — open an issue with a clear title and description,
  reproduction steps, and environment details (Node.js version, OS, relevant
  configuration).
- **Suggest enhancements** — open an issue describing the improvement, why it's
  useful, and how you imagine it working.
- **Fix bugs / implement features** — pick up an issue, fork the repository, and
  send us a pull request.
- **Improve docs** — typos, clarifications, and better instructions are always
  appreciated.

## Getting started

### You will need

- **Node.js 18 or newer** (this project is built and tested against Node.js 24).
- **Git**.
- Optionally **Docker**, for container-based development and CI parity.

### Setup

```bash
# Clone your fork
git clone https://github.com/<your-username>/warp-registry
cd warp-registry

# Install dependencies
npm install
```

For a full walkthrough of getting a local instance running end-to-end, see
[SETUP.md](../SETUP.md).

## Development workflow

### 1. Create a branch

Always create a branch off the latest `main` for your work:

```bash
git checkout -b feat/my-change
```

Use a descriptive branch name, e.g. `fix/typo-in-readme` or
`feat/support-query-param`.

### 2. Make your changes

Keep your changes focused and small. A pull request that addresses one concern
is much easier to review and merge.

### 3. Run the checks locally

Every pull request must pass the checks that run in CI. Run them before you
commit:

```bash
npm test          # run the test suite
npm run lint      # ESLint
npm run format:check   # Prettier formatting check
```

If any formatting check fails, you can fix it automatically with:

```bash
npm run format    # Prettier --write
```

### 4. Commit your changes

Write clear, concise commit messages that follow the repository's existing
style. A good commit message explains **what** changed and **why**.

### 5. Push and open a pull request

```bash
git push -u origin feat/my-change
```

Then open a pull request against the `main` branch, describing the change, the
reason for it, and any manual testing you performed.

## Project layout

- `src/` — the Express server source.
  - `server.js` — entry point; wires up config, database, and the app.
  - `routes.js` — HTTP endpoints (OAuth, publish, fetch).
  - `db.js` — SQLite schema and helpers.
  - `warp-meta.js` — parses compiled extensions and extracts `Warp.meta`.
  - `logger.js` — small logging helpers.
- `test/` — the test suite (uses the built-in `node --test` runner).
- `scripts/` — helper CLI scripts (e.g. `approve.js`).
- `data/` — runtime storage (database and compiled blobs), created on startup.
- `Dockerfile`, `compose.yml` — container setup.

## Testing

Tests live in `test/` and use Node.js's built-in test runner:

```bash
npm test
```

When you add or change behavior, add or update tests to cover it. Run the full
suite before pushing your branch.

## Linting and formatting

This project uses:

- **ESLint** for static analysis (`npm run lint`, config in `eslint.config.js`).
- **Prettier** for consistent formatting (`npm run format:check`, config in
  `.prettierrc.json`).

Please make sure your code is clean and consistently formatted before opening a
pull request.

## CI and pull request checks

Pull requests are automatically checked by GitHub Actions. The CI runs:

- **Lint (ESLint + Prettier)** — `npm run lint` and `npm run format:check`.
- **Lint Dockerfile (hadolint)** — checks `Dockerfile` against
  `.hadolint.yaml`.

Your pull request must pass all of these checks to be merged. You can often
reproduce them locally with the commands in the [development workflow](#development-workflow)
section above.

## Managing dependencies

[Dependabot](../.github/dependabot.yml) keeps `npm` and `github-actions`
dependencies up to date automatically. When a dependency update is opened,
review it and leave the maintainers to merge it once checks pass.

## Release process

Releases are triggered by pushing a version tag. When a tag matching `v*` is
pushed, the [publish workflow](../.github/workflows/publish-ghcr.yml) builds and
pushes a Docker image to GitHub Container Registry. Versioning follows
[semantic versioning](https://semver.org), so only bump the version when there
is a meaningful change.

## Questions?

If you have questions that aren't answered here, open an issue and a maintainer
will be happy to help.

Thank you again for contributing!
