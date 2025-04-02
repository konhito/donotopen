const {
  app,
  BrowserWindow,
  Menu,
  globalShortcut,
  dialog,
  protocol,
  ipcMain,
  session,
  desktopCapturer,
  screen,
} = require("electron/main");
const { exec } = require("child_process");
const http = require("http");
const cors = require("cors");
const express = require("express");
const os = require("os");
const path = require("node:path");
const WebSocket = require("ws");
let mainWindow;
const { Worker } = require("worker_threads");
let globaltoken = "";
const allowedDomains = [
  "examly.net",
  "examly.test",
  "examly.io",
  "iamneo.ai",
  "examly.in",
  "chromewebstore.google.com",
];
const { spawn } = require("child_process");
let temp = 1;
let isDialogOpen = false;
let restrictionAppDialog = false;
let isExternalDisplayConnected = false;
let dialogCheckInProgress = false;
let isAppInitializing = true;
const MemoryManager = require("./memory-management");
const { setupKioskMode } = require("./kiosk-mode");
let appStatusWorker = null;
// app.enableHardwareAcceleration();
app.commandLine.appendSwitch("enable-speech-dispatcher");
app.commandLine.appendSwitch("auto-select-desktop-capture-source", "Screen 1");
app.commandLine.appendSwitch("ignore-certificate-errors");
app.commandLine.appendSwitch("allow-insecure-localhost");
app.commandLine.appendSwitch(
  "enable-features",
  "MediaDevices,WebRTCPipeWireCapturer"
);
app.commandLine.appendSwitch("enable-usermedia-screen-capturing");
app.commandLine.appendSwitch("allow-http-screen-capture");
app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
app.commandLine.appendSwitch("js-flags", "--max-old-space-size=4096");
// app.commandLine.appendSwitch('disable-http-cache');
// app.commandLine.appendSwitch('disable-gpu-vsync');
global.webSocketServer = null;
let globalDisplayStatus = {
  status: true,
  message: null,
  APP_VERSION: "1.1.1",
};

// Add function to update global status
function updateGlobalDisplayStatus(newStatus) {
  globalDisplayStatus = {
    ...newStatus,
    APP_VERSION: "1.1.1",
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
      appStatusWorker = new Worker(
        path.join(__dirname, "blocker-app-detection.js")
      );
      // memoryManager.registerWorker(appStatusWorker);
    }

    const timeout = setTimeout(() => {
      cleanupWorker(appStatusWorker);
      appStatusWorker = null;
      reject(new Error("Process check timed out"));
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

    appStatusWorker.once("message", handleMessage);
    appStatusWorker.once("error", handleError);
    appStatusWorker.once("exit", (code) => {
      if (code !== 0) {
        handleError(new Error(`Worker stopped with code ${code}`));
      }
    });

    appStatusWorker.postMessage("start");
  });
}

let displayMonitorWorker = null;
// Cross-platform display security implementation
function startDisplayMonitoring(mainWindow) {
  if (displayMonitorWorker) {
    console.warn("Display monitoring is already running");
    return;
  }

  try {
    displayMonitorWorker = new Worker(
      path.join(__dirname, "display-monitor.worker.js")
    );
    console.log("Display monitor worker started");

    displayMonitorWorker.on("message", async (message) => {
      console.log("Display monitor message received:", message);

      switch (message.type) {
        case "DUPLICATE_DETECTED":
          const duplicationStatus = {
            status: false,
            message: `External display monitor detected. Please disconnect it to continue.`,
          };
          updateGlobalDisplayStatus(duplicationStatus);

          // Send update through WebSocket
          if (global.webSocketServer && global.webSocketServer.clients) {
            global.webSocketServer.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: "remote-desktop-status",
                    data: duplicationStatus,
                  })
                );
              }
            });
          }
          break;

        case "NO_DUPLICATE_DETECTED":
          const normalStatus = {
            status: true,
            message: null,
          };
          updateGlobalDisplayStatus(normalStatus);

          // Send update through WebSocket
          if (global.webSocketServer && global.webSocketServer.clients) {
            global.webSocketServer.clients.forEach((client) => {
              if (client.readyState === WebSocket.OPEN) {
                client.send(
                  JSON.stringify({
                    type: "remote-desktop-status",
                    data: normalStatus,
                  })
                );
              }
            });
          }
          break;

        case "START_MONITORING":
          console.log(
            "Display monitoring started with",
            message.initialDisplays,
            "displays"
          );
          break;

        case "ERROR":
          console.error("Display monitoring error:", message.error);
          break;
      }
    });

    // Handle worker errors
    displayMonitorWorker.on("error", (error) => {
      console.error("Display monitor worker error:", error);
      cleanupWorker(displayMonitorWorker);
      displayMonitorWorker = null;
    });

    // Start monitoring
    displayMonitorWorker.postMessage({
      type: "START_MONITORING",
      initialState: {
        displayCount: screen.getAllDisplays().length,
        primaryDisplay: screen.getPrimaryDisplay().bounds,
      },
    });
  } catch (error) {
    console.error("Error starting display monitoring:", error);
    if (displayMonitorWorker) {
      cleanupWorker(displayMonitorWorker);
      displayMonitorWorker = null;
    }
  }
}

