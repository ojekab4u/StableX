import { Router } from "express";
import { getCircleReadiness, pingCircle } from "../services/circleService.js";

export const circleRouter = Router();

const fail = (res, error) => res.status(error.statusCode || 502).json({
  error: error.message,
  ...(error.providerResponse ? { provider: "Circle" } : {}),
});

function requireOperator(req, res, next) {
  const operatorToken = process.env.STABLEX_OPERATOR_TOKEN;
  if (!operatorToken || req.get("Authorization") !== `Bearer ${operatorToken}`) {
    return res.status(401).json({ error: "Unauthorized operator action." });
  }
  return next();
}

circleRouter.get("/readiness", (_req, res) => res.json(getCircleReadiness()));

circleRouter.get("/ping", requireOperator, async (_req, res) => {
  try { return res.json(await pingCircle()); }
  catch (error) { return fail(res, error); }
});
