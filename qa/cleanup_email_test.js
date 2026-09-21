const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const r = await pool.query("DELETE FROM notifications WHERE template_key='client_email' AND subject LIKE 'QA Wave4 test%'");
  console.log('deleted', r.rowCount, 'QA test email rows');
  await pool.end();
})();
