/* Build 1 - login
   Authentication is handled by Supabase Auth.
*/

const SUPABASE_URL = 'https://dclbsucsccsegvpmmgdn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjbGJzdWNzY2NlZ2d2bW1tZ2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTA1NjksImV4cCI6MjEwMjY2NjU2OX0.HEVj0gPxioLmCR8SZYgt8qi-Nw47UMYrSgKLUrBZedQ';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

const THERAPIST_EMAILS = ['kontakt@logopedaostroda.pl', 'ziomekzpolski@yahoo.com'];

let redirecting = false;

document.addEventListener('DOMContentLoaded', async () => {
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const errorBox = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-btn');
  const togglePwd = document.getElementById('toggle-pwd');

  if (!form || !emailInput || !passwordInput || !errorBox || !submitBtn) return;

  togglePwd?.addEventListener('click', () => {
    const type = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.type = type;
    togglePwd.textContent = type === 'password' ? '👁️' : '🙈';
  });

  // Do not redirect repeatedly. Supabase persists its own session.
  const { data: sessionData, error: sessionError } = await sb.auth.getSession();
  if (sessionError) {
    console.error('Supabase session error:', sessionError);
  } else if (sessionData?.session) {
    redirectToApp();
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (redirecting) return;

    errorBox.classList.add('hidden');

    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!email || !password) {
      showError('Podaj e-mail i hasło.');
      return;
    }

    submitBtn.disabled = true;
    submitBtn.textContent = 'Logowanie...';

    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password });

      if (error) throw new Error(getAuthError(error));
      if (!data?.session || !data?.user) {
        throw new Error('Nie udało się utworzyć sesji logowania.');
      }

      // Compatibility with Build-1 app.js. Supabase Auth remains the source
      // of truth and also keeps the normal persisted session internally.
      localStorage.setItem('sb-session', JSON.stringify(data.session));

      const role = THERAPIST_EMAILS.includes((data.user.email || email).toLowerCase())
        ? 'therapist'
        : 'patient';

      const profileResult = await sb.from('profiles').upsert({
        id: data.user.id,
        email: data.user.email || email,
        role
      }, { onConflict: 'id' });

      if (profileResult.error) {
        console.warn('Profile was not created/updated:', profileResult.error.message);
      }

      const { data: verified } = await sb.auth.getSession();
      if (!verified?.session) {
        localStorage.removeItem('sb-session');
        throw new Error('Sesja logowania nie została zapisana.');
      }

      redirectToApp();
    } catch (err) {
      console.error('Login error:', err);
      showError(err?.message || 'Nie udało się zalogować.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Zaloguj się / Zarejestruj się';
    }
  });

  function redirectToApp() {
    if (redirecting) return;
    redirecting = true;
    window.location.replace('app.html');
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  function getAuthError(error) {
    if (!error) return 'Nie udało się zalogować.';
    const message = error.message || '';
    if (message === 'Invalid login credentials') {
      return 'Nieprawidłowy e-mail lub hasło.';
    }
    if (message.toLowerCase().includes('email not confirmed')) {
      return 'Potwierdź adres e-mail przed zalogowaniem.';
    }
    return message;
  }
});