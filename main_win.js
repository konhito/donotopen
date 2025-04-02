const { app, BrowserWindow, Menu, globalShortcut, dialog, protocol, ipcMain, session, desktopCapturer,screen } = require("electron/main");
const { clipboard } = require('electron');
const { exec } = require("child_process");
const http = require("http");
const cors = require("cors");
const express = require("express");
const os = require("os");
const path = require('node:path');
const WebSocket = require('ws');
const { GlobalKeyboardListener } = require("node-global-key-listener");
const listener = new GlobalKeyboardListener();
let mainWindow;
const { Worker } = require('worker_threads');
let globaltoken = "";
const allowedDomains = ['examly.net', 'examly.test', 'examly.io', 'iamneo.ai','examly.in'];
let temp = 1;
let isDialogOpen = false;
let restrictionAppDialog = false;
let isExternalDisplayConnected = false;
let dialogCheckInProgress = false;
const WindowsKeyManager = require('./windows-key');
const keyManager = new WindowsKeyManager();
const MemoryManager = require('./memory-management');
let isAppInitializing = false;
const { setupKioskMode } = require('./kiosk-mode');
// const winKeyBlocker = require('./build/Release/winkeyblocker.node');
let appStatusWorker = null;
// app.enableHardwareAcceleration();
app.commandLine.appendSwitch('enable-speech-dispatcher');
// app.commandLine.appendSwitch('ignore-certificate-errors');
app.commandLine.appendSwitch('allow-insecure-localhost');
app.commandLine.appendSwitch('enable-features', 'MediaDevices,WebRTCPipeWireCapturer');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');
// app.commandLine.appendSwitch('disable-http-cache');
// app.commandLine.appendSwitch('disable-gpu-vsync');
const Logger = require('./logger');

// Initialize the logger with custom options
const logger = new Logger({
    logDirectory: path.join(app.getPath('userData'), 'logs'),
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFiles: 7, // Keep 7 days of logs
    logLevel: 'info',
    enableConsole: process.env.NODE_ENV === 'development',
    format: 'json'
});
global.webSocketServer = null;
let globalDisplayStatus = {
  status: true,
  message: null,
  APP_VERSION: "1.1.1"
};

// Add function to update global status
function updateGlobalDisplayStatus(newStatus) {
  globalDisplayStatus = {
    ...newStatus,
    APP_VERSION: "1.1.1"
  };
}

// async function showDialogWithFocus(mainWindow, options) {
//   // Temporarily exit kiosk and full-screen mode
//   mainWindow.setKiosk(false);
//   mainWindow.setFullScreen(false);
//   mainWindow.setAlwaysOnTop(false);
//   // Show the dialog
//   const result = await dialog.showMessageBox(mainWindow, options);

//   // Restore kiosk and full-screen mode
//   mainWindow.setFullScreen(true);
//   mainWindow.setKiosk(true);

//   // Ensure the main window regains focus
//   mainWindow.focus();

//   return result;
// }

function checkAppStatus() {
  return new Promise((resolve, reject) => {
    // Reuse existing worker if available
    if (!appStatusWorker) {
        appStatusWorker = new Worker(path.join(__dirname, 'blocker-app-detection.js'));
        logger.info("appStatusWorker-->", appStatusWorker);
        // memoryManager.registerWorker(appStatusWorker);
    }

    const timeout = setTimeout(() => {
        cleanupWorker(appStatusWorker);
        appStatusWorker = null;
        reject(new Error('Process check timed out'));
    }, 10000);

    function handleMessage(result) {
        clearTimeout(timeout);
        resolve(result);
    }

    function handleError(error) {
        clearTimeout(timeout);
        cleanupWorker(appStatusWorker);
        appStatusWorker = null;
        reject(error);
    }

    appStatusWorker.once('message', handleMessage);
    appStatusWorker.once('error', handleError);
    appStatusWorker.once('exit', code => {
        if (code !== 0) {
            handleError(new Error(`Worker stopped with code ${code}`));
        }
    });

    appStatusWorker.postMessage('start');
});
}

let displayMonitorWorker = null;

