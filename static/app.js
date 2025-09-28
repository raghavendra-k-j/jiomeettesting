const defaultsEl = document.getElementById('app-defaults');
const defaultConfig = defaultsEl ? JSON.parse(defaultsEl.textContent || '{}') : {};

const viewButtons = {
  doctor: document.getElementById('doctorViewBtn'),
  patient: document.getElementById('patientViewBtn'),
};

const panels = {
  doctor: document.getElementById('doctorView'),
  patient: document.getElementById('patientView'),
};

const doctorStateEls = {
  empty: document.getElementById('doctorEmptyState'),
  pending: document.getElementById('doctorPendingMeeting'),
  live: document.getElementById('doctorMeetingLive'),
  doctorNameDisplay: document.getElementById('doctorNameDisplay'),
  patientNameDisplay: document.getElementById('patientNameDisplay'),
  baseLink: document.getElementById('baseLink'),
  doctorLink: document.getElementById('doctorLink'),
  patientLink: document.getElementById('patientLink'),
  providerLabel: document.getElementById('meetingProviderLabel'),
  meetingFrame: document.getElementById('doctorMeetingFrame'),
  meetingPlaceholder: document.getElementById('meetingPlaceholder'),
  copyPatientLinkBtn: document.getElementById('copyPatientLinkBtn'),
  createMeetingBtn: document.getElementById('createMeetingBtn'),
  deleteAppointmentBtn: document.getElementById('deleteAppointmentBtn'),
  resetAppointmentBtn: document.getElementById('resetAppointmentBtn'),
  notesInput: document.getElementById('doctorNotes'),
  notesStatus: document.getElementById('notesStatus'),
  clearNotesBtn: document.getElementById('clearNotesBtn'),
};

const patientStateEls = {
  noAppointment: document.getElementById('patientNoAppointment'),
  waiting: document.getElementById('patientWaiting'),
  ready: document.getElementById('patientReady'),
  patientJoinLink: document.getElementById('patientJoinLink'),
  refreshBtn: document.getElementById('patientRefreshBtn'),
};

const forms = {
  createAppointment: document.getElementById('createAppointmentForm'),
};

const inputs = {
  doctorName: document.getElementById('doctorNameInput'),
  patientName: document.getElementById('patientNameInput'),
};

doctorStateEls.meetingPlaceholderText = doctorStateEls.meetingPlaceholder ? doctorStateEls.meetingPlaceholder.querySelector('span') : null;

const alertContainer = document.getElementById('alertContainer');

const NOTES_STORAGE_KEY = 'doctorNotes';
let notesSaveTimer = null;

let activeView = 'doctor';
let pollingTimer = null;
let currentAppointment = null;

const VIEW_REFRESH_MS = 5000;

function setButtonActive(button, isActive) {
  if (!button) return;
  button.classList.toggle('bg-white', isActive);
  button.classList.toggle('shadow-md', isActive);
  button.classList.toggle('text-brand-600', isActive);
  button.classList.toggle('text-slate-600', !isActive);
}

function togglePanel(panelEl, isVisible) {
  if (!panelEl) return;
  panelEl.classList.toggle('hidden', !isVisible);
}

function showDoctorState(state) {
  togglePanel(doctorStateEls.empty, state === 'empty');
  togglePanel(doctorStateEls.pending, state === 'pending');
  togglePanel(doctorStateEls.live, state === 'live');
}

function showPatientState(state) {
  togglePanel(patientStateEls.noAppointment, state === 'none');
  togglePanel(patientStateEls.waiting, state === 'waiting');
  togglePanel(patientStateEls.ready, state === 'ready');

  if (state === 'ready') {
    patientStateEls.patientJoinLink.classList.add('animate-readyPulse');
  } else {
    patientStateEls.patientJoinLink.classList.remove('animate-readyPulse');
  }
}

function clearAlert() {
  if (!alertContainer) return;
  alertContainer.innerHTML = '';
  alertContainer.classList.add('hidden');
}

function renderAlert({ type = 'info', message }) {
  if (!alertContainer || !message) return;
  alertContainer.innerHTML = `
    <div class="rounded-2xl border ${type === 'error' ? 'border-rose-300 bg-rose-50 text-rose-700' : 'border-sky-300 bg-sky-50 text-sky-700'} px-5 py-4">
      <p class="font-medium">${message}</p>
    </div>
  `;
  alertContainer.classList.remove('hidden');
}

