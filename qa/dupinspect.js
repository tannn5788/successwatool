const { Pool } = require('pg');
require('dotenv').config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
(async () => {
  const c = await p.query("SELECT id, name, email, mobile, address, dob, created_at FROM clients WHERE lower(email)='demo@successwa.com' ORDER BY id");
  console.log('rows:', c.rowCount);
  for (const r of c.rows) {
    const jobs = await p.query('SELECT count(*)::int n FROM jobs WHERE client_id=$1', [r.id]);
    const docs = await p.query('SELECT count(*)::int n FROM documents WHERE client_id=$1', [r.id]);
    const appts = await p.query('SELECT count(*)::int n FROM appointments WHERE client_id=$1', [r.id]);
    const msgs = await p.query('SELECT count(*)::int n FROM client_messages WHERE client_id=$1', [r.id]);
    const folders = await p.query('SELECT count(*)::int n FROM doc_folders WHERE client_id=$1', [r.id]);
    console.log(JSON.stringify({ id: r.id, name: r.name, mobile: r.mobile, address: r.address, dob: r.dob, created: r.created_at,
      jobs: jobs.rows[0].n, docs: docs.rows[0].n, appts: appts.rows[0].n, msgs: msgs.rows[0].n, folders: folders.rows[0].n }));
  }
  await p.end();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
