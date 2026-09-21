// Merge duplicate client CL-0002 into CL-0001 (same email demo@successwa.com),
// caused by the H1 race bug. Reassigns all child rows, then deletes the empty dup.
// Non-destructive: no job/document/message data is deleted, only re-parented.
const { Pool } = require('pg');
require('dotenv').config();
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

const KEEP = 'CL-0001';
const DROP = 'CL-0002';
const TABLES = ['entities', 'jobs', 'recurring_jobs', 'documents', 'doc_folders', 'client_messages', 'appointments'];

(async () => {
  const c = await p.connect();
  try {
    await c.query('BEGIN');
    // Safety: confirm both rows share the same email before merging.
    const chk = await c.query("SELECT id, lower(email) e FROM clients WHERE id = ANY($1)", [[KEEP, DROP]]);
    const emails = new Set(chk.rows.map(r => r.e));
    if (chk.rowCount !== 2 || emails.size !== 1) {
      throw new Error('Safety check failed: expected 2 rows with the same email, got ' + JSON.stringify(chk.rows));
    }
    for (const t of TABLES) {
      const r = await c.query('UPDATE ' + t + ' SET client_id=$1 WHERE client_id=$2', [KEEP, DROP]);
      console.log('  ' + t + ': moved ' + r.rowCount);
    }
    const del = await c.query('DELETE FROM clients WHERE id=$1', [DROP]);
    console.log('deleted client rows:', del.rowCount);
    await c.query('COMMIT');
    console.log('MERGE OK');
  } catch (e) {
    await c.query('ROLLBACK');
    console.error('MERGE FAILED (rolled back):', e.message);
    process.exit(1);
  } finally { c.release(); await p.end(); }
})();
