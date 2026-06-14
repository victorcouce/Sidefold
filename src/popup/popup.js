/* popup.js — Account auth + Carousel logic */

// Load shared modules
const script = document.createElement('script');
script.onload = initPopup;
script.src = '../shared/utils.js';
document.head.appendChild(script);

function loadNextScript(src, callback) {
  const s = document.createElement('script');
  s.onload = callback;
  s.src = src;
  document.head.appendChild(s);
}

function initPopup() {
  loadNextScript('../shared/config.js', () => {
    loadNextScript('../shared/auth.js', () => {
      loadNextScript('../shared/account.js', () => {
        loadNextScript('../shared/sync.js', () => {
          loadNextScript('../shared/i18n.js', () => {
            initAuth();
            initCarousel();
          });
        });
      });
    });
  });
}

// Account authentication
function initAuth() {
  const btnSignIn = document.getElementById('btnSignIn');
  const btnSignOut = document.getElementById('btnSignOut');
  const btnSyncNow = document.getElementById('btnSyncNow');
  const accountContent = document.getElementById('accountContent');
  const accountStatus = document.getElementById('accountStatus');
  const accountEmail = document.getElementById('accountEmail');
  const syncStatus = document.getElementById('syncStatus');

  async function updateAuthUI() {
    const session = await YCSM.auth?.getSession?.();
    if (session) {
      accountContent.style.display = 'none';
      accountStatus.style.display = 'block';
      accountEmail.textContent = session.user.email || 'Connected';
      syncStatus.textContent = 'Last sync: just now';
    } else {
      accountContent.style.display = 'block';
      accountStatus.style.display = 'none';
    }
  }

  btnSignIn.addEventListener('click', async () => {
    btnSignIn.disabled = true;
    btnSignIn.textContent = 'Signing in...';
    try {
      await YCSM.auth.signIn();
      updateAuthUI();
    } catch (e) {
      console.error('[Popup] Sign in error:', e);
      alert('Sign in failed: ' + e.message);
    } finally {
      btnSignIn.disabled = false;
      btnSignIn.textContent = YCSM.i18n?.t('signIn') || 'Sign in with Google';
    }
  });

  btnSignOut.addEventListener('click', async () => {
    btnSignOut.disabled = true;
    try {
      await YCSM.auth.signOut();
      updateAuthUI();
    } catch (e) {
      console.error('[Popup] Sign out error:', e);
    } finally {
      btnSignOut.disabled = false;
    }
  });

  btnSyncNow.addEventListener('click', async () => {
    btnSyncNow.disabled = true;
    btnSyncNow.textContent = YCSM.i18n?.t('syncing') || 'Syncing...';
    try {
      // El popup no tiene acceso a ytcfg, así que el accountId solo puede
      // venir de chrome.storage (escrito por el content script de YouTube).
      const accountId = await YCSM.account?.loadAccountId?.();
      if (!accountId) {
        syncStatus.textContent = YCSM.i18n?.t('syncNoAccount') || 'Open YouTube first, then try again';
        return;
      }
      const result = await YCSM.sync?.sync?.();
      if (result?.success) {
        syncStatus.textContent = 'Last sync: now';
      } else {
        syncStatus.textContent = 'Sync failed: ' + (result?.reason || 'unknown error');
      }
    } catch (e) {
      console.error('[Popup] Sync error:', e);
      syncStatus.textContent = 'Sync error: ' + e.message;
    } finally {
      btnSyncNow.disabled = false;
      btnSyncNow.textContent = YCSM.i18n?.t('syncNow') || 'Sync now';
    }
  });

  // Apply i18n
  if (YCSM.i18n?.apply) {
    YCSM.i18n.apply(document.body);
  }

  // Update UI on load
  updateAuthUI();
}

// Carousel logic
function initCarousel() {
  const tips = document.querySelectorAll('.tip');
  const dots = document.querySelectorAll('.dot');
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const carousel = document.getElementById('carousel');

  let current = 0;
  let paused = false;
  let timer = null;

  function showTip(idx) {
    tips.forEach((t, i) => { t.style.display = i === idx ? 'flex' : 'none'; });
    dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    current = idx;
  }

  function go(dir) {
    paused = true;
    showTip((current + dir + tips.length) % tips.length);
    clearTimeout(timer);
    timer = setTimeout(() => { paused = false; startAuto(); }, 8000);
  }

  function startAuto() {
    clearInterval(timer);
    timer = setInterval(() => {
      if (!paused) showTip((current + 1) % tips.length);
    }, 4500);
  }

  prevBtn.addEventListener('click', () => go(-1));
  nextBtn.addEventListener('click', () => go(1));

  dots.forEach((d, i) => {
    d.addEventListener('click', () => {
      paused = true;
      showTip(i);
      clearTimeout(timer);
      timer = setTimeout(() => { paused = false; startAuto(); }, 8000);
    });
  });

  carousel.addEventListener('mouseenter', () => { paused = true; });
  carousel.addEventListener('mouseleave', () => { paused = false; });

  showTip(0);
  startAuto();
}
