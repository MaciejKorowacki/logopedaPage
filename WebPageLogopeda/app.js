/* ============================================================================
   app.js – Gabinet Neurologopedyczny v2  (schema v2 compatible)
   Full reschedule negotiation flow: patient requests → therapist notified with
   accept/propose-other → back-and-forth until one side accepts → 24h auto-cancel.
   ============================================================================ */

// --- Supabase ---------------------------------------------------------------
const SUPABASE_URL = 'https://dclbsucsccsegvpmmgdn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjbGJzdWNzY2NzZWd2cG1tZ2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTA1NjksImV4cCI6MjEwMjY2NjU2OX0.HEVj0gPxioLmCR8SZYgt8qi-Nw47UMYrSgKLUrBZedQ';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

// --- State ------------------------------------------------------------------
let currentUser = null;
let isTherapist = false;
let currentProfile = null;
let calendar = null;
let allPatients = [];         // for combobox
let selectedAptPatient = null; // selected patient in appointment modal
let selectedAccountPatient = null; // selected patient in Konta tab

const THERAPIST_EMAILS = ['kontakt@logopedaostroda.pl', 'ziomekzpolski@yahoo.com'];
const MONTH_LABELS = ['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];

// --- Init -------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async () => {
  const session = JSON.parse(localStorage.getItem('sb-session') || 'null');
  if (!session || !session.access_token) { location.href = 'login.html'; return; }

  const { data: { user }, error } = await sb.auth.getUser(session.access_token);
  if (error || !user) { localStorage.removeItem('sb-session'); location.href = 'login.html'; return; }

  currentUser = user;
  document.getElementById('nav-greeting').textContent = `Cześć ${user.email}!`;
  let { data: profile } = await sb.from('profiles').select('*').eq('id', user.id).single();

  // If profile row doesn't exist (signup didn't create it), create it now
  if (!profile) {
    const role = THERAPIST_EMAILS.includes(user.email) ? 'therapist' : 'patient';
    const { data: newProfile, error: upsertErr } = await sb.from('profiles').upsert({
      id: user.id,
      email: user.email,
      role: role
    }, { onConflict: 'id' }).select().single();
    if (upsertErr) {
      console.error('Profile upsert failed:', upsertErr.message);
      showToast('Błąd tworzenia profilu: ' + upsertErr.message, 'error');
    }
    profile = newProfile;
  }

  currentProfile = profile;
  isTherapist = THERAPIST_EMAILS.includes(user.email) || (profile && profile.role === 'therapist');

  buildNavTabs();
  initCalendar();
  loadExercises();
  loadNotifications();
  loadProfile();
  if (isTherapist) loadPatients();
  initAptTimeSelect();
  initRecurringMonths('recurring-months');

  // Periodic auto-cancellation check (every 5 minutes)
  setInterval(checkAutoCancellation, 5 * 60 * 1000);

  // Real-time notification subscription for badge updates
  try {
    sb.channel('notif-changes')
      .onPostgresChanges({ event: '*', schema: 'public', table: 'notifications' }, () => {
        loadNotifications();
      })
      .subscribe();
  } catch(e) { /* real-time not available, fall back to manual refresh */ }

  // Event listeners
  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('new-appointment-btn').onclick = () => openNewAptModal();
  document.getElementById('add-exercise-btn').onclick = () => openModal('exercise-modal');
  document.getElementById('create-profile-btn').onclick = () => openNewProfileInAccounts();
  document.getElementById('mark-all-read').onclick = markAllRead;

  // Combobox: accounts search
  const acctSearch = document.getElementById('account-search');
  acctSearch.addEventListener('input', () => renderAccountList(acctSearch.value));

  // Combobox: appointment modal search
  const aptSearch = document.getElementById('apt-patient-search');
  aptSearch.addEventListener('input', () => filterCombobox(aptSearch.value, 'apt-patient-dropdown', p => selectAptPatient(p)));
  aptSearch.addEventListener('focus', () => { if (aptSearch.value.length >= 1) filterCombobox(aptSearch.value, 'apt-patient-dropdown', p => selectAptPatient(p)); });

  // Recurring checkbox
  document.getElementById('apt-recurring').addEventListener('change', e => {
    document.getElementById('recurring-options').classList.toggle('hidden', !e.target.checked);
  });

  // Profile form
  document.getElementById('profile-form').addEventListener('submit', saveProfile);
  document.getElementById('prof-dob').addEventListener('change', () => calcAgeField('prof-dob','prof-age'));

  // Account edit form
  document.getElementById('account-edit-form').addEventListener('submit', saveAccountPatient);
  document.getElementById('acc-dob').addEventListener('change', () => calcAgeField('acc-dob','acc-age'));

  // New appointment form
  document.getElementById('new-appointment-form').addEventListener('submit', createAppointment);

  // Exercise form
  document.getElementById('exercise-form').addEventListener('submit', saveExercise);

  // Modal close buttons
  document.querySelectorAll('.modal-close, .modal-overlay').forEach(el => el.addEventListener('click', closeModalAll));
  document.querySelectorAll('.modal-close-btn').forEach(el => el.addEventListener('click', closeModalAll));

  // Keyboard ESC
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModalAll(); });
});

// --- Navigation -------------------------------------------------------------
function buildNavTabs() {
  const container = document.getElementById('nav-tabs-container');
  container.innerHTML = '';
  const tabs = [
    { id: 'calendar', label: 'Kalendarz', emoji: '📅' },
    { id: 'exercises', label: 'Ćwiczenia', emoji: '🏋️' },
    { id: 'accounts', label: 'Konta', emoji: '👥', therapistOnly: true },
    { id: 'profile', label: 'Profil', emoji: '👤', patientOnly: true },
    { id: 'notifications', label: 'Powiadomienia', emoji: '🔔' },
    { id: 'contact', label: 'Kontakt', emoji: '📞' },
  ];
  tabs.forEach(t => {
    if (t.therapistOnly && !isTherapist) return;
    if (t.patientOnly && isTherapist) return;
    const btn = document.createElement('button');
    btn.className = 'nav-tab';
    btn.dataset.tab = t.id;
    let badgeHtml = '';
    if (t.id === 'notifications') badgeHtml = '<span class="notif-badge hidden" id="notif-badge">0</span>';
    btn.innerHTML = `${t.emoji || ''} ${t.label}${badgeHtml}`;
    btn.onclick = () => switchTab(t.id);
    container.appendChild(btn);
  });
  if (isTherapist) document.getElementById('new-appointment-btn').classList.remove('hidden');
  if (isTherapist) document.getElementById('exercise-therapist-controls').classList.remove('hidden');
}

