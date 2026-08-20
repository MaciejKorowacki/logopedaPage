/* Build 1 - login
   Authentication is handled by Supabase Auth.
   The application does not create a second authentication system.
*/

const SUPABASE_URL = 'https://dclbsucsccsegvpmmgdn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRjbGJzdWNzY3NcsZWd2cG1tZ2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTA1NjksImV4cCI6MjEwMjY2NjU2OX0.HEVj0gPxioLmCR8SZYgt8qi-Nw47UMYrSgKLUrBZedQ';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

const THERAPIST_EMAILS = ['kontakt@logopedaostroda.pl', 'ziomekzpolski@yahoo.com'];

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

  // Supabase is the source of truth. If a valid session already exists,
  // do not show the login form again.
  const { data: sessionData } = await sb.auth.getSession();
  if (sessionData?.session) {
    location.replace('app.html');
    return;
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.classList.add('hidden');

    const email = emailInput.value.trim().toLowerCase();
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

    try {
      // 1. Normal login.
      let result = await sb.auth.signInWithPassword({ email, password });

      // 2. If the account does not exist, create it.
      if (result.error) {
        const signUp = await sb.auth.signUp({ email, password });

        if (signUp.error) {
          throw new Error(getAuthError(signUp.error));
        }

        // Email confirmation enabled in Supabase means there is no session yet.
        if (!signUp.data?.session) {
          showError('Konto zostało utworzone. Sprawdź e-mail i potwierdź konto, a następnie zaloguj się.');
          return;
        }

        result = { data: signUp.data, error: null };
      }

      if (result.error || !result.data?.session) {
        throw new Error(getAuthError(result.error) || 'Nie udało się zalogować.');
      }

      const session = result.data.session;
      const user = session.user;

      // Supabase Auth owns the session. This legacy key is kept only for
      // compatibility with the existing index.html/app.html during Build 1.
      localStorage.setItem('sb-session', JSON.stringify(session));

      // Profile creation is deliberately non-blocking for login. A database
      // profile error must not make a successful authentication look like a
      // failed login.
      const role = THERAPIST_EMAILS.includes((user.email || email).toLowerCase())
        ? 'therapist'
        : 'patient';

      const profileResult = await sb.from('profiles').upsert({
        id: user.id,
        email: user.email || email,
        role
      }, { onConflict: 'id' });

      if (profileResult.error) {
        console.warn('Profile was not created/updated:', profileResult.error.message);
      }

      // Verify that the session is actually available before leaving the page.
      const { data: verified } = await sb.auth.getSession();
      if (!verified?.session) {
        localStorage.removeItem('sb-session');
        throw new Error('Sesja logowania nie została zapisana. Spróbuj ponownie.');
      }

      location.replace('app.html');
    } catch (err) {
      console.error('Login error:', err);
      showError(err?.message || 'Nie udało się zalogować.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Zaloguj się / Zarejestruj się';
    }
  });

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  function getAuthError(error) {
    if (!error) return '';
    if (error.message === 'Invalid login credentials') {
      return 'Nieprawidłowy e-mail lub hasło.';
    }
    if (error.message?.toLowerCase().includes('email not confirmed')) {
      return 'Potwierdź adres e-mail przed zalogowaniem.';
    }
    return error.message;
  }
});