// preload.js
const { contextBridge, ipcRenderer } = require('electron/renderer');
const { desktopCapturer } = require('electron');
// Wait for mediaDevices to be available
const waitForMediaDevices = () => {
  return new Promise((resolve) => {
    if (navigator.mediaDevices) {
      resolve(navigator.mediaDevices);
    } else {
      const checkInterval = setInterval(() => {
        if (navigator.mediaDevices) {
          clearInterval(checkInterval);
          resolve(navigator.mediaDevices);
        }
      }, 100);
    }
  });
};
// Override getDisplayMedia immediately after mediaDevices is available
waitForMediaDevices().then((mediaDevices) => {
  console.log('MediaDevices available, setting up override');
  const originalGetDisplayMedia = mediaDevices.getDisplayMedia;
  mediaDevices.getDisplayMedia = async function(constraints = {}) {
    console.log('getDisplayMedia called with constraints:', constraints);
    try {
      const stream = await originalGetDisplayMedia.call(this, {
        ...constraints,
        video: {
          ...constraints.video,
          displaySurface: { ideal: 'monitor' },
          width: { ideal: window.screen.width },
          height: { ideal: window.screen.height }
        }
      });
      
      console.log('Stream obtained:', stream);
      const videoTrack = stream.getVideoTracks()[0];
      
      if (videoTrack) {
        const settings = videoTrack.getSettings();
        console.log('Original settings:', settings);
        
        // Override getSettings to always return monitor
        videoTrack.getSettings = () => ({
          ...settings,
          displaySurface: 'monitor'
        });
        
        console.log('Modified settings:', videoTrack.getSettings());
      }
      
      return stream;
    } catch (error) {
      console.error('Error in getDisplayMedia:', error);
      throw error;
    }
  };
  console.log('getDisplayMedia override complete');
});
contextBridge.exposeInMainWorld(
  'electronAPI',
  {
    checkCurrentUrl: () => ipcMain.invoke('check-current-url'),
    onUpdateToolbarVisibility: (callback) => {
    ipcMain.on('update-toolbar-visibility', (event, data) => callback(data));
    },
    navigateToUrl: (url) => ipcRenderer.invoke('navigate-to-url', url),
    checkUrlRestrictions: (url) => ipcMain.invoke('check-url-restrictions', url),
    goBack: () => ipcRenderer.invoke('go-back'),
    goForward: () => ipcRenderer.invoke('go-forward'),
    refreshPage: () => ipcRenderer.invoke('refresh-page'),
    // Expose methods for sending messages
    updateParams: (params) => {
      console.log('updateParams called with:', params);
      return ipcRenderer.invoke('update-params', params);
    },
    getProcesses: () => {
      console.log('getProcesses called');
      return ipcRenderer.invoke('get-processes');
    },
    getScreenSources: async () => { 
      try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 150, height: 150 }
      });
      return sources;
    } catch (error) {
      console.error('Error:', error);
      throw error;
    }},
    // Expose methods for receiving messages
    onAppLaunchParams: (callback) => ipcRenderer.on('app-launch-params', (event, params) => callback(params)),
    onReceivedParams: (callback) => ipcRenderer.on('received-params', (event, params) => callback(params)),
    onParamsProcessed: (callback) => ipcRenderer.on('params-processed', (event, result) => callback(result)),
    getUserMedia: async (constraints) => {
      console.log('getUserMedia called with:', constraints);
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        return stream;
      } catch (error) {
        console.error('Failed to access media devices:', error);
      }
    },
    getSources: () => ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES'),
    initProctoring: async (callback) => {
      try {
        // Get screen sources
        const sources = await ipcRenderer.invoke('DESKTOP_CAPTURER_GET_SOURCES');
        // Get the first screen source
        const screenSource = sources.find(source => source.id.startsWith('screen:'));
        
        if (!screenSource) {
          throw new Error('No screen source found');
        }

        // Create media stream
        const stream = await desktopCapturer.getSources({
          audio: true,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: screenSource.id,
              minWidth: 1280,
              maxWidth: 1920,
              minHeight: 720,
              maxHeight: 1080
            }
          }
        });

        return stream;
      } catch (error) {
        console.error('Error capturing screen:', error);
        throw error;
      }
    },
    getScreenSources: async () => {
      try {
        // Use ipcRenderer to request screen sources from main process
        return await ipcRenderer.invoke('get-screen-sources');
      } catch (error) {
        console.error('Error getting screen sources:', error);
        throw error;
      }
    },

    getScreenStream: async (sourceId) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              minWidth: 1280,
              maxWidth: 1920,
              minHeight: 720,
              maxHeight: 1080
            }
          }
        });
        return stream;
      } catch (error) {
        console.error('Error getting screen stream:', error);
        throw error;
      }
    },
    getMediaStream: async (constraints) => {
      try {
        console.log('Getting media stream...');
        
        // Wait for mediaDevices to be available
        const mediaDevices = await waitForMediaDevices();
        
        // List available devices first
        const devices = await mediaDevices.enumerateDevices();
        const videoDevices = devices.filter(device => device.kind === 'videoinput');
        console.log('Available video devices:', videoDevices);
        
        if (videoDevices.length === 0) {
          throw new Error('No camera devices found');
        }
  
        // Request permission first
        await ipcRenderer.invoke('request-media-access');
  
        // Set up constraints
        const streamConstraints = {
          audio: false,
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          }
        };
  
        // Get the stream
        const stream = await mediaDevices.getUserMedia(streamConstraints);
        
        if (!stream) {
          throw new Error('Failed to get camera stream');
        }
  
        return stream;
      } catch (error) {
        console.error('Error in getMediaStream:', error);
        throw new Error('No camera found');
      }
    },
  
    checkMediaPermissions: async () => {
      try {
        const mediaDevices = await waitForMediaDevices();
        const devices = await mediaDevices.enumerateDevices();
        return devices.some(device => device.kind === 'videoinput');
      } catch (error) {
        console.error('Error checking media permissions:', error);
        return false;
      }
    },
    captureScreenshot: async (isFrequent) => {
      try {
        // Get all screens
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 1920, height: 1080 }
        });
  
        // Get the main window/screen
        const mainScreen = sources.find(source => 
          source.name === 'Entire Screen' || 
          source.name === 'Screen 1' || 
          source.id.includes('screen')
        );
  
        if (!mainScreen) {
          throw new Error('No screen source found');
        }
  
        // Convert the thumbnail to blob
        const response = await fetch(mainScreen.thumbnail.toDataURL());
        const blob = await response.blob();
        
        return blob;
      } catch (error) {
        console.error('Failed to capture screenshot:', error);
        return null;
      }
    },
    getMediaStream: async (constraints) => {
      try {
        // For camera access, we don't need to use chromeMediaSource
        const streamConstraints = {
          audio: constraints?.audio || false,
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30 }
          }
        }
  
        // Request camera access directly
        const stream = await desktopCapturer.getSources(streamConstraints)
        
        if (!stream) {
          throw new Error('No camera stream available')
        }
  
        return stream
      } catch (error) {
        console.error('Failed to get media stream:', error)
        throw new Error('No camera found')
      }
    },
  
    checkMediaPermissions: async () => {
      try {
        // Check if we can enumerate devices
        const devices = await navigator.mediaDevices.enumerateDevices()
        const videoDevices = devices.filter(device => device.kind === 'videoinput')
        
        if (videoDevices.length === 0) {
          throw new Error('No video devices found')
        }
  
        return true
      } catch (error) {
        console.error('Error checking media permissions:', error)
        return false
      }
    },
    exitApp: () => ipcRenderer.invoke('exit-app'),
    
    getMediaDevice: async (constraints) => {
      try {
        // Wait for mediaDevices to be available
        const mediaDevices = await waitForMediaDevices();
        
        // List available devices first
        const devices = await mediaDevices.enumerateDevices();
        console.log('Available devices:', devices);
        
        // Request permission through main process
        await ipcRenderer.invoke('request-media-permission', constraints);
        
        // Get the stream
        const stream = await mediaDevices.getUserMedia(constraints);
        
        if (!stream) {
          throw new Error('Failed to get media stream');
        }
        
        return stream;
      } catch (error) {
        console.error('Error in getMediaDevice:', error);
        throw error;
      }
    },
    getScreenShare: () => {
      // Electron specific implementation
      return desktopCapturer.getSources({ types: ['screen'] })
          .then(/* ... */);
    }
  }
);

// Expose screen capture helper
contextBridge.exposeInMainWorld('electronScreenCapture', {
  getSources: async () => {
    try {
      return await window.electron.invoke('DESKTOP_CAPTURER_GET_SOURCES');
    } catch (error) {
      console.error('Error getting sources:', error);
      return [];
    }
  }
});
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
// Screen capture helper
window.electronScreenCapture = {
  getSources: async () => {
    try {
      return await window.electron.invoke('DESKTOP_CAPTURER_GET_SOURCES');
    } catch (error) {
      console.error('Error getting sources:', error);
      return [];
    }
  }
};
// const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
// navigator.mediaDevices.getUserMedia = async function(constraints) {
//   if (constraints?.video?.mandatory?.chromeMediaSource === 'desktop') {
//     const source = await window.electronCapture.getScreenSource();
//     constraints.video.mandatory.chromeMediaSourceId = source.id;
//   }
//   return originalGetUserMedia.call(this, constraints);
// };
// Debug logging
// Override getDisplayMedia immediately after mediaDevices is available
// In your preload.js, modify the override:
// Immediately executing async function to set up the override


console.log('Preload script finished loading');