import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express from "express";
import semver from "semver";
import { NAMESPACE_RE, blobPath, blobsDir } from "./db.js";
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
 * Hashes a password using scrypt with a random salt.
 * @param {string} password - The password to hash.
 * @returns {string} The salt:hash pair in hex format.
 */
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Lifetime of an issued auth token in milliseconds (7 days).
 */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Auth rate-limit configuration: at most MAX consecutive failed attempts over
 * the window before the client is throttled with 429.
 */
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;

/**
 * Fixed page size used for paginated /search results.
 */
const SEARCH_PAGE_SIZE = 10;

/**
 * Simple in-memory rate limiter keyed by `namespace|ip`.
 * Tracks failed attempts for a rolling window. Not sharded or persisted; a
 * restart resets the counters.
 */
function createRateLimiter() {
  const buckets = new Map();
  function sweep() {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now - entry.firstAttemptAt > RATE_LIMIT_WINDOW_MS) {
        buckets.delete(key);
      }
    }
  }
  return {
    onFailure(key, now = Date.now()) {
      sweep();
      let entry = buckets.get(key);
      if (!entry) {
        entry = { count: 0, firstAttemptAt: now };
        buckets.set(key, entry);
      }
      entry.count += 1;
      return entry.count >= RATE_LIMIT_MAX;
    },
    onSuccess(key) {
      buckets.delete(key);
    },
  };
}

/**
 * Per-IP limiter that counts successful signup requests. Unlike
 * createRateLimiter, failed/rejected attempts do not count; only successful
 * account creations consume the bucket so an IP cannot churn out unlimited
 * accounts within the window.
 */
function createSignupLimiter() {
  const buckets = new Map();
  function sweep(now = Date.now()) {
    for (const [key, entry] of buckets) {
      if (now - entry.firstAt > RATE_LIMIT_WINDOW_MS) {
        buckets.delete(key);
      }
    }
  }
  return {
    isLimited(key, now = Date.now()) {
      sweep(now);
      const entry = buckets.get(key);
      return !!entry && entry.count >= RATE_LIMIT_MAX;
    },
    reserve(key, now = Date.now()) {
      sweep(now);
      const entry = buckets.get(key);
      if (!entry) {
        buckets.set(key, { count: 0, reserved: 1, firstAt: now });
        return true;
      }
      if (entry.count + entry.reserved >= RATE_LIMIT_MAX) {
        return false;
      }
      entry.reserved += 1;
      return true;
    },
    release(key) {
      const entry = buckets.get(key);
      if (entry && entry.reserved > 0) {
        entry.reserved -= 1;
      }
    },
    recordSuccess(key, now = Date.now()) {
      sweep(now);
      const entry = buckets.get(key);
      if (entry) {
        entry.count += 1;
        if (entry.reserved > 0) {
          entry.reserved -= 1;
        }
      } else {
        buckets.set(key, { count: 1, reserved: 0, firstAt: now });
      }
    },
  };
}

/**
 * Hashes a password using scrypt with a random salt, asynchronously.
 * @param {string} password - The password to hash.
 * @returns {Promise<string>} A promise resolving to the salt:hash pair in hex format.
 */
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString("hex"));
    });
  });
  return `${salt}:${hash}`;
}

/**
 * Verifies a password against a stored hash, asynchronously.
 * @param {string} password - The password to verify.
 * @param {string} stored - The stored salt:hash pair.
 * @returns {Promise<boolean>} Resolves true if the password matches.
 */
export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const computed = await new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, SCRYPT_PARAMS, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey.toString("hex"));
    });
  });
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(computed, "hex"),
    );
  } catch {
    return false;
  }
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
 * Authenticates a request by extracting and validating the Bearer token.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @param {string} authHeader - The Authorization header value.
 * @returns {{user: object, tokenHash: string}|null} The authenticated user and token hash, or null.
 */
