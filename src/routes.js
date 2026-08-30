import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import semver from "semver";
import { blobPath, blobsDir } from "./db.js";
import { extractWarpMeta } from "./warp-meta.js";
import { success, error } from "./logger.js";

/**
 * Regular expression for validating package IDs.
 * Package IDs must start with an alphanumeric character and can contain dots, dashes, and underscores.
 */
export const PACKAGE_ID_RE = /^[a-z0-9](?:[a-z0-9._-]{0,63})$/;

/**
 * Computes the SHA-256 hash of a token.
 * @param {string} token - The token to hash.
 * @returns {string} The hex-encoded hash.
 */
export function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Creates and configures the Express application.
 * Sets up all routes for OAuth, publishing, and serving packages.
 * @param {object} options - Configuration options.
 * @param {import('better-sqlite3').Database} options.db - The database instance.
 * @param {string} options.dataDir - The data directory path.
 * @param {object} [options.config={}] - Optional configuration for GitHub OAuth and public URL.
 * @returns {import('express').Express} The configured Express app.
 */
export function createApp({ db, dataDir, config = {} }) {
  const app = express();
  app.use(express.json());

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
    const state = crypto.randomBytes(16).toString("hex");
    setStateCookie(res, state, config);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "read:user",
      state,
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
    const state = req.query.state;
    if (typeof state !== "string" || !verifyState(req, state, config)) {
      res.status(400).send("Missing or invalid OAuth state.");
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

  app.post("/v1/publish", async (req, res, next) => {
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
      error("Content-Type must be application/javascript or text/plain.");
      return;
    }

    let source;
    try {
      source = await readRawBody(req);
    } catch (bodyErr) {
      if (bodyErr && bodyErr.statusCode === 413) {
        res.status(413).json({ error: "Request body too large." });
        error("Request body too large.");
        return;
      }
      res.status(400).json({ error: "Failed to read request body." });
      error("Failed to read request body.");
      return;
    }

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
      error(
        "meta.id is required and must match ^[a-z0-9](?:[a-z0-9._-]{0,63})$.",
      );
      return;
    }
    const version = semver.valid(meta.version);
    if (version === null) {
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
        error(`meta.${field} is required and must be a non-empty string.`);
        return;
      }
    }

    const packageId = meta.id;
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
    const tempBlobPath = `${absBlobPath}.tmp-${crypto
      .randomBytes(6)
      .toString("hex")}`;

    try {
      fs.mkdirSync(path.dirname(absBlobPath), { recursive: true });
      fs.writeFileSync(tempBlobPath, source);

      const stageVersion = db.transaction(() => {
        db.prepare(
          `INSERT INTO versions (owner_id, package_id, version, status, final_status, meta_json, blob_path)
           VALUES (?, ?, ?, 'staging', ?, ?, ?)`,
        ).run(
          owner.id,
          packageId,
          version,
          status,
          JSON.stringify(meta),
          absBlobPath,
        );
      });

      try {
        stageVersion();
      } catch {
        fs.rmSync(tempBlobPath, { force: true });
        res
          .status(409)
          .json({ error: "This version already exists for this owner." });
        error("This version already exists for this owner.");
        return;
      }

      try {
        fs.renameSync(tempBlobPath, absBlobPath);
      } catch (err) {
        db.prepare(
          `DELETE FROM versions WHERE owner_id = ? AND package_id = ? AND version = ?`,
        ).run(owner.id, packageId, version);
        throw err;
      }

      db.prepare(
        `UPDATE versions SET status = ? WHERE owner_id = ? AND package_id = ? AND version = ?`,
      ).run(status, owner.id, packageId, version);
    } catch (err) {
      fs.rmSync(tempBlobPath, { force: true });
      next(err);
      return;
    }

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

  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      res.status(400).json({ error: "Malformed JSON body." });
      return;
    }
    next(err);
  });

  return app;
}

/**
 * Marker string used in temporary blob file names.
 */
const TEMP_MARKER = ".tmp-";

/**
 * Reconciles staged versions on startup, promoting or deleting them based on blob existence.
 * Cleans up stale temporary blob files.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} dataDir - The data directory path.
 */
export function reconcileStagedVersions(db, dataDir) {
  const staged = db
    .prepare(
      `SELECT v.id, v.blob_path, v.final_status
       FROM versions v
       WHERE v.status = 'staging'`,
    )
    .all();

  for (const row of staged) {
    if (fs.existsSync(row.blob_path)) {
      db.prepare(`UPDATE versions SET status = ? WHERE id = ?`).run(
        row.final_status,
        row.id,
      );
      continue;
    }
    db.prepare(`DELETE FROM versions WHERE id = ?`).run(row.id);
  }

  cleanStaleTempBlobs(db, dataDir);
}

