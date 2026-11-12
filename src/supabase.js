import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY; // publishable キー (ブラウザに置いてよい)。secret/service_role は入れない

// 環境変数が無いときは null。アプリは従来どおり端末内だけで動く。
export const supabase = url && key
  ? createClient(url, key, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
