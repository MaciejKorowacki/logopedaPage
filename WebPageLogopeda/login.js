/* ============================================================================
   login.js – Gabinet Neurologopedyczny v2
   ============================================================================ */

const SUPABASE_URL = 'https://dclbsucsccsegvpmmgdn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjbGJzdWNzY2NzZWd2cG1tZ2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTA1NjksImV4cCI6MjEwMjY2NjU2OX0.HEVj0gPxioLmCR8SZYgt8qi-Nw47UMYrSgKLUrBZedQ';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

const THERAPIST_EMAILS = ['kontakt@logopedaostroda.pl', 'ziomekzpolski@yahoo.com'];

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const errorBox = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-btn');
  const togglePwd = document.getElementById('toggle-pwd');

  // Check if already logged in
  const session = JSON.parse(localStorage.getItem('sb-session') || 'null');
  if (session && session.access_token) {
    location.href = 'app.html';
    return;
  }

  // Toggle password visibility
  togglePwd.addEventListener('click', () => {
    const type = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.type = type;
    togglePwd.textContent = type === 'password' ? '👁️' : '🙈';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');
    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
      showError('Podaj e-mail i hasło.');
      return;
    }
    if (password.length < 6) {
      showError('Hasło musi mieć min. 6 znaków.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Logowanie...';

    // Try sign in first
    let { data, error } = await sb.auth.signInWithPassword({ email, password });

    // If sign-in fails, try sign-up (auto register)
    if (error) {
      const { data: signUpData, error: signUpError } = await sb.auth.signUp({ email, password });
      if (signUpError) {
        showError(signUpError.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Zaloguj się / Zarejestruj się';
        return;
      }
      data = signUpData;
    }

    // Store session
    if (data.session) {
      localStorage.setItem('sb-session', JSON.stringify(data.session));
      // Create or link profile row for the user in 'profiles' table
      // If therapist pre-created a profile (with null/different id), link it to the real auth UID
      const role = THERAPIST_EMAILS.includes(email) ? 'therapist' : 'patient';
      const { data: existingProfile } = await sb.from('profiles').select('id').eq('email', email).limit(1).single();
      if (existingProfile && existingProfile.id !== data.session.user.id) {
        // Pre-created profile found — update its id to the real auth UID
        const { error: linkErr } = await sb.from('profiles').update({ id: data.session.user.id, role: role }).eq('email', email);
        if (linkErr) console.error('Profile link error on login:', linkErr.message);
      } else {
        const { error: profileErr } = await sb.from('profiles').upsert({
          id: data.session.user.id,
          email: email,
          role: role
        }, { onConflict: 'id' });
        if (profileErr) console.error('Profile upsert error on login:', profileErr.message);
      }
      location.href = 'app.html';
    } else if (data.user && !data.session) {
      // Pre-created profile linking for email-confirmation flow
      const role = THERAPIST_EMAILS.includes(email) ? 'therapist' : 'patient';
      const { data: existingProfile2 } = await sb.from('profiles').select('id').eq('email', email).limit(1).single();
      if (existingProfile2 && existingProfile2.id !== data.user.id) {
        await sb.from('profiles').update({ id: data.user.id, role: role }).eq('email', email);
      } else {
        await sb.from('profiles').upsert({
          id: data.user.id,
          email: email,
          role: role
        }, { onConflict: 'id' });
      }
      showError('Sprawdź swój e-mail, aby potwierdzić konto.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Zaloguj się / Zarejestruj się';
    }
  });

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
  }
});