import "server-only";
import { Secret, TOTP } from "otpauth";
import QRCode from "qrcode";

const ISSUER = "Workdesk";
const LABEL = "owner";

export function getConfiguredSecret() {
  return process.env.TOTP_SECRET?.trim() || null;
}

export function generateSecret() {
  return new Secret({ size: 20 }).base32;
}

function totpFor(secretBase32: string) {
  return new TOTP({
    issuer: ISSUER,
    label: LABEL,
    algorithm: "SHA1", // Google Authenticator only supports SHA1 reliably
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

export async function getQrDataUrl(secretBase32: string) {
  return QRCode.toDataURL(totpFor(secretBase32).toString(), { margin: 1, width: 240 });
}

/** Returns the matched time-step counter, or null if the code is invalid. */
export function checkCode(secretBase32: string, code: string) {
  if (!/^\d{6}$/.test(code)) return null;
  const totp = totpFor(secretBase32);
  const delta = totp.validate({ token: code, window: 1 });
  if (delta === null) return null;
  return totp.counter() + delta;
}

// --- In-memory replay protection + rate limiting -------------------------
// Fine for a single-instance, single-user app. Resets on server restart.

let lastUsedCounter = -1;

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 5 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();

export function isRateLimited(key: string) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < Date.now()) return false;
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(key: string) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

/** Verifies a login code against the configured secret, rejecting reused codes. */
export function verifyLoginCode(code: string, rateKey: string) {
  const secret = getConfiguredSecret();
  if (!secret) return false;

  const counter = checkCode(secret, code);
  if (counter === null || counter <= lastUsedCounter) {
    recordFailure(rateKey);
    return false;
  }

  lastUsedCounter = counter;
  attempts.delete(rateKey);
  return true;
}
