// Diagnostic: time each Insights query individually to find the slow one.
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const ACTIVE = "stage <> '09_completed'";
const months = 6;

const Q = {
  byStage: `SELECT stage, COUNT(*)::int AS n FROM jobs GROUP BY stage`,
  avgStageDuration: `SELECT stage, ROUND(AVG(days)::numeric,1)::float AS days, COUNT(*)::int AS n FROM (
      SELECT h.to_stage AS stage, EXTRACT(EPOCH FROM (LEAD(h.created_at) OVER (PARTITION BY h.job_id ORDER BY h.created_at) - h.created_at))/86400 AS days
        FROM job_status_history h JOIN jobs j ON j.id=h.job_id) t WHERE days IS NOT NULL GROUP BY stage`,
  cycleBox: `SELECT job_type, percentile_cont(0.5) WITHIN GROUP (ORDER BY days) AS median, COUNT(*)::int AS n FROM (
      SELECT COALESCE(NULLIF(j.job_type,''),'Unspecified') AS job_type, EXTRACT(EPOCH FROM (h.created_at - j.created_at))/86400 AS days
        FROM jobs j JOIN job_status_history h ON h.job_id=j.id AND h.to_stage='09_completed') t GROUP BY job_type`,
  ageHist: `SELECT width_bucket(EXTRACT(EPOCH FROM (now()-stage_since))/86400,0,90,9) AS b, COUNT(*)::int AS n FROM jobs WHERE ${ACTIVE} GROUP BY 1`,
  activity: `SELECT to_char(h.created_at,'YYYY-MM') AS month, EXTRACT(DOW FROM h.created_at)::int AS dow, COUNT(*)::int AS n
      FROM job_status_history h JOIN jobs j ON j.id=h.job_id WHERE h.created_at >= now() - interval '${months} months' GROUP BY 1,2`,
  workloadByStage: `SELECT COALESCE(u.name,j.accountant_email,'Unassigned') AS staff, j.stage, COUNT(*)::int AS n
      FROM jobs j LEFT JOIN users u ON lower(u.email)=lower(j.accountant_email) WHERE j.${ACTIVE} GROUP BY 1,2`,
  staffBubble: `SELECT COALESCE(u.name,j.accountant_email,'Unassigned') AS staff, COUNT(*)::int AS total
      FROM jobs j LEFT JOIN users u ON lower(u.email)=lower(j.accountant_email) GROUP BY 1`,
  apptsByService: `SELECT COALESCE(NULLIF(service_name,''),'Unspecified') AS service, COUNT(*)::int AS n
      FROM appointments WHERE status='booked' AND start_time >= now() AND start_time < now() + interval '30 days' GROUP BY 1`,
  outstandingByStage: `SELECT j.stage, COUNT(*)::int AS n FROM doc_requests dr JOIN jobs j ON j.id=dr.job_id WHERE dr.status='pending' GROUP BY j.stage`,
  throughput: `SELECT to_char(date_trunc('month',h.created_at),'YYYY-MM') AS month, COUNT(*)::int AS n
      FROM job_status_history h JOIN jobs j ON j.id=h.job_id WHERE h.to_stage='09_completed' AND h.created_at >= now() - interval '${months} months' GROUP BY 1`,
  docsByStatus: `SELECT d.status, COUNT(*)::int AS n FROM documents d JOIN jobs j ON j.id=d.job_id GROUP BY 1`,
  clients: `SELECT COUNT(*)::int AS n FROM clients`,
  upcomingAppts: `SELECT COUNT(*)::int AS n FROM appointments WHERE status='booked' AND start_time >= now()`,
};

(async () => {
  // warm up a connection
  await pool.query('SELECT 1');
  for (const [name, sql] of Object.entries(Q)) {
    const t = Date.now();
    try { await pool.query(sql); console.log(String(Date.now() - t).padStart(6) + ' ms  ' + name); }
    catch (e) { console.log('  ERR  ' + name + ' — ' + e.message); }
  }
  // row counts for context
  for (const tbl of ['jobs', 'job_status_history', 'documents', 'appointments', 'doc_requests']) {
    const r = await pool.query('SELECT COUNT(*)::int AS n FROM ' + tbl);
    console.log('  rows ' + tbl + ' = ' + r.rows[0].n);
  }
  await pool.end();
})();
