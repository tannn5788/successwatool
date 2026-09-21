const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='jobs' AND column_name IN ('signed_ip','signed_user_agent') ORDER BY column_name");
  console.log('signed cols:', r.rows.map(x => x.column_name).join(', ') || 'NONE');
  await pool.end();
})();
