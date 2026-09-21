const { Pool } = require('pg');
require('dotenv').config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
p.query("SELECT indexname FROM pg_indexes WHERE tablename='clients' AND indexname='clients_email_lower_uidx'")
  .then(r => { console.log('INDEX PRESENT:', r.rowCount === 1 ? 'YES' : 'NO'); return p.end(); })
  .catch(e => { console.error('ERR', e.message); process.exit(1); });
