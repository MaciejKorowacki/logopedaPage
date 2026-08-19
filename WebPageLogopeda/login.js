/* ============================================================================
   login.js – Gabinet Neurologopedyczny v3
   Account state is checked explicitly before choosing login vs registration.
   ============================================================================ */

const SUPABASE_URL = 'https://dclbsucsccsegvpmmgdn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkY2xic3Vjc2NzZWd2c2Nzd2dG1tZ2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTA1NjksImV4cCI6MjEwMjY2NjU2OX0.HEVj0gPxioLmCR8SZYgt8qi-Nw47UMYrSgKLUrBZedQ';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);

let accountStatus = null;
let statusTimer = null;

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('login-form');
  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const errorBox = document.getElementById('login-error');
  const submitBtn = document.getElementById('login-btn');
  const togglePwd = document.getElementById('toggle-pwd');
  const hint = document.querySelector('.login-hint');

  const session = JSON.parse(localStorage.getItem('sb-session') || 'null');
  if (session && session.access_token) {
    location.href = 'app.html';
    return;
  }

  togglePwd.addEventListener('click', () => {
    const type = passwordInput.type === 'password' ? 'text' : 'password';
    passwordInput.type = type;
    togglePwd.textContent = type === 'password' ? '👁️' : '🙈';
  });

  emailInput.addEventListener('input', () => {
    clearTimeout(statusTimer);
    accountStatus = null;
    setLoginMode('checking');
    const email = normalizeEmail(emailInput.value);
    if (!email || !emailInput.validity.valid) {
      setLoginMode('login');
      return;
    }
    statusTimer = setTimeout(() => refreshAccountStatus(email), 350);
  });

  emailInput.addEventListener('blur', () => {
    const email = normalizeEmail(emailInput.value);
    if (email && emailInput.validity.valid) refreshAccountStatus(email);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const email = normalizeEmail(emailInput.value);
    const password = passwordInput.value;

    if (!email || !emailInput.validity.valid) {
      showError('Podaj prawidłowy adres e-mail.');
      return;
    }
    if (!password || password.length < 6) {
      showError('Hasło musi mieć min. 6 znaków.');
      return;
    }

    if (!accountStatus) await refreshAccountStatus(email);

    if (accountStatus === 'registered') {
      await login(email, password);
      return;
    }

    if (accountStatus === 'new' || accountStatus === 'invited') {
      const confirmInput = document.getElementById('password-confirm');
      if (!confirmInput) {
        addPasswordConfirmation();
        showError('Wpisz hasło ponownie, aby utworzyć konto.');
        return;
      }
      if (password !== confirmInput.value) {
        showError('Hasła nie są identyczne.');
        return;
      }
      await register(email, password);
      return;
    }

    if (accountStatus === 'setup') {
      showError('To konto wymaga ustawienia hasła. Użyj opcji odzyskiwania hasła lub skontaktuj się z gabinetem.');
      return;
    }

    showError('Nie udało się sprawdzić konta. Spróbuj ponownie.');
  });

  async function refreshAccountStatus(email) {
    const { data, error } = await sb.rpc('get_account_status', { p_email: email });
    if (error) {
      console.error('Account status error:', error);
      accountStatus = null;
      setLoginMode('login');
      return;
    }

    accountStatus = data;
    clearError();

    if (data === 'registered') {
      removePasswordConfirmation();
      setLoginMode('login');
    } else if (data === 'invited') {
      addPasswordConfirmation();
      setLoginMode('register', 'Konto zostało przygotowane przez logopedę. Ustaw swoje hasło, aby rozpocząć korzystanie z konta.');
    } else if (data === 'new') {
      addPasswordConfirmation();
      setLoginMode('register', 'Nie znaleziono konta dla tego adresu. Możesz je teraz utworzyć.');
    } else if (data === 'setup') {
      removePasswordConfirmation();
      setLoginMode('login', 'To konto wymaga ustawienia hasła. Skorzystaj z odzyskiwania hasła lub skontaktuj się z gabinetem.');
    } else {
      setLoginMode('login');
    }
  }

  function setLoginMode(mode, message = '') {
    submitBtn.classList.remove('btn-register');
    submitBtn.disabled = mode === 'checking';

    if (mode === 'register') {
      submitBtn.textContent = 'Zarejestruj się';
      submitBtn.classList.add('btn-register');
      submitBtn.disabled = false;
      if (message) {
        hint.textContent = message;
        hint.classList.add('login-info');
      }
    } else if (mode === 'checking') {
      submitBtn.textContent = 'Sprawdzanie...';
    } else {
      submitBtn.textContent = 'Zaloguj się';
      hint.textContent = message || 'Wpisz e-mail. Jeśli konto nie istnieje, przycisk zmieni się na „Zarejestruj się”.';
      hint.classList.remove('login-info');
    }
  }

  function addPasswordConfirmation() {
    if (document.getElementById('password-confirm')) return;
    const group = document.createElement('div');
    group.className = 'form-group';
    group.id = 'password-confirm-group';
    group.innerHTML = '<label for="password-confirm">Powtórz hasło</label><input type="password" id="password-confirm" required placeholder="Powtórz hasło" autocomplete="new-password">';
    passwordInput.closest('.form-group').after(group);
  }

  function removePasswordConfirmation() {
    document.getElementById('password-confirm-group')?.remove();
  }

  async function login(email, password) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Logowanie...';

    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      showError('Nieprawidłowy e-mail lub hasło.');
      setLoginMode('login');
      submitBtn.disabled = false;
      return;
    }

    if (!data.session) {
      showError('Logowanie wymaga potwierdzenia adresu e-mail. Sprawdź swoją skrzynkę.');
      setLoginMode('login');
      submitBtn.disabled = false;
      return;
    }

    localStorage.setItem('sb-session', JSON.stringify(data.session));
    location.href = 'app.html';
  }

  async function register(email, password) {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Tworzenie konta...';

    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) {
      showError(error.message || 'Nie udało się utworzyć konta.');
      setLoginMode('register');
      submitBtn.disabled = false;
      return;
    }

    if (data.session) {
      localStorage.setItem('sb-session', JSON.stringify(data.session));
      showSuccess('Konto zostało utworzone. Za chwilę przejdziesz do aplikacji.');
      setTimeout(() => { location.href = 'app.html'; }, 700);
      return;
    }

    accountStatus = 'registered';
    removePasswordConfirmation();
    passwordInput.value = '';
    setLoginMode('login');
    showSuccess('Konto zostało utworzone. Sprawdź e-mail, aby potwierdzić konto, a następnie zaloguj się.');
    submitBtn.disabled = false;
  }

  function clearError() {
    errorBox.classList.add('hidden');
    errorBox.textContent = '';
    errorBox.classList.remove('login-success');
  }

  function showError(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden', 'login-success');
  }

  function showSuccess(msg) {
    errorBox.textContent = msg;
    errorBox.classList.remove('hidden');
    errorBox.classList.add('login-success');
  }
});