function startDisplayMonitoring(mainWindow) {
  if (displayMonitorWorker) {
    console.warn('Display monitoring is already running');
    return;
  }

  try {
    // Create worker
    displayMonitorWorker = new Worker(path.join(__dirname, 'display-monitor.worker.js'));
    logger.info('Display monitor worker started');
    // Set up message handling
    displayMonitorWorker.on('message', async (message) => {
      logger.info('Display monitor worker started', message);
      switch (message.type) {
        case 'DUPLICATE_DETECTED':
          // Enforce window settings
          const primaryDisplay = screen.getPrimaryDisplay();
          mainWindow.setBounds(primaryDisplay.bounds);
          mainWindow.setFullScreen(true);
          mainWindow.setAlwaysOnTop(true, 'screen-saver');
          mainWindow.setVisibleOnAllWorkspaces(true);
          mainWindow.setMovable(false);
          // mainWindow.setSkipTaskbar(true);
          // Notify worker that dialog is closed
          
          try {
            // Get current app status
            
            // Create status update
            const statusUpdate = {
              status: false,
              message: `External display monitor detected. Please disconnect it to continue.`,
            };
            updateGlobalDisplayStatus(statusUpdate);
            // Send status update through WebSocket
            if (global.webSocketServer && global.webSocketServer.clients) {
              global.webSocketServer.clients.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                  client.send(JSON.stringify({
                    type: 'remote-desktop-status',
                    data: statusUpdate
                  }));
                }
              });
            }
          } catch (error) {
            console.error('Error sending display status update:', error);
          }

          displayMonitorWorker.postMessage({ type: 'DIALOG_CLOSED' });
          // try {
                  case 'DUPLICATE_DETECTED':
                    const duplicationStatus = {
                      status: false,
                      message: `External display monitor detected. Please disconnect it to continue.`,
                    };
                    updateGlobalDisplayStatus(duplicationStatus);
                    
                    // Send update through WebSocket
                    if (global.webSocketServer && global.webSocketServer.clients) {
                        global.webSocketServer.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'remote-desktop-status',
                                    data: duplicationStatus
                                }));
                            }
                        });
                    }
                    break;
                  case 'NO_DUPLICATE_DETECTED':
                      // Reset status
                      const normalStatus = {
                          status: true,
                          message: null
                      };
                      updateGlobalDisplayStatus(normalStatus);
                      
                      // Send update through WebSocket
                      if (global.webSocketServer && global.webSocketServer.clients) {
                          global.webSocketServer.clients.forEach(client => {
                              if (client.readyState === WebSocket.OPEN) {
                                  client.send(JSON.stringify({
                                      type: 'remote-desktop-status',
                                      data: normalStatus
                                  }));
                              }
                          });
                      }
                      break;

                  case 'START_MONITORING':
                      logger.info('Display monitoring started successfully');
                      break;

                  case 'MONITORING_STOPPED':
                      logger.info('Display monitoring stopped successfully');
                      break;

                  case 'ERROR':
                      console.error('Display monitoring error:', message.error);
                      break;
      //     } catch (error) {
      //         console.error('Error handling display monitor message:', error);
          }
        });

      // Handle worker errors
      displayMonitorWorker.on('error', (error) => {
          console.error('Display monitor worker error:', error);
          cleanupWorker(displayMonitorWorker);
          displayMonitorWorker = null;
      });

      // Start monitoring with initial display state
      const initialState = {
          displayCount: screen.getAllDisplays().length,
          primaryDisplay: screen.getPrimaryDisplay().bounds
      };

      displayMonitorWorker.postMessage({ 
          type: 'START_MONITORING',
          initialState
      });

  } catch (error) {
      console.error('Error starting display monitoring:', error);
      if (displayMonitorWorker) {
          cleanupWorker(displayMonitorWorker);
          displayMonitorWorker = null;
      }
  }
}

function stopDisplayMonitoring() {
  if (displayMonitorWorker) {
    try {
        displayMonitorWorker.postMessage({ type: 'STOP_MONITORING' });
        cleanupWorker(displayMonitorWorker);
    } catch (error) {
        console.error('Error stopping display monitoring:', error);
    } finally {
        displayMonitorWorker = null;
    }
}
}

async function handleDuplicateDetection(mainWindow) {
  await mainWindow.webContents.send('display-warning', {
    message: 'Screen Mirroring Detected. Please disable it to continue.',
  });
}

class SecureWebSocketServer {
  constructor() {
    this.wss = null;
    this.activeConnections = new Map();
    this.validToken = "";
    this.TOKEN_CHECK_INTERVAL = 15000;
    this.STATUS_UPDATE_INTERVAL = 8000;
    this.appCheckWorker = null;
    this.MAX_RECONNECT_ATTEMPTS = 3;
    this.RECONNECT_DELAY = 5000; // 5 seconds
  }

  async checkAppStatus() {
    if (!this.appCheckWorker) {
      this.appCheckWorker = new Worker(path.join(__dirname, 'blocker-app-detection.js'));
      // memoryManager.registerWorker(this.appCheckWorker);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Check timeout'));
      }, 10000);

