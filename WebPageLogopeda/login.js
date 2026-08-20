/* Build 1 - Gabinet Neurologopedyczny
   Supabase Auth is the source of truth.
   sb-session is only a compatibility bridge for the current app.js.
*/

const SUPABASE_URL = 'https://dclbsucsccsegvpmmgdn.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJkY2xmc3VjczNjc2VndG1tZ2RuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwOTA1NjksImV4cCI6MjEwMjY2NjU2OX0.HEVj0gPxioLmCR8SZYgt8qi-Nw47UMYrSgKLUrBZedQ';
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON, { auth:{ persistSession:true, autoRefreshToken:true, detectSessionInUrl:true } });
const THERAPIST_EMAILS = ['kontakt@logopedaostroda.pl', 'ziomekzpolski@yahoo.com'];
let redirecting = false;

document.addEventListener('DOMContentLoaded', async () => {
  const form=document.getElementById('login-form'), emailInput=document.getElementById('email'), passwordInput=document.getElementById('password'), errorBox=document.getElementById('login-error'), submitBtn=document.getElementById('login-btn'), togglePwd=document.getElementById('toggle-pwd');
  if(!form||!emailInput||!passwordInput||!errorBox||!submitBtn)return;
  togglePwd?.addEventListener('click',()=>{const type=passwordInput.type==='password'?'text':'password';passwordInput.type=type;togglePwd.textContent=type==='password'?'👁️':'🙈';});

  // Clear only a stale compatibility token. A valid Supabase session is copied below.
  localStorage.removeItem('sb-session');
  const {data,error}=await sb.auth.getSession();
  if(error)console.error('Supabase session error:',error);
  if(data?.session){
    localStorage.setItem('sb-session',JSON.stringify(data.session));
    redirectToApp();
    return;
  }

  form.addEventListener('submit',async e=>{
    e.preventDefault(); if(redirecting)return; errorBox.classList.add('hidden');
    const email=emailInput.value.trim().toLowerCase(),password=passwordInput.value;
    if(!email||!password){showError('Podaj e-mail i hasło.');return;}
    submitBtn.disabled=true;submitBtn.textContent='Logowanie...';
    try{
      const result=await sb.auth.signInWithPassword({email,password});
      if(result.error)throw new Error(getAuthError(result.error));
      if(!result.data?.session||!result.data?.user)throw new Error('Nie udało się utworzyć sesji logowania.');
      localStorage.setItem('sb-session',JSON.stringify(result.data.session));
      const role=THERAPIST_EMAILS.includes((result.data.user.email||email).toLowerCase())?'therapist':'patient';
      const profile=await sb.from('profiles').upsert({id:result.data.user.id,email:result.data.user.email||email,role},{onConflict:'id'});
      if(profile.error)console.warn('Profile update failed:',profile.error.message);
      redirectToApp();
    }catch(err){console.error('Login error:',err);showError(err?.message||'Nie udało się zalogować.');submitBtn.disabled=false;submitBtn.textContent='Zaloguj się / Zarejestruj się';}
  });

  function redirectToApp(){if(redirecting)return;redirecting=true;window.location.replace('app.html');}
  function showError(message){errorBox.textContent=message;errorBox.classList.remove('hidden');}
  function getAuthError(error){const message=error?.message||'';if(message==='Invalid login credentials')return'Nieprawidłowy e-mail lub hasło.';if(message.toLowerCase().includes('email not confirmed'))return'Potwierdź adres e-mail przed zalogowaniem.';return message||'Nie udało się zalogować.';}
});