const { desktopCapturer } = require('electron');
// Function to test IPC connection
function testIpcConnection() {
  console.log('Testing IPC connection...');
  
  setTimeout(() => {
    console.log('IPC test timeout - no response received');
  }, 1000);
}

document.addEventListener('keydown', (e) => {
  // Block Windows key combinations
  if (e.key === 'Meta' || e.metaKey) {
      e.preventDefault();
      return false;
  }
}, true);

document.addEventListener('DOMContentLoaded', () => {
  console.log('Renderer process started');
  
  // Get URL parameters
  const urlParams = new URLSearchParams(window.location.search);
  const params = Object.fromEntries(urlParams.entries());
  testIpcConnection();
  
  if (Object.keys(params).length > 0) {
    console.log('Sending URL parameters to main process:', params);
    sendParamsToMain(params);
  }
});

// Use the exposed API instead of direct ipcRenderer
electronAPI.onAppLaunchParams((params) => {
  console.log('App launched with parameters:', params);
  sendParamsToMain(params);
});

electronAPI.onReceivedParams((params) => {
  console.log('Received parameters from main process:', params);
  handleReceivedParams(params);
  sendParamsToMain(params);
});

electronAPI.onParamsProcessed((result) => {
  console.log('Parameters processed by main process:', result);
  updateStatusUI(result);
});

// Function to send parameters to main process
async function sendParamsToMain(params) {
  try {
    let converted = `{data:${JSON.stringify(params.data)}}`;
    
    const result = await window.electronAPI.updateParams(params);
    console.log('Parameters successfully sent to main:', result);
    updateStatusUI({
      status: 'success',
      message: 'Parameters sent successfully'
    });
  } catch (error) {
    console.error('Error sending parameters:', error);
    updateStatusUI({
      status: 'error',
      message: 'Failed to send parameters'
    });
  }
}

function handleReceivedParams(params) {
  console.log('Processing received parameters:', params);
  updateStatusUI({
    status: 'info',
    message: `Received: ${JSON.stringify(params.data)}`
  });
}

function updateStatusUI(result) {
  const statusElement = document.getElementById('set-token');
  if (statusElement) {
    statusElement.textContent = result.message;
    statusElement.className = `status-${result.status}`;
  }
}

async function fetchProcesses() {
  try {
    console.log("Fetching processes...");
    const result = await window.electronAPI.getProcesses();
    console.log("Processes result:", result);
    updateStatusUI({
      status: 'success',
      message: `Processes: ${JSON.stringify(result)}`
    });
  } catch (error) {
    console.error("Error fetching processes:", error);
    updateStatusUI({
      status: 'error',
      message: 'Failed to fetch processes'
    });
  }
}

// In your renderer process:
async function getScreenShareAccess() {
  const sources = await desktopCapturer.getSources({ 
    types: ['window', 'screen']
  });
  
  // Then use this with getUserMedia
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sources[0].id
      }
    }
  });
}

// Add to your renderer JavaScript
window.electronAPI.on('external-display-removed', (event, data) => {
  // Remove any warning messages
  let warningElement = document.getElementById('display-warning');
  if (warningElement) {
    warningElement.style.display = 'none';
  }
  
  // Remove any blocking overlays
  document.body.classList.remove('warning-active');
  
  // Re-enable any disabled controls
  const urlInput = document.getElementById('urlInput');
  const navigationButtons = document.querySelectorAll('.nav-buttons button');
  
  if (urlInput) urlInput.disabled = false;
  navigationButtons.forEach(button => button.disabled = false);
});

// Update the external display detection handler
window.electronAPI.on('external-display-detected', (event, data) => {
  showDisplayWarning(data.message);
  
  // Disable controls
  const urlInput = document.getElementById('urlInput');
  const navigationButtons = document.querySelectorAll('.nav-buttons button');
  
  if (urlInput) urlInput.disabled = false;
  navigationButtons.forEach(button => button.disabled = false);
});

fetchProcesses();