function stopDisplayMonitoring() {
  if (displayMonitorWorker) {
    try {
      displayMonitorWorker.postMessage({ type: "STOP_MONITORING" });
      cleanupWorker(displayMonitorWorker);
    } catch (error) {
      console.error("Error stopping display monitoring:", error);
    } finally {
      displayMonitorWorker = null;
    }
  }
}

async function handleDuplicateDetection(mainWindow) {
  await mainWindow.webContents.send("display-warning", {
    message: "Screen Mirroring Detected. Please disable it to continue.",
  });
}

class SecureWebSocketServer {
  constructor() {
    this.wss = null;
    this.activeConnections = new Map();
    this.reconnectAttempts = new Map();
    this.MAX_RECONNECT_ATTEMPTS = 3;
    this.RECONNECT_INTERVAL = 5000;
    this.STATUS_UPDATE_INTERVAL = 8000;
  }
  async checkAppStatus() {
    if (!this.appCheckWorker) {
      this.appCheckWorker = new Worker(
        path.join(__dirname, "blocker-app-detection.js")
      );
      // memoryManager.registerWorker(this.appCheckWorker);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Check timeout"));
      }, 10000);

      this.appCheckWorker.once("message", (result) => {
        clearTimeout(timeout);
        resolve(result);
      });

      this.appCheckWorker.postMessage("start");
    });
  }
  start(server) {
    try {
      this.wss = new WebSocket.Server({ server });
      global.webSocketServer = this.wss;
      console.log("WebSocket server started");
      this.setupConnectionHandlers();
    } catch (error) {
      console.error("Error starting WebSocket server:", error);
    }
  }

  setupConnectionHandlers() {
    this.wss.on("connection", async (ws) => {
      console.log("New WebSocket connection attempt");
      try {
        const connectionInfo = this.initializeConnection(ws);
        await this.sendInitialStatus(ws);
        this.setupMessageHandlers(ws);

        // Reset reconnection attempts on successful connection
        this.reconnectAttempts.set(ws, 0);
      } catch (error) {
        console.error("Error in connection setup:", error);
        this.handleConnectionError(ws, error);
      }
    });
  }

  initializeConnection(ws) {
    const connectionInfo = {
      statusInterval: setInterval(
        async () => this.sendStatusUpdate(ws),
        this.STATUS_UPDATE_INTERVAL
      ),
      lastActivity: Date.now(),
      isAlive: true,
    };
    this.activeConnections.set(ws, connectionInfo);
    return connectionInfo;
  }

  async sendInitialStatus(ws) {
    try {
      const result = await checkAppStatus();
      const combinedStatus = {
        status: result.status && globalDisplayStatus.status,
        message: globalDisplayStatus.status
          ? result.message
          : globalDisplayStatus.message,
        APP_VERSION: "1.1.1",
        details: {
          appStatus: result,
          displayStatus: globalDisplayStatus,
        },
      };

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "remote-desktop-status",
            data: combinedStatus,
          })
        );
      }
    } catch (error) {
      console.error("Error sending initial status:", error);
      this.handleConnectionError(ws, error);
    }
  }

  async sendStatusUpdate(ws) {
    try {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error("WebSocket not open");
      }

      const result = await checkAppStatus();
      const combinedStatus = {
        status: result.status && globalDisplayStatus.status,
        message: globalDisplayStatus.status
          ? result.message
          : globalDisplayStatus.message,
        APP_VERSION: "1.1.1",
        details: {
          appStatus: result,
          displayStatus: globalDisplayStatus,
        },
      };

      ws.send(
        JSON.stringify({
          type: "remote-desktop-status",
          data: combinedStatus,
        })
      );

      // Update last activity timestamp
      const connectionInfo = this.activeConnections.get(ws);
      if (connectionInfo) {
        connectionInfo.lastActivity = Date.now();
        this.activeConnections.set(ws, connectionInfo);
      }
    } catch (error) {
      console.error("Status update error:", error);
      this.handleConnectionError(ws, error);
    }
  }

  setupMessageHandlers(ws) {
    ws.on("message", (message) => {
      try {
        const data = JSON.parse(message);
        // Update last activity timestamp on any message
        const connectionInfo = this.activeConnections.get(ws);
        if (connectionInfo) {
          connectionInfo.lastActivity = Date.now();
          connectionInfo.isAlive = true;
          this.activeConnections.set(ws, connectionInfo);
        }
      } catch (error) {
        console.error("Error handling message:", error);
      }
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
      this.handleConnectionError(ws, error);
    });

    ws.on("close", () => {
      console.log("WebSocket connection closed");
      this.handleConnectionClose(ws);
    });

    // Setup ping-pong for connection health check
    ws.on("pong", () => {
      const connectionInfo = this.activeConnections.get(ws);
      if (connectionInfo) {
        connectionInfo.isAlive = true;
        this.activeConnections.set(ws, connectionInfo);
      }
    });
  }

  handleConnectionError(ws, error) {
    console.error("Connection error:", error);
    const attempts = this.reconnectAttempts.get(ws) || 0;

    if (attempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts.set(ws, attempts + 1);
      setTimeout(() => this.attemptReconnect(ws), this.RECONNECT_INTERVAL);
    } else {
      console.log("Max reconnection attempts reached, cleaning up connection");
      this.cleanup(ws);
    }
  }

  handleConnectionClose(ws) {
    const attempts = this.reconnectAttempts.get(ws) || 0;

    if (attempts < this.MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts.set(ws, attempts + 1);
      setTimeout(() => this.attemptReconnect(ws), this.RECONNECT_INTERVAL);
    } else {
      this.cleanup(ws);
    }
  }

  attemptReconnect(ws) {
    try {
      if (ws.readyState === WebSocket.CLOSED) {
        // Create new connection with same parameters
        const newWs = new WebSocket(ws.url);
        this.setupMessageHandlers(newWs);
        this.initializeConnection(newWs);
      }
    } catch (error) {
      console.error("Reconnection attempt failed:", error);
      this.cleanup(ws);
    }
  }

  cleanup(ws) {
    try {
      const connectionInfo = this.activeConnections.get(ws);
      if (connectionInfo) {
        if (connectionInfo.statusInterval) {
          clearInterval(connectionInfo.statusInterval);
        }
        this.activeConnections.delete(ws);
        this.reconnectAttempts.delete(ws);
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    } catch (error) {
      console.error("Error in cleanup:", error);
    }
  }

  stop() {
    try {
      if (this.wss) {
        for (const [ws, connectionInfo] of this.activeConnections.entries()) {
          this.cleanup(ws);
        }
        this.wss.close(() => {
          console.log("WebSocket server stopped");
        });
      }
    } catch (error) {
      console.error("Error stopping server:", error);
    }
  }

  // Health check monitor
  startHealthCheck() {
    setInterval(() => {
      this.activeConnections.forEach((connectionInfo, ws) => {
        if (!connectionInfo.isAlive) {
          console.log("Connection dead, initiating cleanup");
          return this.handleConnectionError(
            ws,
            new Error("Health check failed")
          );
        }

        connectionInfo.isAlive = false;
        this.activeConnections.set(ws, connectionInfo);

        try {
          ws.ping();
        } catch (error) {
          this.handleConnectionError(ws, error);
        }
      });
    }, 30000); // Check every 30 seconds
  }
}

