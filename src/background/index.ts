// ============================================================
// Background Service Worker — Ideograph (Chrome MV3)
// ============================================================
//
// Minimal service worker. Heavy processing (PDF.js, AI calls,
// canvas rendering) runs in the NEW TAB page context.
//
// Service worker handles:
// - Extension installation/update events
// - Badge updates (future)
// - Cross-tab messaging coordination (future)
// ============================================================

// --- Install event ---
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`Идеограф installed: ${details.reason}`);
});

// --- Message handling ---
// Currently minimal — most logic is in the tab context.
// Future: badge updates, background sync, etc.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = messageHandlers[message.type as keyof typeof messageHandlers];
  if (handler) {
    handler(message.data).then(sendResponse).catch((err) => {
      sendResponse({ error: String(err) });
    });
    return true; // async response
  }
});

const messageHandlers: Record<string, (data: unknown) => Promise<unknown>> = {
  'ping': async () => 'pong',
  'get-version': async () => chrome.runtime.getManifest().version,
};
