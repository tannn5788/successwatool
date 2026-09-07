// notify.js — template-based notifications (email now, SMS architected for later).
// If SMTP_* env vars are present, sends real email via nodemailer; otherwise it just
// logs the notification to the DB (status 'sent') so the full flow works end-to-end.
const nodemailer = require('nodemailer');

let transporter = null;
if (process.env.SMTP_HOST) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '') === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });
}

function fill(tpl, vars) {
  return String(tpl || '').replace(/\{\{(\w+)\}\}/g, function (_, k) {
    return vars && vars[k] != null ? String(vars[k]) : '';
  });
}

// opts: { jobId, toEmail, templateKey, vars, rawSubject, rawBody, resend }
async function sendNotification(pool, opts) {
  let subject = opts.rawSubject;
  let body = opts.rawBody;

  // Resolve template if not passing raw text.
  if (!subject || !body) {
    const t = await pool.query('SELECT subject, body FROM notification_templates WHERE key=$1', [opts.templateKey]);
    if (t.rows.length) {
      subject = fill(t.rows[0].subject, opts.vars);
      body = fill(t.rows[0].body, opts.vars);
    } else {
      subject = 'Update on your job ' + (opts.vars && opts.vars.jobId || '');
      body = 'There is an update on your job. Please log in to view details.';
    }
  }

  let status = 'sent';
  let error = null;
  if (transporter) {
    try {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'Elite Tax & Wealth <no-reply@successwa.com>',
        to: opts.toEmail, subject: subject, text: body,
      });
      status = opts.resend ? 'resent' : 'sent';
    } catch (e) { status = 'failed'; error = e.message; }
  } else {
    status = opts.resend ? 'resent' : 'sent';
    console.log('[notify] to=' + opts.toEmail + ' subject="' + subject + '"');
  }

  await pool.query(
    `INSERT INTO notifications (job_id, to_email, template_key, subject, body, channel, status, error)
     VALUES ($1,$2,$3,$4,$5,'email',$6,$7)`,
    [opts.jobId || null, opts.toEmail, opts.templateKey || null, subject, body, status, error]);

  return { status, error };
}

module.exports = { sendNotification };