function authenticate(db, authHeader) {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader || "");
  if (!match) return null;
  const token = match[1].trim();
  const tokenHash = hashToken(token);
  const row = db
    .prepare(
      `SELECT u.*, t.id AS token_id, t.expires_at
       FROM auth_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ?`,
    )
    .get(tokenHash);
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    db.prepare("DELETE FROM auth_tokens WHERE id = ?").run(row.token_id);
    return null;
  }
  return { user: row, tokenHash };
}

/**
 * Builds a User response object from a database row.
 * @param {object} row - The user database row.
 * @param {import('better-sqlite3').Database} db - The database instance.
 * @returns {object} The User response object.
 */
function userResponse(row, db) {
  const extensions = db
    .prepare(
      `SELECT DISTINCT package_id FROM versions
       WHERE owner_id = ? AND status = 'published'`,
    )
    .all(row.id)
    .map((r) => r.package_id);
  return {
    id: row.id,
    displayName: row.display_name,
    namespace: row.namespace,
    type: row.type,
    extensions,
  };
}

/**
 * Decodes and validates an opaque pagination cursor.
 * A cursor is a base64-encoded JSON object. Returns `{ ok: false }` when the
 * cursor is malformed or fails the caller-supplied shape validation, otherwise
 * `{ ok: true, value }` where `value` is null when no cursor was provided.
 * @param {string|undefined} raw - The raw query parameter value.
 * @param {(decoded: object) => boolean} validate - Shape validation predicate.
 * @returns {{ ok: boolean, value?: object|null }}
 */
function decodeCursor(raw, validate) {
  if (raw === undefined || raw === "") return { ok: true, value: null };
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return { ok: false };
  }
  if (!decoded || typeof decoded !== "object" || !validate(decoded)) {
    return { ok: false };
  }
  return { ok: true, value: decoded };
}

/**
 * Creates and configures the Express application.
 * Sets up all v2 routes for auth, user management, publishing, and discovery.
 * @param {object} options - Configuration options.
 * @param {import('better-sqlite3').Database} options.db - The database instance.
 * @param {string} options.dataDir - The data directory path.
 * @returns {import('express').Express} The configured Express app.
 */
