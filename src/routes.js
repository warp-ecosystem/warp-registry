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
 * Builds a byte-wise sortable key for a semver version so that ORDER BY on the
 * key reproduces full SemVer precedence, including prerelease identifiers.
 * Build metadata is ignored, per the semver spec.
 * @param {string} version - A valid semver version string.
 * @returns {string} A key ordered identically to semver precedence.
 */
export function semverSortKey(version) {
  const parsed = semver.parse(version);
  if (!parsed) return version;
  const pad = (n) => String(n).padStart(20, "0");
  let key = `${pad(parsed.major)}${pad(parsed.minor)}${pad(parsed.patch)}`;
  if (parsed.prerelease.length === 0) return `${key}\x7f`;
  for (const id of parsed.prerelease) {
    if (/^\d+$/.test(id)) key += `0${pad(id)}!`;
    else key += `A${id}!`;
  }
  return key;
}

const semverSortKeyRegistered = new WeakSet();

/**
 * Unicode case-folding table derived from Unicode 16.0 CaseFolding.txt (status
 * C + F). Contains multi-character expansions (F entries) and common (C)
 * entries where the case-folded form differs from
 * {@link String.prototype.toLowerCase}. Characters not listed here are folded
 * by `toLowerCase`.
 *
 * @see https://www.unicode.org/Public/16.0.0/ucd/CaseFolding.txt
 */