function showMeetingPlaceholder(show, message) {
  const placeholder = doctorStateEls.meetingPlaceholder;
  if (!placeholder) return;
  if (doctorStateEls.meetingPlaceholderText && message) {
    doctorStateEls.meetingPlaceholderText.textContent = message;
  }
  placeholder.classList.toggle('hidden', !show);
  placeholder.classList.toggle('flex', show);
}

function updateMeetingFrame(url) {
  if (!doctorStateEls.meetingFrame) return;
  if (!url) {
    doctorStateEls.meetingFrame.src = 'about:blank';
    showMeetingPlaceholder(true, 'Meeting will appear here once it is created.');
    return;
  }

  showMeetingPlaceholder(true, 'Loading your JioMeet room…');
  doctorStateEls.meetingFrame.src = url;
}

function getStorage() {
  try {
    return window.localStorage;
  } catch (error) {
    console.warn('Local storage unavailable', error);
    return null;
  }
}

function updateNotesStatus(message) {
  if (doctorStateEls.notesStatus) {
    doctorStateEls.notesStatus.textContent = message;
  }
}

function persistNotes(value) {
  const storage = getStorage();
  if (!storage) {
    updateNotesStatus('Notes not saved (storage unavailable)');
    return;
  }

  try {
    if (value) {
      storage.setItem(NOTES_STORAGE_KEY, value);
      updateNotesStatus('Saved just now');
    } else {
      storage.removeItem(NOTES_STORAGE_KEY);
      updateNotesStatus('Notes cleared');
    }
  } catch (error) {
    console.error('Unable to persist notes', error);
    updateNotesStatus('Unable to save notes');
  }
}

function scheduleNotesSave() {
  if (!doctorStateEls.notesInput) return;
  updateNotesStatus('Saving…');
  if (notesSaveTimer) {
    clearTimeout(notesSaveTimer);
  }
  notesSaveTimer = setTimeout(() => {
    persistNotes(doctorStateEls.notesInput.value.trim());
  }, 400);
}

function loadNotes() {
  if (!doctorStateEls.notesInput) return;
  const storage = getStorage();
  if (!storage) {
    updateNotesStatus('Notes not saved (storage unavailable)');
    return;
  }

  const saved = storage.getItem(NOTES_STORAGE_KEY);
  if (typeof saved === 'string') {
    doctorStateEls.notesInput.value = saved;
    updateNotesStatus('Loaded from previous session');
  } else {
    updateNotesStatus('Saved locally');
  }
}

function clearNotes() {
  if (!doctorStateEls.notesInput) return;
  doctorStateEls.notesInput.value = '';
  if (notesSaveTimer) {
    clearTimeout(notesSaveTimer);
    notesSaveTimer = null;
  }
  persistNotes('');
}

