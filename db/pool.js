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

    pool.on("error", (error) => {
      console.error("Unexpected PostgreSQL pool error:", error.message);
    });
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