const FULL_CASE_FOLD = new Map([
  [0x00b5, "\u03BC"],
  [0x00df, "\u0073\u0073"],
  [0x0130, "\u0069\u0307"],
  [0x0149, "\u02BC\u006E"],
  [0x017f, "\u0073"],
  [0x01f0, "\u006A\u030C"],
  [0x0345, "\u03B9"],
  [0x0390, "\u03B9\u0308\u0301"],
  [0x03b0, "\u03C5\u0308\u0301"],
  [0x03c2, "\u03C3"],
  [0x0587, "\u0565\u0582"],
  [0x1c80, "\u0432"],
  [0x1c81, "\u0434"],
  [0x1c82, "\u043E"],
  [0x1c83, "\u0441"],
  [0x1c84, "\u0442"],
  [0x1c85, "\u0442"],
  [0x1c86, "\u044A"],
  [0x1c87, "\u0463"],
  [0x1c88, "\uA64B"],
  [0x1e96, "\u0068\u0331"],
  [0x1e97, "\u0074\u0308"],
  [0x1e98, "\u0077\u030A"],
  [0x1e99, "\u0079\u030A"],
  [0x1e9a, "\u0061\u02BE"],
  [0x1e9e, "\u0073\u0073"],
  [0x1f50, "\u03C5\u0313"],
  [0x1f52, "\u03C5\u0313\u0300"],
  [0x1f54, "\u03C5\u0313\u0301"],
  [0x1f56, "\u03C5\u0313\u0342"],
  [0x1f80, "\u1F00\u03B9"],
  [0x1f81, "\u1F01\u03B9"],
  [0x1f82, "\u1F02\u03B9"],
  [0x1f83, "\u1F03\u03B9"],
  [0x1f84, "\u1F04\u03B9"],
  [0x1f85, "\u1F05\u03B9"],
  [0x1f86, "\u1F06\u03B9"],
  [0x1f87, "\u1F07\u03B9"],
  [0x1f88, "\u1F00\u03B9"],
  [0x1f89, "\u1F01\u03B9"],
  [0x1f8a, "\u1F02\u03B9"],
  [0x1f8b, "\u1F03\u03B9"],
  [0x1f8c, "\u1F04\u03B9"],
  [0x1f8d, "\u1F05\u03B9"],
  [0x1f8e, "\u1F06\u03B9"],
  [0x1f8f, "\u1F07\u03B9"],
  [0x1f90, "\u1F20\u03B9"],
  [0x1f91, "\u1F21\u03B9"],
  [0x1f92, "\u1F22\u03B9"],
  [0x1f93, "\u1F23\u03B9"],
  [0x1f94, "\u1F24\u03B9"],
  [0x1f95, "\u1F25\u03B9"],
  [0x1f96, "\u1F26\u03B9"],
  [0x1f97, "\u1F27\u03B9"],
  [0x1f98, "\u1F20\u03B9"],
  [0x1f99, "\u1F21\u03B9"],
  [0x1f9a, "\u1F22\u03B9"],
  [0x1f9b, "\u1F23\u03B9"],
  [0x1f9c, "\u1F24\u03B9"],
  [0x1f9d, "\u1F25\u03B9"],
  [0x1f9e, "\u1F26\u03B9"],
  [0x1f9f, "\u1F27\u03B9"],
  [0x1fa0, "\u1F60\u03B9"],
  [0x1fa1, "\u1F61\u03B9"],
  [0x1fa2, "\u1F62\u03B9"],
  [0x1fa3, "\u1F63\u03B9"],
  [0x1fa4, "\u1F64\u03B9"],
  [0x1fa5, "\u1F65\u03B9"],
  [0x1fa6, "\u1F66\u03B9"],
  [0x1fa7, "\u1F67\u03B9"],
  [0x1fa8, "\u1F60\u03B9"],
  [0x1fa9, "\u1F61\u03B9"],
  [0x1faa, "\u1F62\u03B9"],
  [0x1fab, "\u1F63\u03B9"],
  [0x1fac, "\u1F64\u03B9"],
  [0x1fad, "\u1F65\u03B9"],
  [0x1fae, "\u1F66\u03B9"],
  [0x1faf, "\u1F67\u03B9"],
  [0x1fb2, "\u1F70\u03B9"],
  [0x1fb3, "\u03B1\u03B9"],
  [0x1fb4, "\u03AC\u03B9"],
  [0x1fb6, "\u03B1\u0342"],
  [0x1fb7, "\u03B1\u0342\u03B9"],
  [0x1fbc, "\u03B1\u03B9"],
  [0x1fc2, "\u1F74\u03B9"],
  [0x1fc3, "\u03B7\u03B9"],
  [0x1fc4, "\u03AE\u03B9"],
  [0x1fc6, "\u03B7\u0342"],
  [0x1fc7, "\u03B7\u0342\u03B9"],
  [0x1fcc, "\u03B7\u03B9"],
  [0x1fd2, "\u03B9\u0308\u0300"],
  [0x1fd3, "\u03B9\u0308\u0301"],
  [0x1fd6, "\u03B9\u0342"],
  [0x1fd7, "\u03B9\u0308\u0342"],
  [0x1fe2, "\u03C5\u0308\u0300"],
  [0x1fe3, "\u03C5\u0308\u0301"],
  [0x1fe4, "\u03C1\u0313"],
  [0x1fe6, "\u03C5\u0342"],
  [0x1fe7, "\u03C5\u0308\u0342"],
  [0x1ff2, "\u1F7C\u03B9"],
  [0x1ff3, "\u03C9\u03B9"],
  [0x1ff4, "\u03CE\u03B9"],
  [0x1ff6, "\u03C9\u0342"],
  [0x1ff7, "\u03C9\u0342\u03B9"],
  [0x1ffc, "\u03C9\u03B9"],
  [0xfb00, "\u0066\u0066"],
  [0xfb01, "\u0066\u0069"],
  [0xfb02, "\u0066\u006C"],
  [0xfb03, "\u0066\u0066\u0069"],
  [0xfb04, "\u0066\u0066\u006C"],
  [0xfb05, "\u0073\u0074"],
  [0xfb06, "\u0073\u0074"],
  [0xfb13, "\u0574\u0576"],
  [0xfb14, "\u0574\u0565"],
  [0xfb15, "\u0574\u056B"],
  [0xfb16, "\u057E\u0576"],
  [0xfb17, "\u0574\u056D"],
]);

/**
 * Case-folds a string using the full Unicode case mapping (not just ASCII).
 * SQLite's built-in LIKE and lower() only fold ASCII (A-Z/a-z), so this is
 * used for name matching to support non-ASCII case-insensitivity. Applies both
 * multi-character expansions (e.g. ß/SS) and single-code-point folds where
 * Unicode case folding differs from {@link String.prototype.toLowerCase}
 * (e.g. U+017F ſ → "s").
 * @param {unknown} value - The value to fold.
 * @returns {string} The case-folded string, or an empty string for NULL.
 */
function unicodeFold(value) {
  if (value == null) return "";
  const str = String(value).normalize("NFC");
  let result = "";
  for (const char of str) {
    const fold = FULL_CASE_FOLD.get(char.codePointAt(0));
    result += fold !== undefined ? fold : char.toLowerCase();
  }
  return result;
}

const unicodeFoldRegistered = new WeakSet();