function hydrateFormDefaults() {
  if (inputs.doctorName && !inputs.doctorName.value) {
    inputs.doctorName.value = defaultConfig.doctor || '';
  }
  if (inputs.patientName && !inputs.patientName.value) {
    inputs.patientName.value = defaultConfig.patient || '';
  }
}

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    ...options,
  });

  if (!response.ok) {
    let detail = 'Request failed';
    try {
      const data = await response.json();
      detail = data.detail || data.message || detail;
    } catch (err) {
      detail = await response.text();
    }
    throw new Error(detail || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function startPolling() {
  stopPolling();
  pollingTimer = setInterval(() => {
    refreshAppointment();
  }, VIEW_REFRESH_MS);
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function refreshAppointment({ showAlertOnError = true } = {}) {
  try {
    const data = await fetchJSON('/api/appointment');
    currentAppointment = data.appointment || null;
    renderState();
    if (currentAppointment?.last_error) {
      renderAlert({ type: 'error', message: currentAppointment.last_error });
    } else {
      clearAlert();
    }
  } catch (error) {
    if (showAlertOnError) {
      renderAlert({ type: 'error', message: error.message });
    }
    currentAppointment = null;
    renderState();
  }
}

function renderState() {
  if (!currentAppointment) {
    clearAlert();
  }
  if (!currentAppointment) {
    showDoctorState('empty');
    showPatientState('none');
    updateMeetingFrame(null);
    return;
  }

  if (!currentAppointment.meeting) {
    showDoctorState('pending');
    showPatientState('waiting');

    doctorStateEls.doctorNameDisplay.textContent = currentAppointment.doctor_name;
    doctorStateEls.patientNameDisplay.textContent = currentAppointment.patient_name;
    doctorStateEls.baseLink.textContent = '';
    doctorStateEls.doctorLink.textContent = '';
    doctorStateEls.patientLink.textContent = '';
    patientStateEls.patientJoinLink.href = '#';
    updateMeetingFrame(null);
    showMeetingPlaceholder(true, 'Meeting will appear here once it is created.');
  } else {
    showDoctorState('live');
    showPatientState('ready');

    const meeting = currentAppointment.meeting;
    doctorStateEls.doctorNameDisplay.textContent = currentAppointment.doctor_name;
    doctorStateEls.patientNameDisplay.textContent = currentAppointment.patient_name;
    doctorStateEls.baseLink.textContent = meeting.base_url;
    doctorStateEls.doctorLink.textContent = meeting.doctor_url;
    doctorStateEls.patientLink.textContent = meeting.patient_url;
    doctorStateEls.providerLabel.textContent = meeting.provider === 'mock' ? 'Mock provider' : 'JioMeet';
    patientStateEls.patientJoinLink.href = meeting.patient_url;
    updateMeetingFrame(meeting.doctor_url);
  }
}

async function onCreateAppointment(event) {
  event.preventDefault();
  if (!forms.createAppointment) return;

  const payload = {
    doctor_name: inputs.doctorName?.value?.trim(),
    patient_name: inputs.patientName?.value?.trim() || undefined,
  };

  if (!payload.doctor_name) {
    renderAlert({ type: 'error', message: 'Doctor name is required.' });
    return;
  }

  try {
    const data = await fetchJSON('/api/appointment', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    currentAppointment = data.appointment;
    renderState();
    clearAlert();
  } catch (error) {
    renderAlert({ type: 'error', message: error.message });
  }
}

async function onCreateMeeting() {
  try {
    const data = await fetchJSON('/api/appointment/meeting', { method: 'POST' });
    currentAppointment = data.appointment;
    renderState();
    renderAlert({ type: 'info', message: 'Meeting created successfully.' });
  } catch (error) {
    renderAlert({ type: 'error', message: error.message });
  }
}

async function onDeleteAppointment() {
  try {
    await fetchJSON('/api/appointment', { method: 'DELETE' });
    currentAppointment = null;
    renderState();
    renderAlert({ type: 'info', message: 'Appointment cleared.' });
  } catch (error) {
    renderAlert({ type: 'error', message: error.message });
  }
}

async function onCopyPatientLink() {
  if (!currentAppointment?.meeting) {
    renderAlert({ type: 'error', message: 'Patient link not available yet.' });
    return;
  }

  try {
    await navigator.clipboard.writeText(currentAppointment.meeting.patient_url);
    renderAlert({ type: 'info', message: 'Patient link copied to clipboard.' });
  } catch (error) {
    renderAlert({ type: 'error', message: `Unable to copy: ${error.message}` });
  }
}

function setView(view) {
  activeView = view;
  Object.entries(viewButtons).forEach(([key, button]) => setButtonActive(button, key === view));
  Object.entries(panels).forEach(([key, panel]) => togglePanel(panel, key === view));

  if (view === 'patient') {
    startPolling();
  } else {
    stopPolling();
  }
}

function wireEvents() {
  forms.createAppointment?.addEventListener('submit', onCreateAppointment);
  doctorStateEls.createMeetingBtn?.addEventListener('click', onCreateMeeting);
  doctorStateEls.deleteAppointmentBtn?.addEventListener('click', onDeleteAppointment);
  doctorStateEls.resetAppointmentBtn?.addEventListener('click', onDeleteAppointment);
  doctorStateEls.copyPatientLinkBtn?.addEventListener('click', onCopyPatientLink);
  doctorStateEls.notesInput?.addEventListener('input', scheduleNotesSave);
  doctorStateEls.clearNotesBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    clearNotes();
  });
  doctorStateEls.meetingFrame?.addEventListener('load', () => {
    const src = doctorStateEls.meetingFrame?.getAttribute('src') || '';
    if (src && src !== 'about:blank') {
      showMeetingPlaceholder(false);
    }
  });
  doctorStateEls.resetAppointmentBtn?.addEventListener('click', () => showMeetingPlaceholder(false));
  patientStateEls.refreshBtn?.addEventListener('click', () => refreshAppointment({ showAlertOnError: true }));

  viewButtons.doctor?.addEventListener('click', () => setView('doctor'));
  viewButtons.patient?.addEventListener('click', () => setView('patient'));
}

(function init() {
  hydrateFormDefaults();
  wireEvents();
  loadNotes();
  setView('doctor');
  refreshAppointment({ showAlertOnError: false });
  if (activeView === 'patient') {
    startPolling();
  }
})();
