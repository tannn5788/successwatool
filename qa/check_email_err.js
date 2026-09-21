const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query("SELECT to_email, subject, status, error, created_at FROM notifications WHERE template_key='client_email' ORDER BY created_at DESC LIMIT 3");
  console.log(JSON.stringify(r.rows, null, 2));
  await pool.end();
})();
