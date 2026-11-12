// oidc-provider's userinfo rejects every access token that has an audience or lacks the
// openid scope. Folio access tokens are always bound to RESOURCE (aud set, openid kept on
// the grant only), so ChatGPT's post-token GET /me failed with 403 and the connector went
// straight to "Reauthentication required". This answers /me for those tokens from the
// grant's consented openid scope and returns only `sub`; other audiences and
// non-header token forms fall through to oidc-provider.
const challenge = (res, status, error, scope) =>
  res
    .set("Cache-Control", "no-store")
    .set("WWW-Authenticate", `Bearer error="${error}"${scope ? `, scope="${scope}"` : ""}`)
    .status(status)
    .json({ error });

export function resourceUserinfo({ resource, findAccessToken, findGrant, findClient, findAccount }) {
  return async (req, res, next) => {
    if (req.method !== "GET" && req.method !== "POST") return next();
    if (!req.headers.authorization) return next();
    const value = req.headers.authorization.match(/^Bearer (\S{1,8192})$/i)?.[1];
    if (!value) return challenge(res, 401, "invalid_token");
    let token;
    try {
      token = await findAccessToken(value);
    } catch {
      token = undefined;
    }
    if (!token || token.isExpired || !token.isValid) return challenge(res, 401, "invalid_token");
    if (token.aud !== resource) return next();
    const grant = await findGrant(token.grantId);
    if (
      !grant ||
      grant.isExpired ||
      grant.accountId !== token.accountId ||
      grant.clientId !== token.clientId
    )
      return challenge(res, 401, "invalid_token");
    const client = await findClient(token.clientId);
    if (!client) return challenge(res, 401, "invalid_token");
    if (!grant.getOIDCScope().split(" ").includes("openid"))
      return challenge(res, 403, "insufficient_scope", "openid");
    const account = await findAccount(token.accountId, token);
    if (!account) return challenge(res, 401, "invalid_token");
    res.set("Cache-Control", "no-store");
    return res.json({ sub: token.accountId });
  };
}