function switchTab(id) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + id).classList.add('active');
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  if (id === 'calendar' && calendar) calendar.updateSize();
  if (id === 'accounts') renderAccountList(document.getElementById('account-search').value);
  // Show broadcast button only for therapist
  const broadcastBtn = document.getElementById('broadcast-btn-container');
  if (broadcastBtn) broadcastBtn.classList.toggle('hidden', !isTherapist);
}

// --- Calendar ---------------------------------------------------------------
function initCalendar() {
  const el = document.getElementById('calendar');
  calendar = new FullCalendar.Calendar(el, {
    locale: 'pl',
    initialView: isTherapist ? 'dayGridMonth' : 'dayGridMonth',
    headerToolbar: {
      left: 'dayGridMonth,timeGridWeek,timeGridDay',
      center: 'title',
      right: 'prev,today,next'
    },
    buttonText: {
      month: 'Miesiąc',
      week: 'Tydzień',
      day: 'Dzień',
      today: 'Dziś'
    },
    slotMinTime: '07:00:00',
    slotMaxTime: '21:00:00',
    slotDuration: '01:00:00',
    allDaySlot: false,
    height: 'auto',
    events: fetchCalendarEvents,
    eventClick: handleEventClick,
    dateClick: isTherapist ? handleDateClick : undefined,
  });
  calendar.render();
}

async function fetchCalendarEvents(info, success, fail) {
  // Run auto-cancellation check before fetching
  await checkAutoCancellation();

  const from = info.startStr.slice(0, 10);
  const to = info.endStr.slice(0, 10);
  let q = sb.from('appointments')
    .select('id, title, appointment_date, status, recurring_type, recurring_parent, patient_email, patient_name, patient_phone, patient_dob')
    .gte('appointment_date', from)
    .lt('appointment_date', to + 'T23:59:59')
    .neq('status', 'cancelled');
  if (!isTherapist) q = q.eq('patient_email', currentUser.email);
  const { data, error } = await q;
  if (error) { fail(error); return; }
  const events = data.map(a => ({
    id: a.id,
    title: a.title,
    start: a.appointment_date,
    backgroundColor:
      a.status === 'confirmed' ? '#22c55e' :
      a.status === 'scheduled' ? '#3b82f6' :
      a.status === 'reschedule_requested' ? '#f97316' :
      a.status === 'reschedule_proposed' ? '#d97706' :
      '#f59e0b',
    extendedProps: a
  }));
  success(events);
}

function handleEventClick(info) {
  const a = info.event.extendedProps;
  showAptDetail(a);
}

function handleDateClick(info) {
  openNewAptModal(info.dateStr);
}

function showAptDetail(apt) {
  const pName = apt.patient_name || '';
  const pPhone = apt.patient_phone || '';
  const pEmail = apt.patient_email || '';
  const pDob = apt.patient_dob || '';
  const age = calcAge(pDob);
  const ageStr = age !== null ? ` (${age} lat)` : '';

  const aptDate = new Date(apt.appointment_date);
  const dateStr = aptDate.toLocaleDateString('pl-PL');
  const timeStr = aptDate.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' });

  const rescheduleInfo = extractRescheduleInfo(apt);

  const body = document.getElementById('modal-body');
  let bodyHtml = `
    <div class="detail-row"><strong>Pacjent:</strong> ${esc(pName)}${ageStr}</div>
    <div class="detail-row"><strong>Data:</strong> ${dateStr}</div>
    <div class="detail-row"><strong>Godzina:</strong> ${timeStr}</div>
    <div class="detail-row"><strong>Status:</strong> ${statusLabel(apt.status)}</div>
    ${pEmail ? `<div class="detail-row"><strong>E-mail:</strong> ${esc(pEmail)}</div>` : ''}
    ${pPhone ? `<div class="detail-row"><strong>Telefon:</strong> ${esc(pPhone)}</div>` : ''}
    ${apt.recurring_type && apt.recurring_type !== 'weekly' ? `<div class="detail-row"><strong>Cykliczność:</strong> ${recurringLabel(apt.recurring_type)}</div>` : ''}
  `;

  // Show negotiation state
  if (rescheduleInfo) {
    const whoProposed = rescheduleInfo.role === 'patient' ? 'Pacjent' : 'Logopeda';
    const waitingFor = rescheduleInfo.role === 'patient' ? 'logopeda' : 'pacjent';
    bodyHtml += `
      <div class="negotiation-info">
        <strong>🔄 Negocjacja terminu</strong><br>
        ${whoProposed} proponuje nowy termin: <strong>${esc(rescheduleInfo.proposedDate)}</strong><br>
        <span style="font-size:.8rem;color:#92400e">Oczekuje na odpowiedź ${waitingFor}</span>
      </div>
    `;
  }

  body.innerHTML = bodyHtml;

  const actions = document.getElementById('modal-actions');
  actions.innerHTML = '';

  // Cancel button (always available if not already cancelled)
  if (apt.status !== 'cancelled') {
    actions.innerHTML += `<button class="btn btn-danger btn-sm" onclick="cancelAppointment('${apt.id}')">Odwołaj wizytę</button> `;
  }

  // --- Negotiation action buttons ---
  if (apt.status === 'reschedule_requested' && isTherapist) {
    // Therapist needs to respond to patient's request
    actions.innerHTML += `<button class="btn btn-primary btn-sm" onclick="acceptReschedule('${apt.id}')">Akceptuj proponowany termin</button> `;
    actions.innerHTML += `<button class="btn btn-outline btn-sm" onclick="proposeAlternativeDate('${apt.id}', 'therapist')">Zaproponuj inny termin</button> `;
  } else if (apt.status === 'reschedule_proposed' && !isTherapist) {
    // Patient needs to respond to therapist's proposal
    actions.innerHTML += `<button class="btn btn-primary btn-sm" onclick="acceptReschedule('${apt.id}')">Akceptuj proponowany termin</button> `;
    actions.innerHTML += `<button class="btn btn-outline btn-sm" onclick="proposeAlternativeDate('${apt.id}', 'patient')">Zaproponuj inny termin</button> `;
  } else if (isTherapist && apt.status !== 'cancelled') {
    // Therapist direct reschedule (no negotiation)
    actions.innerHTML += `<button class="btn btn-outline btn-sm" onclick="openReschedule('${apt.id}')">Przełóż wizytę</button> `;
  } else if (!isTherapist && apt.status !== 'cancelled' && apt.status !== 'reschedule_requested' && apt.status !== 'reschedule_proposed') {
    // Patient can request reschedule on normal appointments
    actions.innerHTML += `<button class="btn btn-outline btn-sm" onclick="requestReschedule('${apt.id}')">Poproś o przełożenie</button> `;
  }

  actions.innerHTML += `<button class="btn btn-outline btn-sm" onclick="closeModalAll()">Wróć</button>`;
  document.getElementById('modal-title').textContent = stripRescheduleRequest(apt.title || '') || 'Szczegóły wizyty';
  openModal('appointment-modal');
}

