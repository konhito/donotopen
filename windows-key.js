const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { GlobalKeyboardListener } = require("node-global-key-listener");

class WindowsKeyManager {
    constructor() {
        this.tempDir = os.tmpdir();
        this.vbsPath = path.join(this.tempDir, 'run_elevated.vbs');
        this.batchPath = path.join(this.tempDir, 'disable_windows_key.bat');
        this.resultPath = path.join(this.tempDir, 'operation_result.txt');
        this.keyboardListener = null;
        this.cleanupExistingFiles();
    }

    cleanupExistingFiles() {
        [this.vbsPath, this.batchPath, this.resultPath].forEach(file => {
            try {
                if (fs.existsSync(file)) {
                    fs.unlinkSync(file);
                }
            } catch (error) {
                console.error(`Failed to clean up file ${file}:`, error);
            }
        });
    }

    async showConfirmationDialog() {
        const dialogVBS = `
        Dim response
        response = MsgBox("Do you want to allow the application to disable Windows key?", vbYesNo + vbQuestion, "Confirm Action")
        If response = vbYes Then
            WScript.Quit(1)
        Else
            WScript.Quit(0)
        End If
        `;

        const dialogPath = path.join(this.tempDir, 'confirm_dialog.vbs');
        fs.writeFileSync(dialogPath, dialogVBS);

        try {
            const result = await new Promise((resolve, reject) => {
                exec(`cscript //nologo "${dialogPath}"`, (error, stdout, stderr) => {
                    fs.unlinkSync(dialogPath);
                    if (error) {
                        resolve(error.code === 1);
                    } else {
                        resolve(false);
                    }
                });
            });
            return result;
        } catch (error) {
            fs.unlinkSync(dialogPath);
            return false;
        }
    }

    async disableWindowsKey() {
        if (process.platform !== 'win32') {
            return { success: false, error: 'This feature is only supported on Windows' };
        }

        try {
            // Show confirmation dialog first
            const confirmed = await this.showConfirmationDialog();
            if (!confirmed) {
                process.exit(1);
            }

            // Create the batch file for Windows key modifications
            const batchContent = `
@echo off
echo Starting registry modifications...

REM Check for admin rights and create result file
NET SESSION >nul 2>&1
if %errorlevel% neq 0 (
    echo "CANCELLED" > "${this.resultPath.replace(/\\/g, '\\\\')}"
    exit /b 1
)

REM Create success marker
echo "SUCCESS" > "${this.resultPath.replace(/\\/g, '\\\\')}"

REM Disable Windows key and task switching
reg add "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layout" /v "Scancode Map" /t REG_BINARY /d "0000000000000000020000000000005BE000000000" /f
reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "NoWinKeys" /t REG_DWORD /d 1 /f
reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "NoWinKeys" /t REG_DWORD /d 1 /f
reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "DisableTaskMgr" /t REG_DWORD /d 1 /f
reg add "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v "DisableTaskMgr" /t REG_DWORD /d 1 /f
reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "NoKeyboardAccess" /t REG_DWORD /d 1 /f

REM Disable Task View functionality
reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v "EnableTaskGroups" /t REG_DWORD /d 0 /f
reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v "VirtualDesktopTaskbarFilter" /t REG_DWORD /d 0 /f
reg add "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced" /v "VirtualDesktopAltTabFilter" /t REG_DWORD /d 0 /f

REM Restart Explorer to apply changes
taskkill /f /im explorer.exe
start explorer.exe

exit /b 0
`.trim();

            // Create VBS to run the batch with elevation and handle UAC response
            const vbsContent = `
Set objShell = CreateObject("Shell.Application")
objShell.ShellExecute "${this.batchPath.replace(/\\/g, '\\\\')}", "", "", "runas", 1
`.trim();

            // Write files
            fs.writeFileSync(this.batchPath, batchContent);
            fs.writeFileSync(this.vbsPath, vbsContent);

            // Execute the VBS script
            await new Promise((resolve) => {
                exec(`cscript //nologo "${this.vbsPath}"`, () => {
                    resolve();
                });
            });

            // Wait for result file and check outcome
            await new Promise((resolve) => setTimeout(resolve, 2000));

            if (!fs.existsSync(this.resultPath)) {
                process.exit(1); // Exit if UAC was cancelled
            }

            const result = fs.readFileSync(this.resultPath, 'utf8');
            if (result.includes('CANCELLED')) {
                process.exit(1);
            }

            // Setup keyboard hook only if successful
            this.setupEnhancedKeyboardHook();
            return { success: true, message: 'Windows key blocking initialized' };

        } catch (error) {
            process.exit(1);
        } finally {
            this.cleanupExistingFiles();
        }
    }

    setupEnhancedKeyboardHook() {
        if (this.keyboardListener) {
            this.keyboardListener.kill();
        }

        this.keyboardListener = new GlobalKeyboardListener();
        
        this.keyboardListener.addListener((e, down) => {
            if (e.state.windows || 
                e.name === "Left Windows" || 
                e.name === "Right Windows" ||
                (e.name === "Tab" && (e.state.windows || e.state.alt)) ||
                (e.state.windows && ["D", "E", "R", "Tab", "L", "M"].includes(e.name)) ||
                ["Up", "Down", "Left", "Right"].includes(e.name) || 
                (e.state.windows && ["Up", "Down", "Left", "Right"].includes(e.name))) {
                return false;
            }
        });
    }
    async restoreWindowsKey() {
        if (process.platform !== 'win32') {
            return { success: false, error: 'This feature is only supported on Windows' };
        }

        try {
            const batchContent = `
@echo off
echo Restoring Windows key functionality...

REM Run with administrative privileges
>nul 2>&1 "%SYSTEMROOT%\\system32\\cacls.exe" "%SYSTEMROOT%\\system32\\config\\system"
if '%errorlevel%' NEQ '0' (
    echo Set UAC = CreateObject^("Shell.Application"^) > "%temp%\\getadmin.vbs"
    echo UAC.ShellExecute "%~s0", "", "", "runas", 1 >> "%temp%\\getadmin.vbs"
    "%temp%\\getadmin.vbs"
    del "%temp%\\getadmin.vbs"
    exit /B
)

REM Remove all registry modifications
reg delete "HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Keyboard Layout" /v "Scancode Map" /f
reg delete "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "NoWinKeys" /f
reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "NoWinKeys" /f
reg delete "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System" /v "DisableTaskMgr" /f

REM Force a restart of explorer to apply changes
taskkill /f /im explorer.exe 2>nul
start explorer.exe

echo Windows key functionality restored
del "%~f0"
`.trim();

            // Write the restoration batch file
            fs.writeFileSync(this.batchPath, batchContent, { encoding: 'utf8' });

            // Execute the restoration batch file
            await new Promise((resolve, reject) => {
                exec(`"${this.batchPath}"`, (error, stdout, stderr) => {
                    if (error && error.code !== 1) {
                        reject(error);
                        return;
                    }
                    resolve(stdout);
                });
            });

            // Kill any existing keyboard listener
            if (this.keyboardListener) {
                this.keyboardListener.kill();
                this.keyboardListener = null;
            }

            return { success: true, message: 'Windows key functionality restored successfully' };
        } catch (error) {
            return { success: false, error: `Failed to restore Windows key: ${error.message}` };
        }
    }
    cleanup() {
        if (this.keyboardListener) {
            this.keyboardListener.kill();
            this.keyboardListener = null;
        }
        this.cleanupExistingFiles();
    }
}

module.exports = WindowsKeyManager;