      this.appCheckWorker.once('message', (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      this.appCheckWorker.postMessage('start');
    });
  }

  start(server) {
    try {
      this.wss = new WebSocket.Server({ server });
      global.webSocketServer = this.wss;
      logger.info('WebSocket server started');
      this.setupConnectionHandlers();
    } catch (error) {
      console.error('Error starting WebSocket server:', error);
    }
  }

  setupConnectionHandlers() {
    this.wss.on('connection', async (ws) => {
      logger.info('New WebSocket connection attempt');
      try {
        const connectionInfo = this.initializeConnection(ws);
        await this.sendInitialStatus(ws);
        this.setupMessageHandlers(ws);
      } catch (error) {
        console.error('Error in connection setup:', error);
      }
    });
  }

  initializeConnection(ws) {
    const connectionInfo = {
      statusInterval: setInterval(async () => this.sendStatusUpdate(ws), this.STATUS_UPDATE_INTERVAL),
      tokenInterval: setInterval(() => this.validateToken(ws), this.TOKEN_CHECK_INTERVAL),
      lastTokenCheck: new Date()
    };
    this.activeConnections.set(ws, connectionInfo);
    return connectionInfo;
  }

  async sendInitialStatus(ws) {
    // Example call
    const result = await checkAppStatus();
    logger.info("result-->",result);
    const combinedStatus = {
      status: result.status && globalDisplayStatus.status,
      message: globalDisplayStatus.status ? result.message : globalDisplayStatus.message,
      APP_VERSION: "1.1.1",
      details: {
        appStatus: result,
        displayStatus: globalDisplayStatus
      }
    };
    // checkAppStatus().then((result) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'remote-desktop-status',
          data: combinedStatus
        }));
        logger.info("result-->",result);
      }
    // }).catch((error) => {
    //     logger.info("error-->",error);
    // }) 
  }

  async sendStatusUpdate(ws) {
    try {
      if (ws.readyState !== WebSocket.OPEN) {
        // Try to reconnect if the connection is closed
        await this.attemptReconnection(ws);
        return;
      }
      
      const result = await this.checkAppStatus();
      const combinedStatus = {
        status: result.status && globalDisplayStatus.status,
        message: globalDisplayStatus.status ? result.message : globalDisplayStatus.message,
        APP_VERSION: "1.1.1",
        details: {
          appStatus: result,
          displayStatus: globalDisplayStatus
        }
      };

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'remote-desktop-status',
          data: combinedStatus
        }));
      }
    } catch (error) {
      console.error('Status update error:', error);
      this.cleanup(ws);
    }
  }

  validateToken(ws) {
    const connectionInfo = this.activeConnections.get(ws);
    if (!connectionInfo) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'request_token_validation'
      }));
    }
  }

  handleTokenValidation(ws, token) {
    const connectionInfo = this.activeConnections.get(ws);
    if (!connectionInfo) return;

    if (token === globaltoken) {
      connectionInfo.lastTokenCheck = new Date();
      this.activeConnections.set(ws, connectionInfo);
      ws.send(JSON.stringify({
        type: 'token_validation_success'
      }));
    } else {
      console.warn('Token validation failed');
      ws.send(JSON.stringify({
        type: 'token_validation_failed'
      }));
      this.cleanup(ws);
      ws.close(4003, 'Token validation failed');
    }
  }

  setupMessageHandlers(ws) {
    ws.on('message', (message) => {
      try {
        const data = JSON.parse(message);
        if (data.type === 'token_validation') {
          this.handleTokenValidation(ws, data.token);
        }
      } catch (error) {
        console.error('Error handling message:', error);
      }
    });

    ws.on('error', (error) => {
      console.error('WebSocket error:', error);
      this.cleanup(ws);
    });

    ws.on('close', () => {
      logger.info('WebSocket connection closed');
      this.cleanup(ws);
    });
  }

  cleanup(ws) {
    try {
      const connectionInfo = this.activeConnections.get(ws);
      if (this.appCheckWorker) {
        cleanupWorker(this.appCheckWorker);
        this.appCheckWorker = null;
      }
      if (connectionInfo) {
        if (connectionInfo.statusInterval) clearInterval(connectionInfo.statusInterval);
        if (connectionInfo.tokenInterval) clearInterval(connectionInfo.tokenInterval);
        if (connectionInfo.worker) cleanupWorker(connectionInfo.worker);
        this.activeConnections.delete(ws);
        logger.info('Connection cleaned up');
      }
    } catch (error) {
      console.error('Error in cleanup:', error);
    }
  }

  async attemptReconnection(ws, attempts = 0) {
    if (attempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error('Max reconnection attempts reached');
      this.cleanup(ws);
      return;
    }

    try {
      if (ws.readyState === WebSocket.CLOSED) {
        // Create new connection
        const newWs = new WebSocket(ws.url);
        await new Promise((resolve, reject) => {
          newWs.onopen = resolve;
          newWs.onerror = reject;
        });
        
        // Replace old connection
        this.cleanup(ws);
        this.initializeConnection(newWs);
        await this.sendInitialStatus(newWs);
        this.setupMessageHandlers(newWs);
      }
    } catch (error) {
      console.error('Reconnection attempt failed:', error);
      setTimeout(() => {
        this.attemptReconnection(ws, attempts + 1);
      }, this.RECONNECT_DELAY);
    }
  }

  stop() {
    try {
      if (this.appCheckWorker) {
        cleanupWorker(this.appCheckWorker);
        this.appCheckWorker = null;
      }
      if (this.wss) {
        for (const [ws, connectionInfo] of this.activeConnections.entries()) {
          if (connectionInfo.statusInterval) clearInterval(connectionInfo.statusInterval);
          if (connectionInfo.tokenInterval) clearInterval(connectionInfo.tokenInterval);
          if (ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'Server shutting down');
          }
        }
        this.activeConnections.clear();
        this.wss.close(() => {
          logger.info('WebSocket server stopped');
        });
      }
    } catch (error) {
      console.error('Error stopping server:', error);
    }
  }
}


const memoryManager = new MemoryManager({
  heapSizeMB: 4096,
  debugMode: true  // Set to false in production
});

// Listen for memory events
memoryManager.on('high-memory', () => {
  logger.info('High memory usage detected');
});

memoryManager.on('memory-warning', (warning) => {
  logger.info('Memory warning:', warning);
});

// Add these imports at the top of the file
const { powerSaveBlocker } = require('electron');

// function blockTaskbarAccess(mainWindow) {
//   // Prevent window minimization
//   // mainWindow.setMinimizable(false);
  
//   // // Keep the app always on top
//   // mainWindow.setAlwaysOnTop(true, 'screen-saver');
  
//   // // Set kiosk mode
//   // mainWindow.setKiosk(true);
  
//   // Prevent window from being minimized programmatically
//   mainWindow.on('minimize', (event) => {
//     event.preventDefault();
//     mainWindow.restore();
//   });

//   // Platform-specific implementations
//   switch (process.platform) {
//     case 'win32':
//       // Windows-specific taskbar blocking
//       // mainWindow.setSkipTaskbar(true); // Hide from taskbar
//        // Set kiosk mode and full screen
//        mainWindow.setFullScreen(true);
//        mainWindow.setAlwaysOnTop(true, 'screen-saver');
//        mainWindow.setVisibleOnAllWorkspaces(true);
//        mainWindow.setSkipTaskbar(false);
//   // mainWindow.setSkipTaskbar(true);
      
//       // Block Windows key combinations that might show taskbar
//       const blockedWindowsShortcuts = [
//         'Super+B',     // Focus taskbar
//         'Super+T',     // Cycle taskbar
//         'Super+Space', // Language switcher/taskbar
//         'Alt+Tab',     // Task switcher
//         'Super+Tab',   // Task view
//         'Super+D',     // Show desktop
//         'Super+M'      // Minimize all
//       ];
      
//       blockedWindowsShortcuts.forEach(shortcut => {
//         globalShortcut.register(shortcut, () => {
//           mainWindow.focus();
//           return false;
//         });
//       });
//       break;

//     case 'darwin':
//       // macOS-specific taskbar blocking
//       app.dock.hide(); // Hide from dock
      
