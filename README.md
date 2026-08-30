# Warp Registry (`warp-registry`)

## Overview

Warp Registry is a Node (Express) server similar to a container registry that stores extensions created with [Warp Compiler](https://github.com/warp-ecosystem/warp-compiler).

## Features

- **Publish compiled extensions** — upload artifacts built with Warp Compiler via a simple `POST /v1/publish` endpoint, authenticated with a GitHub OAuth token.
- **GitHub OAuth auth** — publish tokens are issued once through GitHub's OAuth flow and only ever shown to the owner a single time.
- **First-publish moderation** — a brand-new owner's first publish is held as `pending` until approved, to keep the registry tamper-resistant.
- **Semantic versioning** — each package tracks multiple versions per owner, validated against semver rules.
- **Fetch by package or version** — retrieve a package's info and metadata, download a specific version, or the `latest` release, straight into TurboWarp.
- **SQLite-backed storage** — owners, versions, and metadata are stored in a WAL-mode SQLite database; compiled blobs live on disk under a configurable data directory.

## Installation & Usage

Read [the setup guide](./SETUP.md).

## Contributing

Contributions are welcome! Please read the
[CONTRIBUTING.md](docs/CONTRIBUTING.md) for details on the process for
submitting pull requests, and our [Code of Conduct](CODE_OF_CONDUCT.md) for
community guidelines.

## License

Warp Registry is proud to be Free Software. It is licensed under the [Apache 2.0 license](LICENSE).
