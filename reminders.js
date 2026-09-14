// reminders.js — scheduled email reminders (cluster-safe).
//
// Runs on an interval from server.js. Because the app runs under the PM2 cluster
// (multiple processes), every reminder is guarded by a claim row in job_reminders
// with a UNIQUE(ref_type, ref_id, kind) constraint: only the process that wins the
// INSERT ... ON CONFLICT DO NOTHING actually sends. This guarantees exactly-once
// delivery across all workers and restarts.

// Only send reminders during business hours (local server time) so clients aren't
// pinged in the middle of the night. 8:00–18:59.
function withinBusinessHours(now) {
  const h = (now || new Date()).getHours();
  return h >= 8 && h < 19;
}

// Try to claim a reminder. Returns true if THIS process should send it.
async function claim(pool, refType, refId, kind, sentTo) {
  const r = await pool.query(
    `INSERT INTO job_reminders (ref_type, ref_id, kind, sent_to)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (ref_type, ref_id, kind) DO NOTHING
     RETURNING id`,
    [refType, String(refId), kind, sentTo || null]);
  return r.rows.length > 0;
}

// Stages considered "finished" — no due/overdue reminders for these.
const DONE_STAGES = ['08_lodged', '09_completed'];

// Main entry. deps = { notifyBg }.
async function runReminders(pool, deps, opts) {
  const force = opts && opts.force;
  const now = new Date();
  if (!force && !withinBusinessHours(now)) return { skipped: 'outside business hours' };

  const summary = { client_3d: 0, client_7d: 0, due_tomorrow: 0, overdue: 0, review_stale: 0 };

  // ---- 1. Clients who still haven't provided requested documents ----
  // Pending doc-requests older than 3 / 7 days, for jobs that aren't finished.
  const dr = await pool.query(
    `SELECT dr.id, dr.description, dr.created_at, j.id AS job_id, j.stage,
            c.name AS client_name, c.email AS client_email,
            EXTRACT(EPOCH FROM (now() - dr.created_at)) / 86400 AS age_days
     FROM doc_requests dr
     JOIN jobs j ON j.id = dr.job_id
     JOIN clients c ON c.id = j.client_id
     WHERE dr.status = 'pending'
       AND j.stage <> ALL($1)
       AND c.email IS NOT NULL AND c.email <> ''`,
    [DONE_STAGES]);

  for (const row of dr.rows) {
    const age = Number(row.age_days) || 0;
    // 7-day reminder takes precedence once we're past a week.
    let kind = null;
    if (age >= 7) kind = 'client_7d';
    else if (age >= 3) kind = 'client_3d';
    if (!kind) continue;
    const won = await claim(pool, 'doc_request', row.id, kind, row.client_email);
    if (!won) continue;
    deps.notifyBg({
      jobId: row.job_id, toEmail: row.client_email, templateKey: 'reminder_documents',
      vars: { clientName: row.client_name, jobId: row.job_id, description: row.description },
    });
    summary[kind]++;
  }

  // ---- 2. Jobs due tomorrow / overdue → remind the assigned accountant ----
  const jobs = await pool.query(
    `SELECT j.id, j.due_date, j.stage, j.accountant_email, c.name AS client_name,
            (j.due_date - CURRENT_DATE) AS days_left
     FROM jobs j JOIN clients c ON c.id = j.client_id
     WHERE j.due_date IS NOT NULL
       AND j.stage <> ALL($1)
       AND j.accountant_email IS NOT NULL AND j.accountant_email <> ''`,
    [DONE_STAGES]);

  for (const row of jobs.rows) {
    const daysLeft = Number(row.days_left);
    let kind = null, subject = null, body = null;
    if (daysLeft === 1) {
      kind = 'due_tomorrow';
      subject = 'Reminder: job ' + row.id + ' is due tomorrow';
      body = 'Job ' + row.id + ' for ' + row.client_name + ' is due tomorrow (' + row.due_date + '). Please make sure it is on track.';
    } else if (daysLeft < 0) {
      kind = 'overdue';
      subject = 'Overdue: job ' + row.id;
      body = 'Job ' + row.id + ' for ' + row.client_name + ' was due on ' + row.due_date + ' and is now overdue. Please action it as soon as possible.';
    }
    if (!kind) continue;
    const won = await claim(pool, 'job', row.id + ':' + kind, kind, row.accountant_email);
    if (!won) continue;
    deps.notifyBg({ jobId: row.id, toEmail: row.accountant_email, rawSubject: subject, rawBody: body });
    summary[kind]++;
  }

  // ---- 3. Jobs sitting in supervisor review for too long (>3 days) → remind supervisor ----
  const stale = await pool.query(
    `SELECT j.id, j.supervisor_email, c.name AS client_name,
            EXTRACT(EPOCH FROM (now() - j.stage_since)) / 86400 AS days_in_review
     FROM jobs j JOIN clients c ON c.id = j.client_id
     WHERE j.stage = '05_supervisor_review'
       AND j.supervisor_email IS NOT NULL AND j.supervisor_email <> ''`);

  for (const row of stale.rows) {
    if ((Number(row.days_in_review) || 0) < 3) continue;
    // One reminder per whole-day bucket, so a long-stalled job nudges again each day.
    const bucket = Math.floor(Number(row.days_in_review));
    const won = await claim(pool, 'job', row.id + ':review:' + bucket, 'review_stale', row.supervisor_email);
    if (!won) continue;
    deps.notifyBg({
      jobId: row.id, toEmail: row.supervisor_email,
      rawSubject: 'Reminder: job ' + row.id + ' awaiting your review',
      rawBody: 'Job ' + row.id + ' for ' + row.client_name + ' has been waiting for supervisor review for ' + bucket + ' day(s). Please review it when you can.',
    });
    summary.review_stale++;
  }

  return summary;
}

module.exports = { runReminders, withinBusinessHours };
