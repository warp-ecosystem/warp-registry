import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import semver from "semver";
import { blobPath } from "./db.js";
import { extractWarpMeta } from "./warp-meta.js";
import { success, error } from "./logger.js";

export const PACKAGE_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;

export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createApp({ db, dataDir, config = {} }) {
  const app = express();
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON body." });
      return;
    }
    next(err);
  });

  app.get("/login", (req, res) => {
    const { GITHUB_CLIENT_ID: clientId } = config;
    if (!clientId) {
      res
        .status(500)
        .send("GitHub OAuth is not configured (missing GITHUB_CLIENT_ID).");
      return;
    }
    const redirectUri = config.PUBLIC_BASE_URL
      ? `${config.PUBLIC_BASE_URL}/callback`
      : `${req.protocol}://${req.get("host")}/callback`;
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "read:user",
    });
    res.redirect(
      `https://github.com/login/oauth/authorize?${params.toString()}`,
    );
  });

  app.get("/callback", async (req, res) => {
    const { code } = req.query;
    if (!code) {
      res.status(400).send("Missing `code` query parameter.");
      return;
    }
    const { GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret } =
      config;
    if (!clientId || !clientSecret) {
      res.status(500).send("GitHub OAuth is not configured.");
      return;
    }
    try {
      const tokenRes = await fetch(
        "https://github.com/login/oauth/access_token",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: clientId,
            client_secret: clientSecret,
            code,
          }),
        },
      );
      if (!tokenRes.ok) {
        throw new Error(
          `GitHub token exchange failed with status ${tokenRes.status}`,
        );
      }
      const tokenData = await tokenRes.json();
      if (tokenData.error) {
        throw new Error(`GitHub token exchange error: ${tokenData.error}`);
      }
      const accessToken = tokenData.access_token;
      if (!accessToken) {
        throw new Error("GitHub did not return an access token.");
      }

      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!userRes.ok) {
        throw new Error(
          `GitHub user fetch failed with status ${userRes.status}`,
        );
      }
      const user = await userRes.json();
      const username = user.login;
      if (!username) {
        throw new Error("GitHub did not return a username.");
      }

      const token = crypto.randomBytes(32).toString("hex");
      const tokenHash = hashToken(token);

      db.prepare(
        `INSERT INTO owners (github_username, token_hash, has_published)
         VALUES (?, ?, 0)
         ON CONFLICT(github_username) DO UPDATE SET token_hash = excluded.token_hash`,
      ).run(username, tokenHash);

      success(`OAuth token issued for ${username}`);

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(`<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Warp Registry — Token</title></head>
  <body>
    <h1>Warp Registry</h1>
    <p>Welcome, <strong>${escapeHtml(username)}</strong>.</p>
    <p>Your access token is:</p>
    <pre style="user-select: all;">${escapeHtml(token)}</pre>
    <p><strong>This token will not be shown again.</strong> Store it somewhere safe.
    Use it as the value of the <code>Authorization: Bearer &lt;token&gt;</code> header
    when publishing.</p>
  </body>
</html>`);
    } catch (err) {
      console.error(err);
      res.status(500).send("GitHub OAuth failed. See server logs for details.");
    }
  });

  app.post("/v1/publish", async (req, res) => {
    const authHeader = req.headers.authorization || "";
    const match = /^Bearer\s+(.+)$/i.exec(authHeader);
    if (!match) {
      res
        .status(401)
        .json({ error: "Missing Bearer token in Authorization header." });
      return;
    }
    const token = match[1].trim();
    const tokenHash = hashToken(token);
    const owner = db
      .prepare("SELECT * FROM owners WHERE token_hash = ?")
      .get(tokenHash);
    if (!owner) {
      res.status(401).json({ error: "Invalid token." });
      error("Invalid token.");
      return;
    }

    const contentType = req.headers["content-type"] || "";
    if (
      !contentType.startsWith("application/javascript") &&
      !contentType.startsWith("text/plain")
    ) {
      res.status(400).json({
        error: "Content-Type must be application/javascript or text/plain.",
      });
      return;
    }

    const source = await readRawBody(req);

    const { ok, meta, error: metaError } = extractWarpMeta(source);
    if (!ok) {
      res.status(400).json({ error: metaError });
      error(metaError);
      return;
    }

    if (typeof meta.id !== "string" || !PACKAGE_ID_RE.test(meta.id)) {
      res.status(400).json({
        error:
          "meta.id is required and must match ^[a-z0-9](?:[a-z0-9._-]{0,63})$.",
      });
      return;
    }
    if (typeof meta.version !== "string" || semver.valid(meta.version) === null) {
      res.status(400).json({
        error: "meta.version must be a valid semver string.",
      });
      error("meta.version must be a valid semver string.");
      return;
    }
    for (const field of ["name", "license", "description"]) {
      if (typeof meta[field] !== "string" || meta[field].length === 0) {
        res.status(400).json({
          error: `meta.${field} is required and must be a non-empty string.`,
        });
        return;
      }
    }

    const packageId = meta.id;
    const version = meta.version;
    const ownerName = owner.github_username;

    const existing = db
      .prepare(
        `SELECT id FROM versions WHERE owner_id = ? AND package_id = ? AND version = ?`,
      )
      .get(owner.id, packageId, version);
    if (existing) {
      res
        .status(409)
        .json({ error: "This version already exists for this owner." });
      error("This version already exists for this owner.");
      return;
    }

    const status = owner.has_published === 1 ? "published" : "pending";

    const absBlobPath = blobPath(dataDir, ownerName, packageId, version);
    fs.mkdirSync(path.dirname(absBlobPath), { recursive: true });
    fs.writeFileSync(absBlobPath, source);

    db.prepare(
      `INSERT INTO versions (owner_id, package_id, version, status, meta_json, blob_path)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      owner.id,
      packageId,
      version,
      status,
      JSON.stringify(meta),
      absBlobPath,
    );

    res.status(201).json({
      owner: ownerName,
      id: packageId,
      version,
      status,
      url: `/v1/${ownerName}/${packageId}/${version}`,
    });

    success(`${ownerName}/${packageId}@${version} (${status})`);
  });

  app.get("/v1/:owner/:id", (req, res) => {
    const { owner, id } = req.params;
    const rows = db
      .prepare(
        `SELECT v.version, v.meta_json
         FROM versions v
         JOIN owners o ON o.id = v.owner_id
         WHERE o.github_username = ? AND v.package_id = ? AND v.status = 'published'`,
      )
      .all(owner, id);

    if (rows.length === 0) {
      res
        .status(404)
        .json({ error: "No published versions for this package." });
      return;
    }

    rows.sort((a, b) => semver.compare(b.version, a.version));
    const latest = rows[0];

    res.json({
      owner,
      id,
      latestVersion: latest.version,
      meta: JSON.parse(latest.meta_json),
      versions: rows.map((r) => r.version),
    });
  });

  app.get("/v1/:owner/:id/:version", (req, res) => {
    const { owner, id, version } = req.params;
    if (version === "latest") {
      const latest = findLatest(db, owner, id);
      if (!latest) {
        res
          .status(404)
          .json({ error: "No published versions for this package." });
        return;
      }
      serveBlob(req, res, {
        db,
        dataDir,
        owner,
        id,
        version: latest.version,
      });
      return;
    }
    serveBlob(req, res, { db, dataDir, owner, id, version });
  });

  return app;
}

function findLatest(db, owner, id) {
  const rows = db
    .prepare(
      `SELECT v.version
       FROM versions v
       JOIN owners o ON o.id = v.owner_id
       WHERE o.github_username = ? AND v.package_id = ? AND v.status = 'published'`,
    )
    .all(owner, id);
  if (rows.length === 0) return null;
  rows.sort((a, b) => semver.compare(b.version, a.version));
  return rows[0];
}

function serveBlob(req, res, { db, dataDir, owner, id, version }) {
  const row = db
    .prepare(
      `SELECT v.blob_path, v.status, v.version
       FROM versions v
       JOIN owners o ON o.id = v.owner_id
       WHERE o.github_username = ? AND v.package_id = ? AND v.version = ?`,
    )
    .get(owner, id, version);

  if (!row || row.status !== "published") {
    res.status(404).json({ error: "Version not found." });
    return;
  }

  if (!fs.existsSync(row.blob_path)) {
    res.status(404).json({ error: "Blob file missing on disk." });
    return;
  }

  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.sendFile(path.resolve(row.blob_path));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}
