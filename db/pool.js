import pg from "pg";

const { Pool } = pg;

let pool;

export function getPool() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not configured on the StableX server.");
  }

  if (!pool) {
    const isNeon = process.env.DATABASE_URL.includes(".neon.tech");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ...(isNeon ? { ssl: { rejectUnauthorized: false } } : {}),
    });

    // Managed Postgres (Neon) drops idle TLS connections. A reset arriving on
    // a pooled client must be logged and discarded, never crash the process.
    pool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error:", error.message);
    });
    const acquire = pool.connect.bind(pool);
    pool.connect = (...args) => {
      const attach = (client) => {
        if (client && !client.listenerCount("error")) {
          client.on("error", (error) => {
            console.error("PostgreSQL client connection dropped:", error.message);
          });
        }
        return client;
      };
      // Support both promise and callback callers.
      if (typeof args[0] === "function") {
        const callback = args[0];
        return acquire((err, client, release) => callback(err, attach(client), release));
      }
      return acquire(...args).then(attach);
    };
  }

  return pool;
}

export async function checkDatabaseConnection() {
  const client = await getPool().connect();
  try {
    const result = await client.query("SELECT NOW() AS database_time");
    return { connected: true, databaseTime: result.rows[0].database_time };
  } finally {
    client.release();
  }
}

export async function closeDatabasePool() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}