function statusLabel(s) {
  return {
    scheduled: 'Zaplanowana',
    pending: 'Oczekująca',
    confirmed: 'Potwierdzona',
    cancelled: 'Anulowana',
    reschedule_requested: 'Prośba o przełożenie',
    reschedule_proposed: 'Propozycja logopedy'
  }[s] || s;
}
function recurringLabel(t) {
  return { weekly: 'Co tydzień', biweekly: 'Co 2 tygodnie', monthly: 'Co miesiąc' }[t] || t;
}

async function cancelAppointment(id) {
  if (!confirm('Na pewno anulować wizytę?')) return;
  const { data: apt } = await sb.from('appointments').select('patient_email, patient_name, status, title').eq('id', id).single();
  const cleanTitle = stripRescheduleRequest(apt ? apt.title || '' : '');
  await sb.from('appointments').update({ status: 'cancelled', title: cleanTitle }).eq('id', id);

  // Notify the other party about cancellation
  if (apt) {
    if (isTherapist && apt.patient_email) {
      // Therapist cancelled → notify patient
      await sb.from('notifications').insert({
        patient_email: apt.patient_email,
        message: 'Wizyta została odwołana przez logopedę.',
        type: 'cancel',
        is_read: false
      });
    } else if (!isTherapist) {
      // Patient cancelled → notify therapist
      await sb.from('notifications').insert({
        patient_email: THERAPIST_EMAILS[0],
        message: 'Pacjent ' + (apt.patient_name || '') + ' odwołał wizytę.',
        type: 'cancel',
        is_read: false
      });
    }
    // Mark any reschedule notifications as read
    const { data: notifs } = await sb.from('notifications')
      .select('id')
      .like('type', 'reschedule_%:' + id);
    if (notifs && notifs.length > 0) {
      await sb.from('notifications').update({ is_read: true }).in('id', notifs.map(n => n.id));
    }
  }

  calendar.refetchEvents();
  loadNotifications();
  closeModalAll();
  showToast('Wizyta anulowana');
}

// --- Reschedule: open slot-picker modals -----------------------------------
function openReschedule(aptId) {
  closeModalAll();
  document.getElementById('resched-date').value = '';
  document.getElementById('resched-slots').innerHTML = '';
  document.getElementById('resched-confirm').dataset.aptId = aptId;
  document.getElementById('resched-confirm').dataset.mode = 'therapist';
  document.getElementById('resched-confirm').dataset.notifId = '';
  document.getElementById('resched-confirm').textContent = 'Przełóż wizytę';
  document.getElementById('resched-confirm').disabled = true;
  document.getElementById('reschedule-modal').querySelector('h3').textContent = 'Przełóż wizytę';
  document.getElementById('resched-date').onchange = () => loadReschedSlots(aptId);
  openModal('reschedule-modal');
}

function requestReschedule(aptId) {
  closeModalAll();
  document.getElementById('resched-date').value = '';
  document.getElementById('resched-slots').innerHTML = '';
  document.getElementById('resched-confirm').dataset.aptId = aptId;
  document.getElementById('resched-confirm').dataset.mode = 'patient';
  document.getElementById('resched-confirm').dataset.notifId = '';
  document.getElementById('resched-confirm').textContent = 'Wyślij prośbę o przełożenie';
  document.getElementById('resched-confirm').disabled = true;
  document.getElementById('reschedule-modal').querySelector('h3').textContent = 'Poproś o przełożenie wizyty';
  document.getElementById('resched-date').onchange = () => loadReschedSlots(aptId);
  openModal('reschedule-modal');
}

function proposeAlternativeDate(aptId, role, notifId) {
  closeModalAll();
  document.getElementById('resched-date').value = '';
  document.getElementById('resched-slots').innerHTML = '';
  document.getElementById('resched-confirm').dataset.aptId = aptId;
  document.getElementById('resched-confirm').dataset.mode = role === 'therapist' ? 'therapist_counter' : 'patient_counter';
  document.getElementById('resched-confirm').dataset.notifId = notifId || '';
  document.getElementById('resched-confirm').textContent = role === 'therapist' ? 'Zaproponuj inny termin' : 'Zaproponuj inny termin';
  document.getElementById('resched-confirm').disabled = true;
  document.getElementById('reschedule-modal').querySelector('h3').textContent = 'Zaproponuj inny termin';
  document.getElementById('resched-date').onchange = () => loadReschedSlots(aptId);
  openModal('reschedule-modal');
}

async function loadReschedSlots(aptId) {
  const date = document.getElementById('resched-date').value;
  if (!date) return;
  const dayStart = date + 'T00:00:00';
  const dayEnd = date + 'T23:59:59';
  const { data: taken } = await sb.from('appointments')
    .select('appointment_date')
    .gte('appointment_date', dayStart)
    .lte('appointment_date', dayEnd)
    .neq('status', 'cancelled');
  const takenHours = (taken || []).map(t => {
    const d = new Date(t.appointment_date);
    return String(d.getHours()).padStart(2, '0') + ':00';
  });
  const grid = document.getElementById('resched-slots');
  grid.innerHTML = '';
  for (let h = 7; h <= 21; h++) {
    const t = String(h).padStart(2, '0') + ':00';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'slot-btn' + (takenHours.includes(t) ? ' taken' : '');
    btn.textContent = t;
    btn.disabled = takenHours.includes(t);
    btn.onclick = () => {
      grid.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('resched-confirm').disabled = false;
      document.getElementById('resched-confirm').dataset.time = t;
    };
    grid.appendChild(btn);
  }
}

