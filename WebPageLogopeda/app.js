/* Gabinet Neurologopedyczny – app.js
   Fixed: Europe/Warsaw date handling, appointment conflicts, recurring visits,
   reschedule negotiation/concurrency, 24h cancellation, notification scoping,
   and Supabase error handling.
*/
const SUPABASE_URL='https://dclbsucsccsegvpmmgdn.supabase.co';
const SUPABASE_ANON='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjbGJzdWNzY2NzZWd2cG1tZ2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTA1NjksImV4cCI6MjEwMjY2NjU2OX0.HEVj0gPxioLmCR8SZYgt8qi-Nw47UMYrSgKLUrBZedQ';
const sb=window.supabase.createClient(SUPABASE_URL,SUPABASE_ANON);
let currentUser=null,isTherapist=false,currentProfile=null,calendar=null,allPatients=[],selectedAptPatient=null,selectedAccountPatient=null;
const THERAPIST_EMAILS=['kontakt@logopedaostroda.pl','ziomekzpolski@yahoo.com'];
const MONTH_LABELS=['Styczeń','Luty','Marzec','Kwiecień','Maj','Czerwiec','Lipiec','Sierpień','Wrzesień','Październik','Listopad','Grudzień'];
const TZ='Europe/Warsaw';

/* ------------------------- Date/time helpers ----------------------------- */
function tzParts(date,tz=TZ){
  const p=new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
  const o={};p.forEach(x=>o[x.type]=x.value);return o;
}
function tzOffsetMs(date,tz=TZ){const p=tzParts(date,tz);return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-date.getTime();}
function polandDateTimeToISO(date,time){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!/^\d{2}:\d{2}$/.test(time)) throw new Error('Nieprawidłowa data lub godzina');
  const [y,m,d]=date.split('-').map(Number),[h,min]=time.split(':').map(Number);
  if(h>23||min>59) throw new Error('Nieprawidłowa godzina');
  const wall=Date.UTC(y,m-1,d,h,min,0);
  let utc=wall-tzOffsetMs(new Date(wall),TZ);
  utc=wall-tzOffsetMs(new Date(utc),TZ);
  return new Date(utc).toISOString();
}
function isoToPolandDateTime(iso){const p=tzParts(new Date(iso));return {date:`${p.year}-${p.month}-${p.day}`,time:`${p.hour}:${p.minute}`};}
function displayPoland(iso){const d=new Date(iso);return {date:d.toLocaleDateString('pl-PL',{timeZone:TZ}),time:d.toLocaleTimeString('pl-PL',{timeZone:TZ,hour:'2-digit',minute:'2-digit'})};}
function slotISO(date,time){return polandDateTimeToISO(date,time);}
function hourSlots(){const a=[];for(let h=7;h<21;h++)a.push(`${String(h).padStart(2,'0')}:00`);return a;}

/* ----------------------------- Init -------------------------------------- */
document.addEventListener('DOMContentLoaded',async()=>{
  try{
    const session=JSON.parse(localStorage.getItem('sb-session')||'null');
    if(!session?.access_token){location.href='login.html';return;}
    const {data:{user},error}=await sb.auth.getUser(session.access_token);
    if(error||!user){localStorage.removeItem('sb-session');location.href='login.html';return;}
    currentUser=user;
    const greet=document.getElementById('nav-greeting');if(greet)greet.textContent=`Cześć ${user.email}!`;
    let {data:profile,error:profileError}=await sb.from('profiles').select('*').eq('id',user.id).maybeSingle();
    if(profileError)console.error('Profile load:',profileError.message);
    if(!profile){
      const role=THERAPIST_EMAILS.includes(user.email?.toLowerCase())?'therapist':'patient';
      const r=await sb.from('profiles').upsert({id:user.id,email:user.email,role},{onConflict:'id'}).select().single();
      if(r.error){showToast('Błąd tworzenia profilu: '+r.error.message,'error');return;}profile=r.data;
    }
    currentProfile=profile;
    isTherapist=THERAPIST_EMAILS.includes((user.email||'').toLowerCase())||profile?.role==='therapist';
    buildNavTabs();initCalendar();await Promise.all([loadExercises(),loadNotifications(),loadProfile()]);
    if(isTherapist)await loadPatients();
    initAptTimeSelect();initRecurringMonths('recurring-months');
    await checkAutoCancellation();
    setInterval(checkAutoCancellation,5*60*1000);
    try{sb.channel('notif-changes').onPostgresChanges({event:'*',schema:'public',table:'notifications'},()=>loadNotifications()).subscribe();}catch(e){console.warn('Realtime unavailable',e);}
    bindEvents();
  }catch(e){console.error(e);showToast('Nie udało się uruchomić aplikacji.','error');}
});
function bindEvents(){
  const on=(id,event,fn)=>{const e=document.getElementById(id);if(e)e.addEventListener(event,fn);};
  const click=(id,fn)=>{const e=document.getElementById(id);if(e)e.onclick=fn;};
  click('logout-btn',logout);click('new-appointment-btn',()=>openNewAptModal());click('add-exercise-btn',()=>openModal('exercise-modal'));click('create-profile-btn',openNewProfileInAccounts);click('mark-all-read',markAllRead);
  on('account-search','input',e=>renderAccountList(e.target.value));
  on('apt-patient-search','input',e=>filterCombobox(e.target.value,'apt-patient-dropdown',selectAptPatient));
  on('apt-patient-search','focus',e=>filterCombobox(e.target.value,'apt-patient-dropdown',selectAptPatient));
  on('apt-recurring','change',e=>document.getElementById('recurring-options')?.classList.toggle('hidden',!e.target.checked));
  on('profile-form','submit',saveProfile);on('prof-dob','change',()=>calcAgeField('prof-dob','prof-age'));
  on('account-edit-form','submit',saveAccountPatient);on('acc-dob','change',()=>calcAgeField('acc-dob','acc-age'));
  on('new-appointment-form','submit',createAppointment);on('exercise-form','submit',saveExercise);
  document.querySelectorAll('.modal-close,.modal-overlay,.modal-close-btn').forEach(e=>e.addEventListener('click',closeModalAll));
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModalAll();});
  document.addEventListener('click',e=>{if(!e.target.closest('.combobox-wrapper'))document.querySelectorAll('.combobox-dropdown').forEach(d=>d.classList.add('hidden'));});
}

