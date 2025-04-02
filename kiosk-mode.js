const { app, globalShortcut, dialog, ipcMain } = require("electron/main");
const { powerSaveBlocker } = require("electron");
const { exec } = require("child_process");

function setupKioskMode(mainWindow) {
  // Basic window constraints remain the same
  mainWindow.setFullScreen(false);
  mainWindow.setKiosk(false);
  mainWindow.setAlwaysOnTop(false);
  mainWindow.setVisibleOnAllWorkspaces(false);
  mainWindow.setMovable(true);
  mainWindow.setResizable(true);
  mainWindow.setMaximizable(true);
  mainWindow.setMinimizable(true);
  mainWindow.setClosable(true);

  if (process.platform === "linux") {
    // Comprehensive Linux shortcut blocking
    const linuxShortcuts = [
      // Common Desktop Environment Shortcuts
      // Function Keys
    ];

    // Register all shortcuts globally
    linuxShortcuts.forEach((shortcut) => {
      try {
        globalShortcut.register(shortcut, () => {
          mainWindow.focus();
          return false;
        });
      } catch (error) {
        console.warn(`Failed to register shortcut: ${shortcut}`, error);
      }
    });

    // Try to disable key combinations at system level
    const setupLinuxLockdown = async () => {
     
    };

    // Run Linux lockdown setup
    setupLinuxLockdown();

    // Inject key event prevention
    mainWindow.webContents.executeJavaScript();

    // Monitor for fullscreen changes
    mainWindow.on("leave-full-screen", () => {
      mainWindow.setFullScreen(false);
    });

    // Prevent minimize
    mainWindow.on("minimize", (event) => {
      event.preventDefault();
     
    });

    // Monitor window bounds
    let lastBounds = mainWindow.getBounds();
    // const checkInterval = setInterval(() => {
    //     const currentBounds = mainWindow.getBounds();
    //     if (currentBounds.x !== lastBounds.x ||
    //         currentBounds.y !== lastBounds.y ||
    //         currentBounds.width !== lastBounds.width ||
    //         currentBounds.height !== lastBounds.height) {
    //         mainWindow.setBounds(lastBounds);
    //     }
    // }, 100);
  }

  // Power save blocker
  const powerSaveBlockerId = powerSaveBlocker.start("prevent-display-sleep");

  // Return cleanup function
  return {
    cleanupKiosk: () => {
      globalShortcut.unregisterAll();
      if (powerSaveBlocker.isStarted(powerSaveBlockerId)) {
        powerSaveBlocker.stop(powerSaveBlockerId);
      }
      if (process.platform === "linux") {
        // clearInterval(checkInterval);
        // Reset GNOME settings
        exec("gsettings reset-recursively org.gnome.desktop.wm.keybindings");
        exec("gsettings reset-recursively org.gnome.shell.keybindings");
      }
    },
  };
}

module.exports = { setupKioskMode };
