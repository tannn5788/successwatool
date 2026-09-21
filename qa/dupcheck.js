const { Pool } = require('pg');
require('dotenv').config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
p.query("SELECT lower(email) e, count(*) c FROM clients WHERE email IS NOT NULL GROUP BY lower(email) HAVING count(*) > 1")
  .then(r => { console.log('DUPLICATE EMAILS:', r.rowCount); r.rows.forEach(x => console.log(' ', x.e, x.c)); return p.end(); })
  .catch(e => { console.error('ERR', e.message); process.exit(1); });
