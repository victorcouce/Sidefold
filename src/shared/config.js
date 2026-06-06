/**
 * config.js — Configuración de Supabase (claves públicas)
 * Carga ANTES de auth.js y sync.js.
 * Los valores se rellenan tras crear el proyecto Supabase (ver docs/BACKEND_SETUP.md).
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  // TODO: rellenar tras crear el proyecto Supabase (ver docs/BACKEND_SETUP.md)
  const SUPABASE_URL = 'https://nyuomgpfxsuzbqytrzzf.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_2z0DufhHIu9aal_x_mTQdA_rp6rvnX7';
  const GOOGLE_CLIENT_ID = '807365668587-meqsnv9v73lo1941urfasgbktpf4q3ks.apps.googleusercontent.com';

  window.YCSM.config = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    GOOGLE_CLIENT_ID,
  };
})();