//       // Block Command+Tab and other macOS shortcuts
//       const blockedMacShortcuts = [
//         'Command+Tab',    // App switcher
//         'Command+Space',  // Spotlight
//         'Command+Option+D', // Toggle dock
//         'Control+F3'      // Mission Control
//       ];
      
//       blockedMacShortcuts.forEach(shortcut => {
//         globalShortcut.register(shortcut, () => {
//           mainWindow.focus();
//           return false;
//         });
//       });
//       break;

//     case 'linux':
//       // Linux-specific taskbar blocking
//       mainWindow.setSkipTaskbar(true);
      
//       // Block common Linux desktop shortcuts
//       const blockedLinuxShortcuts = [
//         'Super+S',     // Activities overview
//         'Super+A',     // Applications view
//         'Super+Tab',   // Window switcher
//         'Super+Space'  // Input switcher
//       ];
      
//       blockedLinuxShortcuts.forEach(shortcut => {
//         globalShortcut.register(shortcut, () => {
//           mainWindow.focus();
//           return false;
//         });
//       });
//       break;
//   }

//   // Prevent display sleep and screensaver
//   const id = powerSaveBlocker.start('prevent-display-sleep');

//   // Additional security measures
//   mainWindow.webContents.executeJavaScript(`
//     // Prevent Alt+Tab switching
//     document.addEventListener('visibilitychange', () => {
//       if (document.hidden) {
//         window.focus();
//       }
//     });

//     // Force focus back to window
//     window.addEventListener('blur', () => {
//       window.focus();
//     });

//     // Prevent context menu
//     document.addEventListener('contextmenu', (e) => {
//       e.preventDefault();
//       return false;
//     });
//   `);

//   // Clean up when window is closed
//   mainWindow.on('closed', () => {
//     globalShortcut.unregisterAll();
//     if (powerSaveBlocker.isStarted(id)) {
//       powerSaveBlocker.stop(id);
//     }
//     kioskManager.cleanupKiosk();
//   });
// }
async function createWindow(launchParams = {}) {
  // const response = await fetch(s3Url);
  // rdpApplications = await response.json();
  // if (!canProceed) return;
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: false,
      enableRemoteModule: true,
      webSecurity: true,
      sandbox: false,
      webviewTag: true,
      allowRunningInsecureContent: false,
      mediaFeatures: true,
      backgroundThrottling: false,// Optimize for video
      offscreen: false,
      permissions: ['media', 'mediaDevices', 'display-capture'],
      disableDialogs: true,
      navigateOnDragDrop: false,
      preload: path.join(__dirname, 'preload.js')
    },
    kiosk: true,
    fullscreen: true,
    frame: false,
    skipTaskbar: true
  });
  listener.addListener((event) => {
    if (event.name === "Left Windows") {
      logger.info("Windows key blocked!");
  }
  })
 
  setupSecurityFeatures();
  const kioskManager = setupKioskMode(mainWindow);
  
  // setupKeyboardBlocking(mainWindow);
  // Add display-specific window settings
  mainWindow.setFullScreen(true);
  mainWindow.setKiosk(true);
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // mainWindow.setContentProtection(true);
  setupExpressServer();
  setupIpcHandlers();
  setupWindowBehavior();
  startDisplayMonitoring(mainWindow);
  mainWindow.setMovable(false);
  mainWindow.loadFile("index.html");
  // mainWindow.loadURL("https://klu219.examly.io");
  mainWindow.webContents.openDevTools();
  // Prevent unnecessary redraws
  mainWindow.setBackgroundThrottling(false);
  // Optimize for video performance
  // mainWindow.webContents.setFrameRate(30);
  mainWindow.webContents.executeJavaScript(`
  window.addEventListener('keydown', (e) => {
    if (e.keyCode === 44) {
      e.preventDefault();
      return false;
    }
  });

  window.addEventListener('keyup', (e) => {
    if (e.keyCode === 44) {
      e.preventDefault();
      return false;
    }
  });
`);
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    // Optimize headers for video streaming
    details.requestHeaders['User-Agent'] = 'neo-browser';
    details.requestHeaders['X-Browser-version'] = app.getVersion();
    callback({         
      requestHeaders: {
        ...details.requestHeaders,
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    });
  });
  mainWindow.on('closed', () => {
    kioskManager.cleanupKiosk();
  });
}


async function checkAndNotifyApplications() {
  console.log("isDialogOpen, dialogCheckInProgress->", isDialogOpen, dialogCheckInProgress);
  // If a dialog is already open or check is in progress, don't proceed
  dialogCheckInProgress = false;
  if (isDialogOpen || dialogCheckInProgress) {
    return true;
  }
  logger.info('Checking applications...');
  try {
    dialogCheckInProgress = true;
    const result = await checkAppStatus();
    console.log('App check result:', result, restrictionAppDialog);
    if (!result.status && !restrictionAppDialog) {
      isDialogOpen = true;
      restrictionAppDialog = true;
      logger.info('Showing dialog...');
      const dialogResult = await dialog.showMessageBox(mainWindow,{
        type: 'warning',
        title: 'Applications Need to be Closed',
        message: 'Restricted Applications Detected',
        detail: result.message,
        buttons: ['Check Again', 'Exit Application'],
        defaultId: 0,
        cancelId: 1
      });
      logger.info('Dialog result:', dialogResult);
      isDialogOpen = false;
      console.log("Dialog result-->", dialogResult);
      if (dialogResult.response === 0) {
        // User clicked "Check Again"
        dialogCheckInProgress = false;
        // console.log("Checking ")
        console.log('Checking applications again...');
        return checkAndNotifyApplications();
      } else {
        // User clicked "Exit Application"
        app.quit();
        return false;
      }
    } else {
      if (!result.status && restrictionAppDialog) {
        restrictionAppDialog = false;
        return checkAndNotifyApplications();
      }
      return true;
    }
    
    dialogCheckInProgress = false;
  } catch (error) {
    console.error('Error checking applications:', error);
    if (!isDialogOpen) {
      isDialogOpen = true;
      await dialog.showErrorBox(
        'Error',
        'Failed to check running applications. Please restart the application.'
      );
      isDialogOpen = false;
    }
    app.quit();
    return false;
  }
}



