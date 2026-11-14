import { getAccountBySessionToken } from "../services/accountService.js";

function bearerToken(req) {
  const header = req.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : null;
}

// Resolves a Bearer session token to an authenticated account and attaches it
// as req.account. Note this authenticates the caller but does not authorize
// access to arbitrary customerIds; handlers must scope reads to req.account.
export async function requireAuth(req, res, next) {
  try {
    const token = bearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Provide a Bearer session token from POST /api/auth/login." });
    }
    const resolved = await getAccountBySessionToken(token);
    if (!resolved) {
      return res.status(401).json({ error: "Session is invalid or expired. Sign in again." });
    }
    req.account = resolved.account;
    req.session = resolved.session;
    req.authToken = token;
    return next();
  } catch (error) {
    return res.status(error.statusCode || 503).json({ error: error.message });
  }
}

export function bearerTokenFrom(req) {
  return bearerToken(req);
}
