/**
 * background.js — Service Worker (Manifest V3)
 * Coordina comunicación entre popup, content scripts y storage.
 */

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Extension installed or updated
  // Storage migration happens automatically in storage.js when loaded
});

/**
 * Reenvía mensajes del popup al content script de la pestaña activa.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.action) {
    case 'openPanel':
    case 'refreshSidebar':
      forwardToActiveTab(message, sendResponse);
      return true; // mantiene el canal abierto para respuesta async

    case 'getCategories':
      window.YCSM.storage.getCategories().then((categories) => {
        sendResponse({ categories: categories || {} });
      }).catch((e) => {
        console.error('[Sidefold] getCategories error:', e);
        sendResponse({ categories: {} });
      });
      return true;

    default:
      break;
  }
});

function forwardToActiveTab(message, sendResponse) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    if (!tab?.id) {
      sendResponse({ success: false, error: 'No active tab' });
      return;
    }
    chrome.tabs.sendMessage(tab.id, message, (response) => {
      if (chrome.runtime.lastError) {
        // El content script puede no estar listo aún — no es un error crítico
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse(response);
      }
    });
  });
}
