/**
 * Who you are, by way of Auth0 — the same tenant the rest of looped signs
 * in through, so a workspace member is the identity they already have.
 *
 * Device flow, not a redirect: the app is a desktop program with no URL of
 * its own for Auth0 to send anyone back to. This server holds the native
 * application's client id and does the talking; the app only ever sees a
 * code to type and, at the end, a session token of ours. What comes back
 * from the tenant is an ID token, verified here against the tenant's signing
 * keys; it is read once for who the person is and then dropped.
 */
import { createLocalJWKSet, jwtVerify } from "jose";

export function makeAuth({ db, domain, clientId, devLogin, fetchImpl = fetch }) {
  const issuer = domain ? `https://${domain}/` : "";
  /** The tenant's keys, fetched once; a key rotation is a restart away. */
  let jwks = null;
  const keys = async () => {
    if (jwks) return jwks;
    const res = await fetchImpl(`${issuer}.well-known/jwks.json`);
    if (!res.ok) throw httpError(502, `Auth0 would not hand over its keys (${res.status})`);
    jwks = createLocalJWKSet(await res.json());
    return jwks;
  };
  const configured = () => {
    if (!domain || !clientId) throw httpError(503, "sign-in is not configured on this server");
  };
  const form = (fields) =>
    fetchImpl(`${issuer}oauth/${fields.grant_type ? "token" : "device/code"}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(fields).toString(),
    });

  return {
    /** Step one: a code for the person to type, and the page to type it at. */
    async startDevice() {
      configured();
      const res = await form({ client_id: clientId, scope: "openid profile email" });
      if (!res.ok) throw httpError(502, `Auth0 answered ${res.status}: ${await said(res)}`);
      const j = await res.json();
      return {
        deviceCode: j.device_code,
        userCode: j.user_code,
        // The complete URI carries the code, so the browser lands on a page
        // that only asks "is this you?" — the bare one is kept for the sheet.
        verificationUri: j.verification_uri_complete ?? j.verification_uri,
        interval: j.interval ?? 5,
        expiresIn: j.expires_in ?? 900,
      };
    },

    /**
     * Step two, repeated: has the person finished yet? `pending` until they
     * have; a session of ours once they have.
     */
    async pollDevice(deviceCode) {
      configured();
      const res = await form({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: clientId,
      });
      const j = await res.json().catch(async () => ({ error: `Auth0 answered ${res.status}: ${await said(res)}` }));
      if (j.error) {
        if (j.error === "authorization_pending" || j.error === "slow_down") {
          return { pending: true, slowDown: j.error === "slow_down" };
        }
        throw httpError(400, j.error_description ?? j.error);
      }
      if (!j.id_token) throw httpError(502, "Auth0 answered without an identity");
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(j.id_token, await keys(), { issuer, audience: clientId }));
      } catch (e) {
        throw httpError(401, `the identity could not be verified: ${e.message}`);
      }
      const login = loginOf(claims);
      const user = await db.upsertUser(login, claims.name ?? claims.nickname ?? null, claims.picture ?? null);
      return { token: await db.createSession(login), user };
    },

    /**
     * A session for a bare login, with no tenant in the loop. Only when the
     * server was started with WORKSPACES_DEV_LOGIN=1 — it exists for tests and
     * a laptop, and a deployed server must never have it on.
     */
    async devSession(login) {
      if (!devLogin) throw httpError(404, "not found");
      if (!isLogin(login)) throw httpError(400, "not a login");
      const user = await db.upsertUser(login.toLowerCase(), login, null);
      return { token: await db.createSession(login.toLowerCase()), user };
    },
  };
}

/**
 * What a person is called throughout: their email, lowercased. It is what an
 * invite names before its subject has ever signed in, and it is stable
 * across the connections a tenant may allow behind one account.
 */
function loginOf(claims) {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) throw httpError(401, "the identity carries no email");
  return email;
}

/** An email, or — for the dev path and tests — a plain word. */
export function isLogin(s) {
  return typeof s === "string" && /^[a-z0-9._+-]+(@[a-z0-9.-]+\.[a-z]{2,})?$/i.test(s) && s.length <= 254;
}

/**
 * What a refusing upstream actually said, trimmed to a line. Auth0's own
 * errors are JSON with a description; a proxy in front of it may answer with
 * a page, whose first words still say who refused and why.
 */
async function said(res) {
  const text = (await res.text().catch(() => "")).replace(/\s+/g, " ").trim();
  try {
    const j = JSON.parse(text);
    return j.error_description ?? j.error ?? text.slice(0, 200);
  } catch {
    return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
  }
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