function setupExpressServer() {
  const expressApp = express();
  expressApp.use(cors());

  expressApp.get("/status", async (req, res) => {
    logger.info('Checking status...');
    try {
        const result = await checkAppStatus();
        const combinedStatus = {
          ...result,
          status: result.status && globalDisplayStatus.status, // Both must be true for overall true status
          message: globalDisplayStatus.status ? result.message : globalDisplayStatus.message,
          APP_VERSION: "1.1.1",
          browser_used: "neo-browser",
          details: {
            appStatus: result,
            displayStatus: globalDisplayStatus
          }
        };
        const base64Result = jsonToBase64(combinedStatus);
        return res.status(200).send(base64Result);
    } catch (error) {
      console.error("Error in /status:", error);
      return res.status(500).send(jsonToBase64({ status: false, message: "Internal server error" }));
    }
  });

  expressApp.get("/info", (req, res) => {
    res.status(200).send("This is iamneo secure browser. All systems are operational.");
  });

  expressApp.get("/", (req, res) => {
    res.status(200).send("Welcome to the iamneo secure browser");
  });

  const server = http.createServer(expressApp);
  const secureWss = new SecureWebSocketServer();
  global.webSocketServer = secureWss;
  secureWss.start(server);

  server.listen(9999, () => {
    logger.info("Server running on port 9999");
  });
}

function setupIpcHandlers() {
  logger.info('Setting up IPC handlers');
  mainWindow.webContents.on('did-navigate', async (event, url) => {
    try {
      const urlObj = new URL(url);
      const isDashboard = urlObj.pathname.includes('/dashboard');
      logger.info("isDashboard",isDashboard);
      mainWindow.webContents.send('update-toolbar-visibility', {
        shouldHideToolbar: isDashboard
      });
    } catch (error) {
      console.error('Error handling navigation:', error);
    }
  });
  
  ipcMain.handle('navigate-to-url', async (event, url) => {
    logger.info('Navigating to URL:', url);
    try {
      // Ensure URL has protocol
      if (!/^https?:\/\//i.test(url)) {
        url = 'https://' + url;
      }
  
      let urlObj;
      try {
        urlObj = new URL(url);
      } catch (e) {
        return { 
          success: false, 
          error: 'Invalid URL format' 
        };
      }
  
      // Check if domain is allowed
      const isAllowed = allowedDomains.some(domain => 
        urlObj.hostname.toLowerCase().includes(domain.toLowerCase())
      );
  
      if (!isAllowed) {
        return { 
          success: false, 
          error: 'This domain is not allowed. You can only access examly domains.' 
        };
      }
  
      // Check if it's a dashboard URL
      const isDashboard = urlObj.pathname.includes('/dashboard');
      
      // Load the URL
      await mainWindow.loadURL(url);
      
      // Notify renderer about toolbar visibility
      // mainWindow.webContents.send('update-toolbar-visibility', {
      //   shouldHideToolbar: isDashboard
      // });
  
      return { 
        success: true, 
        url: mainWindow.webContents.getURL(),
        
      };
    } catch (error) {
      console.error('Navigation error:', error);
      return { 
        success: false, 
        error: 'Navigation failed: ' + error.message 
      };
    }
  });
  
  ipcMain.handle('get-screen-sources', async () => {
    try {
      return await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 150, height: 150 }
      });
    } catch (error) {
      console.error('Error getting screen sources:', error);
      throw error;
    }
  });

  // Add a new IPC handler to check display status
  ipcMain.handle('check-display-status', () => {
    return {
      isExternalDisplayConnected,
      canNavigate: !isExternalDisplayConnected
    };
  });


  // ipcMain.handle('get-media-sources', async () => {
  //   try {
  //     return await desktopCapturer.getSources({
  //       types: ['window', 'screen', 'camera'],
  //       thumbnailSize: { width: 0, height: 0 }
  //     });
  //   } catch (error) {
  //     console.error('Error getting sources:', error);
  //     throw error;
  //   }
  // });

  ipcMain.handle('update-params', async (event, params) => {
    try {
      const parsedData = params.data;
      const tokenData = JSON.parse(parsedData)?.token;
      globaltoken = tokenData;
      mainWindow.webContents.send('params-processed', { status: 'success' });
      return { success: true, message: 'Parameters processed successfully' };
    } catch (error) {
      console.error('Error processing parameters:', error);
      return { success: false, message: 'Failed to process parameters', error: error.message };
    }
  });

  ipcMain.handle('get-processes', async () => {
    try {
      return await getRemoteDesktopAppStatus();
    } catch (error) {
      console.error("Error in get-processes:", error);
      throw error;
    }
  });


  // ipcMain.handle('exit-app', () => {
    
  //   dialog.showMessageBox(mainWindow, {
  //     type: 'question',
  //     title: 'Confirm Exit',
  //     message: 'Are you sure you want to exit?',
  //     buttons: ['Yes', 'No'],
  //     defaultId: 1,
  //     cancelId: 1
  //   }).then(async result => {
  //     logger.info('Exit dialog result:', result);
  //     memoryManager.stop();
  //     stopDisplayMonitoring();
  //     if (result.response === 0) {
  //       const result = await keyManager.restoreWindowsKey();
  //       mainWindow.on('closed', () => {
  //         kioskManager.cleanupKiosk();
  //       });
  //       if(result.success){
  //         app.quit();
  //       }else{
  //         console.error('Failed to restore Windows key settings:', result.error);
  //       }
  //     }
  //   });
  // });

  ipcMain.handle('exit-app', async () => {
    logger.info('Exit handler triggered');
    
    try {
      // Skip dialog and proceed directly with cleanup
      logger.info('Starting cleanup process...');
      
      // Unregister shortcuts
      globalShortcut.unregisterAll();
      logger.info('Global shortcuts unregistered');
  
      // Reset window state
      if (!mainWindow.isDestroyed()) {
        // mainWindow.setKiosk(false);
        // mainWindow.setFullScreen(false);
        // mainWindow.setAlwaysOnTop(false);
        logger.info('Window state reset');
      }
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Confirm Exit',
        message: 'Are you sure you want to exit?',
        buttons: ['Yes', 'No'],
        defaultId: 1,
        cancelId: 1
      }).then(async result => {
        logger.info('Exit dialog result:', result);
        memoryManager.stop();
        stopDisplayMonitoring();
        if (result.response === 0) {
          // app.exit();
          const result = await keyManager.restoreWindowsKey();
          if(result.success){
            isAppInitialized = false;
            hasShownDialog = false;
            app.exit();
          }else{
            console.error('Failed to restore Windows key settings:', result.error);
          }
        }
      });
      // Platform specific cleanup
      // if (process.platform === 'win32') {
      //   logger.info('Restoring Windows key...');
      //   const result = await keyManager.restoreWindowsKey();
      //   if (!result.success) {
      //     console.error('Failed to restore Windows key:', result.error);
      //   } else {
      //       logger.info('Windows key restored successfully');
      //       // Memory manager cleanup
      //       if (memoryManager) {
      //         memoryManager.stop();
      //         logger.info('Memory manager stopped');
      //       }
        
      //       // Display monitoring cleanup
      //       stopDisplayMonitoring();
      //       logger.info('Display monitoring stopped');
      //       // Quit the app
      //       }
      // }

      // return { success: true };
      
    } catch (error) {
      console.error('Error during exit:', error);
      return { success: false, error: error.message };
    }
  });
}