// const memoryManager = new MemoryManager({
//   heapSizeMB: 4096,
//   debugMode: true  // Set to false in production
// });

// // Listen for memory events
// memoryManager.on('high-memory', () => {
//   console.log('High memory usage detected');
// });

// memoryManager.on('memory-warning', (warning) => {
//   console.log('Memory warning:', warning);
// });

// Add these imports at the top of the file
const { powerSaveBlocker } = require("electron");

function blockTaskbarAccess(mainWindow) {
  // Prevent window minimization
  // mainWindow.setMinimizable(false);

  // // Keep the app always on top
  // mainWindow.setAlwaysOnTop(true, 'screen-saver');

  // // Set kiosk mode
  // mainWindow.setKiosk(true);

  // Prevent window from being minimized programmatically
  mainWindow.on("minimize", (event) => {
    event.preventDefault();
    mainWindow.restore();
  });

  // Platform-specific implementations
  switch (process.platform) {
    case "win32":
      // Windows-specific taskbar blocking
      // mainWindow.setSkipTaskbar(true); // Hide from taskbar
      // Set kiosk mode and full screen
      mainWindow.setFullScreen(true);
      mainWindow.setAlwaysOnTop(true, "screen-saver");
      mainWindow.setVisibleOnAllWorkspaces(true);
      mainWindow.setSkipTaskbar(false);
      // mainWindow.setSkipTaskbar(true);

      // Block Windows key combinations that might show taskbar
      const blockedWindowsShortcuts = [
        // Minimize all
      ];

      blockedWindowsShortcuts.forEach((shortcut) => {
        globalShortcut.register(shortcut, () => {
          mainWindow.focus();
          return false;
        });
      });
      break;

    case "darwin":
      // macOS-specific taskbar blocking
      app.dock.hide(); // Hide from dock

      // Block Command+Tab and other macOS shortcuts
      const blockedMacShortcuts = [];

      blockedMacShortcuts.forEach((shortcut) => {
        globalShortcut.register(shortcut, () => {
          mainWindow.focus();
          return false;
        });
      });
      break;

    case "linux":
      // Linux-specific taskbar blocking
      mainWindow.setSkipTaskbar(true);

      // Block common Linux desktop shortcuts
      const blockedLinuxShortcuts = [];

      blockedLinuxShortcuts.forEach((shortcut) => {
        globalShortcut.register(shortcut, () => {
          mainWindow.focus();
          return false;
        });
      });
      break;
  }

  // Prevent display sleep and screensaver
  const id = powerSaveBlocker.start("prevent-display-sleep");

  // Additional security measures
  mainWindow.webContents.executeJavaScript();

  // Clean up when window is closed
  mainWindow.on("closed", () => {
    globalShortcut.unregisterAll();
    if (powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
    }
  });
}

