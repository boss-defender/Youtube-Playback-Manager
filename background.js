// Playback coordination is shared by every tab in this Chrome profile, including
// tabs in separate windows. The session copy preserves extension pause ownership
// when Chrome suspends and restarts the MV3 service worker.
let tabStates = {};
let pendingCommands = {};
let isEnabled = true;
let ready = false;
let persistTimer = null;

const readyPromise = initialize();

async function initialize() {
  try {
    const [settings, session] = await Promise.all([
      chrome.storage.local.get('isEnabled'),
      chrome.storage.session.get('tabStates')
    ]);

    isEnabled = settings.isEnabled !== false;
    tabStates = session.tabStates || {};
    ready = true;
    await rescanOpenTabs();
  } catch (error) {
    console.error('[Background] Initialization failed:', error);
    ready = true;
  }
}

function ensureReady() {
  return ready ? Promise.resolve() : readyPromise;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.isEnabled) return;

  isEnabled = changes.isEnabled.newValue !== false;
  if (!isEnabled) {
    Object.values(tabStates).forEach((tab) => {
      if (tab.pausedByExtension) {
        tab.pausedByExtension = false;
        sendPlaybackCommand(tab.id, 'PLAY');
      }
      tab.pausedByExtension = false;
    });
    persistStates();
  } else {
    coordinatePlayback();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PLAYBACK_STATE_CHANGE' && sender.tab?.id !== undefined) {
    ensureReady().then(() => {
      handlePlaybackStateChange(sender.tab.id, message);
    });
    return false;
  }

  if (message.type === 'GET_STATUS') {
    ensureReady().then(() => {
      sendResponse({ isEnabled, tabStates });
    });
    return true;
  }

  if (message.type === 'RESCAN_TABS') {
    ensureReady().then(() => rescanOpenTabs()).then(sendResponse);
    return true;
  }

  if (message.type === 'MANUAL_CONTROL') {
    ensureReady().then(() => {
      handleManualControl(message.tabId, message.action);
      sendResponse({ success: true });
    });
    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabStates[tabId];
  delete pendingCommands[tabId];
  persistStates();
  coordinatePlayback();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || tab.url || '';
  if (!isYouTubeUrl(url) && tabStates[tabId]) {
    delete tabStates[tabId];
    delete pendingCommands[tabId];
    persistStates();
    coordinatePlayback();
  }
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (tabStates[removedTabId]) {
    tabStates[addedTabId] = { ...tabStates[removedTabId], id: addedTabId };
    delete tabStates[removedTabId];
    persistStates();
    requestTabState(addedTabId);
  }
});

function isYouTubeUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

function handlePlaybackStateChange(tabId, state) {
  const previous = tabStates[tabId];
  const isPlaying = Boolean(state.isPlaying);
  const isMusic = Boolean(state.isMusic);
  const pending = pendingCommands[tabId];
  const fromExtension = Boolean(pending && pending.expectedPlaying === isPlaying);

  if (fromExtension) delete pendingCommands[tabId];

  const changed = previous && previous.isPlaying !== isPlaying;
  const userChangedState = Boolean(changed && (!fromExtension || pending.manual));
  const pausedByExtension = fromExtension
    ? (isPlaying ? false : Boolean(previous.pausedByExtension))
    : (userChangedState ? false : (previous?.pausedByExtension || false));

  tabStates[tabId] = {
    id: tabId,
    isMusic,
    isPlaying,
    title: state.title || previous?.title || (isMusic ? 'YouTube Music' : 'YouTube Video'),
    isMuted: Boolean(state.isMuted),
    lastUpdated: Date.now(),
    lastPlayAt: isPlaying
      ? (changed ? Date.now() : (previous?.lastPlayAt || Date.now()))
      : (previous?.lastPlayAt || 0),
    pausedByExtension
  };

  if (userChangedState && !isPlaying && previous.pausedByExtension) {
    // This is unusual (extension-paused media cannot be manually paused again
    // without first playing), but a user pause always clears resume ownership.
    tabStates[tabId].pausedByExtension = false;
  }

  persistStates();

  const action = userChangedState ? { isMusic, isPlaying } : null;
  coordinatePlayback(action);
}

function sendPlaybackCommand(tabId, action, manual = false) {
  const tab = tabStates[tabId];
  if (!tab) return;

  const shouldPlay = action === 'PLAY';
  if (tab.isPlaying === shouldPlay) return;

  pendingCommands[tabId] = {
    expectedPlaying: shouldPlay,
    timestamp: Date.now(),
    manual
  };

  chrome.tabs.sendMessage(tabId, { type: `COMMAND_${action}` }, (response) => {
    if (chrome.runtime.lastError || response?.success === false) {
      delete pendingCommands[tabId];
      console.warn(`[Background] ${action} command failed for tab ${tabId}:`,
        chrome.runtime.lastError?.message || response?.error || 'Unknown error');
    }
  });

  // Don't let a missed event make a later manual action look extension-driven.
  setTimeout(() => {
    const pending = pendingCommands[tabId];
    if (pending && pending.expectedPlaying === shouldPlay && Date.now() - pending.timestamp >= 4000) {
      delete pendingCommands[tabId];
    }
  }, 4100);
}