function setupSecurityFeatures() {
  // Existing switches
  app.commandLine.appendSwitch('disable-frame-rate-limit');
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  
  // Add performance-related switches
  app.commandLine.appendSwitch('enable-gpu-rasterization');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
  app.commandLine.appendSwitch('enable-hardware-overlays');
  
  // Memory management switches
  app.commandLine.appendSwitch('disk-cache-size', '104857600'); // 100MB cache
  //  app.commandLine.appendSwitch('js-flags', '--max-old-space-size=2048'); // Limit memory usage

  app.commandLine.appendSwitch('disable-http-cache');
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('enable-zero-copy');
  app.commandLine.appendSwitch('enable-gpu-rasterization');


    
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'clipboard-read' || permission === 'clipboard-write') {
      callback(false); // Deny clipboard permissions
    } else {
      // Keep existing permission handling logic
      const url = webContents.getURL();
      const allowedDomains = ['examly.test', 'examly.net', 'examly.io', 'iamneo.ai', 'examly.in'];
      try {
        const urlObj = new URL(url);
        const isAllowedDomain = allowedDomains.some(domain => 
          urlObj.hostname.toLowerCase().includes(domain.toLowerCase())
        );
        callback(isAllowedDomain);
      } catch (error) {
        callback(false);
      }
    }
  });

  // 2. Block clipboard API access
  mainWindow.webContents.session.webRequest.onBeforeRequest({
    urls: ['*://*/*']
  }, (details, callback) => {
    if (details.url.includes('clipboard')) {
      callback({ cancel: true });
    } else {
      callback({ cancel: false });
    }
  });

  // 3. Inject clipboard blocking script
  // mainWindow.webContents.on('dom-ready', () => {
  
  // });

  // 4. Handle IPC events for clipboard
  ipcMain.handle('clipboard-operation', async (event, operation) => {
    return { success: false, message: 'Clipboard operations are disabled' };
  });

  // 5. Override electron clipboard module
  const { clipboard } = require('electron');
  Object.defineProperty(global, 'clipboard', {
    value: {
      readText: () => '',
      writeText: () => {},
      readHTML: () => '',
      writeHTML: () => {},
      clear: () => {},
    },
    writable: false,
    configurable: false
  });




  // Enhanced keyboard blocking with copy-paste combinations
  let blockedKeys = [
    'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
    'Tab', 'Control', 'Alt', 'Meta', 'OS', 'Windows', 'Super',
    'PrintScreen', 'ScrollLock', 'Pause', 'Insert',
    'ContextMenu', 'Apps'
  ];



  const blockedCombinations = [
    // System keys
    'Alt', 'Control', 'Meta', 'Super', 'OS',
    'Alt+Tab', 'Control+Tab',
    'Alt+F4', 'Alt+Escape', 'Alt+Space',
    'Control+Escape', 'Control+Alt+Delete', 'Control+Shift+Escape',
    
    // Function keys and their combinations
    ...[...Array(12)].map((_, i) => `F${i + 1}`),
    ...[...Array(12)].map((_, i) => `Control+F${i + 1}`),
    ...[...Array(12)].map((_, i) => `Alt+F${i + 1}`),
    ...[...Array(12)].map((_, i) => `Shift+F${i + 1}`),
    
    // Copy paste combinations
    'Control+C', 'Control+V', 'Control+X',
    'Control+Insert', 'Shift+Insert',
    'Control+Shift+C', 'Control+Shift+V',
    'Control+A', // Select all
  ];

  // Register global shortcuts
  globalShortcut.unregisterAll();
  blockedCombinations.forEach(combo => {
    try {
      globalShortcut.register(combo, () => false);
    } catch (error) {
      logger.info(`Failed to register shortcut: ${combo}`);
    }
  });

  globalShortcut.register('PrintScreen', () => {
    return false; // Blocks the PrintScreen key
  });
  // Enhanced keyboard event handling for the main window
  mainWindow.webContents.on('before-input-event', (event, input) => {
    // Block Windows/Command key and combinations
    if (input.meta || input.key === 'Meta' || input.key === 'Super' || 
        input.key === 'OS' || input.metaKey || input.windowsKey) {
      event.preventDefault();
      return false;
    }

    // Block copy-paste combinations
    if ((input.ctrlKey) ||
        (input.metaKey)) {
      event.preventDefault();
      return false;
    }

    // Block specific key combinations
    if ((input.ctrlKey && input.altKey) || 
        (input.ctrlKey) ||
        (input.altKey)) {
      event.preventDefault();
      return false;
    }

    // Block individual keys
    if (blockedKeys.includes(input.key)) {
      event.preventDefault();
      return false;
    }
  });

  // Inject JavaScript to handle keyboard events at DOM level
  mainWindow.webContents.on('dom-ready', () => {
    mainWindow.webContents.executeJavaScript(`
    // Block context menu
      document.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        return false;
      }, true);

      // Block copy-paste events
      document.addEventListener('copy', (e) => {
        e.preventDefault();
        return false;
      }, true);

      document.addEventListener('paste', (e) => {
        e.preventDefault();
        return false;
      }, true);

      document.addEventListener('cut', (e) => {
        e.preventDefault();
        return false;
      }, true);

      // Enhanced keyboard event blocking
      document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.key === 'Meta' || e.key === 'OS' || 
            e.key === 'Super' || e.windowsKey || 
            (e.ctrlKey && e.altKey) || 
            (e.ctrlKey) ||
            (e.altKey) ||
            (e.ctrlKey && (e.key === 'c' || e.key === 'v' || e.key === 'x')) ||
            (e.metaKey && (e.key === 'c' || e.key === 'v' || e.key === 'x')) ||
            ['Meta', 'Super', 'OS', 'Windows', 'Tab', 'Escape', 
            'PrintScreen', 'ScrollLock', 'Pause', 'Insert',
            'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 
            'F7', 'F8', 'F9', 'F10', 'F11', 'F12'].includes(e.key)) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }, true);

      // Disable text selection
      document.addEventListener('selectstart', (e) => {
        e.preventDefault();
        return false;
      }, true);

      // Rest of the existing event listeners...
      document.addEventListener('keyup', (e) => {
        if (e.key === 'Meta' || e.key === 'OS' || e.key === 'Super' || 
            e.metaKey || e.windowsKey) {
          e.preventDefault();
          e.stopPropagation();
          return false;
        }
      }, true);

      window.addEventListener('blur', (e) => {
        window.focus();
      });

      window.addEventListener('visibilitychange', (e) => {
        if (document.hidden) {
          window.focus();
        }
      });
    `, true);
  });

  // const { session } = require('electron');

  app.on('web-contents-created', (event, contents) => {
    logger.info("web contents created changed.......................")
    contents.session.setPermissionRequestHandler((webContents, permission, callback) => {
      if (permission === 'media') {
        callback(true); // Allow media access
      } else {
        callback(false); // Deny other permissions
      }
    });
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const url = details.requestingUrl;
    const allowedDomains = ['examly.test', 'examly.net', 'examly.io', 'iamneo.ai', 'examly.in'];
    
    try {
      const urlObj = new URL(url);
      const isAllowedDomain = allowedDomains.some(domain => 
        urlObj.hostname.toLowerCase().includes(domain.toLowerCase())
      );

      // List of permissions that require special handling
      const mediaPermissions = ['media', 'camera', 'microphone', 'display-capture'];
      
      if (isAllowedDomain && mediaPermissions.includes(permission)) {
        // Allow media permissions for allowed domains regardless of protocolw
        callback(true);
      } else {
        // For other permissions, only allow on HTTPS or specific HTTP domains
        const isHttpAllowed = urlObj.protocol === 'http:' && isAllowedDomain;
        const isHttpsAllowed = urlObj.protocol === 'https:';
        
        callback(isHttpsAllowed || isHttpAllowed);
      }
    } catch (error) {
      console.error('Error checking URL permissions:', error);
      callback(false);
    }
  });

  // Update content security policy to allow media on HTTP
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' http: https: data: blob:;",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:;",
          "style-src 'self' 'unsafe-inline' http: https:;",
          "img-src 'self' data: http: https: blob:;",
          "media-src 'self' http: https: blob:;",
          "connect-src 'self' http: https:;",
          "font-src 'self' data: http: https:;"
        ].join(' ')
      }
    });
  });

  // Add additional security features for media access
  const additionalSwitches = [
    'enable-features=MediaDevices,MediaStreamAPI,WebRTC',
    'allow-insecure-localhost',
    'allow-running-insecure-content'
  ];

  additionalSwitches.forEach(switch_ => {
    app.commandLine.appendSwitch(switch_);
  });

  // Block navigation to external URLs
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowedDomains = ['examly.net', 'examly.test', 'examly.io', 'iamneo.ai', 'examly.in'];
    try {
      const urlObj = new URL(url);
      const isAllowed = allowedDomains.some(domain => 
        urlObj.hostname.toLowerCase().includes(domain.toLowerCase())
      );
      if (!isAllowed) {
        event.preventDefault();
      }
    } catch (error) {
      event.preventDefault();
    }
  });

  try {
    clipboard.clear();
    Object.defineProperty(clipboard, 'readText', { value: () => '' });
    Object.defineProperty(clipboard, 'writeText', { value: () => {} });
    Object.defineProperty(clipboard, 'readHTML', { value: () => '' });
    Object.defineProperty(clipboard, 'writeHTML', { value: () => {} });
    Object.defineProperty(clipboard, 'clear', { value: () => {} });
  } catch (error) {
    console.error('Failed to override clipboard:', error);
  }
}

