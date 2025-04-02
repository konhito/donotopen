// display-monitor.worker.js
const { parentPort } = require('worker_threads');
const { exec } = require('child_process');
const util = require('util');
const execAsync = util.promisify(exec);

let displayCheckInterval = null;
const DISPLAY_CHECK_INTERVAL = 2000; // Reduced to 2 seconds for better responsiveness
let lastWarningTime = 0;
const WARNING_COOLDOWN = 2000;
let isShowingWarning = false;
let initialDisplayConfig = null;
let isDialogOpen = false;
let previousDisplayState = null;

// Listen for messages from main thread
parentPort.on('message', async (message) => {
  switch (message.type) {
    case 'START_MONITORING':
      try {
        initialDisplayConfig = message.initialState;
        startMonitoring();
      } catch (error) {
        parentPort.postMessage({
          type: 'ERROR',
          error: error.message
        });
      }
      break;

    case 'STOP_MONITORING':
      stopMonitoring();
      break;

    case 'DIALOG_CLOSED':
      isDialogOpen = false;
      break;

    case 'CHECK_NOW':
      performCheck();
      break;
  }
});

async function performCheck() {
  try {
    if (!isDialogOpen) {
      const isDuplicated = await checkForDuplication();
      
      // Only send update if state has changed or it's the first check
      if (previousDisplayState === null || previousDisplayState !== isDuplicated) {
        previousDisplayState = isDuplicated;
        parentPort.postMessage({ 
          type: isDuplicated ? 'DUPLICATE_DETECTED' : 'NO_DUPLICATE_DETECTED',
          timestamp: Date.now()
        });
      }
    }
  } catch (error) {
    parentPort.postMessage({
      type: 'ERROR',
      error: error.message
    });
  }
}

function startMonitoring() {
  // Perform initial check immediately
  performCheck();

  // Start periodic checks
  displayCheckInterval = setInterval(performCheck, DISPLAY_CHECK_INTERVAL);
  parentPort.postMessage({ type: 'MONITORING_STARTED' });
}

async function checkForDuplication() {
  switch (process.platform) {
    case 'win32':
      return await checkWindowsDisplayDuplication();
    case 'darwin':
      return await checkMacDisplays();
    case 'linux':
      return await checkLinuxDisplays();
    default:
      throw new Error('Unsupported operating system');
  }
}

async function checkMacDisplays() {
  try {
    console.log('Checking macOS displays...');
    const { stdout } = await execAsync('system_profiler SPDisplaysDataType -json');
    
    const displayData = JSON.parse(stdout);
    const displays = displayData.SPDisplaysDataType[0].spdisplays_ndrvs || [];
    
    const activeDisplays = displays.length;
    const externalDisplays = displays.filter(display => 
      !display.spdisplay_device_name?.toLowerCase().includes('built-in')
    ).length;
    const isMirrored = displays.some(display => 
      display._spdisplay_mirrors !== undefined
    );

    console.log({
      activeDisplays,
      externalDisplays,
      isMirrored
    });

    return activeDisplays >= 2 || (activeDisplays >= 2 && externalDisplays >= 1);
  } catch (error) {
    console.error('Error checking macOS displays:', error);
    return false;
  }
}

async function checkLinuxDisplays() {
  try {
    // Try xrandr first (for X11)
    try {
      const { stdout: xrandrOutput } = await execAsync('xrandr --query');
      const connectedDisplays = (xrandrOutput.match(/ connected /g) || []).length;
      const activeDisplays = (xrandrOutput.match(/\d+x\d+\+\d+\+\d+/g) || []).length;
      
      const positions = xrandrOutput.match(/\d+x\d+\+\d+\+\d+/g) || [];
      const uniquePositions = new Set(positions);
      
      console.log("activeDisplays-->", activeDisplays);
      console.log("connectedDisplays-->", connectedDisplays);
      
      return activeDisplays >= 2 || (connectedDisplays >= 2 && activeDisplays >= 2);
    } catch {
      // If xrandr fails, try wayland
      const { stdout: waylandOutput } = await execAsync('wlr-randr 2>/dev/null || wayland-info 2>/dev/null');
      const outputs = waylandOutput.match(/output|wl_output/g) || [];
      const activeDisplays = outputs.length;
      
      return activeDisplays >= 2;
    }
  } catch (error) {
    console.error('Error checking Linux displays:', error);
    return false;
  }
}

async function checkWindowsDisplayDuplication() {
  try {
    const command = `powershell.exe -command "Get-WmiObject WmiMonitorBasicDisplayParams -Namespace root\\wmi | Select-Object Active, InstanceName"`;
    const { stdout } = await execAsync(command);
    
    const displays = stdout.toString().trim().split('\r\n')
      .filter(line => line && !line.includes('---'));
    
    const activeDisplays = displays.filter(d => d.toLowerCase().includes('true')).length;
    const physicalDisplays = initialDisplayConfig.displayCount;
    
    console.log('Active displays:', activeDisplays, 'Physical displays:', physicalDisplays);
    
    return activeDisplays >= 2 || (activeDisplays >= 2 && physicalDisplays >= 2);
  } catch (error) {
    console.error('Error checking Windows display settings:', error);
    return false;
  }
}

function stopMonitoring() {
  if (displayCheckInterval) {
    clearInterval(displayCheckInterval);
    displayCheckInterval = null;
  }
  parentPort.postMessage({ type: 'MONITORING_STOPPED' });
}

// Cleanup on exit
process.on('exit', () => {
  if (displayCheckInterval) {
    clearInterval(displayCheckInterval);
  }
});