/**
 * Cleans up stale temporary blob files that are no longer needed.
 * Removes temp files if their final versions don't exist or are not referenced.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} dataDir - The data directory path.
 */
function cleanStaleTempBlobs(db, dataDir) {
  const blobsRoot = blobsDir(dataDir);
  if (!fs.existsSync(blobsRoot)) return;
  const referenced = new Set(
    db
      .prepare("SELECT blob_path FROM versions")
      .all()
      .map((row) => row.blob_path),
  );
  for (const file of collectFiles(blobsRoot)) {
    const markerIndex = file.lastIndexOf(TEMP_MARKER);
    if (markerIndex === -1) continue;
    const finalPath = file.slice(0, markerIndex);
    if (!referenced.has(finalPath) || !fs.existsSync(finalPath)) {
      fs.unlinkSync(file);
    }
  }
}

/**
 * Recursively collects all file paths in a directory.
 * @param {string} dir - The directory to traverse.
 * @returns {string[]} Array of absolute file paths.
 */
function collectFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(full));
    else files.push(full);
  }
  return files;
}

/**
 * Finds the latest published version of a package.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} owner - The package owner's username.
 * @param {string} id - The package identifier.
 * @returns {object|null} The latest version row, or null if no published versions exist.
 */
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

/**
 * Serves a package version blob file as JavaScript.
 * @param {import('express').Request} req - The Express request object.
 * @param {import('express').Response} res - The Express response object.
 * @param {object} options - Options for serving the blob.
 * @param {import('better-sqlite3').Database} options.db - The database instance.
 * @param {string} options.owner - The package owner's username.
 * @param {string} options.id - The package identifier.
 * @param {string} options.version - The package version.
 */
function serveBlob(req, res, { db, owner, id, version }) {
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
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.sendFile(path.resolve(row.blob_path));
}

/**
 * Maximum allowed request body size in bytes (1MB).
 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * Reads the raw body of a request as a UTF-8 string.
 * Enforces a maximum body size to prevent memory exhaustion.
 * @param {import('express').Request} req - The Express request object.
 * @param {number} [maxBytes=MAX_BODY_BYTES] - Maximum allowed body size in bytes.
 * @returns {Promise<string>} The request body as a string.
 */
function readRawBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        const err = new Error("Request body too large.");
        err.statusCode = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (req.destroyed) return;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * Converts a hex string to a Buffer.
 * @param {string} hex - The hex string to convert.
 * @returns {Buffer|null} The Buffer, or null if the hex string is invalid.
 */
function hexToBuffer(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0) return null;
  return Buffer.from(hex, "hex");
}

/**
 * Returns the secret used for signing OAuth state cookies.
 * Falls back to client ID or a default if client secret is not configured.
 * @param {object} config - The configuration object.
 * @returns {string} The state secret.
 */
function stateSecret(config) {
  return (
    config.GITHUB_CLIENT_SECRET || config.GITHUB_CLIENT_ID || "warp-registry"
  );
}

/**
 * Sets an HttpOnly cookie containing the signed OAuth state.
 * @param {import('express').Response} res - The Express response object.
 * @param {string} state - The state value to sign and store.
 * @param {object} config - The configuration object.
 */
function setStateCookie(res, state, config) {
  const sig = crypto
    .createHmac("sha256", stateSecret(config))
    .update(state)
    .digest("hex");
  res.setHeader(
    "Set-Cookie",
    `warp_oauth_state=${state}.${sig}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600`,
  );
}

/**
 * Verifies the OAuth state cookie matches the provided state value.
 * Uses timing-safe comparison to prevent timing attacks.
 * @param {import('express').Request} req - The Express request object.
 * @param {string} state - The state value to verify.
 * @param {object} config - The configuration object.
 * @returns {boolean} True if the state is valid, false otherwise.
 */
function verifyState(req, state, config) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [name, value] = part.trim().split("=");
    if (name !== "warp_oauth_state" || !value) continue;
    const [cookieState, cookieSig] = value.split(".");
    if (!cookieState || !cookieSig) return false;
    if (cookieState !== state) return false;
    const expected = crypto
      .createHmac("sha256", stateSecret(config))
      .update(cookieState)
      .digest("hex");
    const sigBuf = hexToBuffer(cookieSig);
    const expBuf = hexToBuffer(expected);
    if (!sigBuf || !expBuf || sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  }
  return false;
}

/**
 * Escapes HTML special characters to prevent XSS attacks.
 * @param {string} str - The string to escape.
 * @returns {string} The escaped string.
 */
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
