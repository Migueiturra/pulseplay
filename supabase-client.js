const pulseplayConfig = window.PULSEPLAY_CONFIG || {};
const hasSupabaseConfig = Boolean(pulseplayConfig.supabaseUrl && pulseplayConfig.supabaseAnonKey);
const initialAuthHash = new URLSearchParams(location.hash.replace(/^#/, ""));
const initialAuthQuery = new URLSearchParams(location.search);
window.pulseplayAuthReturn = {
  type: initialAuthHash.get("type"),
  confirmed: initialAuthQuery.get("confirmed") === "1",
};
window.supabaseConfigurationError = hasSupabaseConfig && !window.supabase
  ? "No se pudo cargar el cliente de Supabase"
  : null;

window.pulseplaySupabase = hasSupabaseConfig && window.supabase
  ? window.supabase.createClient(pulseplayConfig.supabaseUrl, pulseplayConfig.supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

window.isSupabaseConfigured = () => hasSupabaseConfig;
