import { createClient } from '@supabase/supabase-js';

// 末尾の空白・スラッシュ・/rest/v1 などの付けすぎを取り除き、origin だけにする
function normalizeUrl(v) {
  if (!v) return '';
  try { return new URL(String(v).trim()).origin; } catch { return ''; }
}
const url = normalizeUrl(import.meta.env.VITE_SUPABASE_URL);
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim(); // publishable キー (ブラウザに置いてよい)。secret/service_role は入れない

// 環境変数が無いときは null。アプリは従来どおり端末内だけで動く。
export const supabase = url && key
  ? createClient(url, key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
