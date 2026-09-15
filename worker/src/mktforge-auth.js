/* ==========================================================================
   Persona Drafter Worker — Mktforge sign-in check
   Drop this file next to the Worker's main file (e.g. worker/src/mktforge-auth.js).

   getMktforgeUser(request, env) returns the signed-in Mktforge account when the
   request carries a valid Firebase ID token (Authorization: Bearer <token>),
   otherwise null. The Worker uses that to skip Turnstile for Mktforge only;
   the standalone site sends no token, so it still has to pass Turnstile.

   No dependencies. Verifies the token the way Firebase documents it:
     - RS256 signature against Google's published keys (cached)
     - aud = project id, iss = https://securetoken.google.com/<project id>
     - not expired, not issued in the future, has a subject (uid)
     - email_verified = true (Mktforge requires verified accounts)

   Optional Worker variable: FIREBASE_PROJECT_ID (defaults to "mktforge").
   ========================================================================== */

const JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const CLOCK_SKEW_SECONDS = 60;

let keyCache = { keys: null, expires: 0 };

function b64urlToBytes(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));
}

async function googleKeys(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && keyCache.keys && now < keyCache.expires) return keyCache.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error(`Could not load Google signing keys (${res.status})`);
  const { keys } = await res.json();
  const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]) || 3600;
  keyCache = { keys: keys || [], expires: now + maxAge * 1000 };
  return keyCache.keys;
}

async function verifySignature(jwk, signingInput, signature) {
  const key = await crypto.subtle.importKey(
    'jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  return crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature,
                              new TextEncoder().encode(signingInput));
}

/** Throws on any problem; returns the token's claims when valid. */
export async function verifyFirebaseIdToken(token, projectId) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, sig] = parts;
  const header = b64urlToJson(h);
  const claims = b64urlToJson(p);

  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unexpected token header');

  let keys = await googleKeys();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {                       // Google rotated keys since we cached them
    keys = await googleKeys(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new Error('Unknown signing key');
  if (!(await verifySignature(jwk, `${h}.${p}`, b64urlToBytes(sig)))) {
    throw new Error('Bad signature');
  }

  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== projectId) throw new Error('Wrong audience');
  if (claims.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Wrong issuer');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new Error('Missing subject');
  if (!(claims.exp > now - CLOCK_SKEW_SECONDS)) throw new Error('Token expired');
  if (!(claims.iat <= now + CLOCK_SKEW_SECONDS)) throw new Error('Token issued in the future');
  if (claims.auth_time && !(claims.auth_time <= now + CLOCK_SKEW_SECONDS)) throw new Error('Bad auth_time');
  if (claims.email_verified !== true) throw new Error('Email not verified');
  return claims;
}

/** The Mktforge account behind this request, or null (never throws). */
export async function getMktforgeUser(request, env = {}) {
  const auth = request.headers.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  try {
    const claims = await verifyFirebaseIdToken(match[1].trim(), env.FIREBASE_PROJECT_ID || 'mktforge');
    return { uid: claims.sub, email: claims.email || '' };
  } catch (err) {
    console.warn('[mktforge-auth] token rejected:', err.message);
    return null;
  }
}