// Reschedule confirm handler – supports 4 modes:
//   'patient'           – patient initial request
//   'therapist'         – therapist direct reschedule (no negotiation)
//   'patient_counter'   – patient counter-proposes after therapist's proposal
//   'therapist_counter' – therapist counter-proposes after patient's request
document.getElementById('resched-confirm')?.addEventListener('click', async function() {
  const aptId = this.dataset.aptId;
  const mode = this.dataset.mode || 'therapist';
  const notifId = this.dataset.notifId || '';
  const date = document.getElementById('resched-date').value;
  const time = this.dataset.time;
  if (!date || !time) return;
  const proposedDateStr = date + ' ' + time;
  const newAppointmentDate = date + 'T' + time + ':00';

  // Fetch current appointment data
  const { data: curApt } = await sb.from('appointments')
    .select('id, title, patient_email, patient_name, appointment_date')
    .eq('id', aptId).single();
  if (!curApt) { showToast('Wizyta nie istnieje', 'error'); return; }
  const baseTitle = stripRescheduleRequest(curApt.title || '');

  // Format original appointment date for display
  const origDate = curApt.appointment_date ? new Date(curApt.appointment_date) : null;
  const origDateStr = origDate ? origDate.toLocaleDateString('pl-PL', {day:'2-digit',month:'2-digit',year:'numeric'}) + ' ' + origDate.toLocaleTimeString('pl-PL', {hour:'2-digit',minute:'2-digit'}) : '—';

  if (mode === 'patient' || mode === 'patient_counter') {
    // Patient requests or counter-proposes a new date
    const newTitle = baseTitle + ' [Prośba o przełożenie na ' + proposedDateStr + ']';
    await sb.from('appointments').update({
      status: 'reschedule_requested',
      title: newTitle
    }).eq('id', aptId);

    // Notify therapist
    await sb.from('notifications').insert({
      patient_email: THERAPIST_EMAILS[0],
      message: 'Pacjent ' + (curApt.patient_name || '') + ' prosi o przełożenie wizyty z {{black:' + origDateStr + '}} na {{green:' + proposedDateStr + '}}',
      type: 'reschedule_therapist:' + aptId,
      is_read: false
    });

    // Mark old notification as read (if counter-proposal)
    if (notifId) await sb.from('notifications').update({ is_read: true }).eq('id', notifId);

    calendar.refetchEvents();
    loadNotifications();
    closeModalAll();
    showToast('Prośba o przełożenie wysłana na ' + proposedDateStr);

  } else if (mode === 'therapist_counter') {
    // Therapist counter-proposes a different date
    const newTitle = baseTitle + ' [Propozycja logopedy: ' + proposedDateStr + ']';
    await sb.from('appointments').update({
      status: 'reschedule_proposed',
      title: newTitle
    }).eq('id', aptId);

    // Notify patient
    await sb.from('notifications').insert({
      patient_email: curApt.patient_email,
      message: 'Logopeda proponuje nowy termin wizyty z {{black:' + origDateStr + '}} na {{green:' + proposedDateStr + '}}',
      type: 'reschedule_patient:' + aptId,
      is_read: false
    });

    // Mark old notification as read
    if (notifId) await sb.from('notifications').update({ is_read: true }).eq('id', notifId);

    calendar.refetchEvents();
    loadNotifications();
    closeModalAll();
    showToast('Propozycja wysłana: ' + proposedDateStr);

  } else {
    // mode === 'therapist' – direct reschedule (no negotiation)
    await sb.from('appointments').update({
      appointment_date: newAppointmentDate,
      status: 'confirmed',
      title: baseTitle
    }).eq('id', aptId);

    // Notify patient about the direct reschedule
    await sb.from('notifications').insert({
      patient_email: curApt.patient_email,
      message: 'Logopeda przełożył Twoją wizytę na ' + proposedDateStr,
      type: 'info',
      is_read: false
    });

    calendar.refetchEvents();
    loadNotifications();
    closeModalAll();
    showToast('Wizyta przełożona na ' + proposedDateStr);
  }
});

// --- Accept reschedule proposal -------------------------------------------
async function acceptReschedule(aptId, notifId) {
  const { data: apt } = await sb.from('appointments')
    .select('id, title, patient_email, patient_name, appointment_date')
    .eq('id', aptId).single();
  if (!apt) { showToast('Wizyta nie istnieje', 'error'); return; }

  const info = extractRescheduleInfo(apt);
  if (!info) { showToast('Brak propozycji przełożenia', 'error'); return; }

  const proposedDateStr = info.proposedDate; // e.g. "2026-08-25 10:00"
  const newAppointmentDate = proposedDateStr.replace(' ', 'T') + ':00';
  const cleanTitle = stripRescheduleRequest(apt.title);

  // Update appointment to accepted date
  const { error } = await sb.from('appointments').update({
    appointment_date: newAppointmentDate,
    status: 'confirmed',
    title: cleanTitle
  }).eq('id', aptId);
  if (error) { showToast('Błąd: ' + error.message, 'error'); return; }

  // Notify the other party about acceptance
  if (info.role === 'patient') {
    // Patient proposed, therapist accepted → notify patient
    await sb.from('notifications').insert({
      patient_email: apt.patient_email,
      message: 'Logopeda zaakceptował Twój proponowany termin: ' + proposedDateStr + '. Wizyta potwierdzona!',
      type: 'accepted_patient',
      is_read: false
    });
  } else {
    // Therapist proposed, patient accepted → notify therapist
    await sb.from('notifications').insert({
      patient_email: THERAPIST_EMAILS[0],
      message: 'Pacjent ' + (apt.patient_name || '') + ' zaakceptował proponowany termin: ' + proposedDateStr,
      type: 'accepted_therapist',
      is_read: false
    });
  }

  // Mark any reschedule notifications for this apt as read
  const { data: notifs } = await sb.from('notifications')
    .select('id')
    .like('type', 'reschedule_%:' + aptId);
  if (notifs && notifs.length > 0) {
    await sb.from('notifications').update({ is_read: true }).in('id', notifs.map(n => n.id));
  }
  if (notifId) {
    await sb.from('notifications').update({ is_read: true }).eq('id', notifId);
  }

  calendar.refetchEvents();
  loadNotifications();
  closeModalAll();
  showToast('Termin potwierdzony: ' + proposedDateStr);
}

// --- 24h Auto-cancellation ------------------------------------------------
// If an appointment is in reschedule_requested or reschedule_proposed status
// and the ORIGINAL appointment date is within 24 hours of now, auto-cancel it.
async function checkAutoCancellation() {
  const now = new Date();
  const cutoff = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24h from now

  const { data: apts } = await sb.from('appointments')
    .select('id, title, patient_email, patient_name, appointment_date, status')
    .in('status', ['reschedule_requested', 'reschedule_proposed']);

  if (!apts || apts.length === 0) return;

  for (const apt of apts) {
    const origDate = new Date(apt.appointment_date);
    if (origDate <= cutoff) {
      // Auto-cancel this appointment
      const cleanTitle = stripRescheduleRequest(apt.title);
      await sb.from('appointments').update({
        status: 'cancelled',
        title: cleanTitle
      }).eq('id', apt.id);

      // Notify patient
      await sb.from('notifications').insert({
        patient_email: apt.patient_email,
        message: 'Wizyta została automatycznie anulowana – nie ustalono nowego terminu w ciągu 24h przed planowaną wizytą.',
        type: 'cancel',
        is_read: false
      });

      // Notify therapist
      await sb.from('notifications').insert({
        patient_email: THERAPIST_EMAILS[0],
        message: 'Wizyta pacjenta ' + (apt.patient_name || '') + ' została automatycznie anulowana – brak ustalonego terminu (24h przed wizytą).',
        type: 'cancel',
        is_read: false
      });

      // Mark any reschedule notifications as read
      const { data: notifs } = await sb.from('notifications')
        .select('id')
        .like('type', 'reschedule_%:' + apt.id);
      if (notifs && notifs.length > 0) {
        await sb.from('notifications').update({ is_read: true }).in('id', notifs.map(n => n.id));
      }
    }
  }
}

