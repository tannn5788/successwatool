// recurring.js — recurring job schedules. Generates a fresh job (with checklist)
// when a schedule's next_run_date is within lead_days. Cluster-safe because job
// generation is guarded by a row lock (SELECT ... FOR UPDATE) on the schedule row.
const checklists = require('./checklists');

// Add one recurrence period to a YYYY-MM-DD date string. Returns YYYY-MM-DD.
function addPeriod(dateStr, frequency) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00');
  if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
  else if (frequency === 'quarterly') d.setMonth(d.getMonth() + 3);
  else d.setFullYear(d.getFullYear() + 1); // annually (default)
  return d.toISOString().slice(0, 10);
}

// Bump an Australian financial year label like "FY2024-25" -> "FY2025-26".
// Leaves anything it doesn't recognise unchanged.
function bumpFinancialYear(fy) {
  const m = /^FY(\d{4})-(\d{2})$/.exec(String(fy || '').trim());
  if (!m) return fy || null;
  const start = Number(m[1]) + 1;
  const end = String(start + 1).slice(-2);
  return 'FY' + start + '-' + end;
}

// Generate the sequential job id (mirrors server.js nextId).
async function nextJobId(client) {
  const r = await client.query(
    `INSERT INTO id_counters (name, value) VALUES ('job', 1)
     ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1
     RETURNING value`);
  return 'JB-' + String(r.rows[0].value).padStart(4, '0');
}

// Create one job from a recurring schedule row (inside an existing transaction).
async function createJobFromSchedule(client, sch, actor, notifyBg) {
  const id = await nextJobId(client);
  await client.query(
    `INSERT INTO jobs (id, client_id, entity_id, job_type, financial_year, accountant_email, supervisor_email, due_date, priority, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'01_created')`,
    [id, sch.client_id, sch.entity_id || null, sch.job_type || null, sch.financial_year || null,
     sch.accountant_email || null, sch.supervisor_email || null, sch.next_run_date, sch.priority || 'normal']);
  // Seed checklist from the job-type template.
  const tpl = checklists.templateFor(sch.job_type);
  for (let i = 0; i < tpl.length; i++) {
    await client.query(
      'INSERT INTO job_checklist_items (job_id, label, required, sort_order) VALUES ($1,$2,$3,$4)',
      [id, tpl[i].label, tpl[i].required !== false, i]);
  }
  await client.query('INSERT INTO job_status_history (job_id, from_stage, to_stage, changed_by, reason) VALUES ($1,$2,$3,$4,$5)',
    [id, null, '01_created', actor, 'Auto-created from recurring schedule ' + sch.id]);
  await client.query(
    'INSERT INTO audit_log (actor_email, action, entity_type, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [actor, 'job.recurring_create', 'job', id, JSON.stringify({ recurringId: sch.id })]);
  // Notify the assigned accountant (best-effort, outside caller's concern).
  if (sch.accountant_email && notifyBg) {
    notifyBg({
      jobId: id, toEmail: sch.accountant_email,
      rawSubject: 'New recurring job assigned: ' + id,
      rawBody: 'A recurring ' + (sch.job_type || 'job') + ' (' + id + ') has been created and assigned to you, due ' + sch.next_run_date + '.',
    });
  }
  return id;
}

// Generate one job per schedule that is due (next_run_date - lead_days <= today),
// then advance the schedule. force=true ignores the lead window (used by "Run now").
async function generateForSchedule(pool, scheduleId, actor, notifyBg, force) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sr = await client.query('SELECT * FROM recurring_jobs WHERE id=$1 FOR UPDATE', [scheduleId]);
    if (!sr.rows.length) { await client.query('ROLLBACK'); return null; }
    const sch = sr.rows[0];
    if (!force) {
      if (!sch.active) { await client.query('ROLLBACK'); return null; }
      const due = await client.query(
        'SELECT ($1::date - $2::int) <= CURRENT_DATE AS ready', [sch.next_run_date, sch.lead_days]);
      if (!due.rows[0].ready) { await client.query('ROLLBACK'); return null; }
    }
    const jobId = await createJobFromSchedule(client, sch, actor, notifyBg);
    // Advance the schedule to the next period.
    const nextDate = addPeriod(sch.next_run_date, sch.frequency);
    const nextFy = bumpFinancialYear(sch.financial_year);
    await client.query(
      'UPDATE recurring_jobs SET next_run_date=$1, financial_year=$2, last_job_id=$3 WHERE id=$4',
      [nextDate, nextFy, jobId, sch.id]);
    await client.query('COMMIT');
    return jobId;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// Scan all active schedules and generate any that are due.
async function generateDueJobs(pool, deps) {
  const actor = 'system@recurring';
  const r = await pool.query(
    `SELECT id FROM recurring_jobs
     WHERE active = true AND (next_run_date - lead_days) <= CURRENT_DATE`);
  let created = 0;
  for (const row of r.rows) {
    try {
      const jobId = await generateForSchedule(pool, row.id, actor, deps.notifyBg, false);
      if (jobId) created++;
    } catch (e) { console.error('[recurring]', row.id, (e && e.message) || e); }
  }
  return { created };
}

module.exports = { addPeriod, bumpFinancialYear, generateForSchedule, generateDueJobs };
