// checklists.js — per-job-type work-checklist templates.
// When a job is created, we seed job_checklist_items from the template that best
// matches the (free-text) job_type. Offshore staff tick these off; required items
// must be complete before the job can be sent to supervisor review.

// Each template is an ordered list of { label, required }.
const TEMPLATES = {
  individual: [
    { label: 'Client identity confirmed', required: true },
    { label: 'Income reviewed (salary/wages)', required: true },
    { label: 'PAYG payment summaries checked', required: true },
    { label: 'Interest income included', required: false },
    { label: 'Dividend income included', required: false },
    { label: 'Rental property schedule prepared', required: false },
    { label: 'Work-related deductions reviewed', required: true },
    { label: 'Supporting documents attached', required: true },
    { label: 'Private health insurance details entered', required: false },
    { label: 'Medicare levy / surcharge checked', required: true },
    { label: 'Previous year comparison reviewed', required: false },
    { label: 'Workpapers completed', required: true },
  ],
  company: [
    { label: 'Financial statements reconciled', required: true },
    { label: 'Trial balance reviewed', required: true },
    { label: 'Income reconciled to source', required: true },
    { label: 'Expenses reviewed and coded', required: true },
    { label: 'Depreciation schedule updated', required: false },
    { label: 'Franking account checked', required: false },
    { label: 'Tax reconciliation prepared', required: true },
    { label: 'Supporting documents attached', required: true },
    { label: 'Workpapers completed', required: true },
  ],
  trust: [
    { label: 'Financial statements reconciled', required: true },
    { label: 'Trust distribution resolution reviewed', required: true },
    { label: 'Beneficiary details confirmed', required: true },
    { label: 'Income reconciled to source', required: true },
    { label: 'Expenses reviewed and coded', required: true },
    { label: 'Supporting documents attached', required: true },
    { label: 'Workpapers completed', required: true },
  ],
  smsf: [
    { label: 'Member details confirmed', required: true },
    { label: 'Contributions reviewed (caps checked)', required: true },
    { label: 'Investments reconciled', required: true },
    { label: 'Market valuations obtained', required: true },
    { label: 'Pension/minimum drawdown checked', required: false },
    { label: 'Financial statements prepared', required: true },
    { label: 'Audit documents prepared', required: true },
    { label: 'Workpapers completed', required: true },
  ],
  bas: [
    { label: 'Bank feeds reconciled for the period', required: true },
    { label: 'GST coding reviewed', required: true },
    { label: 'PAYG withholding checked', required: true },
    { label: 'Sales / purchases reconciled', required: true },
    { label: 'Supporting documents attached', required: true },
    { label: 'BAS figures reviewed', required: true },
  ],
  bookkeeping: [
    { label: 'Bank accounts reconciled', required: true },
    { label: 'Transactions coded correctly', required: true },
    { label: 'Unreconciled items reviewed', required: true },
    { label: 'Supporting documents attached', required: false },
    { label: 'Reports reviewed', required: true },
  ],
  // Fallback for any job type we do not recognise.
  default: [
    { label: 'Documents reviewed', required: true },
    { label: 'Work prepared', required: true },
    { label: 'Figures checked', required: true },
    { label: 'Workpapers attached', required: true },
    { label: 'Ready for review', required: true },
  ],
};

// Choose a template key from a free-text job type string.
function keyForJobType(jobType) {
  const t = String(jobType || '').toLowerCase();
  if (!t) return 'default';
  if (t.indexOf('smsf') !== -1 || t.indexOf('self-managed') !== -1 || t.indexOf('self managed') !== -1) return 'smsf';
  if (t.indexOf('bas') !== -1 || t.indexOf('ias') !== -1 || t.indexOf('activity statement') !== -1) return 'bas';
  if (t.indexOf('bookkeep') !== -1) return 'bookkeeping';
  if (t.indexOf('company') !== -1 || t.indexOf('pty') !== -1) return 'company';
  if (t.indexOf('trust') !== -1) return 'trust';
  if (t.indexOf('individual') !== -1 || t.indexOf('personal') !== -1 ||
      (t.indexOf('tax return') !== -1 && t.indexOf('company') === -1 && t.indexOf('trust') === -1)) return 'individual';
  return 'default';
}

// Return the ordered checklist template (array of { label, required }) for a job type.
function templateFor(jobType) {
  return TEMPLATES[keyForJobType(jobType)] || TEMPLATES.default;
}

module.exports = { TEMPLATES, keyForJobType, templateFor };
