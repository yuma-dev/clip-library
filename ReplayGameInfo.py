import json
import os
import threading
import subprocess
import ctypes
from ctypes import wintypes
import time
from typing import Optional

import obspython as obs

# ---------------------------- CONFIGURABLE SECTION -------------------------------- #
# No capture-source look-up required – we rely on focused window

# Win32 constants & helpers (kept minimal – no external deps)
user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
psapi = ctypes.windll.psapi

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MAX_PATH = 260

windowsSystemApps = [
  "explorer.exe",           # File Explorer
  "SystemSettings.exe",     # Windows Settings
  "SearchUI.exe",           # Windows Search
  "ShellExperienceHost.exe",
  "StartMenuExperienceHost.exe",
  "Taskmgr.exe",            # Task Manager
  "SnippingTool.exe",       # Snipping Tool
  "SnipAndSketch.exe",
  "Magnify.exe",            # Magnifier
  "Narrator.exe",
  "osk.exe",                # On-screen keyboard
  "MSPaint.exe",            # Paint
  "notepad.exe",
  "winver.exe",             # Windows version dialog
  "calc.exe",               # Calculator
  "mspaint.exe",            # Paint
  "winword.exe",            # Word (arguably could be useful)
  "excel.exe",              # Excel
  "powerpnt.exe",           # PowerPoint
  "OneNote.exe",
  "regedit.exe",
  "cmd.exe",
  "powershell.exe",
  "WindowsTerminal.exe",
  "wt.exe",                 # Terminal (alt)
  "conhost.exe",
  "mmc.exe",                # Management console
  "control.exe",            # Control Panel
  "rundll32.exe",
  "CompMgmtLauncher.exe",   # Computer Management
  "ApplicationFrameHost.exe", # UWP host process
  "RuntimeBroker.exe",      # UWP broker process
  "taskschd.msc",
  "eventvwr.msc",
  "perfmon.exe",
  "dfrgui.exe",             # Defragmenter
  "OptionalFeatures.exe",
  "SystemPropertiesComputerName.exe",
  "TaskSchd.exe",          # Task Scheduler main executable
  "schtasks.exe",          # Task Scheduler CLI
  "services.msc",          # Services console
  "devmgmt.msc",           # Device Manager
  "diskmgmt.msc",          # Disk Management
  "compmgmt.msc",          # Computer Management (MMC)
  "gpedit.msc",            # Group Policy Editor
  "secpol.msc",            # Local Security Policy
  "Msinfo32.exe",          # System Information
  "dxdiag.exe",            # DirectX Diagnostic Tool
  "wscript.exe",           # Windows Script Host
  "cscript.exe",           # Windows Script Host (CLI)
  "mrt.exe",                # Malicious Software Removal Tool
  "SearchApp.exe",          # New Windows Search host
  "LockApp.exe",            # Lock screen overlay
  "ctfmon.exe",             # Text Services Framework (IME)
  "sihost.exe",             # Shell Infrastructure Host
  "BackgroundTaskHost.exe", # UWP background task host
  "SettingSyncHost.exe",    # Settings sync host
  "YourPhone.exe",          # Phone Link
  "PhoneExperienceHost.exe",
  "FilePickerHost.exe",     # File picker dialog
  "PickerHost.exe",         # Variation of file picker
  "smartscreen.exe",        # Windows SmartScreen
  "WerFault.exe",           # Error Reporting
  "cleanmgr.exe",           # Disk Cleanup utility
  # Common MMC snap‐ins not yet listed
  "certmgr.msc",            # Certificate Manager
  "wf.msc"                  # Windows Firewall with Advanced Security
]

archiveToolsAndFileManagers = [
  "7zFM.exe",               # 7-Zip
  "WinRAR.exe",
  "WinZip32.exe",
  "PeaZip.exe",
  "TotalCmd.exe",
  "FreeCommander.exe",
  "Q-Dir.exe",
  "MultiCommander.exe",
  "Everything.exe",
  "TreeSizeFree.exe"
]

installerAndLauncherApps = [
  "setup.exe",
  "uninstall.exe",
  "msiexec.exe",
  "dxsetup.exe",
  "installshield.exe",
  "bootstrapper.exe",
  "update.exe",
  "unins000.exe",
]

virtualizationApps = [
  "vmware.exe",
  "vmware-vmx.exe",
  "VirtualBox.exe",
  "vboxheadless.exe",
  "vboxmanage.exe",
  "mstsc.exe",             
  "TeamViewer.exe",
]

antivirusAndCleanerApps = [
  "AvastUI.exe",
  "avgui.exe",
  "msmpeng.exe",
  "SecurityHealthSystray.exe",
  "Malwarebytes.exe",
  "CCleaner.exe",
  "AdwCleaner.exe",
  "NortonSecurity.exe",
  "McUICnt.exe"
]

debuggingAndDevTools = [
  "Procmon.exe",            # Sysinternals
  "ProcessHacker.exe",
  "ProcessExplorer.exe",
  "Autoruns.exe",
  "VMMap.exe",
  "windbg.exe",
  "OllyDbg.exe",
  "x64dbg.exe",
  "DependencyWalker.exe",
  "HxD.exe"                 # Hex editor
]

printerScannerApps = [
  "FaxConsole.exe",
  "PrintDialog.exe",
  "printmanagement.msc",
  "HPScan.exe",
  "CanonIJ.exe",
  "EpsonScan.exe"
]

accessories = [
  "wordpad.exe",
  "write.exe",
  "charmap.exe",            # Character map
  "stikynot.exe",           # Sticky Notes
  "XpsRchVw.exe",           # XPS viewer
  "hh.exe",                 # HTML Help Viewer
  "MobilityCenter.exe"
]

