/**
 * Popup Script for interactive extension control dashboard.
 */

document.addEventListener('DOMContentLoaded', () => {
  const enableToggle = document.getElementById('enableToggle');
  const statusDot = document.getElementById('statusDot');
  const statusLabel = document.getElementById('statusLabel');
  const rescanBtn = document.getElementById('rescanBtn');
  const tabList = document.getElementById('tabList');
  const quickPauseMusicBtn = document.getElementById('quickPauseMusicBtn');
  const quickPlayMusicBtn = document.getElementById('quickPlayMusicBtn');

  // Load initial settings and active status
  function updateUI() {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('Could not contact background service worker:', chrome.runtime.lastError.message);
        statusLabel.textContent = 'Service worker connecting...';
        statusDot.className = 'dot offline';
        return;
      }

      if (response) {
        // Update Enable toggle state
        enableToggle.checked = response.isEnabled;
        
        // Update main status card
        if (response.isEnabled) {
          statusLabel.textContent = 'Monitoring & Sync Active';
          statusDot.className = 'dot active';
        } else {
          statusLabel.textContent = 'Auto-Pause Disabled';
          statusDot.className = 'dot inactive';
        }

        // Render detected active tables
        renderTabsList(response.tabStates);
        
        // Update footer quick controls availability
        updateQuickControls(response.tabStates);
      }
    });
  }

  // Handle dynamic render of tabs tracked in the background state
  function renderTabsList(tabsMap) {
    const tabs = Object.values(tabsMap || {});
    tabList.innerHTML = '';

    if (tabs.length === 0) {
      tabList.innerHTML = `
        <div class="empty-state">
          No active YouTube or YT Music tabs detected. Open tabs first!
        </div>
      `;
      return;
    }

    tabs.sort((a, b) => b.lastUpdated - a.lastUpdated).forEach(tab => {
      const tabCard = document.createElement('div');
      tabCard.className = `tab-card ${tab.isPlaying ? 'playing' : ''}`;
      
      const categoryLabel = tab.isMusic ? 'YouTube Music' : 'YouTube Video';
      const categoryClass = tab.isMusic ? 'badge-music' : 'badge-video';
      
      const playIcon = tab.isPlaying ? `
        <svg class="icon playing-anim" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="5 3 19 12 5 21 5 3"/>
        </svg>
      ` : `
        <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="14" y="4" width="4" height="16" rx="1"/>
          <rect x="6" y="4" width="4" height="16" rx="1"/>
        </svg>
      `;

      // Clean title for neat UI
      let cleanTitle = tab.title || 'Untitled YouTube Tab';
      if (cleanTitle.endsWith(' - YouTube')) {
        cleanTitle = cleanTitle.slice(0, -10);
      }

      tabCard.innerHTML = `
        <div class="tab-info">
          <div class="tab-header">
            <span class="badge ${categoryClass}">${categoryLabel}</span>
            ${tab.pausedByExtension ? '<span class="paused-by-ext">Auto-Paused</span>' : ''}
          </div>
          <div class="tab-title" title="${tab.title}">${cleanTitle}</div>
        </div>
        <button class="manual-play-pause-btn" data-id="${tab.id}" data-action="${tab.isPlaying ? 'PAUSE' : 'PLAY'}">
          ${tab.isPlaying ? 'Pause' : 'Play'}
        </button>
      `;

      tabList.appendChild(tabCard);
    });

    // Attach row button triggers
    document.querySelectorAll('.manual-play-pause-btn').forEach(button => {
      button.addEventListener('click', (e) => {
        const tabId = parseInt(e.target.getAttribute('data-id'), 10);
        const action = e.target.getAttribute('data-action');
        
        chrome.runtime.sendMessage({
          type: 'MANUAL_CONTROL',
          tabId: tabId,
          action: action
        }, () => {
          // Instantly refresh UI state with brief delays
          setTimeout(updateUI, 150);
        });
      });
    });
  }

  // Checks mapping to see if at least one YouTube Music tab exists, then enables manual controls accordingly
  function updateQuickControls(tabsMap) {
    const tabs = Object.values(tabsMap || {});
    const musicTabs = tabs.filter(t => t.isMusic);
    const hasMusicTabs = musicTabs.length > 0;

    quickPauseMusicBtn.disabled = !hasMusicTabs;
    quickPlayMusicBtn.disabled = !hasMusicTabs;

    // Attach listeners once
    if (hasMusicTabs) {
      quickPauseMusicBtn.onclick = () => triggerMusicAction(musicTabs, 'PAUSE');
      quickPlayMusicBtn.onclick = () => triggerMusicAction(musicTabs, 'PLAY');
    }
  }

  function triggerMusicAction(musicTabs, action) {
    musicTabs.forEach(mt => {
      chrome.runtime.sendMessage({
        type: 'MANUAL_CONTROL',
        tabId: mt.id,
        action: action
      });
    });
    setTimeout(updateUI, 150);
  }

  // Handle enabling/disabling sync behavior via central slider
  enableToggle.addEventListener('change', (e) => {
    const isChecked = e.target.checked;
    chrome.storage.local.set({ isEnabled: isChecked }, () => {
      console.log('User toggled execution flag saved to storage:', isChecked);
      updateUI();
    });
  });

  // Handle re-scan of tabs action
  rescanBtn.addEventListener('click', () => {
    rescanBtn.disabled = true;
    rescanBtn.textContent = 'Scanning...';
    
    chrome.runtime.sendMessage({ type: 'RESCAN_TABS' }, (response) => {
      rescanBtn.disabled = false;
      rescanBtn.innerHTML = `
        <svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
          <path d="M16 3h5v5"/>
          <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
          <path d="M8 21H3v-5"/>
        </svg>
        Rescan
      `;
      updateUI();
    });
  });

  // Periodically refresh the status so users see updates if states changed inside background tabs
  setInterval(updateUI, 2000);

  // Run initial loading
  updateUI();
});
