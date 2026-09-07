// workflow.js — Elite Client Hub workflow engine.
// Keeps all stage logic + internal->client status mapping separate from UI.

// The 9 internal stages (plus ON HOLD / ACTION REQUIRED handled as flags on the job).
const STAGES = [
  '01_created',
  '02_waiting_docs',
  '03_docs_received',
  '04_processing',
  '05_supervisor_review',
  '06_awaiting_signature',
  '07_ready_lodgement',
  '08_lodged',
  '09_completed',
];

// Internal -> Client-facing mapping. `notify` = template key to fire on entering the stage.
// `internalLabel` is staff-only; `clientStatus` + `clientMessage` are the only things a client sees.
const STAGE_MAP = {
  '01_created':            { internalLabel: '01 Job Created',            clientStatus: 'Received',            clientMessage: 'We have created your job and will be in touch shortly.',                       notify: null },
  '02_waiting_docs':       { internalLabel: '02 Waiting for Documents',  clientStatus: 'Action Required',     clientMessage: 'We need some documents from you to get started.',                             notify: 'action_required' },
  '03_docs_received':      { internalLabel: '03 Documents Received',     clientStatus: 'In Progress',         clientMessage: 'Thanks — we have received your documents and started work.',                   notify: 'documents_received' },
  '04_processing':         { internalLabel: '04 Accountant Processing',  clientStatus: 'In Progress',         clientMessage: 'Your accountant is currently preparing your work.',                           notify: null },
  '05_supervisor_review':  { internalLabel: '05 Supervisor Review',      clientStatus: 'In Progress',         clientMessage: 'Your work is being reviewed by a senior team member.',                        notify: 'supervisor_review' },
  '06_awaiting_signature': { internalLabel: '06 Awaiting Client Signature', clientStatus: 'Action Required', clientMessage: 'Your documents are ready — please review and sign.',                          notify: 'awaiting_signature' },
  '07_ready_lodgement':    { internalLabel: '07 Ready for Lodgement',    clientStatus: 'In Progress',         clientMessage: 'Everything is signed and ready to lodge.',                                    notify: null },
  '08_lodged':             { internalLabel: '08 Lodged',                 clientStatus: 'Lodged',              clientMessage: 'Your return has been lodged with the ATO.',                                   notify: 'lodged' },
  '09_completed':          { internalLabel: '09 Completed',              clientStatus: 'Completed',           clientMessage: 'This job is now complete. Thank you for choosing us.',                        notify: 'completed' },
};

// Human-friendly next action shown to staff on the dashboard.
const NEXT_ACTION = {
  '01_created':            'Request documents from client',
  '02_waiting_docs':       'Wait for / follow up client documents',
  '03_docs_received':      'Assign & begin processing',
  '04_processing':         'Complete work and submit for review',
  '05_supervisor_review':  'Supervisor to approve or return',
  '06_awaiting_signature': 'Wait for client signature',
  '07_ready_lodgement':    'Lodge with ATO',
  '08_lodged':             'Confirm outcome and complete',
  '09_completed':          'None — job complete',
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

function clientView(job) {
  const m = STAGE_MAP[job.stage] || {};
  let clientStatus = m.clientStatus || 'In Progress';
  let clientMessage = m.clientMessage || '';
  if (job.on_hold) { clientStatus = 'On Hold'; clientMessage = 'This job is temporarily on hold. We will update you soon.'; }
  else if (job.action_required && clientStatus !== 'Action Required') { clientStatus = 'Action Required'; }
  return {
    clientStatus: clientStatus,
    clientMessage: clientMessage,
    progressPct: Math.round(((stageIndex(job.stage) + 1) / STAGES.length) * 100),
  };
}

function notifyKeyForStage(stage) {
  const m = STAGE_MAP[stage];
  return m ? m.notify : null;
}

module.exports = {
  STAGES, STAGE_MAP, NEXT_ACTION,
  isValidStage, stageIndex, canTransition, clientView, notifyKeyForStage,
};
