/**
 * test-account.js — Tests de detección de cuenta (account.js)
 * Run with: node test-account.js
 *
 * Regresión cubierta: el fallback por DOM cogía el canal del CONTENIDO de la
 * página (p. ej. /@LaVanguardia) como si fuera la cuenta del usuario, scopeando
 * el storage a una cuenta fantasma y mostrando categorías vacías.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ─── Mock mínimo de DOM/chrome ──────────────────────────────────── */
function makeDocument(avatarHref) {
  return {
    querySelector(sel) {
      // Solo respondemos al selector del avatar real del masthead.
      if (avatarHref && sel.includes('ytd-masthead')) {
        return { href: avatarHref };
      }
      return null;
    },
  };
}

function loadAccount({ ytcfg = null, avatarHref = null } = {}) {
  const sandbox = {
    window: { ytcfg: ytcfg ? { data_: ytcfg } : undefined },
    document: makeDocument(avatarHref),
    chrome: { storage: { local: { set: async () => {}, get: async () => ({}) } } },
    console,
  };
  sandbox.window.window = sandbox.window;
  const code = fs.readFileSync(path.join(__dirname, 'src/shared/account.js'), 'utf8');
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.window.YCSM.account;
}

/* ─── Mini framework ─────────────────────────────────────────────── */
let passed = 0;
let failed = 0;
function assertEqual(actual, expected, msg) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}\n      esperado: ${JSON.stringify(expected)}\n      recibido: ${JSON.stringify(actual)}`);
  }
}

const VALID_UC = 'UC' + 'a'.repeat(22); // 24 chars, formato canónico

console.log('\naccount.detect()');

// 1. ytcfg con ID canónico → detecta y queda ready
{
  const acc = loadAccount({ ytcfg: { CHANNEL_ID: VALID_UC, LOGGED_IN: true } });
  const r = acc.detect();
  assertEqual(r.accountId, VALID_UC, 'usa ytcfg.CHANNEL_ID canónico');
  assertEqual(r.ready, true, 'queda ready con un ID válido');
}

// 2. ytcfg con un handle (no canónico) → se rechaza, no ready
{
  const acc = loadAccount({ ytcfg: { CHANNEL_ID: 'LaVanguardia', LOGGED_IN: true } });
  const r = acc.detect();
  assertEqual(r.accountId, null, 'rechaza un handle como ID de cuenta');
  assertEqual(r.ready, false, 'no queda ready con un valor no canónico');
}

// 3. Sin ytcfg, enlace de canal del CONTENIDO en la página → NO se usa
//    (el selector está restringido al avatar del masthead, así que querySelector
//     devuelve null para enlaces normales del contenido).
{
  const acc = loadAccount({ ytcfg: { LOGGED_IN: true }, avatarHref: null });
  const r = acc.detect();
  assertEqual(r.accountId, null, 'ignora enlaces de canal del contenido de la página');
  assertEqual(r.ready, false, 'no queda ready si solo hay contenido ajeno');
}

// 4. Fallback DOM válido: avatar real del masthead con /channel/UC...
{
  const acc = loadAccount({
    ytcfg: { LOGGED_IN: true },
    avatarHref: `https://www.youtube.com/channel/${VALID_UC}`,
  });
  const r = acc.detect();
  assertEqual(r.accountId, VALID_UC, 'acepta el avatar del masthead con ID canónico');
  assertEqual(r.ready, true, 'queda ready vía fallback DOM válido');
}

// 5. Avatar del masthead pero con handle /@ → rechazado
{
  const acc = loadAccount({
    ytcfg: { LOGGED_IN: true },
    avatarHref: 'https://www.youtube.com/@LaVanguardia',
  });
  const r = acc.detect();
  assertEqual(r.accountId, null, 'rechaza handle aunque venga del masthead');
}

// 6. ytcfg tiene prioridad sobre el DOM
{
  const acc = loadAccount({
    ytcfg: { CHANNEL_ID: VALID_UC, LOGGED_IN: true },
    avatarHref: `https://www.youtube.com/channel/${'UC' + 'b'.repeat(22)}`,
  });
  const r = acc.detect();
  assertEqual(r.accountId, VALID_UC, 'ytcfg gana al fallback DOM');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
