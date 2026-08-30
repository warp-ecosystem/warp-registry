# Warp Registry — Self-Hosting Setup

A walkthrough for running Warp Registry yourself for the first time.

## 1. Prerequisites

- **Node.js.** `package.json` declares an `engines` field of `^20.19.0 || ^22.13.0 || >=24`. This project was built and tested against **Node.js v24.14.0** (npm 11.9.0). It relies on built-in `fetch` and the `node --test` runner.

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

## 3. Create a GitHub OAuth App

Warp Registry uses GitHub OAuth to hand out publish tokens, so you need an OAuth App.

1. Go to <https://github.com/settings/developers>.
2. Click **New OAuth App**.
3. Fill in an **Application name** and **Homepage URL**.
4. Set the **Authorization callback URL** to `http://<host>:<port>/callback` for strictly local development, where `<host>:<port>` matches where the server will actually run — and critically, **it must match the `PORT` value in your `.env`**. For example, with `PORT=3000` on your own machine, the callback URL is `http://localhost:3000/callback`. Use HTTP only for `localhost` or other strictly local development. Whenever the server is shared, remotely reachable, or publicly deployed, use an **HTTPS** callback URL (for example `https://registry.example.com/callback`). If these don't match, the `/login` flow will fail.
5. Click **Register application**.
6. GitHub now shows a **Client ID** and a **Client Secret**.

Put those values in `.env`:

```bash
PORT=3000
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
PUBLIC_BASE_URL=https://registry.example.com
DATA_DIR=./data
```

`PUBLIC_BASE_URL` is optional. When running behind a reverse proxy or a publicly deployed server, set it to the canonical base URL of your deployment (scheme and host, no trailing `/`) — for example `https://registry.example.com`. The registry then builds the OAuth redirect to `${PUBLIC_BASE_URL}/callback` instead of deriving it from the incoming request, so the value must match the **Authorization callback URL** you registered with GitHub above. For plain `http://localhost` development you can leave it empty and the redirect is derived automatically.

## 4. Start the server

```bash
npm start
```

A successful startup looks like a green check-marked line:

```text
✓ Warp Registry listening on http://localhost:3000
```

The `PORT` you see here comes from your `.env`.

## 5. Get a token

Open `http://localhost:3000/login` in a browser and complete the GitHub OAuth flow. The callback page shows your access token in a `<pre>` block.

**This token is displayed exactly once and can never be retrieved again.** Save it somewhere safe before navigating away. You'll use it as the `Authorization: Bearer <token>` header when publishing.

## 6. Publish something

You likely don't have a ready-made compiled extension — this registry only accepts files produced by [Warp Compiler](https://github.com/warp-ecosystem/warp-compiler). Fortunately the compiler ships on npm, so build a real one first.

In a scratch directory (not inside the repo itself):

```bash
mkdir ~/warp-extension && cd ~/warp-extension
npm install @warp-ecosystem/warp-compiler
npx warp-compiler init
npx warp-compiler build
```

That produces a freshly compiled `dist/helloworld@0.1.0.js`. (The `init`/`build` commands print a few warnings about package.json fields not matching the manifest — those are expected and don't affect the output.) Use that real build to publish:

```bash
curl -X POST http://localhost:3000/v1/publish \
  -H "Content-Type: application/javascript" \
  -H "Authorization: Bearer <your-token>" \
  --data-binary @dist/helloworld@0.1.0.js
```

A successful publish returns `201` with JSON describing the version:

```json
{
  "owner": "your-gh-username",
  "id": "helloworld",
  "version": "0.1.0",
  "status": "pending",
  "url": "/v1/your-gh-username/helloworld/0.1.0"
}
```

## 7. Approve the first publish

A brand-new owner's **first** publish is held as `pending`. Pending versions are stored on disk and in the database but are not served over HTTP until approved — you'll get `404` from the info and blob endpoints until then.

Approve it with the CLI script, passing `github_username`, `package_id`, and `version`:

```bash
node scripts/approve.js your-gh-username helloworld 0.1.0
```

You should see a green `✓ Approved your-gh-username/helloworld@0.1.0 (owner now has_published=1)`.

After that first approval, **every publish from the same owner is `published` immediately** and needs no further approval.

If your GitHub username contains characters you don't want to type, note that `data/registry.db` (set via `DATA_DIR`) stores the owner by username; the approve script looks owners up by that exact string.

## 8. Confirm it's live

Fetch the package info — it lists all published versions and the latest one:

```bash
curl http://localhost:3000/v1/your-gh-username/helloworld
```

Fetch a specific version's compiled source:

```bash
curl http://localhost:3000/v1/your-gh-username/helloworld/0.1.0
```

The latter serves the same `application/javascript` blob you uploaded. (`/v1/your-gh-username/helloworld/latest` works too.)

## 9. Load it into TurboWarp

Now you can load the example extension you published into TurboWarp. You can load it from the URL: `http://localhost:3000/v1/your-gh-username/helloworld/0.1.0`.
