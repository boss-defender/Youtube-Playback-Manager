/**
 * Content Script for YouTube and YouTube Music tabs.
 * Injected automatically on matching domains.
 */

let videoElement = null;
let stateReportingInterval = null;

// Initialize when page elements are ready
function init() {
  console.log('[YT-Playback-Link] Content Script initialized on:', window.location.hostname);
  setupVideoListeners();
  
  // Set up periodic sync just in case some events are eaten by SPAs
  if (stateReportingInterval) clearInterval(stateReportingInterval);
  stateReportingInterval = setInterval(reportState, 1500);
}

// Locate video element and attach playback events
function setupVideoListeners() {
  const video = document.querySelector('video');
  
  if (!video) {
    // Retry shortly if YouTube is still rendering the page contents
    setTimeout(setupVideoListeners, 1000);
    return;
  }
  
  if (videoElement === video) {
    return; // Already tracking the right active element
  }
  
  // Clean up any old listeners if video is swapped (rare but possible during deep SPA navigations)
  if (videoElement) {
    removeEventListeners(videoElement);
  }
  
  videoElement = video;
  
  // Bind standard HTML5 video state listeners
  const events = ['play', 'pause', 'ended', 'volumechange', 'ratechange', 'emptied', 'stalled'];
  events.forEach(evt => {
    video.addEventListener(evt, reportState);
  });
  
  console.log('[YT-Playback-Link] Successfully attached tracking listeners to <video> element.');
  reportState();
}

// Clean up listeners from old video elements
function removeEventListeners(video) {
  const events = ['play', 'pause', 'ended', 'volumechange', 'ratechange', 'emptied', 'stalled'];
  events.forEach(evt => {
    try {
      video.removeEventListener(evt, reportState);
    } catch (e) {
      // Ignored
    }
  });
}

// Assemble and transmit video element state to background.js
function reportState() {
  if (!videoElement) {
    // Check if a video element has loaded in the meantime
    const video = document.querySelector('video');
    if (video) {
      setupVideoListeners();
    }
    return;
  }

  // Buffering still represents an active play request; readyState can drop
  // briefly without the user pausing the video.
  const isPlaying = !videoElement.paused && !videoElement.ended;
  const isMuted = videoElement.muted || videoElement.volume === 0;
  
  // Detect if current page is YouTube Music vs YouTube Videos
  const isMusic = window.location.hostname.includes('music.youtube.com');

  chrome.runtime.sendMessage({
    type: 'PLAYBACK_STATE_CHANGE',
    isPlaying,
    isMuted,
    currentTime: videoElement.currentTime,
    title: document.title,
    isMusic: isMusic
  });
}

// Helper object for assembling current state on-demand
function getCurrentStateObject() {
  if (!videoElement) return null;
  const isPlaying = !videoElement.paused && !videoElement.ended;
  const isMuted = videoElement.muted || videoElement.volume === 0;
  const isMusic = window.location.hostname.includes('music.youtube.com');

  return {
    isPlaying,
    isMuted,
    currentTime: videoElement.currentTime,
    title: document.title,
    isMusic: isMusic
  };
}

// Direct interface for commands received from Background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'COMMAND_PLAY') {
    if (videoElement) {
      videoElement.play()
        .then(() => {
          sendResponse({ success: true, state: 'PLAYING' });
          reportState();
        })
        .catch(err => {
          console.warn('[YT-Playback-Link] Failed to trigger video.play():', err);
          sendResponse({ success: false, error: err.toString() });
        });
      return true; // Keep response channel open for async promise
    } else {
      sendResponse({ success: false, error: 'No active video tag found.' });
    }
  } 
  
  else if (message.type === 'COMMAND_PAUSE') {
    if (videoElement) {
      videoElement.pause();
      sendResponse({ success: true, state: 'PAUSED' });
      reportState();
    } else {
      sendResponse({ success: false, error: 'No active video tag found.' });
    }
  } 
  
  else if (message.type === 'REQUEST_CURRENT_STATE') {
    const state = getCurrentStateObject();
    sendResponse(state);
  }
});

// Watch for DOM shifts because YouTube loads content dynamically as a single page application
const observer = new MutationObserver(() => {
  const video = document.querySelector('video');
  if (video && video !== videoElement) {
    console.log('[YT-Playback-Link] New video element identified via MutationObserver.');
    setupVideoListeners();
  }
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

// Run bootstrapping flow
init();
