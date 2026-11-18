// Fixed-window limiter keyed by signed-in account. In-memory: resets on restart
// and applies per server process, which is enough until we run multiple instances.
export function rateLimitByAccount({ windowMs, max, label }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.account?.accountId || req.ip;
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now >= entry.resetAt) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: `Too many ${label} requests. Try again later.` });
    }
    return next();
  };
}