/**
 * Detects a violation of the partial unique index that allows at most one
 * staging or pending version per owner, distinguishing it from the per-version
 * uniqueness constraint.
 * Determines whether the owner has a staging or pending row by querying the
 * database state before classifying the conflict. The pending classification
 * is returned only when that row confirms it; the error-message check is kept
 * solely as a fallback when the state query cannot determine the result.
 * @param {unknown} err - The error thrown by better-sqlite3.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {number} ownerId - The id of the owner performing the publish.
 * @param {string} packageId - The package id being published.
 * @param {string} version - The version being published.
 * @returns {boolean} True if the error is the one-pending-per-owner violation.
 */
function isPendingConflict(err, db, ownerId, packageId, version) {
  if (
    db
      .prepare(
        `SELECT 1 FROM versions
         WHERE owner_id = ? AND status IN ('staging', 'pending')
           AND NOT (package_id = ? AND version = ?)`,
      )
      .get(ownerId, packageId, version)
  ) {
    return true;
  }
  return (
    err?.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof err.message === "string" &&
    err.message.includes("versions.owner_id") &&
    !err.message.includes("versions.package_id")
  );
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

  if (!semverSortKeyRegistered.has(db)) {
    db.function("semverSortKey", { deterministic: true }, semverSortKey);
    semverSortKeyRegistered.add(db);
  }

  if (!unicodeFoldRegistered.has(db)) {
    db.function("unicode_fold", { deterministic: true }, unicodeFold);
    unicodeFoldRegistered.add(db);
  }

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

    const absBlobPath = blobPath(dataDir, ownerName, packageId, version);
    const tempBlobPath = `${absBlobPath}.tmp-${crypto
      .randomBytes(6)
      .toString("hex")}`;

    let finalStatus;
    try {
      fs.mkdirSync(path.dirname(absBlobPath), { recursive: true });
      fs.writeFileSync(tempBlobPath, source);

      const outcome = db
        .transaction(() => {
          const current = db
            .prepare("SELECT has_published FROM owners WHERE id = ?")
            .get(owner.id);
          const derivedStatus =
            current.has_published === 1 ? "published" : "pending";

          const blocked =
            current.has_published !== 1 &&
            db
              .prepare(
                `SELECT id FROM versions
                 WHERE owner_id = ? AND status = 'pending'
                   AND NOT (package_id = ? AND version = ?)`,
              )
              .get(owner.id, packageId, version);

          if (blocked) return { blocked: true };

          db.prepare(
            `INSERT INTO versions (owner_id, package_id, version, status, final_status, meta_json, blob_path)
             VALUES (?, ?, ?, 'staging', ?, ?, ?)`,
          ).run(
            owner.id,
            packageId,
            version,
            derivedStatus,
            JSON.stringify(meta),
            absBlobPath,
          );
          fs.renameSync(tempBlobPath, absBlobPath);
          db.prepare(
            `UPDATE versions SET status = ? WHERE owner_id = ? AND package_id = ? AND version = ?`,
          ).run(derivedStatus, owner.id, packageId, version);

          return { status: derivedStatus };
        })
        .immediate();

      if (outcome.blocked) {
        fs.rmSync(tempBlobPath, { force: true });
        res.status(409).json({
          error:
            "A publish from your account is already awaiting review. Wait for it to be approved before publishing again.",
        });
        error(
          "A publish from your account is already awaiting review. Wait for it to be approved before publishing again.",
        );
        return;
      }
      finalStatus = outcome.status;
    } catch (err) {
      fs.rmSync(tempBlobPath, { force: true });
      const blobReferenced = db
        .prepare("SELECT 1 FROM versions WHERE blob_path = ?")
        .get(absBlobPath);
      if (!blobReferenced) {
        fs.rmSync(absBlobPath, { force: true });
      }
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        if (isPendingConflict(err, db, owner.id, packageId, version)) {
          res.status(409).json({
            error:
              "A publish from your account is already awaiting review. Wait for it to be approved before publishing again.",
          });
          error(
            "A publish from your account is already awaiting review. Wait for it to be approved before publishing again.",
          );
          return;
        }
        res
          .status(409)
          .json({ error: "This version already exists for this owner." });
        error("This version already exists for this owner.");
        return;
      }
      next(err);
      return;
    }

    res.status(201).json({
      owner: ownerName,
      id: packageId,
      version,
      status: finalStatus,
      url: `/v1/${ownerName}/${packageId}/${version}`,
    });

    success(`${ownerName}/${packageId}@${version} (${finalStatus})`);
  });

  const latestPublishedSelections = `
    SELECT o.github_username AS owner, v.package_id AS id,
           v.meta_json AS meta_json, v.version AS latestVersion,
           v.created_at AS created_at,
           ROW_NUMBER() OVER (
             PARTITION BY v.owner_id, v.package_id
             ORDER BY semverSortKey(v.version) DESC, v.id DESC
           ) AS rn
    FROM versions v
    JOIN owners o ON o.id = v.owner_id
    WHERE v.status = 'published'
  `;

  app.get("/v1/search", (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (!q) {
      res.status(400).json({ error: "Missing required `q` query parameter." });
      error("Missing required `q` query parameter.");
      return;
    }
    const escaped = q
      .replace(/\\/g, "\\\\")
      .replace(/%/g, "\\%")
      .replace(/_/g, "\\_");
    const pattern = `%${escaped}%`;
    const rows = db
      .prepare(
        `SELECT owner, id, meta_json, latestVersion
         FROM (${latestPublishedSelections}) t
         WHERE t.rn = 1
           AND (unicode_fold(json_extract(t.meta_json, '$.name'))
                  LIKE unicode_fold(?) ESCAPE '\\'
             OR json_extract(t.meta_json, '$.version') LIKE ? ESCAPE '\\'
             OR json_extract(t.meta_json, '$.license') LIKE ? ESCAPE '\\'
             OR json_extract(t.meta_json, '$.description') LIKE ? ESCAPE '\\'
             OR t.id LIKE ? ESCAPE '\\'
             OR t.owner LIKE ? ESCAPE '\\')
         ORDER BY t.created_at DESC, t.owner ASC, t.id ASC
         LIMIT 10`,
      )
      .all(pattern, pattern, pattern, pattern, pattern, pattern);
    res.json({
      results: rows.map((r) => {
        const meta = JSON.parse(r.meta_json);
        return {
          owner: r.owner,
          id: r.id,
          name: meta.name,
          description: meta.description,
          latestVersion: r.latestVersion,
        };
      }),
    });
  });

  app.get("/v1/packages", (req, res) => {
    let limit = 20;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (!Number.isInteger(parsed) || parsed <= 0) {
        res.status(400).json({ error: "limit must be a positive integer." });
        return;
      }
      limit = parsed;
    }
    limit = Math.min(limit, 50);

    let cursor = null;
    if (req.query.cursor !== undefined && req.query.cursor !== "") {
      let decoded;
      try {
        decoded = JSON.parse(
          Buffer.from(req.query.cursor, "base64").toString("utf8"),
        );
      } catch {
        res.status(400).json({ error: "Invalid cursor." });
        return;
      }
      if (
        !decoded ||
        typeof decoded !== "object" ||
        typeof decoded.createdAt !== "string" ||
        typeof decoded.owner !== "string" ||
        typeof decoded.packageId !== "string"
      ) {
        res.status(400).json({ error: "Invalid cursor." });
        return;
      }
      cursor = decoded;
    }

    let where = "WHERE t.rn = 1";
    const params = [];
    if (cursor) {
      where += ` AND (
        t.created_at < ? OR
        (t.created_at = ? AND (t.owner > ? OR (t.owner = ? AND t.id > ?)))
      )`;
      params.push(
        cursor.createdAt,
        cursor.createdAt,
        cursor.owner,
        cursor.owner,
        cursor.packageId,
      );
    }

    const rows = db
      .prepare(
        `SELECT t.owner, t.id, t.meta_json, t.latestVersion, t.created_at
         FROM (${latestPublishedSelections}) t
         ${where}
         ORDER BY t.created_at DESC, t.owner ASC, t.id ASC
         LIMIT ?`,
      )
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    let nextCursor = null;
    if (hasMore) {
      const last = page[page.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({
          createdAt: last.created_at,
          owner: last.owner,
          packageId: last.id,
        }),
      ).toString("base64");
    }

    res.json({
      packages: page.map((r) => {
        const meta = JSON.parse(r.meta_json);
        return {
          owner: r.owner,
          id: r.id,
          name: meta.name,
          description: meta.description,
          latestVersion: r.latestVersion,
          publishedAt: r.created_at,
        };
      }),
      nextCursor,
    });
  });

  app.get("/v1/stats", (req, res) => {
    const published = db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT 1 FROM versions WHERE status = 'published'
           GROUP BY owner_id, package_id
         )`,
      )
      .get().c;
    const pending = db
      .prepare(`SELECT COUNT(*) AS c FROM versions WHERE status = 'pending'`)
      .get().c;
    const authors = db
      .prepare(
        `SELECT COUNT(*) AS c FROM (
           SELECT 1 FROM versions WHERE status = 'published'
           GROUP BY owner_id
         )`,
      )
      .get().c;

    res.json({ published, pending, authors });
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
