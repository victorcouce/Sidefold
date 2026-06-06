/**
 * config.js — Configuración de Supabase (claves públicas)
 * Carga ANTES de auth.js y sync.js.
 * Los valores se rellenan tras crear el proyecto Supabase (ver docs/BACKEND_SETUP.md).
 */
(function () {
  if (!window.YCSM) window.YCSM = {};

  // TODO: rellenar tras crear el proyecto Supabase (ver docs/BACKEND_SETUP.md)
  const SUPABASE_URL = 'https://your-project.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
  const GOOGLE_CLIENT_ID = 'your-client-id.apps.googleusercontent.com';

  window.YCSM.config = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    GOOGLE_CLIENT_ID,
  };
})();