async function createWindow(launchParams = {}) {
  // const response = await fetch(s3Url);
  // rdpApplications = await response.json();
  // if (!canProceed) return;
  // app.commandLine.appendSwitch('no-sandbox');
  // app.commandLine.appendSwitch('ignore-gpu-blacklist');
  // app.commandLine.appendSwitch('enable-gpu-rasterization');
  // app.commandLine.appendSwitch('enable-zero-copy');
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      devTools: true,
      enableRemoteModule: false,
      webSecurity: true,
      sandbox: false,
      webviewTag: true,
      allowRunningInsecureContent: false,
      mediaFeatures: true,
      spellcheck: false,
      backgroundThrottling: false, // Optimize for video
      offscreen: false,
      nativeWindowOpen: true,
      spellcheck: false,
      sandbox: false,
      enableScreenCapturing: true,
      mediaDevices: true,
      permissions: [
        "media",
        "mediaDevices",
        "display-capture",
        "desktopCapture",
      ],
      disableDialogs: true,
      navigateOnDragDrop: false,
      // sandbox: false,
      screenCapture: {
        onlyScreen: true, // This is a conceptual example - actual property name may differ
      },
      // Add specific settings for Angular
      experimentalFeatures: true,
      nodeIntegrationInSubFrames: true,
      preload: path.join(__dirname, "preload.js"),
    },
    kiosk: false,
    fullscreen: false,
    frame: false,
    skipTaskbar: true,
  });
  // setupLinuxScreenSharing(mainWindow);
  // app.commandLine.appendSwitch('no-sandbox');

  // Ensure proper window layering for Linux

  // Ensure proper window layering
  // if (process.platform === 'linux') {
  //   // Install required packages if missing
  //   exec('which wmctrl || sudo apt-get install -y wmctrl');
  //   exec('which xdg-desktop-portal-gtk || sudo apt-get install -y xdg-desktop-portal-gtk');

  //   mainWindow.setVisibleOnAllWorkspaces(true);
  //   mainWindow.on('show', () => {
  //     setTimeout(() => {
  //       mainWindow.setAlwaysOnTop(true);
  //     }, 100);
  //   });
  // }
  const primaryDisplay = screen.getPrimaryDisplay();
  mainWindow.setBounds(primaryDisplay.bounds);
  setupSecurityFeatures();
  // const kioskManager = setupKioskMode(mainWindow);
  // mainWindow.setFullScreen(true);
  // mainWindow.setAlwaysOnTop(true);
  // mainWindow.setKiosk(true);
  mainWindow.setVisibleOnAllWorkspaces(true);
  setupExpressServer();
  setupIpcHandlers();
  setupWindowBehavior();
  startDisplayMonitoring(mainWindow);
  // setupLinuxScreenSharing(mainWindow)
  mainWindow.setMovable(false);
  mainWindow.loadFile("index.html");
  // mainWindow.loadURL("http://pscollege841.examly.test:4200");
  mainWindow.webContents.openDevTools();
  // Prevent unnecessary redraws
  mainWindow.setBackgroundThrottling(false);
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
  globalShortcut.register("PrintScreen", () => {
    return false; // Blocks the PrintScreen key
  });
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const { requestHeaders } = details;

    // Add our custom browser identifier
    requestHeaders["User-Agent"] = "neo-browser-updated";
    requestHeaders["X-Browser-Version"] = app.getVersion();

    callback({ requestHeaders });
  });
  mainWindow.on("closed", () => {
    // kioskManager.cleanupKiosk();
  });

  mainWindow.webContents.on("context-menu", (event, params) => {
    const menu = Menu.buildFromTemplate([
      {
        label: "Inspect Element",
        click() {
          mainWindow.webContents.inspectElement(params.x, params.y);
        },
      },
    ]);
    menu.popup(mainWindow, params.x, params.y);
  });
}
if (process.platform === "linux") {
  // Check if we're running in Cinnamon environment
  exec("echo $XDG_CURRENT_DESKTOP", (error, stdout) => {
    const desktop = stdout.trim();
    if (desktop === "X-Cinnamon" || desktop === "Cinnamon") {
      console.log(
        "Detected Cinnamon environment, applying special keyboard handling"
      );

      // Add Cinnamon-specific handling
      mainWindow.webContents.executeJavaScript(`
        // Intercept and force-enable backspace
        const cinnamonKeyHandler = function(e) {
          if (e.key === 'Backspace') {
            // Prevent the event from being blocked
            e.stopImmediatePropagation = function() {};
            e.stopPropagation = function() {};
            e.preventDefault = function() {};
          }
        };
        document.addEventListener('keydown', cinnamonKeyHandler, true);
      `);
    }
  });
}
function setupLinuxScreenSharing(mainWindow) {
  if (process.platform === "linux") {
    // Essential environment variables for pipewire
    process.env.XDG_SESSION_TYPE = "x11";
    process.env.XDG_CURRENT_DESKTOP = "GNOME";
    process.env.XDG_RUNTIME_DIR =
      process.env.XDG_RUNTIME_DIR || "/run/user/1000";

    // Critical switches for screen sharing
    const switches = [
      ["enable-features", "WebRTCPipeWireCapturer,MediaDevices"],
      ["enable-usermedia-screen-capturing"],
      ["auto-select-desktop-capture-source", "Entire screen"],
      ["enable-media-stream"],
      ["use-fake-ui-for-media-stream"],
      ["enable-webrtc-pipewire-capturer"],
      ["ozone-platform-hint", "auto"],
      ["enable-raw-draw"],
    ];

    switches.forEach(([name, value]) => {
      if (value) {
        app.commandLine.appendSwitch(name, value);
      } else {
        app.commandLine.appendSwitch(name);
      }
    });

    // Start required services
    const startServices = async () => {
      const services = [
        "systemctl --user enable pipewire",
        "systemctl --user start pipewire",
        "systemctl --user start pipewire-media-session",
        "systemctl --user start xdg-desktop-portal",
        "systemctl --user start xdg-desktop-portal-gnome",
      ];

      for (const cmd of services) {
        try {
          await exec(cmd);
          console.log(`Service started: ${cmd}`);
        } catch (error) {
          console.warn(`Warning starting service: ${cmd}`, error);
        }
      }
    };

    startServices();

    // Set up permissions
    session.defaultSession.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        const allowedPermissions = [
          "media",
          "display-capture",
          "desktopCapture",
        ];
        if (allowedPermissions.includes(permission)) {
          callback(true);
        } else {
          callback(false);
        }
      }
    );

    // Handle screen capture sources
    ipcMain.handle("DESKTOP_CAPTURER_GET_SOURCES", async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });

        // Always return the entire screen source
        const entireScreen = sources.find(
          (source) =>
            source.name === "Entire Screen" ||
            source.name === "Screen 1" ||
            source.name.includes("screen")
        );

        return entireScreen ? [entireScreen] : sources;
      } catch (error) {
        console.error("Error getting screen sources:", error);
        return [];
      }
    });

    // Add necessary headers
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          "Permissions-Policy": ["camera=*, microphone=*, display-capture=*"],
          // 'Cross-Origin-Embedder-Policy': ['require-corp'],
          // 'Cross-Origin-Opener-Policy': ['same-origin']
        },
      });
    });

    // Handle screen sharing permissions specifically
    mainWindow.webContents.session.setPermissionRequestHandler(
      (webContents, permission, callback) => {
        if (permission === "display-capture" || permission === "media") {
          callback(true);
        } else {
          callback(false);
        }
      }
    );

    // Force allow screen sharing
    // mainWindow.webContents.executeJavaScript(`
    //   if (!window.electronScreenCapture) {
    //     // window.electronScreenCapture = {
    //     //   getSources: async () => {
    //     //     try {
    //     //       return await window.electron.invoke('DESKTOP_CAPTURER_GET_SOURCES');
    //     //     } catch (error) {
    //     //       console.error('Error getting sources:', error);
    //     //       return [];
    //     //     }
    //     //   }
    //     // };
    //   }

    //   // Override getUserMedia
    //   // const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    //   // navigator.mediaDevices.getUserMedia = async function(constraints) {
    //   //   if (constraints.video?.mandatory?.chromeMediaSource === 'desktop') {
    //   //     const sources = await window.electronScreenCapture.getSources();
    //   //     if (sources && sources[0]) {
    //   //       constraints.video.mandatory.chromeMediaSourceId = sources[0].id;
    //   //     }
    //   //   }
    //   //   return originalGetUserMedia(constraints);
    //   // };
    // `, true);
  }
}
async function checkAndNotifyApplications() {
  console.log(
    "isDialogOpen, dialogCheckInProgress->",
    isDialogOpen,
    dialogCheckInProgress
  );
  // If a dialog is already open or check is in progress, don't proceed
  dialogCheckInProgress = false;
  if (isDialogOpen || dialogCheckInProgress) {
    return true;
  }
  console.log("Checking applications...");
  try {
    dialogCheckInProgress = true;
    const result = await checkAppStatus();
    console.log("App check result:", result, restrictionAppDialog);
    if (!result.status && !restrictionAppDialog) {
      isDialogOpen = true;
      restrictionAppDialog = true;
      console.log("Showing dialog...");
      const dialogResult = await dialog.showMessageBox(mainWindow, {
        type: "warning",
        title: "Applications Need to Be Closed.",
        message: "Restricted Applications Detected.",
        detail: result.message,
        buttons: ["Check Again", "Exit Neo Browser"],
        defaultId: 0,
        cancelId: 1,
      });
      console.log("Dialog result:", dialogResult);
      isDialogOpen = false;
      console.log("Dialog result-->", dialogResult);
      if (dialogResult.response === 0) {
        // User clicked "Check Again"
        dialogCheckInProgress = false;
        // console.log("Checking ")
        console.log("Checking applications again...");
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
    console.error("Error checking applications:", error);
    if (!isDialogOpen) {
      isDialogOpen = true;
      await dialog.showErrorBox(
        "Error",
        "Failed to check running applications. Please restart the application."
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
  expressApp.use(
    cors({
      origin: "*",
      methods: ["GET", "POST"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    })
  );
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src 'self' 'unsafe-inline' 'unsafe-eval' http: https: data: blob: ws: wss:;",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' http: https:;",
          "style-src 'self' 'unsafe-inline' http: https:;",
          "img-src 'self' data: http: https: blob:;",
          "media-src 'self' http: https: blob:;",
          "connect-src 'self' ws: wss: http: https:;",
          "font-src 'self' data: http: https:;",
        ].join(" "),
      },
    });
  });
  expressApp.get("/status", async (req, res) => {
    console.log("Checking status...");
    try {
      // Temporarily disable window constraints for screen sharing
      if (mainWindow && !mainWindow.isDestroyed()) {
        // mainWindow.setAlwaysOnTop(false);
        // Set a timeout to restore window state after screen share dialog
        // setTimeout(() => {
        //   if (mainWindow && !mainWindow.isDestroyed()) {
        //     mainWindow.setFullScreen(true);
        //     mainWindow.setAlwaysOnTop(true, 'screen-saver');
        //     mainWindow.setKiosk(true);
        //   }
        // }, 50000); // 10 second delay to allow for screen share dialog
      }
      const result = await checkAppStatus();
      console.log("App status:<<<<<<<<<<------------>>>>>>>>>>", result);
      const combinedStatus = {
        status: result.status && globalDisplayStatus.status, // Both must be true for overall true status
        message: globalDisplayStatus.status
          ? result.message
          : globalDisplayStatus.message,
        APP_VERSION: "1.1.1",
        browser_used: "neo-browser",
      };
      // mainWindow.setAlwaysOnTop(false);
      console.log("Combined status:", combinedStatus);
      const base64Result = jsonToBase64(combinedStatus);
      console.log("Base64 result:", base64Result);
      return res.status(200).send(base64Result);
    } catch (error) {
      console.error("Error in /status:", error);
      return res
        .status(500)
        .send(
          jsonToBase64({ status: false, message: "Internal server error" })
        );
    }
  });

  expressApp.get("/info", (req, res) => {
    res
      .status(200)
      .send("This is iamneo secure browser. All systems are operational.");
  });

  expressApp.get("/", (req, res) => {
    res.status(200).send("Welcome to the iamneo secure browser");
  });

  const server = http.createServer(expressApp);
  const secureWss = new SecureWebSocketServer();
  global.webSocketServer = secureWss;
  secureWss.start(server);
  console.log("WebSocket server started", secureWss.activeConnections);
  server.listen(9999, () => {
    console.log("Server running on port 9999");
  });
}

