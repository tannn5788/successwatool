// Compare sequential vs Promise.all against Neon with the app's pool config.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 20),
});
const sql = `SELECT COUNT(*)::int AS n FROM jobs WHERE stage <> '09_completed'`;
(async () => {
  await pool.query('SELECT 1'); // warm one
  // Sequential x20
  let t = Date.now();
  for (let i = 0; i < 20; i++) await pool.query(sql);
  console.log('sequential x20:', (Date.now() - t) + ' ms');
  // Parallel x20
  t = Date.now();
  await Promise.all(Array.from({ length: 20 }, () => pool.query(sql)));
  console.log('parallel   x20:', (Date.now() - t) + ' ms');
  // Parallel x20 again (connections now warm)
  t = Date.now();
  await Promise.all(Array.from({ length: 20 }, () => pool.query(sql)));
  console.log('parallel   x20 (warm):', (Date.now() - t) + ' ms');
  console.log('pool total/idle:', pool.totalCount, pool.idleCount);
  await pool.end();
})();
