import { Pool } from "pg";

// Lazy pool — created on first use so dotenv has time to populate env vars
let _pool: Pool | null = null;

function getPool(): Pool {
  if (!_pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is not set. Did you create a .env file?");
    }
    _pool = new Pool({ connectionString: process.env.DATABASE_URL });
    _pool.on("error", (err) => console.error("PostgreSQL pool error:", err));
  }
  return _pool;
}

// Proxy object so existing code (pool.query) keeps working unchanged
const pool = new Proxy({} as Pool, {
  get(_target, prop) {
    return (getPool() as any)[prop];
  },
});

export default pool;
