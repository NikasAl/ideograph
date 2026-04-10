// ============================================================
// Background Service Worker — Ideograph (Chrome MV3)
// ============================================================
//
// Handles:
// - Extension icon click → opens Ideograph in a new tab
// - Keyboard shortcut (Alt+I) → opens Ideograph in a new tab
// - Extension installation/update events
// - Cross-tab messaging coordination (future)
// ============================================================

const IDEOGRAPH_URL = chrome.runtime.getURL('index.html');

/** Open Ideograph in a new tab (or focus existing one). */
async function openIdeograph(): Promise<void> {
  // Check if an Ideograph tab already exists
  const existingTabs = await chrome.tabs.query({ url: IDEOGRAPH_URL });
  if (existingTabs.length > 0) {
    // Focus the first matching tab
    await chrome.tabs.update(existingTabs[0].id!, { active: true });
    // Also bring the window to front
    if (existingTabs[0].windowId) {
      await chrome.windows.update(existingTabs[0].windowId, { focused: true });
    }
    return;
  }

  // Open a new tab
  await chrome.tabs.create({ url: IDEOGRAPH_URL });
}

// --- Extension icon click ---
chrome.action.onClicked.addListener(() => {
  openIdeograph();
});

// --- Install event ---
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`Идеограф installed: ${details.reason}`);
  if (details.reason === 'install') {
    // Open Ideograph on first install
    openIdeograph();
  }
});

// --- Message handling ---
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
  'open-ideograph': async () => { openIdeograph(); return 'ok'; },
};