ignoredExecutables = (
    windowsSystemApps +
    archiveToolsAndFileManagers +
    installerAndLauncherApps +
    virtualizationApps +
    antivirusAndCleanerApps +
    debuggingAndDevTools +
    printerScannerApps +
    accessories
)

# Pre-compute a lower-case set for fast, case-insensitive look-ups
ignoredExecutables_lower = {name.lower() for name in ignoredExecutables}

# No global source uuid needed anymore


def debug(msg: str):
    """Write a message to both OBS log and stdout for easy troubleshooting."""
    tagged = f"[ReplayGameInfo] {msg}"
    print(tagged)
    try:
        obs.script_log(obs.LOG_INFO, tagged)
    except Exception:
        # obs might not be initialized yet (during module import)
        pass


# ----------------------------------------------------------------------------
# Low-level helpers to resolve executable path for a window title (ctypes only)
# ----------------------------------------------------------------------------

# Helper: quickly fetch foreground window title & hwnd

debug("ReplayGameInfo script loaded and event callback registered")

def get_foreground_window_info():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return "", None
    length = user32.GetWindowTextLengthW(hwnd)
    buf = ctypes.create_unicode_buffer(length + 1)
    user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value
    return title, hwnd


def _get_executable_from_hwnd(hwnd: int):
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    h_process = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid.value)
    if not h_process:
        return None
    exe_path_buf = ctypes.create_unicode_buffer(MAX_PATH)
    psapi.GetModuleFileNameExW(h_process, None, exe_path_buf, MAX_PATH)
    kernel32.CloseHandle(h_process)
    return exe_path_buf.value if exe_path_buf.value else None


# Convenience wrapper for exe from hwnd

def get_executable_from_hwnd(hwnd):
    return _get_executable_from_hwnd(hwnd)


# -------------------------------------------------------------
# Icon extraction via a tiny PowerShell call (fast & dependency-free)
# -------------------------------------------------------------

def extract_icon(exe_path: str, out_path: str):
    """Extract the associated icon of an executable to PNG using PowerShell."""
    ps_cmd = (
        "Add-Type -AssemblyName System.Drawing; "
        f"$icon=[System.Drawing.Icon]::ExtractAssociatedIcon('{exe_path.replace("'", "''")}'); "
        "$bmp=$icon.ToBitmap(); "
        f"$bmp.Save('{out_path.replace("'", "''")}',[System.Drawing.Imaging.ImageFormat]::Png);"
    )
    try:
        creation_flag = 0
        if os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW"):
            creation_flag = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]

        subprocess.run(
            [
                "powershell",
                "-NoLogo",
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                ps_cmd,
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            creationflags=creation_flag,
        )
        return True
    except Exception as e:
        debug(f"Icon extraction failed: {e}")
        return False


# ------------------------------
# Core per-recording work routine
# ------------------------------

def handle_replay_saved(recording_path: str, window_title: str, exe_path: Optional[str]):
    try:
        # Skip generating metadata for ignored executables
        if exe_path:
            exe_basename_full = os.path.basename(exe_path)
            if exe_basename_full.lower() in ignoredExecutables_lower:
                debug(f"Executable {exe_basename_full} is in ignored list; skipping .gameinfo generation")
                return

        folder = os.path.dirname(recording_path)
        icons_dir = os.path.join(folder, "icons")
        metadata_dir = os.path.join(folder, ".clip_metadata")

        os.makedirs(icons_dir, exist_ok=True)
        os.makedirs(metadata_dir, exist_ok=True)

        icon_filename = None
        if exe_path:
            exe_basename = os.path.splitext(os.path.basename(exe_path))[0]
            icon_filename = f"{exe_basename}.png"
            icon_path = os.path.join(icons_dir, icon_filename)
            if not os.path.isfile(icon_path):
                debug(f"Extracting icon for {exe_basename} ...")
                extract_icon(exe_path, icon_path)

        # Compose and store .gameinfo JSON
        info = {
            "window_title": window_title,
            "icon_file": icon_filename or "",
        }
        gameinfo_filename = os.path.basename(recording_path) + ".gameinfo"
        gameinfo_path = os.path.join(metadata_dir, gameinfo_filename)
        with open(gameinfo_path, "w", encoding="utf-8") as f:
            json.dump(info, f)
        debug(f".gameinfo saved to {gameinfo_path}")
    except Exception as exc:
        debug(f"Failed to handle replay info: {exc}")


# --------------------------
# OBS event / signal plumbing
# --------------------------

def replay_buffer_event_cb(event):
    if event == obs.OBS_FRONTEND_EVENT_REPLAY_BUFFER_SAVED:
        debug("Replay Buffer Saved event received")
        recording_path = obs.obs_frontend_get_last_replay()
        if not recording_path:
            return

        window_title, hwnd = get_foreground_window_info()
        if not window_title:
            window_title = "Unknown Window"
        exe_path = get_executable_from_hwnd(hwnd) if hwnd else None

        threading.Thread(
            target=handle_replay_saved,
            args=(recording_path, window_title, exe_path),
            daemon=True,
        ).start()


# ------------------
# OBS script hooks
# ------------------

def script_load(settings):
    debug("ReplayGameInfo script loaded and event callback registered")
    obs.obs_frontend_add_event_callback(replay_buffer_event_cb)


def script_unload():
    obs.obs_frontend_remove_event_callback(replay_buffer_event_cb)


def script_description():
    return (
        "<h3>Replay GameInfo Generator</h3>"
        "<hr>Creates a <code>.gameinfo</code> JSON file and extracts the application icon for every saved replay buffer recording."
    )

# No user-exposed properties required for now.

def script_properties():
    return obs.obs_properties_create() 