// --- Reschedule request helpers (encode in title) --------------------------
// Patterns in title field:
//   " [Prośba o przełożenie na 2026-08-25 10:00]"   — patient proposed date
//   " [Propozycja logopedy: 2026-08-26 11:00]"      — therapist proposed date
const RESCHED_REGEX = / \[(Prośba o przełożenie na|Propozycja logopedy:) .+\]$/;

function stripRescheduleRequest(title) {
  return (title || '').replace(RESCHED_REGEX, '').trim();
}

function extractRescheduleInfo(apt) {
  const m = (apt.title || '').match(RESCHED_REGEX);
  if (!m) return null;
  const text = m[0];
  if (text.includes('Prośba o przełożenie na')) {
    const dateStr = text.replace(' [Prośba o przełożenie na ', '').replace(']', '');
    return { role: 'patient', proposedDate: dateStr };
  } else if (text.includes('Propozycja logopedy:')) {
    const dateStr = text.replace(' [Propozycja logopedy: ', '').replace(']', '');
    return { role: 'therapist', proposedDate: dateStr };
  }
  return null;
}

// Backward-compatible alias
function extractRescheduleRequest(apt) {
  const info = extractRescheduleInfo(apt);
  return info ? info.proposedDate : null;
}

// --- Patient Combobox -------------------------------------------------------
async function loadPatients() {
  const { data } = await sb.from('profiles').select('*').eq('role', 'patient').order('last_name');
  allPatients = (data || []).filter(p => p.id !== currentUser.id && p.email !== currentUser.email);
  renderAccountList('');
}

function renderAccountList(query) {
  const container = document.getElementById('account-list');
  if (!container) return;
  let list = allPatients;
  if (query && query.length >= 1) {
    const q = query.toLowerCase();
    list = allPatients.filter(p =>
      (p.first_name || '').toLowerCase().includes(q) ||
      (p.last_name || '').toLowerCase().includes(q) ||
      (p.email || '').toLowerCase().includes(q)
    );
  }
  if (list.length === 0) {
    container.innerHTML = '<div class="account-list-empty">Brak wyników</div>';
    return;
  }
  container.innerHTML = list.map(p =>
    `<div class="account-list-item" data-id="${p.id}">
      <div class="account-list-info"><span class="account-list-name">${p.last_name || ''} ${p.first_name || ''}</span><span class="account-list-email">${p.email || ''}</span></div>
      <span class="account-list-arrow">›</span>
    </div>`
  ).join('');
  container.querySelectorAll('.account-list-item').forEach(el => {
    el.addEventListener('click', () => {
      const patient = allPatients.find(p => p.id === el.dataset.id);
      if (patient) selectAccountPatient(patient);
    });
  });
}

function filterCombobox(query, dropdownId, onSelect) {
  const dd = document.getElementById(dropdownId);
  if (!query || query.length < 1) { dd.classList.add('hidden'); return; }
  const q = query.toLowerCase();
  const matches = allPatients.filter(p =>
    (p.first_name || '').toLowerCase().includes(q) ||
    (p.last_name || '').toLowerCase().includes(q) ||
    (p.email || '').toLowerCase().includes(q)
  );
  if (matches.length === 0) { dd.classList.add('hidden'); return; }
  dd.innerHTML = matches.map(p =>
    `<div class="combobox-item" data-id="${p.id}">${p.first_name || ''} ${p.last_name || ''} (${p.email || ''})</div>`
  ).join('');
  dd.classList.remove('hidden');
  dd.querySelectorAll('.combobox-item').forEach(el => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      const patient = allPatients.find(p => p.id === el.dataset.id);
      onSelect(patient);
    });
  });
}

// Close dropdowns on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('.combobox-wrapper')) {
    document.querySelectorAll('.combobox-dropdown').forEach(d => d.classList.add('hidden'));
  }
});

function selectAptPatient(patient) {
  selectedAptPatient = patient;
  document.getElementById('apt-patient-search').value = `${patient.first_name || ''} ${patient.last_name || ''}`;
  document.getElementById('apt-patient-dropdown').classList.add('hidden');
  document.getElementById('apt-patient-data').classList.remove('hidden');
  document.getElementById('apt-email').value = patient.email || '';
  document.getElementById('apt-phone').value = patient.phone || '';
  document.getElementById('apt-name').value = `${patient.first_name || ''} ${patient.last_name || ''}`;
  document.getElementById('apt-dob').value = patient.dob || '';
  const age = calcAge(patient.dob);
  document.getElementById('apt-age-display').textContent = age !== null ? `Wiek: ${age} lat` : '';
}

function selectAccountPatient(patient) {
  selectedAccountPatient = patient;
  document.getElementById('account-search').value = `${patient.first_name || ''} ${patient.last_name || ''}`;
  document.getElementById('account-detail').classList.remove('hidden');
  document.getElementById('account-detail-title').textContent = `${patient.first_name || ''} ${patient.last_name || ''}`;
  document.getElementById('acc-email').value = patient.email || '';
  document.getElementById('acc-phone').value = patient.phone || '';
  document.getElementById('acc-first').value = patient.first_name || '';
  document.getElementById('acc-last').value = patient.last_name || '';
  document.getElementById('acc-dob').value = patient.dob || '';
  calcAgeField('acc-dob', 'acc-age');
  document.getElementById('acc-public-notes').value = patient.public_notes || '';
  document.getElementById('acc-private-notes').value = patient.private_notes || '';
}

// --- New Appointment Modal --------------------------------------------------
function openNewAptModal(dateStr) {
  selectedAptPatient = null;
  document.getElementById('apt-patient-search').value = '';
  document.getElementById('apt-patient-dropdown').classList.add('hidden');
  document.getElementById('apt-patient-data').classList.add('hidden');
  document.getElementById('apt-title').value = 'Wizyta logopedyczna';
  document.getElementById('apt-date').value = dateStr || '';
  document.getElementById('apt-time').value = '09:00';
  document.getElementById('apt-recurring').checked = false;
  document.getElementById('recurring-options').classList.add('hidden');
  document.getElementById('apt-recurring-type').value = 'weekly';
  openModal('new-appointment-modal');
}

function initAptTimeSelect() {
  const sel = document.getElementById('apt-time');
  for (let h = 7; h <= 21; h++) {
    const val = String(h).padStart(2, '0') + ':00';
    const opt = document.createElement('option');
    opt.value = val;
    opt.textContent = val;
    sel.appendChild(opt);
  }
}

function initRecurringMonths(containerId) {
  const grid = document.getElementById(containerId);
  grid.innerHTML = MONTH_LABELS.map((m, i) =>
    `<button type="button" class="month-btn" data-month="${i+1}">${m.slice(0,3)}</button>`
  ).join('');
  grid.querySelectorAll('.month-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'));
  });
}

