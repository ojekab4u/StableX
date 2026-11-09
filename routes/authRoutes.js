import { Router } from "express";
import {
  registerAccount,
  verifyAccountChannel,
  resendVerificationCode,
  loginWithPassword,
  getSessionOverview,
  logoutSession,
} from "../services/accountService.js";
import { requireAuth, bearerTokenFrom } from "../middleware/requireAuth.js";

export const authRouter = Router();
const fail = (res, error) => res.status(error.statusCode || 503).json({ error: error.message });

// Step 1 of the customer flow: create an account. Personal or business,
// with email and optional phone verification codes issued immediately.
authRouter.post("/register", async (req, res) => {
  try {
    const result = await registerAccount(req.body || {});
    return res.status(201).json({
      message: "Account created. Verify the issued codes to activate it.",
      ...result,
    });
  } catch (error) {
    return fail(res, error);
  }
});

authRouter.post("/verify/email", async (req, res) => {
  try {
    const { accountId, code } = req.body || {};
    return res.json(await verifyAccountChannel({ accountId, channel: "EMAIL", code }));
  } catch (error) {
    return fail(res, error);
  }
});

authRouter.post("/verify/phone", async (req, res) => {
  try {
    const { accountId, code } = req.body || {};
    return res.json(await verifyAccountChannel({ accountId, channel: "PHONE", code }));
  } catch (error) {
    return fail(res, error);
  }
});

authRouter.post("/resend", async (req, res) => {
  try {
    const { accountId, channel } = req.body || {};
    const result = await resendVerificationCode({ accountId, channel });
    return res.json({ message: "A new code was issued; the previous code is no longer valid.", verification: result });
  } catch (error) {
    return fail(res, error);
  }
});

authRouter.post("/login", async (req, res) => {
  try {
    const result = await loginWithPassword(req.body || {});
    return res.json({
      message: "Signed in. Use the token as a Bearer session token.",
      ...result,
    });
  } catch (error) {
    const body = { error: error.message };
    if (error.pendingChannels) {
      body.pendingChannels = error.pendingChannels;
      body.accountId = error.accountId;
    }
    return res.status(error.statusCode || 503).json(body);
  }
});

// Returns the signed-in account, its verification state and the compliance
// gate that links step 1 (account) to step 2 (KYC/KYB).
authRouter.get("/session", requireAuth, async (req, res) => {
  try {
    const overview = await getSessionOverview(req.authToken);
    return overview
      ? res.json(overview)
      : res.status(401).json({ error: "Session is invalid or expired. Sign in again." });
  } catch (error) {
    return fail(res, error);
  }
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  try {
    const revoked = await logoutSession(bearerTokenFrom(req));
    return res.json({ message: revoked ? "Session ended." : "Session was already ended.", revoked });
  } catch (error) {
    return fail(res, error);
  }
});
