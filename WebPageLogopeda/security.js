/* ============================================================================
   security.js – small compatibility/security layer
   Loaded after app.js so it can intercept the therapist's "new patient profile"
   form before the legacy profile INSERT runs. Authentication and authorization
   are still enforced by Supabase/RLS; this file only adapts the existing UI.
   ============================================================================ */

(() => {
  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!form || form.id !== 'account-edit-form') return;

    // Existing-patient edits continue through the original handler.
    if (typeof selectedAccountPatient !== 'undefined' && selectedAccountPatient) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    const email = String(document.getElementById('acc-email')?.value || '').trim().toLowerCase();
    const phone = String(document.getElementById('acc-phone')?.value || '').trim();
    const first = String(document.getElementById('acc-first')?.value || '').trim();
    const last = String(document.getElementById('acc-last')?.value || '').trim();
    const dob = document.getElementById('acc-dob')?.value || null;
    const notes = String(document.getElementById('acc-public-notes')?.value || '').trim();
    const privateNotes = String(document.getElementById('acc-private-notes')?.value || '').trim();

    if (!email || !email.includes('@')) {
      showToast('Podaj prawidłowy e-mail pacjenta', 'error');
      return;
    }

    const { data: existingInvite, error: lookupError } = await sb
      .from('patient_invites')
      .select('id')
      .eq('email', email)
      .is('used_at', null)
      .maybeSingle();

    if (lookupError) {
      showToast('Nie udało się sprawdzić konta: ' + lookupError.message, 'error');
      return;
    }

    const payload = {
      email,
      phone,
      first_name: first,
      last_name: last,
      dob: dob || null,
      public_notes: notes,
      private_notes: privateNotes
    };

    let result;
    if (existingInvite) {
      result = await sb.from('patient_invites').update(payload).eq('id', existingInvite.id);
    } else {
      result = await sb.from('patient_invites').insert(payload);
    }

    if (result.error) {
      showToast('Błąd zapisu konta: ' + result.error.message, 'error');
      return;
    }

    document.getElementById('account-detail')?.classList.add('hidden');
    showToast(existingInvite ? 'Dane przygotowanego konta zaktualizowane' : 'Konto pacjenta przygotowane. Pacjent ustawi hasło przy pierwszym wejściu.');

    if (typeof renderAccountList === 'function') renderAccountList(document.getElementById('account-search')?.value || '');
  }, true);
})();
