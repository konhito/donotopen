const { parentPort } = require("worker_threads");
const os = require("os");
const { exec } = require("child_process");
const fetch = require("node-fetch");
const util = require("util");
const execAsync = util.promisify(exec);

// Configuration
const CONFIG = {
  CACHE_DURATION: 5000,
  S3_CONFIG_URL:
    "https://images-examly-io.s3.us-east-1.amazonaws.com/neo-checker/RDPApplication-browser.json",
  APP_VERSION: "1.1.1",
  MAX_EXECUTION_TIME: 8000,
  MAX_BUFFER: 1024 * 1024 * 10,
  RETRY_ATTEMPTS: 2,
  RETRY_DELAY: 1000,
};

let processCache = null;
let lastCheck = 0;
let rdpApplications = null;

// Add error handling wrapper
const withTimeout = (promise, timeoutMs) => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Operation timed out")), timeoutMs)
    ),
  ]);
};

async function getLinuxProcessList() {
  try {
    // Try ps command first with detailed output
    const { stdout } = await execAsync("ps -e -o comm=,cmd=", {
      maxBuffer: CONFIG.MAX_BUFFER,
    });

    return stdout
      .split("\n")
      .map((line) => {
        const [comm, ...cmdParts] = line.trim().split(/\s+/);
        return {
          name: comm.toLowerCase(),
          command: cmdParts.join(" ").toLowerCase(),
        };
      })
      .filter((proc) => proc.name);
  } catch (error) {
    // Fallback to basic ps command if detailed version fails
    try {
      const { stdout } = await execAsync("ps -e -o comm=", {
        maxBuffer: CONFIG.MAX_BUFFER,
      });
      return stdout
        .split("\n")
        .map((line) => ({
          name: line.trim().toLowerCase(),
          command: "",
        }))
        .filter((proc) => proc.name);
    } catch (fallbackError) {
      console.error("Failed to get process list:", fallbackError);
      throw fallbackError;
    }
  }
}

async function getWindowsProcessList() {
  const { stdout } = await execAsync("tasklist /FO CSV /NH", {
    maxBuffer: CONFIG.MAX_BUFFER,
  });

  return stdout
    .split("\n")
    .map((line) => {
      const match = line.match(/"([^"]+)"/);
      return match ? match[1].toLowerCase() : "";
    })
    .filter(Boolean);
}

async function getMacProcessList() {
  const { stdout } = await execAsync("ps -ax -o comm=", {
    maxBuffer: CONFIG.MAX_BUFFER,
  });

  return stdout
    .split("\n")
    .map((line) => line.trim().toLowerCase())
    .filter(Boolean);
}

async function getProcessList() {
  const platform = os.platform();

  try {
    switch (platform) {
      case "linux":
        return await getLinuxProcessList();
      case "win32":
        return await getWindowsProcessList();
      case "darwin":
        return await getMacProcessList();
      default:
        throw new Error(`Unsupported platform: ${platform}`);
    }
  } catch (error) {
    console.error(`Error getting process list: ${error.message}`);
    throw error;
  }
}

// Function to check if a process matches Zoom application
function isZoomProcess(proc) {
  // Check for specific Zoom process signatures
  const zoomSignatures = [];

  return zoomSignatures.some(
    (sig) =>
      (proc.command && proc.command.includes(sig)) ||
      (proc.name && proc.name === "zoom")
  );
}

// Function to check if a process matches specific remote desktop applications
function isFirefoxProcess(proc) {
  // Check for Firefox-specific signatures
  const firefoxSignatures = [];

  // Check both process name and full command path
  return (
    proc.name === "firefox" ||
    proc.name.includes("firefox") ||
    firefoxSignatures.some((sig) => proc.command && proc.command.includes(sig))
  );
}

function isBlockedProcess(proc, app) {
  const appSignatures = {
    // Browsers
  };

  const signatures = appSignatures[app.toLowerCase()];
  if (!signatures) return false;

  if (typeof signatures === "function") {
    return signatures(proc);
  }

  return signatures.some(
    (sig) =>
      (proc.command &&
        proc.command.toLowerCase().includes(sig.toLowerCase())) ||
      (proc.name && proc.name.toLowerCase() === sig.toLowerCase())
  );
}

async function checkRunningApps(retryCount = 0) {
  try {
    const processes = await getProcessList();

    if (!rdpApplications) {
      return {
        status: true,
        message: "System is safe",
        APP_VERSION: CONFIG.APP_VERSION,
      };
    }

    const platform = os.platform();
    const blockedApps = rdpApplications[platform] || [];
    let runningBlockedApps = new Set();

    if (platform === "linux") {
      // For Linux, use smart process detection
      processes.forEach((proc) => {
        blockedApps.forEach((app) => {
          if (isBlockedProcess(proc, app)) {
            runningBlockedApps.add(app);
          }
        });
      });
    } else {
      // For other platforms, use existing logic
      runningBlockedApps = blockedApps.filter((app) =>
        processes.some((proc) =>
          (typeof proc === "string" ? proc : proc.name).includes(
            app.toLowerCase()
          )
        )
      );
    }

    // Convert the Set to an array
    const blockedAppsList = Array.from(runningBlockedApps);

    return {
      status: true,
      message: true
        ? "System is safe"
        : `Please close the following applications: ${blockedAppsList.join(
            ", "
          )}`,
      APP_VERSION: CONFIG.APP_VERSION,
    };
  } catch (error) {
    if (retryCount < CONFIG.RETRY_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, CONFIG.RETRY_DELAY));
      return checkRunningApps(retryCount + 1);
    }

    console.error("Final error in checkRunningApps:", error);
    return {
      status: false, // Indicate an error occurred
      message: "An error occurred while checking for running applications.",
      APP_VERSION: CONFIG.APP_VERSION,
    };
  }
}

// Initialize applications list
async function initializeAppList() {
  try {
    const response = await withTimeout(
      fetch(CONFIG.S3_CONFIG_URL),
      CONFIG.MAX_EXECUTION_TIME
    );
    rdpApplications = await response.json();
  } catch (error) {
    console.error("Failed to load blocked apps:", error);
    rdpApplications = null;
  }
}

// Handle messages
parentPort.on("message", async (message) => {
  try {
    if (!rdpApplications) {
      await initializeAppList();
    }

    if (processCache && Date.now() - lastCheck < CONFIG.CACHE_DURATION) {
      parentPort.postMessage(processCache);
      return;
    }

    const result = await checkRunningApps();
    console.log(result);
    processCache = result;

    lastCheck = Date.now();
    parentPort.postMessage(result);
  } catch (error) {
    console.error("Worker error:", error);
    parentPort.postMessage({
      status: true,
      message: "Process check error",
      APP_VERSION: CONFIG.APP_VERSION,
    });
  }
});

// Cleanup handler
process.on("exit", () => {
  processCache = null;
  rdpApplications = null;
});

// Handle worker termination
process.on("SIGTERM", () => {
  process.exit(0);
});