function getSelectedMonths(containerId) {
  return [...document.getElementById(containerId).querySelectorAll('.month-btn.selected')].map(b => parseInt(b.dataset.month));
}

async function createAppointment(e) {
  e.preventDefault();
  if (!selectedAptPatient) { showToast('Wybierz pacjenta z listy', 'error'); return; }
  const date = document.getElementById('apt-date').value;
  const time = document.getElementById('apt-time').value;
  const title = document.getElementById('apt-title').value;
  const recurring = document.getElementById('apt-recurring').checked;
  const recurringType = recurring ? document.getElementById('apt-recurring-type').value : null;
  const months = recurring ? getSelectedMonths('recurring-months') : [];

  if (!date || !time) { showToast('Podaj datę i godzinę', 'error'); return; }

  const appointmentDate = date + 'T' + time + ':00';

  const aptData = {
    patient_email: selectedAptPatient.email,
    patient_name: `${selectedAptPatient.first_name || ''} ${selectedAptPatient.last_name || ''}`.trim(),
    patient_phone: selectedAptPatient.phone || '',
    patient_dob: selectedAptPatient.dob || null,
    appointment_date: appointmentDate,
    title,
    status: 'confirmed',
    recurring_type: recurringType || 'weekly'
  };
  const { data: mainApt, error } = await sb.from('appointments').insert(aptData).select().single();
  if (error) { showToast('Błąd: ' + error.message, 'error'); return; }

  // If recurring, generate series
  if (recurring && months.length > 0) {
    const d = new Date(appointmentDate);
    const gen = [];
    for (let m of months) {
      const mDate = new Date(d.getFullYear(), m - 1, d.getDate(), d.getHours());
      let cur = new Date(mDate);
      const end = new Date(mDate.getFullYear(), mDate.getMonth() + 1, 0);
      while (cur <= end) {
        if (cur >= d && cur.toISOString() !== d.toISOString()) {
          gen.push({
            patient_email: selectedAptPatient.email,
            patient_name: `${selectedAptPatient.first_name || ''} ${selectedAptPatient.last_name || ''}`.trim(),
            patient_phone: selectedAptPatient.phone || '',
            patient_dob: selectedAptPatient.dob || null,
            appointment_date: cur.toISOString(),
            title,
            status: 'pending',
            recurring_type: recurringType || 'weekly',
            recurring_parent: mainApt.id
          });
        }
        if (recurringType === 'weekly') cur.setDate(cur.getDate() + 7);
        else if (recurringType === 'biweekly') cur.setDate(cur.getDate() + 14);
        else cur.setMonth(cur.getMonth() + 1);
      }
    }
    if (gen.length > 0) await sb.from('appointments').insert(gen);
  }

  calendar.refetchEvents();
  closeModalAll();
  showToast('Wizyta utworzona');
}

// --- Exercises --------------------------------------------------------------
let allExercises = [];
let exerciseFavIds = [];

