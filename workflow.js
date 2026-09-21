// workflow.js — Elite Client Hub workflow engine.
// Keeps all stage logic + internal->client status mapping separate from UI.

// The 9 internal stages (plus ON HOLD / ACTION REQUIRED handled as flags on the job).
const STAGES = [
  '01_created',
  '02_waiting_docs',
  '03_docs_received',
  '04_processing',        // Allocated to offshore
  '04b_started',          // Offshore started work
  '04c_waiting_info',     // Offshore waiting on more info
  '04d_prep_complete',    // Offshore finished prep
  '05_supervisor_review', // Sent for review
  '06_awaiting_signature',
  '07_ready_lodgement',
  '08_lodged',
  '09_completed',
];

// The 9 simplified steps a CLIENT sees (the stepper on their portal), per the
// boss's requirement. Internal stages map onto these; several internal stages can
// share one client step. "Awaiting Payment" is shown for completeness ("if
// applicable") — payment integration itself is deferred to a later phase.
const CLIENT_STEPS = [
  'Documents Requested',          // 1
  'Documents Partially Received', // 2
  'All Documents Received',       // 3
  'Work in Progress',             // 4
  'Under Review',                 // 5
  'Awaiting Payment',             // 6 (if applicable)
  'Awaiting Signature',           // 7
  'Lodged with ATO',              // 8
  'Completed',                    // 9
];

// Internal -> Client-facing mapping. `notify` = template key to fire on entering the stage.
// `internalLabel` is staff-only; `clientStatus` + `clientMessage` are the only things a client sees.
// `clientStep` (1..9) positions the job on the client's simplified progress stepper.
// Note: the document-collection steps (1-3) are further refined at runtime in
// clientView() based on how many requested documents have actually been received.
const STAGE_MAP = {
  '01_created':            { internalLabel: '01 Job Created',            clientStep: 1, clientStatus: 'Received',            clientMessage: 'We have created your job and will request documents shortly.',              notify: null },
  '02_waiting_docs':       { internalLabel: '02 Waiting for Documents',  clientStep: 1, clientStatus: 'Action Required',     clientMessage: 'We need some documents from you to get started.',                             notify: 'action_required' },
  '03_docs_received':      { internalLabel: '03 Documents Received',     clientStep: 3, clientStatus: 'In Progress',         clientMessage: 'Thanks — we have received all your documents and started work.',              notify: 'documents_received' },
  '04_processing':         { internalLabel: '04 Offshore — Allocated',      clientStep: 4, clientStatus: 'In Progress',         clientMessage: 'Your accountant is currently preparing your work.',                           notify: null },
  '04b_started':           { internalLabel: '04 Offshore — In Progress',    clientStep: 4, clientStatus: 'In Progress',         clientMessage: 'Your accountant is currently preparing your work.',                           notify: null },
  '04c_waiting_info':      { internalLabel: '04 Offshore — Waiting for Info', clientStep: 4, clientStatus: 'In Progress',       clientMessage: 'Your accountant is currently preparing your work.',                           notify: null },
  '04d_prep_complete':     { internalLabel: '04 Offshore — Prep Complete',  clientStep: 4, clientStatus: 'In Progress',         clientMessage: 'Your accountant is currently preparing your work.',                           notify: null },
  '05_supervisor_review':  { internalLabel: '05 Supervisor Review',      clientStep: 5, clientStatus: 'In Progress',         clientMessage: 'Your work is being reviewed by a senior team member.',                        notify: 'supervisor_review' },
  '06_awaiting_signature': { internalLabel: '06 Awaiting Client Signature', clientStep: 7, clientStatus: 'Action Required', clientMessage: 'Your documents are ready — please review and sign.',                          notify: 'awaiting_signature' },
  '07_ready_lodgement':    { internalLabel: '07 Ready for Lodgement',    clientStep: 7, clientStatus: 'In Progress',         clientMessage: 'Everything is signed and ready to lodge.',                                    notify: null },
  '08_lodged':             { internalLabel: '08 Lodged',                 clientStep: 8, clientStatus: 'Lodged',              clientMessage: 'Your return has been lodged with the ATO.',                                   notify: 'lodged' },
  '09_completed':          { internalLabel: '09 Completed',              clientStep: 9, clientStatus: 'Completed',           clientMessage: 'This job is now complete. Thank you for choosing us.',                        notify: 'completed' },
};