function setupIpcHandlers() {
  console.log("Setting up IPC handlers");
  mainWindow.webContents.on("did-navigate", async (event, url) => {
    try {
      const urlObj = new URL(url);
      const isDashboard = urlObj.pathname.includes("/dashboard");
      console.log("isDashboard", isDashboard);
      mainWindow.webContents.send("update-toolbar-visibility", {
        shouldHideToolbar: isDashboard,
      });
    } catch (error) {
      console.error("Error handling navigation:", error);
    }
  });

  ipcMain.handle("navigate-to-url", async (event, url) => {
    console.log("Navigating to URL:", url);
    try {
      // Ensure URL has protocol
      if (!/^https?:\/\//i.test(url)) {
        url = "https://" + url;
      }

      let urlObj;
      try {
        urlObj = new URL(url);
      } catch (e) {
        return {
          success: false,
          error: "Invalid URL format",
        };
      }

      // Check if domain is allowed
      const isAllowed = allowedDomains.some((domain) =>
        urlObj.hostname.toLowerCase().includes(domain.toLowerCase())
      );

      if (!isAllowed) {
        return {
          success: false,
          error:
            "This domain is not allowed. You can only access examly domains.",
        };
      }

      // Check if it's a dashboard URL
      const isDashboard = urlObj.pathname.includes("/dashboard");

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
      console.error("Navigation error:", error);
      return {
        success: false,
        error: "Navigation failed: " + error.message,
      };
    }
  });

  // ipcMain.handle('get-screen-sources', async () => {
  //   try {
  //     return await desktopCapturer.getSources({
  //       types: ['screen', 'window'],
  //       thumbnailSize: { width: 150, height: 150 }
  //     });
  //   } catch (error) {
  //     console.error('Error getting screen sources:', error);
  //     throw error;
  //   }
  // });

  // Add a new IPC handler to check display status
  ipcMain.handle("check-display-status", () => {
    return {
      isExternalDisplayConnected,
      canNavigate: !isExternalDisplayConnected,
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

  ipcMain.handle("update-params", async (event, params) => {
    try {
      const parsedData = params.data;
      const tokenData = JSON.parse(parsedData)?.token;
      globaltoken = tokenData;
      mainWindow.webContents.send("params-processed", { status: "success" });
      return { success: true, message: "Parameters processed successfully" };
    } catch (error) {
      console.error("Error processing parameters:", error);
      return {
        success: false,
        message: "Failed to process parameters",
        error: error.message,
      };
    }
  });

  ipcMain.handle("get-processes", async () => {
    try {
      return await getRemoteDesktopAppStatus();
    } catch (error) {
      console.error("Error in get-processes:", error);
      throw error;
    }
  });

  ipcMain.handle("exit-app", () => {
    dialog
      .showMessageBox(mainWindow, {
        type: "question",
        title: "Confirm Exit",
        message: "Are you sure you want to exit?",
        buttons: ["Yes", "No"],
        defaultId: 1,
        cancelId: 1,
      })
      .then(async (result) => {
        console.log("Exit dialog result:", result);
        // memoryManager.stop();
        stopDisplayMonitoring();
        if (result.response === 0) {
          // const result = await keyManager.restoreWindowsKey();
          // if(result.success){
          app.quit();
          // }else{
          //   app.quit();
          //   // console.error('Failed to restore Windows key settings:', result.error);
          // }
        }
      });
  });
}

function setupSecurityFeatures() {
  // Keep essential performance switches
  app.commandLine.appendSwitch("enable-gpu-rasterization");
  app.commandLine.appendSwitch("enable-zero-copy");
  app.commandLine.appendSwitch("ignore-gpu-blocklist");

  // Enable DevTools globally for all windows including web content
  mainWindow.webContents.on("before-input-event", (event, input) => {
    // Allow Ctrl+Shift+I for DevTools
    if (input.control && input.shift && input.key.toLowerCase() === "i") {
      mainWindow.webContents.openDevTools({ mode: "detach" });
      // Get the focused webContents
      const focused = webContents.getFocusedWebContents();
      if (focused && focused.id !== mainWindow.webContents.id) {
        focused.openDevTools({ mode: "detach" });
      }
      event.preventDefault();
      return;
    }
  });

  // Enable DevTools for all webContents
  app.on("web-contents-created", (event, contents) => {
    contents.on("before-input-event", (event, input) => {
      if (input.control && input.shift && input.key.toLowerCase() === "i") {
        contents.openDevTools({ mode: "detach" });
        event.preventDefault();
      }
    });
  });

  // Ensure DevTools is enabled in webPreferences
  mainWindow.webPreferences = {
    ...mainWindow.webPreferences,
    devTools: true,
    webviewTag: true,
    nodeIntegration: true,
    contextIsolation: false,
  };

  // Remove CSP restrictions
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [
          "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:",
          "script-src * 'unsafe-inline' 'unsafe-eval'",
          "connect-src * 'unsafe-inline'",
          "img-src * data: blob: 'unsafe-inline'",
          "frame-src *",
          "style-src * 'unsafe-inline'",
        ].join("; "),
      },
    });
  });
}