/* --------------------------- Navigation ---------------------------------- */
function buildNavTabs(){
  const c=document.getElementById('nav-tabs-container');if(!c)return;c.innerHTML='';
  [{id:'calendar',label:'Kalendarz',emoji:'📅'},{id:'exercises',label:'Ćwiczenia',emoji:'🏋️'},{id:'accounts',label:'Konta',emoji:'👥',therapistOnly:true},{id:'profile',label:'Profil',emoji:'👤',patientOnly:true},{id:'notifications',label:'Powiadomienia',emoji:'🔔'},{id:'contact',label:'Kontakt',emoji:'📞'}].forEach(t=>{
    if(t.therapistOnly&&!isTherapist||t.patientOnly&&isTherapist)return;const b=document.createElement('button');b.className='nav-tab';b.dataset.tab=t.id;b.innerHTML=`${t.emoji} ${t.label}${t.id==='notifications'?'<span class="notif-badge hidden" id="notif-badge">0</span>':''}`;b.onclick=()=>switchTab(t.id);c.appendChild(b);
  });
  if(isTherapist){document.getElementById('new-appointment-btn')?.classList.remove('hidden');document.getElementById('exercise-therapist-controls')?.classList.remove('hidden');}
}
function switchTab(id){document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));document.getElementById('tab-'+id)?.classList.add('active');document.querySelectorAll('.nav-tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===id));if(id==='calendar'&&calendar)calendar.updateSize();if(id==='accounts')renderAccountList(document.getElementById('account-search')?.value||'');document.getElementById('broadcast-btn-container')?.classList.toggle('hidden',!isTherapist);}

/* ----------------------------- Calendar ---------------------------------- */
function initCalendar(){
  const el=document.getElementById('calendar');if(!el)return;
  calendar=new FullCalendar.Calendar(el,{locale:'pl',timeZone:TZ,initialView:'dayGridMonth',headerToolbar:{left:'dayGridMonth,timeGridWeek,timeGridDay',center:'title',right:'prev,today,next'},buttonText:{month:'Miesiąc',week:'Tydzień',day:'Dzień',today:'Dziś'},slotMinTime:'07:00:00',slotMaxTime:'21:00:00',slotDuration:'01:00:00',allDaySlot:false,height:'auto',events:fetchCalendarEvents,eventClick:handleEventClick,dateClick:isTherapist?handleDateClick:undefined});calendar.render();
}
async function fetchCalendarEvents(info,success,fail){
  try{
    await checkAutoCancellation();
    const from=info.startStr.slice(0,10),to=info.endStr.slice(0,10);
    let q=sb.from('appointments').select('id,title,appointment_date,status,recurring_type,recurring_parent,patient_email,patient_name,patient_phone,patient_dob').gte('appointment_date',polandDateTimeToISO(from,'00:00')).lt('appointment_date',polandDateTimeToISO(to,'00:00')).neq('status','cancelled');
    if(!isTherapist)q=q.eq('patient_email',currentUser.email);
    const {data,error}=await q;if(error)throw error;
    success((data||[]).map(a=>({id:a.id,title:a.title,start:a.appointment_date,backgroundColor:eventColor(a.status),extendedProps:a})));
  }catch(e){console.error(e);fail(e);showToast('Nie udało się pobrać kalendarza.','error');}
}
function eventColor(s){return s==='confirmed'?'#22c55e':s==='scheduled'?'#3b82f6':s==='reschedule_requested'?'#f97316':s==='reschedule_proposed'?'#d97706':'#f59e0b';}
function handleEventClick(info){showAptDetail(info.event.extendedProps);}
function handleDateClick(info){openNewAptModal(info.dateStr.slice(0,10));}
function showAptDetail(apt){
  const age=calcAge(apt.patient_dob);const d=displayPoland(apt.appointment_date),r=extractRescheduleInfo(apt);let html=`<div class="detail-row"><strong>Pacjent:</strong> ${esc(apt.patient_name||'')}${age!==null?` (${age} lat)`:''}</div><div class="detail-row"><strong>Data:</strong> ${d.date}</div><div class="detail-row"><strong>Godzina:</strong> ${d.time}</div><div class="detail-row"><strong>Status:</strong> ${statusLabel(apt.status)}</div>${apt.patient_email?`<div class="detail-row"><strong>E-mail:</strong> ${esc(apt.patient_email)}</div>`:''}${apt.patient_phone?`<div class="detail-row"><strong>Telefon:</strong> ${esc(apt.patient_phone)}</div>`:''}${apt.recurring_type&&apt.recurring_type!=='weekly'?`<div class="detail-row"><strong>Cykliczność:</strong> ${recurringLabel(apt.recurring_type)}</div>`:''}`;
  if(r)html+=`<div class="negotiation-info"><strong>🔄 Negocjacja terminu</strong><br>${r.role==='patient'?'Pacjent':'Logopeda'} proponuje: <strong>${esc(r.proposedDate)}</strong><br><span style="font-size:.8rem;color:#92400e">Oczekuje na odpowiedź ${r.role==='patient'?'logopeda':'pacjent'}</span></div>`;
  document.getElementById('modal-body').innerHTML=html;const a=document.getElementById('modal-actions');a.innerHTML='';
  if(apt.status!=='cancelled')a.innerHTML+=`<button class="btn btn-danger btn-sm" onclick="cancelAppointment('${apt.id}')">Odwołaj wizytę</button> `;
  if(apt.status==='reschedule_requested'&&isTherapist)a.innerHTML+=`<button class="btn btn-primary btn-sm" onclick="acceptReschedule('${apt.id}')">Akceptuj proponowany termin</button> <button class="btn btn-outline btn-sm" onclick="proposeAlternativeDate('${apt.id}','therapist')">Zaproponuj inny termin</button> `;
  else if(apt.status==='reschedule_proposed'&&!isTherapist)a.innerHTML+=`<button class="btn btn-primary btn-sm" onclick="acceptReschedule('${apt.id}')">Akceptuj proponowany termin</button> <button class="btn btn-outline btn-sm" onclick="proposeAlternativeDate('${apt.id}','patient')">Zaproponuj inny termin</button> `;
  else if(isTherapist&&apt.status!=='cancelled')a.innerHTML+=`<button class="btn btn-outline btn-sm" onclick="openReschedule('${apt.id}')">Przełóż wizytę</button> `;
  else if(!isTherapist&&apt.status!=='cancelled')a.innerHTML+=`<button class="btn btn-outline btn-sm" onclick="requestReschedule('${apt.id}')">Poproś o przełożenie</button> `;
  a.innerHTML+=`<button class="btn btn-outline btn-sm" onclick="closeModalAll()">Wróć</button>`;document.getElementById('modal-title').textContent=stripRescheduleRequest(apt.title)||'Szczegóły wizyty';openModal('appointment-modal');
}
function statusLabel(s){return{scheduled:'Zaplanowana',pending:'Oczekująca',confirmed:'Potwierdzona',cancelled:'Anulowana',reschedule_requested:'Prośba o przełożenie',reschedule_proposed:'Propozycja logopedy'}[s]||s;}
function recurringLabel(t){return{weekly:'Co tydzień',biweekly:'Co 2 tygodnie',monthly:'Co miesiąc'}[t]||t;}

/* ------------------------ Appointment conflicts -------------------------- */
async function isSlotTaken(date,time,excludeId=null){
  const iso=slotISO(date,time);let q=sb.from('appointments').select('id').eq('appointment_date',iso).neq('status','cancelled').limit(1);if(excludeId)q=q.neq('id',excludeId);const {data,error}=await q;if(error)throw error;return !!data?.length;
}
async function getTakenHours(date,excludeId=null){
  const start=slotISO(date,'00:00'),end=slotISO(date,'23:59');let q=sb.from('appointments').select('id,appointment_date').gte('appointment_date',start).lte('appointment_date',end).neq('status','cancelled');if(excludeId)q=q.neq('id',excludeId);const {data,error}=await q;if(error)throw error;return new Set((data||[]).map(x=>isoToPolandDateTime(x.appointment_date).time));}

async function cancelAppointment(id){
  if(!confirm('Na pewno anulować wizytę?'))return;
  const {data:apt,error:getErr}=await sb.from('appointments').select('patient_email,patient_name,status,title').eq('id',id).maybeSingle();if(getErr||!apt){showToast('Nie znaleziono wizyty.','error');return;}
  if(apt.status==='cancelled'){showToast('Wizyta jest już anulowana.','info');return;}
  const {error}=await sb.from('appointments').update({status:'cancelled',title:stripRescheduleRequest(apt.title)}).eq('id',id).neq('status','cancelled');if(error){showToast('Błąd anulowania: '+error.message,'error');return;}
  const target=isTherapist?apt.patient_email:THERAPIST_EMAILS[0];const msg=isTherapist?'Wizyta została odwołana przez logopedę.':`Pacjent ${apt.patient_name||''} odwołał wizytę.`;const n=await sb.from('notifications').insert({patient_email:target,message:msg,type:'cancel',is_read:false});if(n.error)console.error('Notification:',n.error.message);await markRescheduleNotificationsRead(id);calendar?.refetchEvents();await loadNotifications();closeModalAll();showToast('Wizyta anulowana');
}

/* -------------------------- Rescheduling --------------------------------- */
function resetResched(aptId,mode,notifId='',label='Przełóż wizytę',heading='Przełóż wizytę'){const b=document.getElementById('resched-confirm');document.getElementById('resched-date').value='';document.getElementById('resched-slots').innerHTML='';b.dataset.aptId=aptId;b.dataset.mode=mode;b.dataset.notifId=notifId;b.dataset.time='';b.disabled=true;b.textContent=label;document.getElementById('reschedule-modal').querySelector('h3').textContent=heading;document.getElementById('resched-date').onchange=()=>loadReschedSlots(aptId);openModal('reschedule-modal');}
function openReschedule(id){closeModalAll();resetResched(id,'therapist','','Przełóż wizytę','Przełóż wizytę');}
function requestReschedule(id){closeModalAll();resetResched(id,'patient','','Wyślij prośbę o przełożenie','Poproś o przełożenie wizyty');}
function proposeAlternativeDate(id,role,notifId=''){closeModalAll();resetResched(id,role==='therapist'?'therapist_counter':'patient_counter',notifId,'Zaproponuj inny termin','Zaproponuj inny termin');}
async function loadReschedSlots(aptId){
  const date=document.getElementById('resched-date').value;if(!date)return;const grid=document.getElementById('resched-slots');grid.innerHTML='';const status=document.getElementById('resched-confirm');status.disabled=true;
  try{const taken=await getTakenHours(date,aptId);for(const t of hourSlots()){const busy=taken.has(t),b=document.createElement('button');b.type='button';b.className='slot-btn'+(busy?' taken':'');b.textContent=busy?`${t} — Zajęte`:`${t} — Dostępne`;b.disabled=busy;if(!busy)b.onclick=()=>{grid.querySelectorAll('.slot-btn').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');status.disabled=false;status.dataset.time=t;};grid.appendChild(b);}}catch(e){console.error(e);showToast('Nie udało się sprawdzić dostępności.','error');}
}

document.getElementById('resched-confirm')?.addEventListener('click',async function(){
  const id=this.dataset.aptId,mode=this.dataset.mode,date=document.getElementById('resched-date').value,time=this.dataset.time,notifId=this.dataset.notifId||'';if(!id||!date||!time)return;
  try{
    const {data:apt,error}=await sb.from('appointments').select('id,title,patient_email,patient_name,appointment_date,status').eq('id',id).maybeSingle();if(error||!apt){showToast('Wizyta nie istnieje.','error');return;}
    const expected=mode==='therapist'?'confirmed':mode==='patient'?'confirmed':mode==='therapist_counter'?'reschedule_requested':'reschedule_proposed';
    if(apt.status!==expected){showToast('Ta negocjacja została już zmieniona. Odśwież kalendarz.','error');return;}
    if(await isSlotTaken(date,time,id)){showToast('Ten termin został właśnie zajęty. Wybierz inny.','error');await loadReschedSlots(id);return;}
    const proposed=`${date} ${time}`,base=stripRescheduleRequest(apt.title),orig=displayPoland(apt.appointment_date);let update;
    if(mode==='patient'||mode==='patient_counter')update={status:'reschedule_requested',title:`${base} [Prośba o przełożenie na ${proposed}]`};
    else if(mode==='therapist_counter')update={status:'reschedule_proposed',title:`${base} [Propozycja logopedy: ${proposed}]`};
    else update={appointment_date:polandDateTimeToISO(date,time),status:'confirmed',title:base};
    const q=sb.from('appointments').update(update).eq('id',id).eq('status',expected).select('id');const r=await q;if(r.error||!r.data?.length){showToast('Wizyta została zmieniona przez drugą osobę.','error');return;}
    if(mode==='patient'||mode==='patient_counter')await notify(THERAPIST_EMAILS[0],`Pacjent ${apt.patient_name||''} prosi o przełożenie wizyty z {{black:${orig.date} ${orig.time}}} na {{green:${proposed}}}`,`reschedule_therapist:${id}`);
    else if(mode==='therapist_counter')await notify(apt.patient_email,`Logopeda proponuje nowy termin wizyty z {{black:${orig.date} ${orig.time}}} na {{green:${proposed}}}`,`reschedule_patient:${id}`);
    else await notify(apt.patient_email,`Logopeda przełożył Twoją wizytę na ${proposed}`,'info');
    if(notifId)await sb.from('notifications').update({is_read:true}).eq('id',notifId);calendar?.refetchEvents();await loadNotifications();closeModalAll();showToast(mode==='therapist'?'Wizyta przełożona':`Propozycja wysłana: ${proposed}`);
  }catch(e){console.error(e);showToast('Błąd operacji: '+e.message,'error');}
});

async function acceptReschedule(id,notifId=''){
  try{
    const {data:apt,error}=await sb.from('appointments').select('id,title,patient_email,patient_name,appointment_date,status').eq('id',id).maybeSingle();if(error||!apt){showToast('Wizyta nie istnieje.','error');return;}
    const info=extractRescheduleInfo(apt);if(!info){showToast('Brak aktywnej propozycji.','error');return;}
    const expected=info.role==='patient'?'reschedule_requested':'reschedule_proposed';if(apt.status!==expected){showToast('Ta propozycja została już obsłużona.','error');return;}
    const [date,time]=info.proposedDate.split(' ');if(!date||!time){showToast('Nieprawidłowy proponowany termin.','error');return;}
    if(await isSlotTaken(date,time,id)){showToast('Proponowany termin został właśnie zajęty.','error');return;}
    const r=await sb.from('appointments').update({appointment_date:polandDateTimeToISO(date,time),status:'confirmed',title:stripRescheduleRequest(apt.title)}).eq('id',id).eq('status',expected).select('id');if(r.error||!r.data?.length){showToast('Propozycja została już obsłużona.','error');return;}
    await notify(info.role==='patient'?apt.patient_email:THERAPIST_EMAILS[0],info.role==='patient'?`Logopeda zaakceptował Twój proponowany termin: ${info.proposedDate}. Wizyta potwierdzona!`:`Pacjent ${apt.patient_name||''} zaakceptował proponowany termin: ${info.proposedDate}` ,info.role==='patient'?'accepted_patient':'accepted_therapist');
    await markRescheduleNotificationsRead(id);if(notifId)await sb.from('notifications').update({is_read:true}).eq('id',notifId);calendar?.refetchEvents();await loadNotifications();closeModalAll();showToast('Termin potwierdzony: '+info.proposedDate);
  }catch(e){console.error(e);showToast('Błąd akceptacji: '+e.message,'error');}
}
function extractRescheduleInfo(apt){const m=(apt.title||'').match(RESCHED_REGEX);if(!m)return null;return m[1].startsWith('Prośba')?{role:'patient',proposedDate:m[0].slice(' [Prośba o przełożenie na '.length,-1)}:{role:'therapist',proposedDate:m[0].slice(' [Propozycja logopedy: '.length,-1)};}
function extractRescheduleRequest(apt){const i=extractRescheduleInfo(apt);return i?.proposedDate||null;}
const RESCHED_REGEX=/ \[(Prośba o przełożenie na|Propozycja logopedy:) .+\]$/;
function stripRescheduleRequest(title){return(title||'').replace(RESCHED_REGEX,'').trim();}

/* ------------------------ Auto cancellation ------------------------------ */
async function checkAutoCancellation(){
  if(!currentUser)return;const {data,error}=await sb.from('appointments').select('id,title,patient_email,patient_name,appointment_date,status').in('status',['reschedule_requested','reschedule_proposed']);if(error){console.error('Auto cancellation:',error.message);return;}
  const now=Date.now(),cutoff=now+24*60*60*1000;
  for(const apt of data||[]){const original=new Date(apt.appointment_date).getTime();if(!Number.isFinite(original))continue;if(original>now&&original<=cutoff){
    const expected=apt.status,r=await sb.from('appointments').update({status:'cancelled',title:stripRescheduleRequest(apt.title)}).eq('id',apt.id).eq('status',expected).select('id');if(r.error||!r.data?.length)continue;
    await notify(apt.patient_email,'Wizyta została automatycznie anulowana – nie ustalono nowego terminu w ciągu 24h przed planowaną wizytą.','cancel');await notify(THERAPIST_EMAILS[0],`Wizyta pacjenta ${apt.patient_name||''} została automatycznie anulowana – brak ustalonego terminu 24h przed wizytą.`,'cancel');await markRescheduleNotificationsRead(apt.id);
  }}
}
async function markRescheduleNotificationsRead(id){const {data,error}=await sb.from('notifications').select('id').like('type','reschedule_%:'+id);if(error)return;if(data?.length)await sb.from('notifications').update({is_read:true}).in('id',data.map(x=>x.id));}
async function notify(email,message,type='info'){if(!email)return;const {error}=await sb.from('notifications').insert({patient_email:email,message,type,is_read:false});if(error)console.error('Notification:',error.message);}

/* -------------------------- Patient accounts ----------------------------- */
async function loadPatients(){const {data,error}=await sb.from('profiles').select('*').eq('role','patient').order('last_name');if(error){showToast('Nie udało się pobrać pacjentów.','error');return;}allPatients=(data||[]).filter(p=>p.id!==currentUser.id&&p.email!==currentUser.email);renderAccountList('');}
function renderAccountList(q=''){const c=document.getElementById('account-list');if(!c)return;const x=(q||'').toLowerCase();const list=allPatients.filter(p=>!x||(p.first_name||'').toLowerCase().includes(x)||(p.last_name||'').toLowerCase().includes(x)||(p.email||'').toLowerCase().includes(x));if(!list.length){c.innerHTML='<div class="account-list-empty">Brak wyników</div>';return;}c.innerHTML=list.map(p=>`<div class="account-list-item" data-id="${p.id}"><div class="account-list-info"><span class="account-list-name">${esc(p.last_name||'')} ${esc(p.first_name||'')}</span><span class="account-list-email">${esc(p.email||'')}</span></div><span class="account-list-arrow">›</span></div>`).join('');c.querySelectorAll('.account-list-item').forEach(e=>e.onclick=()=>{const p=allPatients.find(x=>x.id===e.dataset.id);if(p)selectAccountPatient(p);});}
function filterCombobox(q,id,onSelect){const d=document.getElementById(id);if(!q){d?.classList.add('hidden');return;}const x=q.toLowerCase(),m=allPatients.filter(p=>(p.first_name||'').toLowerCase().includes(x)||(p.last_name||'').toLowerCase().includes(x)||(p.email||'').toLowerCase().includes(x));if(!m.length){d.classList.add('hidden');return;}d.innerHTML=m.map(p=>`<div class="combobox-item" data-id="${p.id}">${esc(p.first_name||'')} ${esc(p.last_name||'')} (${esc(p.email||'')})</div>`).join('');d.classList.remove('hidden');d.querySelectorAll('.combobox-item').forEach(e=>e.addEventListener('mousedown',ev=>{ev.preventDefault();const p=allPatients.find(x=>x.id===e.dataset.id);if(p)onSelect(p);}));}
function selectAptPatient(p){selectedAptPatient=p;document.getElementById('apt-patient-search').value=`${p.first_name||''} ${p.last_name||''}`;document.getElementById('apt-patient-dropdown').classList.add('hidden');document.getElementById('apt-patient-data').classList.remove('hidden');document.getElementById('apt-email').value=p.email||'';document.getElementById('apt-phone').value=p.phone||'';document.getElementById('apt-name').value=`${p.first_name||''} ${p.last_name||''}`;document.getElementById('apt-dob').value=p.dob||'';document.getElementById('apt-age-display').textContent=calcAge(p.dob)!==null?`Wiek: ${calcAge(p.dob)} lat`:'';}
function selectAccountPatient(p){selectedAccountPatient=p;document.getElementById('account-search').value=`${p.first_name||''} ${p.last_name||''}`;document.getElementById('account-detail').classList.remove('hidden');document.getElementById('account-detail-title').textContent=`${p.first_name||''} ${p.last_name||''}`;['email','phone'].forEach(k=>document.getElementById('acc-'+k).value=p[k]||'');document.getElementById('acc-first').value=p.first_name||'';document.getElementById('acc-last').value=p.last_name||'';document.getElementById('acc-dob').value=p.dob||'';calcAgeField('acc-dob','acc-age');document.getElementById('acc-public-notes').value=p.public_notes||'';document.getElementById('acc-private-notes').value=p.private_notes||'';document.getElementById('acc-email').setAttribute('readonly','true');}
function openNewProfileInAccounts(){selectedAccountPatient=null;document.getElementById('account-detail').classList.remove('hidden');document.getElementById('account-detail-title').textContent='Nowy profil pacjenta';['email','phone','first','last','dob','public-notes','private-notes'].forEach(k=>{const e=document.getElementById('acc-'+k);if(e)e.value='';});document.getElementById('acc-age').value='';document.getElementById('acc-email').removeAttribute('readonly');}
async function saveAccountPatient(e){e.preventDefault();try{const email=document.getElementById('acc-email').value.trim(),phone=document.getElementById('acc-phone').value,first=document.getElementById('acc-first').value,last=document.getElementById('acc-last').value,dob=document.getElementById('acc-dob').value,notes=document.getElementById('acc-public-notes').value,priv=document.getElementById('acc-private-notes').value;if(!email){showToast('Podaj e-mail pacjenta','error');return;}if(!selectedAccountPatient){const {data:existing,error:findErr}=await sb.from('profiles').select('*').eq('email',email).maybeSingle();if(findErr)throw findErr;if(existing){selectedAccountPatient=existing;const r=await sb.from('profiles').update({phone,first_name:first,last_name:last,dob,public_notes:notes,private_notes:priv}).eq('id',existing.id);if(r.error)throw r.error;}else{const r=await sb.from('profiles').insert({email,phone,first_name:first,last_name:last,dob,public_notes:notes,private_notes:priv,role:'patient'});if(r.error)throw r.error;}}else{const r=await sb.from('profiles').update({phone,first_name:first,last_name:last,dob,public_notes:notes,private_notes:priv}).eq('id',selectedAccountPatient.id);if(r.error)throw r.error;}await loadPatients();showToast('Profil pacjenta zapisany');}catch(err){console.error(err);showToast('Błąd zapisu profilu: '+err.message,'error');}}

/* -------------------------- New appointments ---------------------------- */
function openNewAptModal(date=''){selectedAptPatient=null;document.getElementById('apt-patient-search').value='';document.getElementById('apt-patient-dropdown').classList.add('hidden');document.getElementById('apt-patient-data').classList.add('hidden');document.getElementById('apt-title').value='Wizyta logopedyczna';document.getElementById('apt-date').value=date;document.getElementById('apt-time').value='';document.getElementById('apt-slots').innerHTML='';document.getElementById('apt-recurring').checked=false;document.getElementById('recurring-options').classList.add('hidden');document.getElementById('apt-recurring-type').value='weekly';openModal('new-appointment-modal');if(date)initAptTimeSelect();}
async function initAptTimeSelect(){const sel=document.getElementById('apt-time'),grid=document.getElementById('apt-slots'),date=document.getElementById('apt-date'),status=document.getElementById('apt-slot-status');if(!sel||!grid||!date)return;sel.innerHTML='<option value="">Wybierz godzinę</option>';grid.innerHTML='';if(!date.value){if(status)status.textContent='Wybierz datę';return;}if(status)status.textContent='Sprawdzanie dostępności…';try{const taken=await getTakenHours(date.value);let n=0;for(const t of hourSlots()){const busy=taken.has(t),o=document.createElement('option');o.value=t;o.textContent=busy?`${t} — Zajęte`:t;o.disabled=busy;sel.appendChild(o);const b=document.createElement('button');b.type='button';b.className='slot-btn'+(busy?' taken':'');b.textContent=busy?`${t} — Zajęte`:t;b.disabled=busy;if(!busy){n++;b.onclick=()=>{grid.querySelectorAll('.slot-btn').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');sel.value=t;};}grid.appendChild(b);}if(status)status.textContent=n?`${n} dostępnych terminów`:'Brak wolnych terminów';}catch(e){console.error(e);if(status)status.textContent='Nie udało się sprawdzić dostępności';}}
document.getElementById('apt-date')?.addEventListener('change',initAptTimeSelect);
function initRecurringMonths(id){const g=document.getElementById(id);if(!g)return;g.innerHTML=MONTH_LABELS.map((m,i)=>`<button type="button" class="month-btn" data-month="${i+1}">${m.slice(0,3)}</button>`).join('');g.querySelectorAll('.month-btn').forEach(b=>b.onclick=()=>b.classList.toggle('selected'));}
function getSelectedMonths(id){return[...document.getElementById(id).querySelectorAll('.month-btn.selected')].map(x=>+x.dataset.month);}
async function createAppointment(e){
  e.preventDefault();if(!isTherapist){showToast('Tylko logopeda może tworzyć wizyty.','error');return;}if(!selectedAptPatient){showToast('Wybierz pacjenta z listy','error');return;}
  const date=document.getElementById('apt-date').value,time=document.getElementById('apt-time').value,title=document.getElementById('apt-title').value.trim(),rec=document.getElementById('apt-recurring').checked,type=rec?document.getElementById('apt-recurring-type').value:null,months=rec?getSelectedMonths('recurring-months'):[];if(!date||!time){showToast('Podaj datę i godzinę','error');return;}if(rec&&!months.length){showToast('Wybierz co najmniej jeden miesiąc dla wizyt cyklicznych.','error');return;}
  try{if(await isSlotTaken(date,time)){showToast('Ten termin jest już zajęty. Wybierz inną godzinę.','error');await initAptTimeSelect();return;}const patient={patient_email:selectedAptPatient.email,patient_name:`${selectedAptPatient.first_name||''} ${selectedAptPatient.last_name||''}`.trim(),patient_phone:selectedAptPatient.phone||'',patient_dob:selectedAptPatient.dob||null};const mainDate=polandDateTimeToISO(date,time);const r=await sb.from('appointments').insert({...patient,appointment_date:mainDate,title,status:'confirmed',recurring_type:type||'weekly'}).select().single();if(r.error)throw r.error;const main=r.data;
    if(rec){const generated=generateRecurringAppointments(date,time,type,months);const filtered=[];for(const a of generated){if(!(await isSlotTaken(a.date,a.time)))filtered.push({...patient,appointment_date:polandDateTimeToISO(a.date,a.time),title,status:'pending',recurring_type:type,recurring_parent:main.id});}if(filtered.length){const ir=await sb.from('appointments').insert(filtered);if(ir.error)throw ir.error;}}
    calendar?.refetchEvents();closeModalAll();showToast('Wizyta utworzona');
  }catch(err){console.error(err);showToast('Błąd tworzenia wizyty: '+err.message,'error');}
}
function generateRecurringAppointments(startDate,startTime,type,months){const [y,m,d]=startDate.split('-').map(Number),[h,min]=startTime.split(':').map(Number),start=new Date(y,m-1,d,h,min),out=[];for(const month of months){let cur=new Date(y,month-1,d,h,min),end=new Date(y,month,0,h,min);if(type==='monthly'){if(cur>start)out.push(localDateObj(cur));continue;}while(cur<=end){if(cur>start)out.push(localDateObj(cur));cur.setDate(cur.getDate()+(type==='biweekly'?14:7));}}return out;}
function localDateObj(d){return{date:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`,time:`${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`};}

/* ----------------------------- Exercises -------------------------------- */
let allExercises=[],exerciseFavIds=[];
function filterExercises(filter,btn){document.querySelectorAll('#exercise-sub-tabs .sub-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderExerciseCards(filter==='favorites'?allExercises.filter(e=>exerciseFavIds.includes(e.id)):allExercises);}
function renderExerciseCards(exercises){const l=document.getElementById('exercises-list');if(!l)return;l.innerHTML=exercises.length?exercises.map(ex=>`<div class="card exercise-card" data-id="${ex.id}"><div class="card-header"><h3><img src="icon.png" class="inline-icon" alt=""> ${esc(ex.title)}</h3></div><p class="card-desc">${esc(ex.description||'')}</p>${ex.link?`<a href="${esc(ex.link)}" target="_blank" rel="noopener" class="exercise-link"><img src="icon.png" class="inline-icon" alt=""> Pobierz materiały</a>`:'<span class="exercise-no-link">Ćwiczenie bez materiałów</span>'}<div class="card-months">${(ex.months||[]).map(m=>MONTH_LABELS[m-1]||'').join(', ')}</div><div class="card-actions"><button class="btn btn-outline btn-sm" onclick="toggleFavorite('${ex.id}',${exerciseFavIds.includes(ex.id)})">${exerciseFavIds.includes(ex.id)?'Ulubione':'Dodaj do ulubionych'}</button>${isTherapist?`<button class="btn btn-danger btn-sm" onclick="deleteExercise('${ex.id}')">Usuń</button>`:''}</div></div>`).join(''):'<p class="empty-msg">Brak ćwiczeń</p>';}
async function loadExercises(){const r=await sb.from('exercises').select('*').order('title');if(r.error){console.error(r.error);return;}allExercises=r.data||[];const f=await sb.from('favorite_exercises').select('exercise_id').eq('user_id',currentUser.id);if(f.error)console.error(f.error);exerciseFavIds=(f.data||[]).map(x=>x.exercise_id);const active=document.querySelector('#exercise-sub-tabs .sub-tab.active');renderExerciseCards(active?.dataset.filter==='favorites'?allExercises.filter(e=>exerciseFavIds.includes(e.id)):allExercises);const side=document.getElementById('favorite-exercises-sidebar'),list=document.getElementById('favorites-list');if(side){side.classList.toggle('hidden',!exerciseFavIds.length);if(list)list.innerHTML=allExercises.filter(e=>exerciseFavIds.includes(e.id)).map(e=>`<div class="fav-item">${esc(e.title)}</div>`).join('');}}
async function toggleFavorite(id,current){const r=current?await sb.from('favorite_exercises').delete().eq('exercise_id',id).eq('user_id',currentUser.id):await sb.from('favorite_exercises').insert({exercise_id:id,user_id:currentUser.id});if(r.error){showToast('Błąd ulubionych: '+r.error.message,'error');return;}loadExercises();}
async function deleteExercise(id){if(!isTherapist||!confirm('Usunąć ćwiczenie?'))return;const r=await sb.from('exercises').delete().eq('id',id);if(r.error){showToast('Błąd usuwania: '+r.error.message,'error');return;}loadExercises();showToast('Ćwiczenie usunięte');}
async function saveExercise(e){e.preventDefault();if(!isTherapist)return;const r=await sb.from('exercises').insert({title:document.getElementById('ex-title').value,description:document.getElementById('ex-desc').value,link:document.getElementById('ex-link').value});if(r.error){showToast('Błąd: '+r.error.message,'error');return;}closeModalAll();loadExercises();showToast('Ćwiczenie dodane');}

/* ------------------------------ Profile ---------------------------------- */
function loadProfile(){if(!currentProfile)return;['email','phone','first','last','dob'].forEach(k=>{const e=document.getElementById('prof-'+k);if(e)e.value=currentProfile[k==='first'?'first_name':k==='last'?'last_name':k]||'';});calcAgeField('prof-dob','prof-age');const n=document.getElementById('prof-notes');if(n)n.value=currentProfile.public_notes||'';if(!isTherapist&&n)n.readOnly=true;if(!isTherapist&&currentProfile.profile_locked){document.getElementById('profile-locked-msg')?.classList.remove('hidden');['phone','first','last','dob'].forEach(k=>{const e=document.getElementById('prof-'+k);if(e)e.disabled=true;});document.getElementById('prof-save-btn')?.classList.add('hidden');}}
async function saveProfile(e){e.preventDefault();if(!currentProfile)return;if(!isTherapist&&currentProfile.profile_locked){showToast('Profil zablokowany – tylko terapeuta może zmienić dane','error');return;}const updates={phone:document.getElementById('prof-phone').value,first_name:document.getElementById('prof-first').value,last_name:document.getElementById('prof-last').value,dob:document.getElementById('prof-dob').value,public_notes:document.getElementById('prof-notes').value};if(!isTherapist)updates.profile_locked=true;const r=await sb.from('profiles').update(updates).eq('id',currentUser.id);if(r.error){showToast('Błąd zapisu: '+r.error.message,'error');return;}const p=await sb.from('profiles').select('*').eq('id',currentUser.id).single();if(p.error){showToast('Błąd odświeżania profilu: '+p.error.message,'error');return;}currentProfile=p.data;loadProfile();if(!isTherapist)openModal('profile-save-popup');else showToast('Profil zapisany');}
function calcAge(dob){if(!dob)return null;const d=new Date(dob+'T00:00:00'),now=new Date();let a=now.getFullYear()-d.getFullYear();if(now.getMonth()<d.getMonth()||(now.getMonth()===d.getMonth()&&now.getDate()<d.getDate()))a--;return a>=0?a:null;}
function calcAgeField(dobId,ageId){const e=document.getElementById(dobId),out=document.getElementById(ageId);if(!e||!out)return;const a=calcAge(e.value);out.value=a===null?'':`${a} lat`;}

/* --------------------------- Notifications ------------------------------- */
let allNotifications=[],notifFilter='unread';
async function loadNotifications(){if(!currentUser)return;let q=sb.from('notifications').select('*').order('created_at',{ascending:false});q=isTherapist?q.in('patient_email',THERAPIST_EMAILS):q.eq('patient_email',currentUser.email);const r=await q;if(r.error){console.error('Notifications:',r.error.message);return;}allNotifications=r.data||[];updateNotifBadge();renderNotifications();}
function updateNotifBadge(){const b=document.getElementById('notif-badge');if(!b)return;const n=allNotifications.filter(x=>!x.is_read).length;b.textContent=n>99?'99+':n;b.classList.toggle('hidden',n===0);}
function parseNotificationType(t){if(!t)return null;const p=t.split(':');return p.length===2?{action:p[0],aptId:p[1]}:{action:t,aptId:null};}
function isRescheduleForMe(a){return isTherapist?a==='reschedule_therapist':a==='reschedule_patient';}
function renderNotifications(){const l=document.getElementById('notifications-list');if(!l)return;let list=allNotifications;if(notifFilter==='unread')list=list.filter(x=>!x.is_read);else if(notifFilter==='read')list=list.filter(x=>x.is_read);if(!list.length){l.innerHTML=`<p class="empty-msg">${notifFilter==='unread'?'Brak nieprzeczytanych powiadomień':notifFilter==='read'?'Brak przeczytanych powiadomień':'Brak powiadomień'}</p>`;return;}l.innerHTML=list.map(n=>{const p=parseNotificationType(n.type),rel=p&&isRescheduleForMe(p.action),actions=rel&&!n.is_read?`<div class="notif-actions" onclick="event.stopPropagation()"><button class="btn btn-primary btn-sm" onclick="acceptRescheduleFromNotif('${p.aptId}','${n.id}')">Akceptuj termin</button><button class="btn btn-outline btn-sm" onclick="proposeAlternativeDateFromNotif('${p.aptId}','${isTherapist?'therapist':'patient'}','${n.id}')">Zaproponuj inny termin</button></div>`:'';const icon=p?.action?.startsWith('reschedule_')?'🔄':n.type?.startsWith('accepted_')?'✅':n.type==='cancel'?'❌':n.type==='broadcast'?'📢':n.type==='info'?'ℹ️':'🔔';return`<div class="card notif-card ${n.is_read?'read':''}" data-id="${n.id}" onclick="markNotifRead('${n.id}')"><div class="card-header"><h3>${n.is_read?'':'<span class="unread-dot"></span>'}${icon} ${renderNotifMessage(n.message)}</h3></div><span class="card-date">${new Date(n.created_at).toLocaleDateString('pl-PL',{timeZone:TZ})} ${new Date(n.created_at).toLocaleTimeString('pl-PL',{timeZone:TZ,hour:'2-digit',minute:'2-digit'})}</span>${actions}</div>`;}).join('');}
async function markNotifRead(id){const n=allNotifications.find(x=>x.id===id);if(!n||n.is_read)return;const r=await sb.from('notifications').update({is_read:true}).eq('id',id).eq('patient_email',isTherapist?undefined:currentUser.email);if(r.error){console.error(r.error);return;}n.is_read=true;updateNotifBadge();renderNotifications();}
function filterNotifications(filter,btn){notifFilter=filter;document.querySelectorAll('#notif-sub-tabs .sub-tab').forEach(b=>b.classList.remove('active'));btn.classList.add('active');renderNotifications();}
async function markAllRead(){let q=sb.from('notifications').update({is_read:true});q=isTherapist?q.in('patient_email',THERAPIST_EMAILS):q.eq('patient_email',currentUser.email);const r=await q;if(r.error){showToast('Błąd oznaczania powiadomień: '+r.error.message,'error');return;}allNotifications.forEach(n=>n.is_read=true);updateNotifBadge();renderNotifications();}
async function sendBroadcast(){if(!isTherapist)return;const msg=document.getElementById('broadcast-msg').value.trim();if(!msg){showToast('Wpisz treść wiadomości','error');return;}const p=await sb.from('profiles').select('email').eq('role','patient');if(p.error){showToast('Błąd: '+p.error.message,'error');return;}if(!p.data?.length){showToast('Brak pacjentów','error');return;}const r=await sb.from('notifications').insert(p.data.map(x=>({patient_email:x.email,message:msg,type:'broadcast',is_read:false})));if(r.error){showToast('Błąd: '+r.error.message,'error');return;}document.getElementById('broadcast-msg').value='';closeModalAll();showToast('Wiadomość wysłana do '+p.data.length+' pacjentów');}
function acceptRescheduleFromNotif(id,n){acceptReschedule(id,n);}
function proposeAlternativeDateFromNotif(id,role,n){proposeAlternativeDate(id,role,n);}

/* ------------------------------ UI --------------------------------------- */
function openModal(id){document.getElementById(id)?.classList.remove('hidden');document.body.style.overflow='hidden';}
function closeModalAll(){document.querySelectorAll('.modal').forEach(m=>m.classList.add('hidden'));document.body.style.overflow='';}
function showToast(msg,type='success'){const c=document.getElementById('toast-container');if(!c)return;const t=document.createElement('div');t.className=`toast toast-${type}`;t.textContent=msg;c.appendChild(t);setTimeout(()=>t.remove(),3500);}
async function logout(){await sb.auth.signOut();localStorage.removeItem('sb-session');location.href='login.html';}
function renderNotifMessage(msg){let s=esc(msg||'');return s.replace(/\{\{black:(.*?)\}\}/g,'<span style="color:#1e293b;font-weight:600">$1</span>').replace(/\{\{green:(.*?)\}\}/g,'<span style="color:#22c55e;font-weight:600">$1</span>');}
function esc(s){const d=document.createElement('div');d.textContent=s??'';return d.innerHTML;}
