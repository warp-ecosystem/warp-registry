# Warp Registry (`warp-registry`)

## Overview

Warp Registry is a Node (Express) server similar to a container registry that stores extensions created with [Warp Compiler](https://github.com/warp-ecosystem/warp-compiler).

## Features

- **Username/password accounts** — sign up, log in, and manage your own account. Passwords are hashed server-side with scrypt (asynchronously) and never stored in plain text.
- **Bearer token auth** — every publish and account/extension edit is authenticated with an opaque bearer token issued at signup/login. Tokens expire after 7 days and can be revoked at any time (logout invalidates the current token; changing your password or deleting your account revokes all of them).
- **Brute-force protection** — login and signup are rate-limited per namespace + IP (5 attempts / 15 min) and respond `429` before any password hashing or verification once the limit is hit.
- **First-publish moderation** — a brand-new owner's first publish is held as `pending` until an admin approves it, to keep the registry tamper-resistant.
- **Admin moderation** — admins can approve pending extensions via the API or the CLI approval script.
- **Semantic versioning** — each package tracks multiple versions per owner, validated against semver rules.
- **Fetch by package or version** — retrieve a package's info and metadata, download a specific version, or the `latest` release, straight into TurboWarp.
- **SQLite-backed storage** — users, tokens, versions, and metadata are stored in a WAL-mode SQLite database; compiled blobs live on disk under a configurable data directory.

## API

The HTTP API is versioned and documented by OpenAPI. The authoritative contract lives in [`openapi/v2.json`](openapi/v2.json). Highlights:

| Method | Path                              | Auth  | Description                                          |
| ------ | --------------------------------- | ----- | ---------------------------------------------------- |
| POST   | `/v2/auth/signup`                 | —     | Create an account, get a token                       |
| POST   | `/v2/auth/login`                  | —     | Log in, get a token                                  |
| POST   | `/v2/auth/logout`                 | ✓     | Revoke the current token                             |
| GET    | `/v2/users`                       | —     | List users (paginated)                               |
| GET    | `/v2/users/{namespace}`           | —     | Read a user                                          |
| PATCH  | `/v2/users/{namespace}`           | ✓     | Update own user (or any as admin)                    |
| DELETE | `/v2/users/{namespace}`           | ✓     | Delete own user (or any as admin)                    |
| POST   | `/v2/publish`                     | ✓     | Publish an extension version                         |
| GET    | `/v2/@{namespace}/{id}`           | —     | Read an extension                                    |
| PATCH  | `/v2/@{namespace}/{id}`           | ✓     | Update own extension                                 |
| DELETE | `/v2/@{namespace}/{id}`           | ✓     | Delete own extension                                 |
| GET    | `/v2/@{namespace}/{id}/{version}` | —     | Fetch extension source (`latest` resolves to newest) |
| POST   | `/v2/@{namespace}/{id}/approve`   | admin | Approve a pending extension                          |
| GET    | `/v2/search?query=...`            | —     | Search published extensions (query optional)         |
| GET    | `/v2/extensions`                  | —     | List published extensions                            |
| GET    | `/v2/stats`                       | —     | Registry statistics                                  |

Authentication uses the `Authorization: Bearer <token>` header. Missing or invalid tokens return `401`; authenticated-but-unauthorized access returns `403`.

## Installation & Usage

Read [the setup guide](./SETUP.md).

## Contributing

Contributions are welcome! Please read the
[CONTRIBUTING.md](docs/CONTRIBUTING.md) for details on the process for
submitting pull requests, and our [Code of Conduct](CODE_OF_CONDUCT.md) for
community guidelines.

## License

Warp Registry is proud to be Free Software. It is licensed under the [Apache 2.0 license](LICENSE).