function setupWindowBehavior() {
  mainWindow.webContents.on("did-finish-load", () => {
    mainWindow.webContents.send("electron-app-ready");
  });

  Menu.setApplicationMenu(null);
}

async function handleCustomProtocol() {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient("neoexam", process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient("neoexam");
  }

  app.on("open-url", (event, url) => {
    const urlObj = new URL(url);
    const params = Object.fromEntries(urlObj.searchParams);
    if (mainWindow) {
      mainWindow.webContents.send("received-params", params);
      mainWindow.webContents.send("app-launch-params", params);
    } else {
      createWindow();
      mainWindow.webContents.on("did-finish-load", () => {
        mainWindow.webContents.send("received-params", params);
        mainWindow.webContents.send("app-launch-params", params);
      });
    }
  });
}

function handleErrors() {
  process.on("unhandledRejection", (reason, promise) => {
    console.error("Unhandled Rejection at:", promise, "reason:", reason);
    dialog.showErrorBox(
      "Application Error",
      "An unexpected error occurred. The application will now close."
    );
    app.quit();
  });

  process.on("uncaughtException", (error) => {
    console.error("Uncaught Exception:", error);
    dialog.showErrorBox(
      "Application Error",
      "A critical error occurred. The application will now close."
    );
    app.quit();
  });
}

