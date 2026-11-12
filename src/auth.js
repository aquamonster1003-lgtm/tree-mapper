// ログイン制御。Supabase の環境変数が無ければ何もしない (従来の端末内モード)。
import { supabase } from './supabase.js';

export const isCloudEnabled = () => !!supabase;

const el = (id) => document.getElementById(id);
const VIEWS = ['auth-login', 'auth-denied', 'auth-error', 'auth-loading'];

function show(view, extra = {}) {
  el('auth-screen').classList.remove('hidden');
  VIEWS.forEach((v) => el(v).classList.toggle('hidden', v !== view));
  if (extra.email !== undefined) el('auth-denied-email').textContent = extra.email;
  if (extra.message !== undefined) el('auth-error-message').textContent = extra.message;
}
const hide = () => el('auth-screen').classList.add('hidden');

export async function signInWithGoogle() {
  const { error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + window.location.pathname }
  });
  if (error) show('auth-error', { message: 'ログインを開始できませんでした。' });
}

export async function signOut() {
  await supabase.auth.signOut();
}

// 'local' | 'ok' | 'login' | 'denied' | 'error' を返す。'ok' / 'local' のときだけアプリを開始してよい。
export async function checkAccess() {
  if (!supabase) return 'local';
  show('auth-loading');
  const { data, error } = await supabase.auth.getSession();
  if (error) { show('auth-error', { message: '通信に失敗しました。' }); return 'error'; }
  const session = data.session;
  if (!session) { show('auth-login'); return 'login'; }

  const { data: isMember, error: rpcError } = await supabase.rpc('is_member');
  if (rpcError) { show('auth-error', { message: '通信に失敗しました。電波の良い場所で再読み込みしてください。' }); return 'error'; }
  if (isMember !== true) { show('auth-denied', { email: session.user.email || '' }); return 'denied'; }

  el('account-section').classList.remove('hidden');
  el('account-email').textContent = session.user.email || '';
  hide();
  return 'ok';
}

export function bindAuthUi() {
  if (!supabase) return;
  el('auth-google-btn').addEventListener('click', signInWithGoogle);
  el('auth-retry-btn').addEventListener('click', () => window.location.reload());
  el('auth-denied-signout').addEventListener('click', signOut);
  el('logout-btn').addEventListener('click', signOut);
  // ログアウト・別タブでのログアウト・セッション失効 → 画面を戻す (端末内データは消さない)
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') window.location.reload();
  });
}