export function createApp({ db, dataDir }) {
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

  // ── Auth routes ──────────────────────────────────────────────────────

  const rateLimiter = createRateLimiter();
  const signupLimiter = createSignupLimiter();

  const rateLimited = (res) => {
    res.status(429).json({ error: "Too many attempts. Try again later." });
  };

  const clientIp = (req) =>
    req.ip || (req.socket && req.socket.remoteAddress) || "unknown";

  app.post("/v2/auth/signup", async (req, res) => {
    const { namespace, displayName, password } = req.body || {};
    const rateKey = `signup:${clientIp(req)}`;
    const reject = (status, error) => {
      if (rateLimiter.onFailure(rateKey)) {
        rateLimited(res);
        return;
      }
      res.status(status).json({ error });
    };

    if (!namespace || typeof namespace !== "string") {
      reject(400, "namespace is required.");
      return;
    }
    if (!NAMESPACE_RE.test(namespace)) {
      reject(
        400,
        "namespace must match ^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$.",
      );
      return;
    }
    if (!password || typeof password !== "string" || password.length < 8) {
      reject(400, "password must be at least 8 characters.");
      return;
    }
    if (displayName !== undefined && typeof displayName !== "string") {
      reject(400, "displayName must be a string.");
      return;
    }

    if (signupLimiter.isLimited(rateKey)) {
      rateLimited(res);
      return;
    }
    if (!signupLimiter.reserve(rateKey)) {
      rateLimited(res);
      return;
    }

    const existing = db
      .prepare("SELECT id FROM users WHERE namespace = ?")
      .get(namespace);
    if (existing) {
      signupLimiter.release(rateKey);
      reject(409, "Namespace already exists.");
      return;
    }

    const passwordHash = await hashPassword(password);

    let result;
    try {
      result = db
        .prepare(
          `INSERT INTO users (namespace, display_name, password_hash, type)
           VALUES (?, ?, ?, 'normal')`,
        )
        .run(namespace, displayName || "", passwordHash);
    } catch (err) {
      signupLimiter.release(rateKey);
      if (err.code === "SQLITE_CONSTRAINT_UNIQUE") {
        reject(409, "Namespace already exists.");
        return;
      }
      throw err;
    }

    signupLimiter.recordSuccess(rateKey);

    const user = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(result.lastInsertRowid);

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    db.prepare(
      "INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    ).run(user.id, tokenHash, expiresAt);

    success(`User signed up: ${namespace}`);
    res.status(201).json({ user: userResponse(user, db), token });
  });

  app.post("/v2/auth/login", async (req, res) => {
    const { namespace, password } = req.body || {};
    if (!namespace || typeof namespace !== "string") {
      res.status(400).json({ error: "namespace is required." });
      return;
    }
    if (!password || typeof password !== "string") {
      res.status(400).json({ error: "password is required." });
      return;
    }

    const rateKey = `login:${namespace}|${clientIp(req)}`;
    if (rateLimiter.onFailure(rateKey)) {
      rateLimited(res);
      return;
    }

    const user = db
      .prepare("SELECT * FROM users WHERE namespace = ?")
      .get(namespace);
    const ok = user && (await verifyPassword(password, user.password_hash));
    if (!user || !ok) {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }
    rateLimiter.onSuccess(rateKey);

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
    db.prepare(
      "INSERT INTO auth_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    ).run(user.id, tokenHash, expiresAt);

    success(`User logged in: ${namespace}`);
    res.status(200).json({ user: userResponse(user, db), token });
  });

  app.post("/v2/auth/logout", (req, res) => {
    const auth = authenticate(db, req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    db.prepare("DELETE FROM auth_tokens WHERE token_hash = ?").run(
      auth.tokenHash,
    );
    res.status(200).json({ message: "Logged out." });
  });

  // ── User routes ──────────────────────────────────────────────────────

  app.get("/v2/users", (req, res) => {
    let limit = 20;
    if (req.query.limit !== undefined) {
      const parsed = Number(req.query.limit);
      if (!Number.isInteger(parsed) || parsed < 1) {
        res.status(400).json({ error: "limit must be a positive integer." });
        return;
      }
      limit = parsed;
    }
    limit = Math.min(limit, 50);

    const cursor = decodeCursor(
      req.query.cursor,
      (d) => typeof d.id === "number",
    );
    if (!cursor.ok) {
      res.status(400).json({ error: "Invalid cursor." });
      return;
    }
    const cursorId = cursor.value ? cursor.value.id : null;

    const where = cursorId !== null ? "WHERE id > ?" : "";
    const params = cursorId !== null ? [cursorId] : [];

    const rows = db
      .prepare(`SELECT * FROM users ${where} ORDER BY id ASC LIMIT ?`)
      .all(...params, limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);

    let nextCursor = null;
    if (hasMore) {
      nextCursor = Buffer.from(
        JSON.stringify({ id: page[page.length - 1].id }),
      ).toString("base64");
    }

    res.json({
      users: page.map((r) => userResponse(r, db)),
      nextCursor,
    });
  });

  app.get("/v2/users/:namespace", (req, res) => {
    const user = db
      .prepare("SELECT * FROM users WHERE namespace = ?")
      .get(req.params.namespace);
    if (!user) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    res.json(userResponse(user, db));
  });

  app.patch("/v2/users/:namespace", async (req, res) => {
    const auth = authenticate(db, req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    const target = db
      .prepare("SELECT * FROM users WHERE namespace = ?")
      .get(req.params.namespace);
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    if (auth.user.type !== "admin" && auth.user.id !== target.id) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }

    const { displayName, password } = req.body || {};
    if (displayName === undefined && password === undefined) {
      res.status(400).json({ error: "At least one field is required." });
      return;
    }

    if (displayName !== undefined && typeof displayName !== "string") {
      res.status(400).json({ error: "displayName must be a string." });
      return;
    }
    if (
      password !== undefined &&
      (typeof password !== "string" || password.length < 8)
    ) {
      res.status(400).json({
        error: "password must be at least 8 characters.",
      });
      return;
    }

    if (displayName !== undefined) {
      db.prepare("UPDATE users SET display_name = ? WHERE id = ?").run(
        displayName,
        target.id,
      );
    }
    if (password !== undefined) {
      const passwordHash = await hashPassword(password);
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        passwordHash,
        target.id,
      );
      db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(target.id);
    }

    const updated = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(target.id);
    res.json(userResponse(updated, db));
  });

  app.delete("/v2/users/:namespace", (req, res) => {
    const auth = authenticate(db, req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    const target = db
      .prepare("SELECT * FROM users WHERE namespace = ?")
      .get(req.params.namespace);
    if (!target) {
      res.status(404).json({ error: "User not found." });
      return;
    }
    if (auth.user.type !== "admin" && auth.user.id !== target.id) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }

    const versions = db
      .prepare(
        `SELECT version, blob_path FROM versions
         WHERE owner_id = ?`,
      )
      .all(target.id);

    const deleteUser = db.transaction((id) => {
      db.prepare("DELETE FROM auth_tokens WHERE user_id = ?").run(id);
      db.prepare("DELETE FROM versions WHERE owner_id = ?").run(id);
      db.prepare("DELETE FROM users WHERE id = ?").run(id);
    });
    deleteUser(target.id);

    for (const v of versions) {
      fs.rmSync(v.blob_path, { force: true });
    }

    res.status(200).json({ message: "Deleted." });
  });

  // ── Publish route ────────────────────────────────────────────────────

  app.post("/v2/publish", (req, res, next) => {
    const auth = authenticate(db, req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }

    const { id, meta, extensionBlob } = req.body || {};
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id is required." });
      return;
    }
    if (!PACKAGE_ID_RE.test(id)) {
      res.status(400).json({
        error: "id must match ^[a-z0-9](?:[a-z0-9._-]{0,63})$.",
      });
      return;
    }
    if (!meta || typeof meta !== "object") {
      res.status(400).json({ error: "meta is required." });
      return;
    }
    if (!extensionBlob || typeof extensionBlob !== "string") {
      res.status(400).json({ error: "extensionBlob is required." });
      return;
    }

    const source = extensionBlob;
    const {
      ok,
      meta: extractedMeta,
      error: metaError,
    } = extractWarpMeta(source);
    if (!ok) {
      res.status(400).json({ error: metaError });
      error(metaError);
      return;
    }

    if (extractedMeta.id !== id) {
      res.status(400).json({
        error: "meta.id must match the request id.",
      });
      return;
    }

    const version = semver.valid(extractedMeta.version);
    if (version === null) {
      res.status(400).json({
        error: "meta.version must be a valid semver string.",
      });
      error("meta.version must be a valid semver string.");
      return;
    }
    for (const field of ["name", "license", "description"]) {
      if (
        typeof extractedMeta[field] !== "string" ||
        extractedMeta[field].length === 0
      ) {
        res.status(400).json({
          error: `meta.${field} is required and must be a non-empty string.`,
        });
        error(`meta.${field} is required and must be a non-empty string.`);
        return;
      }
    }

    const packageId = id;
    const ownerName = auth.user.namespace;

    const existing = db
      .prepare(
        `SELECT id FROM versions WHERE owner_id = ? AND package_id = ? AND version = ?`,
      )
      .get(auth.user.id, packageId, version);
    if (existing) {
      res
        .status(409)
        .json({ error: "This version already exists for this owner." });
      error("This version already exists for this owner.");
      return;
    }

    const pending = db
      .prepare(
        `SELECT id FROM versions
         WHERE owner_id = ? AND status IN ('staging', 'pending')
           AND NOT (package_id = ? AND version = ?)`,
      )
      .get(auth.user.id, packageId, version);
    if (pending) {
      res.status(403).json({
        error:
          "A publish from your account is already awaiting review. Wait for it to be approved before publishing again.",
      });
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
            .prepare("SELECT has_published FROM users WHERE id = ?")
            .get(auth.user.id);
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
              .get(auth.user.id, packageId, version);

          if (blocked) return { blocked: true };

          db.prepare(
            `INSERT INTO versions (owner_id, package_id, version, status, final_status, meta_json, blob_path)
             VALUES (?, ?, ?, 'staging', ?, ?, ?)`,
          ).run(
            auth.user.id,
            packageId,
            version,
            derivedStatus,
            JSON.stringify(extractedMeta),
            absBlobPath,
          );
          fs.renameSync(tempBlobPath, absBlobPath);
          db.prepare(
            `UPDATE versions SET status = ? WHERE owner_id = ? AND package_id = ? AND version = ?`,
          ).run(derivedStatus, auth.user.id, packageId, version);

          return { status: derivedStatus };
        })
        .immediate();

      if (outcome.blocked) {
        fs.rmSync(tempBlobPath, { force: true });
        res.status(403).json({
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
        if (isPendingConflict(err, db, auth.user.id, packageId, version)) {
          res.status(403).json({
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

    const versions = db
      .prepare(
        `SELECT version FROM versions
         WHERE owner_id = ? AND package_id = ? AND status = 'published'
         ORDER BY semverSortKey(version) DESC`,
      )
      .all(auth.user.id, packageId)
      .map((r) => r.version);

    res.status(201).json({
      extension: {
        owner: ownerName,
        id: packageId,
        meta: extractedMeta,
        versions,
        approved: finalStatus === "published",
      },
      publishedUrl: `/v2/@${ownerName}/${packageId}`,
    });

    success(`${ownerName}/${packageId}@${version} (${finalStatus})`);
  });

  // ── Extension info ───────────────────────────────────────────────────

  app.get("/v2/@:namespace/:id", (req, res) => {
    const { namespace, id } = req.params;
    const rows = db
      .prepare(
        `SELECT v.version, v.meta_json, v.status
         FROM versions v
         JOIN users u ON u.id = v.owner_id
         WHERE u.namespace = ? AND v.package_id = ? AND v.status = 'published'`,
      )
      .all(namespace, id);

    if (rows.length === 0) {
      res
        .status(404)
        .json({ error: "No published versions for this package." });
      return;
    }

    rows.sort((a, b) => semver.compare(b.version, a.version));
    const latest = rows[0];
    const user = db
      .prepare("SELECT id FROM users WHERE namespace = ?")
      .get(namespace);

    res.json({
      owner: namespace,
      id,
      meta: JSON.parse(latest.meta_json),
      versions: rows.map((r) => r.version),
      approved: user
        ? db
            .prepare(
              `SELECT 1 FROM versions
               WHERE owner_id = ? AND package_id = ? AND status = 'published'`,
            )
            .get(user.id, id) !== undefined
        : false,
    });
  });

  // ── Update extension ─────────────────────────────────────────────────

  app.patch("/v2/@:namespace/:id", (req, res) => {
    const auth = authenticate(db, req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }

    const { namespace, id } = req.params;
    const target = db
      .prepare("SELECT * FROM users WHERE namespace = ?")
      .get(namespace);
    if (!target) {
      res.status(404).json({ error: "Extension not found." });
      return;
    }

    const existingExt = db
      .prepare(
        `SELECT id FROM versions WHERE owner_id = ? AND package_id = ? AND status = 'published' LIMIT 1`,
      )
      .get(target.id, id);
    if (!existingExt) {
      res.status(404).json({ error: "Extension not found." });
      return;
    }

    if (auth.user.type !== "admin" && auth.user.id !== target.id) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }

    const { meta, extensionBlob } = req.body || {};
    if (meta === undefined && extensionBlob === undefined) {
      res.status(400).json({ error: "At least one field is required." });
      return;
    }

    let finalMeta = meta;

    if (extensionBlob !== undefined) {
      if (typeof extensionBlob !== "string") {
        res.status(400).json({ error: "extensionBlob must be a string." });
        return;
      }
      const {
        ok,
        meta: extractedMeta,
        error: metaError,
      } = extractWarpMeta(extensionBlob);
      if (!ok) {
        res.status(400).json({ error: metaError });
        return;
      }
      finalMeta = extractedMeta;

      if (!PACKAGE_ID_RE.test(id)) {
        res.status(400).json({
          error: "id must match ^[a-z0-9](?:[a-z0-9._-]{0,63})$.",
        });
        return;
      }
      if (!finalMeta || typeof finalMeta !== "object") {
        res
          .status(400)
          .json({ error: "meta is required when uploading a blob." });
        return;
      }
      const version = semver.valid(finalMeta.version);
      if (version === null) {
        res.status(400).json({
          error: "meta.version must be a valid semver string.",
        });
        return;
      }
      if (finalMeta.id !== id) {
        res.status(400).json({ error: "meta.id must match the request id." });
        return;
      }

      const absBlobPath = blobPath(dataDir, namespace, id, version);
      fs.mkdirSync(path.dirname(absBlobPath), { recursive: true });
      fs.writeFileSync(absBlobPath, extensionBlob);

      const existingVersion = db
        .prepare(
          `SELECT id FROM versions WHERE owner_id = ? AND package_id = ? AND version = ?`,
        )
        .get(target.id, id, version);
      if (existingVersion) {
        db.prepare(
          "UPDATE versions SET meta_json = ?, blob_path = ? WHERE id = ?",
        ).run(JSON.stringify(finalMeta), absBlobPath, existingVersion.id);
      } else {
        const current = db
          .prepare("SELECT has_published FROM users WHERE id = ?")
          .get(target.id);
        const derivedStatus =
          current.has_published === 1 ? "published" : "pending";

        const blocked =
          current.has_published !== 1 &&
          db
            .prepare(
              `SELECT id FROM versions
               WHERE owner_id = ? AND status IN ('staging', 'pending')
                 AND NOT (package_id = ? AND version = ?)`,
            )
            .get(target.id, id, version);
        if (blocked) {
          fs.rmSync(absBlobPath, { force: true });
          res.status(409).json({
            error:
              "A publish from your account is already awaiting review. Wait for it to be approved before publishing again.",
          });
          return;
        }

        db.prepare(
          `INSERT INTO versions (owner_id, package_id, version, status, final_status, meta_json, blob_path)
           VALUES (?, ?, ?, 'staging', ?, ?, ?)`,
        ).run(
          target.id,
          id,
          version,
          derivedStatus,
          JSON.stringify(finalMeta),
          absBlobPath,
        );
        db.prepare(
          `UPDATE versions SET status = ? WHERE owner_id = ? AND package_id = ? AND version = ?`,
        ).run(derivedStatus, target.id, id, version);
      }
    }

    if (finalMeta) {
      const latestRow = db
        .prepare(
          `SELECT v.id FROM versions v
           WHERE v.owner_id = ? AND v.package_id = ? AND v.status = 'published'
           ORDER BY semverSortKey(v.version) DESC LIMIT 1`,
        )
        .get(target.id, id);
      if (latestRow) {
        db.prepare("UPDATE versions SET meta_json = ? WHERE id = ?").run(
          JSON.stringify(finalMeta),
          latestRow.id,
        );
      }
    }

    const versions = db
      .prepare(
        `SELECT version FROM versions
         WHERE owner_id = ? AND package_id = ? AND status = 'published'
         ORDER BY semverSortKey(version) DESC`,
      )
      .all(target.id, id)
      .map((r) => r.version);

    const metaRow = db
      .prepare(
        `SELECT meta_json FROM versions
         WHERE owner_id = ? AND package_id = ? AND status = 'published'
         ORDER BY semverSortKey(version) DESC LIMIT 1`,
      )
      .get(target.id, id);

    res.json({
      owner: namespace,
      id,
      meta: metaRow ? JSON.parse(metaRow.meta_json) : finalMeta,
      versions,
      approved: true,
    });
  });

  // ── Delete extension ─────────────────────────────────────────────────

  app.delete("/v2/@:namespace/:id", (req, res) => {
    const auth = authenticate(db, req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }

    const { namespace, id } = req.params;
    const target = db
      .prepare("SELECT * FROM users WHERE namespace = ?")
      .get(namespace);
    if (!target) {
      res.status(404).json({ error: "Extension not found." });
      return;
    }

    const versions = db
      .prepare(
        `SELECT version, blob_path FROM versions
         WHERE owner_id = ? AND package_id = ?`,
      )
      .all(target.id, id);
    if (versions.length === 0) {
      res.status(404).json({ error: "Extension not found." });
      return;
    }

    if (auth.user.type !== "admin" && auth.user.id !== target.id) {
      res.status(403).json({ error: "Forbidden." });
      return;
    }

    for (const v of versions) {
      fs.rmSync(v.blob_path, { force: true });
    }
    db.prepare(
      "DELETE FROM versions WHERE owner_id = ? AND package_id = ?",
    ).run(target.id, id);

    res.status(200).json({ message: "Deleted." });
  });

  // ── Serve extension source by version ────────────────────────────────

  app.get("/v2/@:namespace/:id/:version", (req, res) => {
    const { namespace, id, version } = req.params;
    if (version === "latest") {
      const latest = findLatest(db, namespace, id);
      if (!latest) {
        res
          .status(404)
          .json({ error: "No published versions for this package." });
        return;
      }
      serveBlob(req, res, {
        db,
        dataDir,
        owner: namespace,
        id,
        version: latest.version,
      });
      return;
    }
    serveBlob(req, res, { db, dataDir, owner: namespace, id, version });
  });

  // ── Approve extension (admin only) ───────────────────────────────────

  app.post("/v2/@:namespace/:id/approve", (req, res) => {
    const auth = authenticate(db, req.headers.authorization);
    if (!auth) {
      res.status(401).json({ error: "Unauthorized." });
      return;
    }
    if (auth.user.type !== "admin") {
      res.status(403).json({ error: "Admin required." });
      return;
    }

    const { namespace, id } = req.params;
    const target = db
      .prepare("SELECT * FROM users WHERE namespace = ?")
      .get(namespace);
    if (!target) {
      res.status(404).json({ error: "Extension not found." });
      return;
    }

    const latestPending = db
      .prepare(
        `SELECT id, version FROM versions
         WHERE owner_id = ? AND package_id = ? AND status = 'pending'
         ORDER BY semverSortKey(version) DESC LIMIT 1`,
      )
      .get(target.id, id);

    if (!latestPending) {
      res.status(404).json({ error: "No pending version found." });
      return;
    }

    db.transaction(() => {
      db.prepare(
        `UPDATE versions SET status = 'published'
         WHERE owner_id = ? AND package_id = ? AND status = 'pending'`,
      ).run(target.id, id);
      db.prepare("UPDATE users SET has_published = 1 WHERE id = ?").run(
        target.id,
      );
    })();

    success(`Approved ${namespace}/${id}@${latestPending.version}`);
    res.status(200).json({ message: "Approved." });
  });

  // ── Search ───────────────────────────────────────────────────────────

  const latestPublishedSelections = `
    SELECT u.namespace AS owner, v.package_id AS id,
           v.meta_json AS meta_json, v.version AS latestVersion,
           v.created_at AS created_at,
           ROW_NUMBER() OVER (
             PARTITION BY v.owner_id, v.package_id
             ORDER BY semverSortKey(v.version) DESC, v.id DESC
           ) AS rn
    FROM versions v
    JOIN users u ON u.id = v.owner_id
    WHERE v.status = 'published'
  `;

  app.get("/v2/search", (req, res) => {
    const raw = typeof req.query.query === "string" ? req.query.query : "";
    const q = raw.trim();

    const decodedCursor = decodeCursor(
      req.query.cursor,
      (d) =>
        typeof d.createdAt === "string" &&
        typeof d.owner === "string" &&
        typeof d.packageId === "string",
    );
    if (!decodedCursor.ok) {
      res.status(400).json({ error: "Invalid cursor." });
      return;
    }
    const cursor = decodedCursor.value;

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

    if (q) {
      const escaped = q
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_");
      const pattern = `%${escaped}%`;
      where += ` AND (unicode_fold(json_extract(t.meta_json, '$.name'))
                LIKE unicode_fold(?) ESCAPE '\\'
              OR json_extract(t.meta_json, '$.version') LIKE ? ESCAPE '\\'
              OR json_extract(t.meta_json, '$.license') LIKE ? ESCAPE '\\'
              OR json_extract(t.meta_json, '$.description') LIKE ? ESCAPE '\\'
              OR t.id LIKE ? ESCAPE '\\'
              OR t.owner LIKE ? ESCAPE '\\')`;
      params.push(pattern, pattern, pattern, pattern, pattern, pattern);
    }

    const rows = db
      .prepare(
        `SELECT owner, id, meta_json, latestVersion, created_at
         FROM (${latestPublishedSelections}) t
         ${where}
         ORDER BY t.created_at DESC, t.owner ASC, t.id ASC
         LIMIT ?`,
      )
      .all(...params, SEARCH_PAGE_SIZE + 1);

    const hasMore = rows.length > SEARCH_PAGE_SIZE;
    const page = rows.slice(0, SEARCH_PAGE_SIZE);

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
      results: page.map((r) => {
        const meta = JSON.parse(r.meta_json);
        return {
          owner: r.owner,
          id: r.id,
          name: meta.name,
          description: meta.description,
          latestVersion: r.latestVersion,
        };
      }),
      nextCursor,
    });
  });

  // ── Extensions ───────────────────────────────────────────────────────

  app.get("/v2/extensions", (req, res) => {
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

    const decodedCursor = decodeCursor(
      req.query.cursor,
      (d) =>
        typeof d.createdAt === "string" &&
        typeof d.owner === "string" &&
        typeof d.packageId === "string",
    );
    if (!decodedCursor.ok) {
      res.status(400).json({ error: "Invalid cursor." });
      return;
    }
    const cursor = decodedCursor.value;

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
      extensions: page.map((r) => {
        const meta = JSON.parse(r.meta_json);
        return {
          owner: r.owner,
          id: r.id,
          name: meta.name,
          description: meta.description,
          latestVersion: r.latestVersion,
          publishedAt: `${r.created_at.replace(" ", "T")}Z`,
        };
      }),
      nextCursor,
    });
  });

  // ── Stats ────────────────────────────────────────────────────────────

  app.get("/v2/stats", (_req, res) => {
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

  // ── Error handling ───────────────────────────────────────────────────

  app.use((err, _req, res, next) => {
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
 * @param {string} owner - The package owner's namespace.
 * @param {string} id - The package identifier.
 * @returns {object|null} The latest version row, or null if no published versions exist.
 */
function findLatest(db, owner, id) {
  const rows = db
    .prepare(
      `SELECT v.version
       FROM versions v
       JOIN users u ON u.id = v.owner_id
       WHERE u.namespace = ? AND v.package_id = ? AND v.status = 'published'`,
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
 * @param {string} options.owner - The package owner's namespace.
 * @param {string} options.id - The package identifier.
 * @param {string} options.version - The package version.
 */
function serveBlob(req, res, { db, owner, id, version }) {
  const row = db
    .prepare(
      `SELECT v.blob_path, v.status, v.version
       FROM versions v
       JOIN users u ON u.id = v.owner_id
       WHERE u.namespace = ? AND v.package_id = ? AND v.version = ?`,
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