function jsonToBase64(jsonData) {
  return Buffer.from(JSON.stringify(jsonData), "utf-8").toString("base64");
}

if (process.platform === "linux") {
  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    // Another instance is already running, show message and quit
    app.on("ready", () => {
      dialog.showMessageBoxSync({
        type: "info",
        title: "Neo Browser",
        message: "Neo Browser is already running",
        detail: "Please use the existing window.",
        buttons: ["OK"],
      });
      app.quit();
    });
  } else {
    // This is the first instance
    app.on("second-instance", (event, commandLine, workingDirectory) => {
      // Show alert and focus existing window
      if (mainWindow && !mainWindow.isDestroyed()) {
        dialog.showMessageBoxSync({
          type: "info",
          title: "Neo Browser",
          message: "Neo Browser is already running",
          detail: "Please use the existing window.",
          buttons: ["OK"],
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

        // Linux-specific key management
        const result = await keyManager.disableSystemKeys();
        if (!result.success) {
          isAppInitializing = false;
          if (result.cancelled) {
            logger.info("User denied permission. Exiting application...");
            app.quit();
          } else {
            console.error("Failed to disable system keys:", result.error);
            app.quit();
          }
          return;
        }

        logger.info("System keys disabled successfully");

        // Start memory management
        MemoryManager.start();

        // Create window with Linux-specific options
        await createWindow();

        // Setup error handling
        handleErrors();
      } catch (error) {
        console.error("Error during Linux initialization:", error);
        isAppInitializing = false;
        app.quit();
      } finally {
        isAppInitializing = false;
      }
    });
  }
}

app.whenReady().then(async () => {
  handleCustomProtocol();
  const isAppOpen = await checkAndNotifyApplications();
  if (!isAppOpen) return;
  // const result = await keyManager.disableWindowsKey();
  // try {
  //   // const result = await manager.disableWindowsKey();
  //   if (!result.success) {
  //       if (result.cancelled) {
  //             console.log('User denied permission. Exiting application...');
  //             process.exit(1);
  //         } else {
  //             console.error('Failed to disable Windows key:', result.error);
  //             // process.exit(1);
  //         }
  //     } else {
  //         console.log('Windows key disabled successfully');
  //     }
  // } catch (error) {
  //     console.error('Error:', error);
  //     process.exit(1);
  // }
  // memoryManager.start();
  createWindow();
  handleErrors();
});

app.on("window-all-closed", async () => {
  // memoryManager.stop();
  stopDisplayMonitoring();

  if (displayMonitorWorker) {
    cleanupWorker(displayMonitorWorker);
    displayMonitorWorker = null;
  }

  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", async (event) => {
  // memoryManager.stop();
  stopDisplayMonitoring();
  if (displayMonitorWorker) {
    cleanupWorker(displayMonitorWorker);
    displayMonitorWorker = null;
  }

  try {
    // const result = await keyManager.restoreWindowsKey();
    // if(result.success) {
    //     app.exit(0);
    // } else {
    //     console.error('Failed to restore Windows key settings:', result.error);
    //     app.exit(1);
    // }
  } catch (error) {
    console.error("Error during cleanup:", error);
    app.exit(1);
  }
});
ipcMain.handle("go-back", () => {
  if (mainWindow.webContents.canGoBack()) {
    mainWindow.webContents.goBack();
    return true;
  }
  return false;
});

ipcMain.handle("go-forward", () => {
  if (mainWindow.webContents.canGoForward()) {
    mainWindow.webContents.goForward();
    return true;
  }
  return false;
});

ipcMain.handle("refresh-page", () => {
  mainWindow.webContents.reload();
  return true;
});

ipcMain.handle("check-media-permissions", async () => {
  return true;
});

// ipcMain.handle('get-screen-stream', async (event, sourceId) => {
//   try {
//     return { sourceId };
//   } catch (error) {
//     console.error('Error getting screen stream:', error);
//     throw error;
//   }
// });

// ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async () => {
//   try {
//     const sources = await desktopCapturer.getSources({
//       types: ['screen'],
//       thumbnailSize: { width: 0, height: 0 }
//     });

//     // Return only the necessary data, not the entire source object
//     return sources.map(source => ({
//       id: source.id,
//       name: source.name,
//       display_id: source.display_id
//     }));
//   } catch (error) {
//     console.error('Error getting screen sources:', error);
//     return [];
//   }
// });

ipcMain.on("get-remote-desktop-status", async (event) => {
  try {
    // Example call
    const result = await checkAppStatus();
    // checkAppStatus().then((result) => {
    event.reply("remote-desktop-status", {
      status: result.status,
      message: result.message,
      // });
    });
  } catch (error) {
    console.error("Error in get-remote-desktop-status:", error);
    event.reply("remote-desktop-status", {
      status: false,
      message: "Error checking remote desktop status",
    });
  }
});

ipcMain.on("ping-test", (event) => {
  console.log("Main: Received ping from renderer");
  event.reply("pong-test");
});

ipcMain.on("update-params", (event, params) => {
  console.log("Main: Received ping from renderer", params);
});

ipcMain.on("params-to-main", (event, params) => {
  console.log("Received parameters in main process:", params);
});

// Handle sudden termination
process.on("SIGTERM", async () => {
  try {
    // await keyManager.restoreWindowsKey();
    app.quit();
  } catch (error) {
    console.error("Error during SIGTERM cleanup:", error);
    process.exit(1);
  }
});

function cleanupWorker(worker) {
  if (!worker) return;
  try {
    worker.terminate();
  } catch (error) {
    console.error("Error terminating worker:", error);
  }
}

// async function setupAutoScreenCapture(mainWindow) {
//   // Set up IPC handlers
//   ipcMain.handle('DESKTOP_CAPTURER_GET_SOURCES', async (event) => {
//     try {
//       const sources = await desktopCapturer.getSources({
//         types: ['screen'],
//         thumbnailSize: { width: 0, height: 0 }
//       });

//       // Get primary screen or first screen
//       const primarySource = sources.find(source => source.name === 'Entire Screen') || sources[0];
//       return [primarySource];
//     } catch (error) {
//       console.error('Error getting screen sources:', error);
//       throw error;
//     }
//   });

//   // Set up automatic permission handling
//   session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
//     if (permission === 'media' || permission === 'display-capture') {
//       callback(true);
//     } else {
//       callback(false);
//     }
//   });

//   // Inject preload script for screen capture
//   mainWindow.webContents.executeJavaScript(`
//     navigator.mediaDevices.getUserMedia = async function(constraints) {
//       if (constraints.video?.mandatory?.chromeMediaSource === 'desktop') {
//         const sources = await window.electron.invoke('DESKTOP_CAPTURER_GET_SOURCES');
//         const source = sources[0];

//         constraints.video.mandatory.chromeMediaSourceId = source.id;
//         return originalGetUserMedia.call(this, constraints);
//       }
//       return originalGetUserMedia.call(this, constraints);
//     };
//   `, true);

//   // Update preload script
//   const preloadScript = `
//     const { contextBridge, ipcRenderer } = require('electron');

//     contextBridge.exposeInMainWorld('electron', {
//       invoke: (channel, ...args) => {
//         if (channel === 'DESKTOP_CAPTURER_GET_SOURCES') {
//           return ipcRenderer.invoke(channel);
//         }
//       }
//     });

//     // Store original getUserMedia
//     const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
//   `;

//   return preloadScript;
// }

// Function to configure window for screen sharing
// function configureScreenSharing(mainWindow) {
//   // Configure window settings
//   mainWindow.webContents.setBackgroundThrottling(false);

//   // Add screen capture switches
//   app.commandLine.appendSwitch('enable-features', 'MediaDevices,WebRTCPipeWireCapturer');
//   app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
//   app.commandLine.appendSwitch('allow-http-screen-capture');
//   app.commandLine.appendSwitch('auto-select-desktop-capture-source', 'Screen 1');
// }