function filterExercises(filter, btn) {
  document.querySelectorAll('#exercise-sub-tabs .sub-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const list = document.getElementById('exercises-list');
  if (filter === 'favorites') {
    const favCards = allExercises.filter(e => exerciseFavIds.includes(e.id));
    if (favCards.length === 0) {
      list.innerHTML = '<p class="empty-msg">Brak ulubionych ćwiczeń</p>';
    } else {
      renderExerciseCards(favCards);
    }
  } else {
    renderExerciseCards(allExercises);
  }
}

function renderExerciseCards(exercises) {
  const list = document.getElementById('exercises-list');
  list.innerHTML = exercises.map(ex => `
    <div class="card exercise-card" data-id="${ex.id}">
      <div class="card-header"><h3><img src="icon.png" class="inline-icon" alt=""> ${esc(ex.title)}</h3></div>
      <p class="card-desc">${esc(ex.description || '')}</p>
      ${ex.link ? `<a href="${esc(ex.link)}" target="_blank" class="exercise-link"><img src="icon.png" class="inline-icon" alt=""> Pobierz materiały</a>` : '<span class="exercise-no-link">Ćwiczenie bez materiałów</span>'}
      <div class="card-months">${(ex.months||[]).map(m => MONTH_LABELS[m-1]).join(', ')}</div>
      <div class="card-actions">
        <button class="btn btn-outline btn-sm" onclick="toggleFavorite('${ex.id}', ${exerciseFavIds.includes(ex.id)})">
          <img src="icon.png" class="inline-icon" alt=""> ${exerciseFavIds.includes(ex.id) ? 'Ulubione' : 'Dodaj do ulubionych'}
        </button>
        ${isTherapist ? `<button class="btn btn-danger btn-sm" onclick="deleteExercise('${ex.id}')">Usuń</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function loadExercises() {
  const { data } = await sb.from('exercises').select('*').order('title');
  allExercises = data || [];
  const list = document.getElementById('exercises-list');
  if (!data || data.length === 0) {
    list.innerHTML = '<p class="empty-msg">Brak ćwiczeń</p>';
    return;
  }

  const { data: favs } = await sb.from('favorite_exercises').select('exercise_id').eq('user_id', currentUser.id);
  exerciseFavIds = (favs || []).map(f => f.exercise_id);

  const activeFilter = document.querySelector('#exercise-sub-tabs .sub-tab.active');
  if (activeFilter && activeFilter.dataset.filter === 'favorites') {
    const favCards = allExercises.filter(e => exerciseFavIds.includes(e.id));
    if (favCards.length === 0) {
      list.innerHTML = '<p class="empty-msg">Brak ulubionych ćwiczeń</p>';
    } else {
      renderExerciseCards(favCards);
    }
  } else {
    renderExerciseCards(allExercises);
  }

  const sidebar = document.getElementById('favorite-exercises-sidebar');
  const favList = document.getElementById('favorites-list');
  if (exerciseFavIds.length === 0) {
    sidebar.classList.add('hidden');
  } else {
    sidebar.classList.remove('hidden');
    favList.innerHTML = allExercises.filter(e => exerciseFavIds.includes(e.id)).map(e =>
      `<div class="fav-item"><img src="icon.png" class="inline-icon" alt=""> ${esc(e.title)}</div>`
    ).join('');
  }
}

async function toggleFavorite(exId, current) {
  if (current) {
    await sb.from('favorite_exercises').delete().eq('exercise_id', exId).eq('user_id', currentUser.id);
  } else {
    await sb.from('favorite_exercises').insert({ exercise_id: exId, user_id: currentUser.id });
  }
  loadExercises();
}

async function deleteExercise(id) {
  if (!confirm('Usunąć ćwiczenie?')) return;
  await sb.from('exercises').delete().eq('id', id);
  loadExercises();
  showToast('Ćwiczenie usunięte');
}

async function saveExercise(e) {
  e.preventDefault();
  const title = document.getElementById('ex-title').value;
  const desc = document.getElementById('ex-desc').value;
  const link = document.getElementById('ex-link').value;
  await sb.from('exercises').insert({ title, description: desc, link });
  closeModalAll();
  loadExercises();
  showToast('Ćwiczenie dodane');
}

// --- Konta Tab (therapist only) ---------------------------------------------
function openNewProfileInAccounts() {
  selectedAccountPatient = null;
  document.getElementById('account-search').value = '';
  renderAccountList('');
  document.getElementById('account-detail').classList.remove('hidden');
  document.getElementById('account-detail-title').textContent = 'Nowy profil pacjenta';
  document.getElementById('acc-email').value = '';
  document.getElementById('acc-phone').value = '';
  document.getElementById('acc-first').value = '';
  document.getElementById('acc-last').value = '';
  document.getElementById('acc-dob').value = '';
  document.getElementById('acc-age').value = '';
  document.getElementById('acc-public-notes').value = '';
  document.getElementById('acc-private-notes').value = '';
  document.getElementById('acc-email').removeAttribute('readonly');
}

async function saveAccountPatient(e) {
  e.preventDefault();
  if (!selectedAccountPatient) {
    const email = document.getElementById('acc-email').value;
    const phone = document.getElementById('acc-phone').value;
    const first = document.getElementById('acc-first').value;
    const last = document.getElementById('acc-last').value;
    const dob = document.getElementById('acc-dob').value;
    const notes = document.getElementById('acc-public-notes').value;
    const privNotes = document.getElementById('acc-private-notes').value;
    if (!email) { showToast('Podaj e-mail pacjenta', 'error'); return; }
    const { data: existing } = await sb.from('profiles').select('*').eq('email', email).single();
    if (existing) {
      selectedAccountPatient = existing;
      await sb.from('profiles').update({
        phone, first_name: first, last_name: last, dob, public_notes: notes, private_notes: privNotes
      }).eq('id', existing.id);
    } else {
      await sb.from('profiles').upsert({
        email, phone, first_name: first, last_name: last, dob, public_notes: notes, private_notes: privNotes, role: 'patient'
      }, { onConflict: 'email' });
    }
    showToast('Profil pacjenta zapisany');
    loadPatients();
    return;
  }
  const phone = document.getElementById('acc-phone').value;
  const first = document.getElementById('acc-first').value;
  const last = document.getElementById('acc-last').value;
  const dob = document.getElementById('acc-dob').value;
  const notes = document.getElementById('acc-public-notes').value;
  const privNotes = document.getElementById('acc-private-notes').value;
  await sb.from('profiles').update({
    phone, first_name: first, last_name: last, dob, public_notes: notes, private_notes: privNotes
  }).eq('id', selectedAccountPatient.id);
  showToast('Dane pacjenta zaktualizowane');
  loadPatients();
}


// --- Profile (continued) ---------------------------------------------------
function loadProfile() {
  if (!currentProfile) return;
  document.getElementById('prof-email').value = currentProfile.email || '';
  document.getElementById('prof-phone').value = currentProfile.phone || '';
  document.getElementById('prof-first').value = currentProfile.first_name || '';
  document.getElementById('prof-last').value = currentProfile.last_name || '';
  document.getElementById('prof-dob').value = currentProfile.dob || '';
  calcAgeField('prof-dob', 'prof-age');
  document.getElementById('prof-notes').value = currentProfile.public_notes || '';

  if (!isTherapist) {
    document.getElementById('prof-notes').setAttribute('readonly', true);
  }

  if (!isTherapist) {
    if (currentProfile.profile_locked) {
      document.getElementById('profile-locked-msg').classList.remove('hidden');
      document.getElementById('prof-phone').disabled = true;
      document.getElementById('prof-first').disabled = true;
      document.getElementById('prof-last').disabled = true;
      document.getElementById('prof-dob').disabled = true;
      document.getElementById('prof-save-btn').classList.add('hidden');
    } else {
      document.getElementById('profile-locked-msg').classList.add('hidden');
    }
  }
}

async function saveProfile(e) {
  e.preventDefault();
  if (!currentProfile) {
    const role = THERAPIST_EMAILS.includes(currentUser.email) ? 'therapist' : 'patient';
    const { data: newProfile } = await sb.from('profiles').upsert({
      id: currentUser.id,
      email: currentUser.email,
      role: role
    }, { onConflict: 'id' }).select().single();
    currentProfile = newProfile;
  }
  if (!isTherapist && currentProfile.profile_locked) {
    showToast('Profil zablokowany – tylko terapeuta może zmienić dane', 'error');
    return;
  }
  const phone = document.getElementById('prof-phone').value;
  const first = document.getElementById('prof-first').value;
  const last = document.getElementById('prof-last').value;
  const dob = document.getElementById('prof-dob').value;
  const notes = document.getElementById('prof-notes').value;

  const updates = { phone, first_name: first, last_name: last, dob, public_notes: notes };

  if (!isTherapist && !currentProfile.profile_locked) {
    updates.profile_locked = true;
  }

  const { error } = await sb.from('profiles').update(updates).eq('id', currentUser.id);
  if (error) { showToast('Błąd zapisu: ' + error.message, 'error'); return; }

  const { data } = await sb.from('profiles').select('*').eq('id', currentUser.id).single();
  currentProfile = data;
  loadProfile();

  if (!isTherapist && updates.profile_locked) {
    openModal('profile-save-popup');
  } else {
    showToast('Profil zapisany');
  }
}

// --- Age calculation --------------------------------------------------------
function calcAge(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

function calcAgeField(dobId, ageId) {
  const dob = document.getElementById(dobId).value;
  const age = calcAge(dob);
  document.getElementById(ageId).value = age !== null ? age + ' lat' : '';
}

// --- Notifications ----------------------------------------------------------
// Notification types used by reschedule flow:
//   type = 'reschedule_therapist:APT_ID'  → shown to therapist (patient requested)
//   type = 'reschedule_patient:APT_ID'    → shown to patient (therapist proposed)
//   type = 'accepted_therapist'            → therapist notified: patient accepted
//   type = 'accepted_patient'             → patient notified: therapist accepted
//   type = 'broadcast'                    → therapist broadcast to all patients
//   type = 'info'                         → general info
// The appointment ID is embedded in the type field after the colon.
let allNotifications = [];
let notifFilter = 'unread'; // 'unread' | 'read' | 'all'

async function loadNotifications() {
  let q = sb.from('notifications').select('*').order('created_at', { ascending: false });
  if (!isTherapist) {
    q = q.eq('patient_email', currentUser.email);
  } else {
    // Therapist sees only notifications addressed to them (patient_email = therapist email)
    q = q.in('patient_email', THERAPIST_EMAILS);
  }
  const { data } = await q;
  allNotifications = data || [];
  updateNotifBadge();
  renderNotifications();
}

function updateNotifBadge() {
  const unread = allNotifications.filter(n => !n.is_read).length;
  const badge = document.getElementById('notif-badge');
  if (badge) {
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : unread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }
  }
}

function renderNotifications() {
  const list = document.getElementById('notifications-list');
  if (allNotifications.length === 0) {
    list.innerHTML = '<p class="empty-msg">Brak powiadomień</p>';
    return;
  }

  let filtered = allNotifications;
  if (notifFilter === 'unread') filtered = allNotifications.filter(n => !n.is_read);
  else if (notifFilter === 'read') filtered = allNotifications.filter(n => n.is_read);

  if (filtered.length === 0) {
    const msg = notifFilter === 'unread' ? 'Brak nieprzeczytanych powiadomień' : 'Brak przeczytanych powiadomień';
    list.innerHTML = `<p class="empty-msg">${msg}</p>`;
    return;
  }

  list.innerHTML = filtered.map(n => {
    const parsed = parseNotificationType(n.type);
    const isReschedule = parsed && (parsed.action === 'reschedule_therapist' || parsed.action === 'reschedule_patient');
    const isRelevant = isReschedule && isRescheduleForMe(parsed.action);

    let actionsHtml = '';
    if (isRelevant && !n.is_read) {
      const aptId = parsed.aptId;
      if (parsed.action === 'reschedule_therapist') {
        actionsHtml = `
          <div class="notif-actions" onclick="event.stopPropagation()">
            <button class="btn btn-primary btn-sm" onclick="acceptRescheduleFromNotif('${aptId}', '${n.id}')">Akceptuj termin</button>
            <button class="btn btn-outline btn-sm" onclick="proposeAlternativeDateFromNotif('${aptId}', 'therapist', '${n.id}')">Zaproponuj inny termin</button>
          </div>
        `;
      } else if (parsed.action === 'reschedule_patient') {
        actionsHtml = `
          <div class="notif-actions" onclick="event.stopPropagation()">
            <button class="btn btn-primary btn-sm" onclick="acceptRescheduleFromNotif('${aptId}', '${n.id}')">Akceptuj termin</button>
            <button class="btn btn-outline btn-sm" onclick="proposeAlternativeDateFromNotif('${aptId}', 'patient', '${n.id}')">Zaproponuj inny termin</button>
          </div>
        `;
      }
    }

    const notifIcon = isReschedule ? '🔄'
      : (n.type.startsWith('accepted_') ? '✅'
      : (n.type === 'cancel' ? '❌'
      : (n.type === 'broadcast' ? '📢'
      : (n.type === 'info' ? 'ℹ️' : '🔔'))));
    const unreadDot = n.is_read ? '' : '<span class="unread-dot"></span>';

    return `
      <div class="card notif-card ${n.is_read ? 'read' : ''}" data-id="${n.id}" onclick="markNotifRead('${n.id}')">
        <div class="card-header"><h3>${unreadDot}${notifIcon} ${renderNotifMessage(n.message)}</h3></div>
        <span class="card-date">${new Date(n.created_at).toLocaleDateString('pl-PL')} ${new Date(n.created_at).toLocaleTimeString('pl-PL', {hour:'2-digit',minute:'2-digit'})}</span>
        ${actionsHtml}
      </div>
    `;
  }).join('');
}

function parseNotificationType(type) {
  if (!type) return null;
  const parts = type.split(':');
  if (parts.length === 2) {
    return { action: parts[0], aptId: parts[1] };
  }
  return { action: type, aptId: null };
}

function isRescheduleForMe(action) {
  if (isTherapist && action === 'reschedule_therapist') return true;
  if (!isTherapist && action === 'reschedule_patient') return true;
  return false;
}

async function markNotifRead(notifId) {
  const n = allNotifications.find(x => x.id === notifId);
  if (!n || n.is_read) return;
  await sb.from('notifications').update({ is_read: true }).eq('id', notifId);
  n.is_read = true;
  updateNotifBadge();
  renderNotifications();
}

function filterNotifications(filter, btn) {
  notifFilter = filter;
  document.querySelectorAll('#notif-sub-tabs .sub-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderNotifications();
}

async function sendBroadcast() {
  const msg = document.getElementById('broadcast-msg').value.trim();
  if (!msg) { showToast('Wpisz treść wiadomości', 'error'); return; }

  const { data: patients } = await sb.from('profiles').select('email').eq('role', 'patient');
  if (!patients || patients.length === 0) { showToast('Brak pacjentów', 'error'); return; }

  const inserts = patients.map(p => ({
    patient_email: p.email,
    message: msg,
    type: 'broadcast',
    is_read: false
  }));

  const { error } = await sb.from('notifications').insert(inserts);
  if (error) { showToast('Błąd: ' + error.message, 'error'); return; }

  document.getElementById('broadcast-msg').value = '';
  closeModalAll();
  showToast('Wiadomość wysłana do ' + patients.length + ' pacjentów');
  loadNotifications();
}

// Accept reschedule from notification card
async function acceptRescheduleFromNotif(aptId, notifId) {
  await acceptReschedule(aptId, notifId);
}

// Propose alternative date from notification card
function proposeAlternativeDateFromNotif(aptId, role, notifId) {
  proposeAlternativeDate(aptId, role === 'therapist' ? 'therapist' : 'patient', notifId);
}

async function markAllRead() {
  let q = sb.from('notifications').update({ is_read: true });
  if (!isTherapist) q = q.eq('patient_email', currentUser.email);
  await q;
  allNotifications.forEach(n => n.is_read = true);
  updateNotifBadge();
  renderNotifications();
}

// --- Modal helpers ----------------------------------------------------------
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}

function closeModalAll() {
  document.querySelectorAll('.modal').forEach(m => m.classList.add('hidden'));
  document.body.style.overflow = '';
}

// --- Toast ------------------------------------------------------------------
function showToast(msg, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3500);
}

// --- Logout ------------------------------------------------------------------
async function logout() {
  await sb.auth.signOut();
  localStorage.removeItem('sb-session');
  location.href = 'login.html';
}

// --- Render notification message with safe color markers --------------------
// Message may contain {{black:text}} and {{green:text}} markers.
// We escape all HTML first, then convert markers to styled spans.
function renderNotifMessage(msg) {
  // Escape the whole string first to neutralize any raw HTML
  let safe = esc(msg);
  // Now convert markers (they survived escaping as plain text)
  safe = safe.replace(/\{\{black:(.*?)\}\}/g, '<span style="color:#1e293b;font-weight:600">$1</span>');
  safe = safe.replace(/\{\{green:(.*?)\}\}/g, '<span style="color:#22c55e;font-weight:600">$1</span>');
  return safe;
}

// --- Escape HTML ------------------------------------------------------------
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}