// Creates the DB schema on Neon + seeds Elite Client Hub demo data.
// Run: node db/init.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

async function upsertUser(email, name, password, role) {
  const { salt, hash } = hashPassword(password);
  await pool.query(
    `INSERT INTO users (email, name, pass_hash, pass_salt, role, active)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (email) DO UPDATE SET name=EXCLUDED.name, role=EXCLUDED.role, active=true`,
    [email, name, hash, salt, role]);
}

const TEMPLATES = [
  ['documents_received', 'We have received your documents', 'Hi {{clientName}},\n\nThank you — we have received your documents for job {{jobId}} and have started work.\n\nElite Tax & Wealth Advisory'],
  ['supervisor_review', 'Your work is under review', 'Hi {{clientName}},\n\nYour work for job {{jobId}} is now being reviewed by a senior team member.\n\nElite Tax & Wealth Advisory'],
  ['action_required', 'Action required: documents needed', 'Hi {{clientName}},\n\nWe need some documents from you to progress job {{jobId}}. Please log in to your portal to see what is outstanding and upload them.\n\nElite Tax & Wealth Advisory'],
  ['awaiting_signature', 'Your documents are ready to sign', 'Hi {{clientName}},\n\nYour documents for job {{jobId}} are ready. Please review and sign at your earliest convenience.\n\nElite Tax & Wealth Advisory'],
  ['lodged', 'Your return has been lodged', 'Hi {{clientName}},\n\nGood news — job {{jobId}} has been lodged with the ATO.\n\nElite Tax & Wealth Advisory'],
  ['completed', 'Your job is complete', 'Hi {{clientName}},\n\nJob {{jobId}} is now complete. Thank you for choosing Elite Tax & Wealth Advisory.'],
];

async function seedTemplates() {
  for (const [key, subject, body] of TEMPLATES) {
    await pool.query(
      `INSERT INTO notification_templates (key, subject, body, updated_by)
       VALUES ($1,$2,$3,'system')
       ON CONFLICT (key) DO NOTHING`,
      [key, subject, body]);
  }
}

async function nextId(name, prefix) {
  const r = await pool.query(
    `INSERT INTO id_counters (name, value) VALUES ($1, 1)
     ON CONFLICT (name) DO UPDATE SET value = id_counters.value + 1 RETURNING value`, [name]);
  return prefix + String(r.rows[0].value).padStart(4, '0');
}

async function seedDemo() {
  // Only seed a demo client/entity/job if none exist yet.
  const ex = await pool.query('SELECT COUNT(*)::int AS n FROM clients');
  if (ex.rows[0].n > 0) { console.log('Clients already exist — skipping demo client seed.'); return; }

  const clientId = await nextId('client', 'CL-');
  await pool.query('INSERT INTO clients (id, name, email, phone) VALUES ($1,$2,$3,$4)',
    [clientId, 'Demo Client', 'demo@successwa.com', '0400 000 000']);
  const entityId = await nextId('entity', 'EN-');
  await pool.query('INSERT INTO entities (id, client_id, entity_name, entity_type, abn) VALUES ($1,$2,$3,$4,$5)',
    [entityId, clientId, 'Demo Client (Individual)', 'individual', null]);
  const jobId = await nextId('job', 'JB-');
  await pool.query(
    `INSERT INTO jobs (id, client_id, entity_id, job_type, financial_year, accountant_email, supervisor_email, stage)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'01_created')`,
    [jobId, clientId, entityId, 'Individual Tax Return', 'FY2024-25', 'accountant@successwa.com', 'supervisor@successwa.com']);
  await pool.query('INSERT INTO job_status_history (job_id, from_stage, to_stage, changed_by, reason) VALUES ($1,$2,$3,$4,$5)',
    [jobId, null, '01_created', 'system', 'Seed job']);
  console.log('Seeded demo: client', clientId, 'entity', entityId, 'job', jobId);
}

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  try {
    await pool.query(sql);

    // Seed staff accounts (idempotent). Default temp passwords — change in production.
    await upsertUser('admin@successwa.com', 'Admin User', 'admin123', 'administrator');
    await upsertUser('supervisor@successwa.com', 'Supervisor User', 'super123', 'supervisor');
    await upsertUser('accountant@successwa.com', 'Accountant User', 'acct123', 'accountant');
    await upsertUser('reception@successwa.com', 'Reception User', 'recep123', 'reception');
    await upsertUser('demo@successwa.com', 'Demo Client', 'demo123', 'client');

    await seedTemplates();
    await seedDemo();

    const r = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name");
    console.log('Schema applied. Tables:', r.rows.map((x) => x.table_name).join(', '));
    console.log('\nSeed accounts:');
    console.log('  admin@successwa.com / admin123        (administrator)');
    console.log('  supervisor@successwa.com / super123   (supervisor)');
    console.log('  accountant@successwa.com / acct123    (accountant)');
    console.log('  reception@successwa.com / recep123    (reception)');
    console.log('  demo@successwa.com / demo123          (client)');
  } catch (e) {
    console.error('Init failed:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
