/**
 * Who you are, by way of GitHub.
 *
 * Device flow, not a redirect: the app is a desktop program with no URL of its
 * own for GitHub to send anyone back to. The server holds the OAuth app's
 * client id and does the talking; the app only ever sees a code to type and,
 * at the end, a session token of ours. GitHub's token never leaves here, and
 * is not kept: once it has said who you are, the session is the only thing
 * that matters.
 */

const GITHUB = "https://github.com";
const GITHUB_API = "https://api.github.com";

export function makeAuth({ db, clientId, devLogin, fetchImpl = fetch }) {
  return {
    /** Step one: a code for the person to type at github.com/login/device. */
    async startDevice() {
      if (!clientId) throw httpError(503, "sign-in is not configured on this server");
      const res = await fetchImpl(`${GITHUB}/login/device/code`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: "read:user" }),
      });
      if (!res.ok) throw httpError(502, `GitHub answered ${res.status}`);
      const j = await res.json();
      return {
        deviceCode: j.device_code,
        userCode: j.user_code,
        verificationUri: j.verification_uri,
        interval: j.interval ?? 5,
        expiresIn: j.expires_in ?? 900,
      };
    },

    /**
     * Step two, repeated: has the person finished on GitHub yet? `pending`
     * until they have; a session of ours once they have.
     */
    async pollDevice(deviceCode) {
      if (!clientId) throw httpError(503, "sign-in is not configured on this server");
      const res = await fetchImpl(`${GITHUB}/login/oauth/access_token`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      });
      const j = await res.json();
      if (j.error) {
        if (j.error === "authorization_pending" || j.error === "slow_down") {
          return { pending: true, slowDown: j.error === "slow_down" };
        }
        throw httpError(400, j.error_description ?? j.error);
      }
      const who = await fetchImpl(`${GITHUB_API}/user`, {
        headers: { Authorization: `Bearer ${j.access_token}`, Accept: "application/vnd.github+json" },
      });
      if (!who.ok) throw httpError(502, `GitHub would not say who you are (${who.status})`);
      const u = await who.json();
      const user = await db.upsertUser(u.login, u.name ?? null, u.avatar_url ?? null);
      return { token: await db.createSession(u.login), user };
    },

    /**
     * A session for a bare login, with no GitHub in the loop. Only when the
     * server was started with WORKSPACES_DEV_LOGIN=1 — it exists for tests and
     * a laptop, and a deployed server must never have it on.
     */
    async devSession(login) {
      if (!devLogin) throw httpError(404, "not found");
      if (!/^[a-z0-9-]{1,39}$/i.test(login ?? "")) throw httpError(400, "not a login");
      const user = await db.upsertUser(login, login, null);
      return { token: await db.createSession(login), user };
    },
  };
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