function setupWindowBehavior() {
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('electron-app-ready');
  });

  Menu.setApplicationMenu(null);
}

async function handleCustomProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient('neoexam', process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient('neoexam');
  }

  app.on('open-url', (event, url) => {
    const urlObj = new URL(url);
    const params = Object.fromEntries(urlObj.searchParams);
    if (mainWindow) {
      mainWindow.webContents.send('received-params', params);
      mainWindow.webContents.send('app-launch-params', params);
    } else {
      createWindow();
      mainWindow.webContents.on('did-finish-load', () => {
        mainWindow.webContents.send('received-params', params);
        mainWindow.webContents.send('app-launch-params', params);
      });
    }
  });
}

function handleErrors() {
  process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    dialog.showErrorBox('Application Error', 'An unexpected error occurred. The application will now close.');
    app.quit();
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    dialog.showErrorBox('Application Error', 'A critical error occurred. The application will now close.');
    app.quit();
  });
}



function jsonToBase64(jsonData) {
  return Buffer.from(JSON.stringify(jsonData), "utf-8").toString("base64");
}

if (process.platform === 'win32') {
  const gotTheLock = app.requestSingleInstanceLock();
  
  if (!gotTheLock) {
    // Another instance is already running, show message and quit
    app.on('ready', () => {
      dialog.showMessageBoxSync({
        type: 'info',
        title: 'Neo Browser',
        message: 'Neo Browser is already running',
        detail: 'Please use the existing window.',
        buttons: ['OK']
      });
      app.quit();
    });
  } else {
    // This is the first instance
    app.on('second-instance', (event, commandLine, workingDirectory) => {
      // Show alert and focus existing window
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBoxSync({
          type: 'info',
          title: 'Neo Browser',
          message: 'Neo Browser is already running',
          detail: 'Please use the existing window.',
          buttons: ['OK']
        });
  
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
        mainWindow.show();
      }
    });
    app.whenReady().then(async () => {
      // Prevent multiple initializations
      if (isAppInitializing) return;
      isAppInitializing = true;
  
      try {
        handleCustomProtocol();
        
        const isAppOpen = await checkAndNotifyApplications();
        if (!isAppOpen) {
          isAppInitializing = false;
          app.quit();
          return;
        }
  
        const result = await keyManager.disableWindowsKey();
        if (!result.success) {
          isAppInitializing = false;
          if (result.cancelled) {
            logger.info('User denied permission. Exiting application...');
            app.quit();
          } else {
            console.error('Failed to disable Windows key:', result.error);
            app.quit();
          }
          return;
        }
  
        logger.info('Windows key disabled successfully');
        memoryManager.start();
        await createWindow();
        handleErrors();
        
      } catch (error) {
        console.error('Error during initialization:', error);
        isAppInitializing = false;
        app.quit();
      } finally {
        isAppInitializing = false;
      }
    });
  }
}