function coordinatePlayback(trigger = null) {
  if (!isEnabled) return;

  const tabs = Object.values(tabStates);

  // A user action is mirrored directly to the opposite service. Do this before
  // inferring a winner from active tabs so a pause always resumes the other
  // service, even if it was paused manually or was never playing before.
  if (trigger) {
    tabs.filter((tab) => tab.isMusic !== trigger.isMusic).forEach((tab) => {
      if (trigger.isPlaying) {
        if (tab.isPlaying) tab.pausedByExtension = true;
        sendPlaybackCommand(tab.id, 'PAUSE');
      } else {
        tab.pausedByExtension = false;
        sendPlaybackCommand(tab.id, 'PLAY');
      }
    });
    persistStates();
    return;
  }

  const playingVideos = tabs.filter((tab) => !tab.isMusic && tab.isPlaying);
  const playingMusic = tabs.filter((tab) => tab.isMusic && tab.isPlaying);
  let winningType = null;
  if (playingVideos.length && playingMusic.length) {
    const newestVideo = Math.max(...playingVideos.map((tab) => tab.lastPlayAt || 0));
    const newestMusic = Math.max(...playingMusic.map((tab) => tab.lastPlayAt || 0));
    winningType = newestMusic > newestVideo ? 'music' : 'video';
  } else if (playingVideos.length) {
    winningType = 'video';
  } else if (playingMusic.length) {
    winningType = 'music';
  }

  if (winningType) {
    const winnerIsMusic = winningType === 'music';
    const winners = tabs.filter((tab) => tab.isMusic === winnerIsMusic);
    const losers = tabs.filter((tab) => tab.isMusic !== winnerIsMusic);

    // If playback returned to a side that was paused by this extension, restore
    // those tabs. Tabs paused by the user never carry this flag.
    winners.forEach((tab) => {
      if (tab.pausedByExtension) {
        tab.pausedByExtension = false;
        sendPlaybackCommand(tab.id, 'PLAY');
      }
    });

    losers.forEach((tab) => {
      if (tab.isPlaying) {
        tab.pausedByExtension = true;
        sendPlaybackCommand(tab.id, 'PAUSE');
      }
    });
    persistStates();
    return;
  }

}

function handleManualControl(tabId, action) {
  const tab = tabStates[tabId];
  if (!tab || !['PLAY', 'PAUSE'].includes(action)) return;
  if (action === 'PLAY') tab.pausedByExtension = false;
  if (action === 'PAUSE') tab.pausedByExtension = false;
  persistStates();
  sendPlaybackCommand(tabId, action, true);
}

function requestTabState(tabId) {
  chrome.tabs.sendMessage(tabId, { type: 'REQUEST_CURRENT_STATE' }, (state) => {
    if (chrome.runtime.lastError || !state) return;
    handlePlaybackStateChange(tabId, state);
  });
}

async function rescanOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: ['*://youtube.com/*', '*://*.youtube.com/*'] });
    const openIds = new Set(tabs.map((tab) => String(tab.id)));

    Object.keys(tabStates).forEach((id) => {
      if (!openIds.has(String(id))) delete tabStates[id];
    });

    tabs.forEach((tab) => {
      const id = tab.id;
      const oldState = tabStates[id];
      tabStates[id] = {
        id,
        isMusic: Boolean(tab.url?.includes('music.youtube.com')),
        isPlaying: oldState?.isPlaying || false,
        title: tab.title || (tab.url?.includes('music.youtube.com') ? 'YouTube Music' : 'YouTube Video'),
        isMuted: oldState?.isMuted || false,
        lastUpdated: oldState?.lastUpdated || Date.now(),
        lastPlayAt: oldState?.lastPlayAt || 0,
        pausedByExtension: oldState?.pausedByExtension || false
      };
      requestTabState(id);
    });

    persistStates();
    return { success: true, count: tabs.length };
  } catch (error) {
    console.error('[Background] Error rescanning tabs:', error);
    return { success: false, error: String(error) };
  }
}

function persistStates() {
  if (persistTimer !== null) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    chrome.storage.session.set({ tabStates }).catch((error) => {
      console.warn('[Background] Could not save session state:', error);
    });
  }, 150);
}