// Human-friendly next action shown to staff on the dashboard.
const NEXT_ACTION = {
  '01_created':            'Request documents from client',
  '02_waiting_docs':       'Wait for / follow up client documents',
  '03_docs_received':      'Assign & begin processing',
  '04_processing':         'Offshore to start work',
  '04b_started':           'Offshore preparing the work',
  '04c_waiting_info':      'Offshore waiting for more information',
  '04d_prep_complete':     'Send to supervisor for review',
  '05_supervisor_review':  'Supervisor to approve or return',
  '06_awaiting_signature': 'Wait for client signature',
  '07_ready_lodgement':    'Lodge with ATO',
  '08_lodged':             'Confirm outcome and complete',
  '09_completed':          'None — job complete',
};

// A short, plain-English explanation shown under each client step, so the client
// always understands what the current status means. Keyed by step label.
const CLIENT_STEP_EXPLAIN = {
  'Documents Requested':          'We have asked you for some documents. Please upload them so we can begin.',
  'Documents Partially Received': 'Thanks! We have received some of your documents and are still waiting on the rest.',
  'All Documents Received':       'We have everything we need and your job is queued to be worked on.',
  'Work in Progress':            'Your accountant is preparing your work.',
  'Under Review':                'A senior team member is reviewing your work for accuracy.',
  'Awaiting Payment':            'Your work is ready. Payment is required before we finalise (if applicable).',
  'Awaiting Signature':          'Your documents are ready — please review and sign so we can lodge.',
  'Lodged with ATO':             'Your return has been lodged with the ATO.',
  'Completed':                   'This job is complete. Thank you for choosing us.',
};

function isValidStage(s) { return STAGES.indexOf(s) !== -1; }
function stageIndex(s) { return STAGES.indexOf(s); }

// Allowed transitions. Forward one step is always allowed; supervisor return/approve handled
// explicitly. We also allow jumping backward (e.g. return) but validate the target exists.
function canTransition(from, to) {
  if (!isValidStage(to)) return false;
  if (from === to) return false;
  return true; // Staff can move stages freely; history + audit record every move.
}

// Build the client-facing view of a job.
// `docInfo` is optional: { requested, received } counts of the job's document
// requests, used to refine the document-collection steps (1-3) into
// "Documents Requested" / "Partially Received" / "All Received".
function clientView(job, docInfo) {
  const m = STAGE_MAP[job.stage] || {};
  let clientStatus = m.clientStatus || 'In Progress';
  let clientMessage = m.clientMessage || '';
  let step = m.clientStep || 1; // 1..9 on the client stepper

  // Refine the document-collection phase (only while we are still collecting, i.e.
  // before the job has progressed to processing). Internal stages 01_created and
  // 02_waiting_docs map to step 1 by default; promote to step 2/3 based on receipts.
  if (docInfo && (job.stage === '01_created' || job.stage === '02_waiting_docs')) {
    const requested = Number(docInfo.requested) || 0;
    const received = Number(docInfo.received) || 0;
    if (requested > 0) {
      if (received >= requested) {
        step = 3; clientStatus = 'In Progress';
        clientMessage = 'Thanks — we have received all your documents.';
      } else if (received > 0) {
        step = 2; clientStatus = 'In Progress';
        clientMessage = 'Thanks — we have some of your documents and are waiting on the rest.';
      }
    }
  }

  if (job.on_hold) { clientStatus = 'On Hold'; clientMessage = 'This job is temporarily on hold. We will update you soon.'; }
  else if (job.action_required && clientStatus !== 'Action Required') { clientStatus = 'Action Required'; }

  const stepLabel = CLIENT_STEPS[step - 1];
  return {
    clientStatus: clientStatus,
    clientMessage: clientMessage,
    clientStep: step,                          // which of the 9 steps is current
    clientStepLabel: stepLabel,                // e.g. 'Work in Progress'
    clientStepExplain: CLIENT_STEP_EXPLAIN[stepLabel] || '', // plain-English detail
    clientSteps: CLIENT_STEPS,                 // the 9 labels, for the stepper UI
    // Progress reflects the client's 9-step journey, not the internal stages.
    progressPct: Math.round((step / CLIENT_STEPS.length) * 100),
  };
}

function notifyKeyForStage(stage) {
  const m = STAGE_MAP[stage];
  return m ? m.notify : null;
}

module.exports = {
  STAGES, STAGE_MAP, NEXT_ACTION, CLIENT_STEPS, CLIENT_STEP_EXPLAIN,
  isValidStage, stageIndex, canTransition, clientView, notifyKeyForStage,
};
