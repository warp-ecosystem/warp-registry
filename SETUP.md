# Warp Registry — Self-Hosting Setup

A walkthrough for running Warp Registry yourself for the first time.

## 1. Prerequisites

- **Node.js.** `package.json` declares an `engines` field of `^22.13.0 || >=24`. This project was built and tested against **Node.js v24**. It relies on built-in `fetch` and the `node --test` runner.

## 2. Install

Clone the repository and install dependencies:

```bash
git clone https://github.com/warp-ecosystem/warp-registry warp-registry
cd warp-registry
npm install
```

Create your environment file from the template:

```bash
cp .env.example .env
```

## 3. Configure

The registry requires no external services. Configure the environment file:

```bash
PORT=3000
PUBLIC_BASE_URL=
DATA_DIR=./data
```

`PUBLIC_BASE_URL` is optional. When running behind a reverse proxy or a publicly deployed server, set it to the canonical base URL of your deployment (scheme and host, no trailing `/`) — for example `https://registry.example.com`.

## 4. Start the server

```bash
npm start
```

A successful startup looks like a green check-marked line:

```text
✓ Warp Registry listening on http://localhost:3000
```

The `PORT` you see here comes from your `.env`.

## 5. Create an account

Sign up with a username (`namespace`), an optional display name, and a password of at least 8 characters:

```bash
curl -X POST http://localhost:3000/v2/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"namespace":"yourname","displayName":"Your Name","password":"a-strong-password"}'
```

A successful signup returns `201` with your user object and an opaque bearer token:

```json
{
  "user": {
    "id": 1,
    "displayName": "Your Name",
    "namespace": "yourname",
    "type": "normal",
    "extensions": []
  },
  "token": "e4f2...hex-token..."
}
```

**The token is your credential.** Store it somewhere safe. You'll use it as the `Authorization: Bearer <token>` header for all authenticated requests. If you lose it, log in again to get a fresh one:

```bash
curl -X POST http://localhost:3000/v2/auth/login \
  -H "Content-Type: application/json" \
  -d '{"namespace":"yourname","password":"a-strong-password"}'
```

Passwords are salted and hashed with scrypt on the server, and only the hash is stored.

## 6. Publish something

You likely don't have a ready-made compiled extension — this registry only accepts files produced by [Warp Compiler](https://github.com/warp-ecosystem/warp-compiler). Fortunately the compiler ships on npm, so build a real one first.

In a scratch directory (not inside the repo itself):

```bash
mkdir ~/warp-extension && cd ~/warp-extension
npm install @warp-ecosystem/warp-compiler
npx warp-compiler init
npx warp-compiler build
```

That produces a freshly compiled `dist/helloworld@0.1.0.js`. (The `init`/`build` commands print a few warnings about package.json fields not matching the manifest — those are expected and don't affect the output.) Use that real build to publish via the JSON API:

```bash
curl -X POST http://localhost:3000/v2/publish \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{
    "id": "helloworld",
    "meta": {
      "class": "HelloWorld",
      "name": "It works!",
      "id": "helloworld",
      "license": "Apache-2.0",
      "authors": ["You"],
      "description": "A description of the extension.",
      "version": "0.1.0"
    },
    "extensionBlob": "<contents of dist/helloworld@0.1.0.js>"
  }'
```

A successful publish returns `201` with JSON describing the extension:

```json
{
  "extension": {
    "owner": "yourname",
    "id": "helloworld",
    "meta": { "class": "HelloWorld", "name": "It works!" },
    "versions": [],
    "approved": false
  },
  "publishedUrl": "/v2/@yourname/helloworld"
}
```

> Tip: rather than pasting large files inline, generate the JSON body programmatically, e.g. with `json -e 'this.extensionBlob = require("node:fs").readFileSync("dist/helloworld@0.1.0.js", "utf8")'` or a small Node/JQ script.

## 7. Approve the first publish

A brand-new owner's **first** publish is held as `pending`. Pending versions are stored on disk and in the database but are not served over HTTP until approved — you'll get `404` from the info and blob endpoints until then.

An **admin** can approve it through the API:

```bash
curl -X POST http://localhost:3000/v2/@yourname/helloworld/approve \
  -H "Authorization: Bearer <admin-token>"
```

Or with the CLI script (works directly against the database, no token required), passing `namespace`, `package_id`, and `version`:

```bash
node scripts/approve.js yourname helloworld 0.1.0
```

You should see a green `✓ Approved yourname/helloworld@0.1.0 (owner now has_published=1)`.

After that first approval, **every publish from the same owner is `published` immediately** and needs no further approval.

To make a given account an admin, update its row in the database:

```bash
sqlite3 data/registry.db "UPDATE users SET type='admin' WHERE namespace='yourname';"
```

## 8. Confirm it's live

Fetch the package info — it lists all published versions and the latest one:

```bash
curl http://localhost:3000/v2/@yourname/helloworld
```

Fetch a specific version's compiled source:

```bash
curl http://localhost:3000/v2/@yourname/helloworld/0.1.0
```

The latter serves the same `application/javascript` blob you uploaded. (`/v2/@yourname/helloworld/latest` works too.)

## 9. Load it into TurboWarp

Now you can load the example extension you published into TurboWarp. You can load it from the URL: `http://localhost:3000/v2/@yourname/helloworld/0.1.0`.

## 10. Manage your account

Update your display name or password:

```bash
curl -X PATCH http://localhost:3000/v2/users/yourname \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <your-token>" \
  -d '{"displayName":"New Name"}'
```

Log out (revokes the current token):

```bash
curl -X POST http://localhost:3000/v2/auth/logout \
  -H "Authorization: Bearer <your-token>"
```

Delete your account (revokes all tokens and removes your published extensions):

```bash
curl -X DELETE http://localhost:3000/v2/users/yourname \
  -H "Authorization: Bearer <your-token>"
```