app.on("window-all-closed", async () => {
  memoryManager.stop();
    stopDisplayMonitoring();
    
    if (displayMonitorWorker) {
        cleanupWorker(displayMonitorWorker);
        displayMonitorWorker = null;
    }

    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on('before-quit', async(event) => {
  memoryManager.stop();
    stopDisplayMonitoring();
    
    if (displayMonitorWorker) {
        cleanupWorker(displayMonitorWorker);
        displayMonitorWorker = null;
    }

    try {
    } catch (error) {
        console.error('Error during cleanup:', error);
        app.exit(1);
    }
});
ipcMain.handle('go-back', () => {
  if (mainWindow.webContents.canGoBack()) {
    mainWindow.webContents.goBack();
    return true;
  }
  return false;
});

ipcMain.handle('go-forward', () => {
  if (mainWindow.webContents.canGoForward()) {
    mainWindow.webContents.goForward();
    return true;
  }
  return false;
});

ipcMain.handle('refresh-page', () => {
  mainWindow.webContents.reload();
  return true;
});

ipcMain.handle('check-media-permissions', async () => {
  return true;
});

ipcMain.handle('get-screen-stream', async (event, sourceId) => {
  try {
    return { sourceId };
  } catch (error) {
    console.error('Error getting screen stream:', error);
    throw error;
  }
});

ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event) => {
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 150, height: 150 }
    });
    return sources;
  } catch (error) {
    console.error('Error getting sources:', error);
    throw error;
  }
});

ipcMain.on('get-remote-desktop-status', async (event) => {
  try {
    // Example call
    const result = await checkAppStatus();
    // checkAppStatus().then((result) => {
      event.reply('remote-desktop-status', {
        status: result.status,
        message: result.message
      // });
    })    
  } catch (error) {
    console.error('Error in get-remote-desktop-status:', error);
    event.reply('remote-desktop-status', { 
      status: false, 
      message: "Error checking remote desktop status" 
    });
  }
});

ipcMain.on('ping-test', (event) => {
  logger.info('Main: Received ping from renderer');
  event.reply('pong-test');
});

ipcMain.on('update-params', (event, params) => {
  logger.info('Main: Received ping from renderer', params);
});

ipcMain.on('params-to-main', (event, params) => {
  logger.info('Received parameters in main process:', params);
});

// Handle sudden termination
process.on('SIGTERM', async () => {
  try {
      await keyManager.restoreWindowsKey();
      app.quit();
  } catch (error) {
      console.error('Error during SIGTERM cleanup:', error);
      process.exit(1);
  }
});

function cleanupWorker(worker) {
  if (!worker) return;
  try {
      worker.terminate();
  } catch (error) {
      console.error('Error terminating worker:', error);
  }
}