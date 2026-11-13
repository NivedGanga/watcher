$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true

Push-Location "$PSScriptRoot/../cli"
try {
    python -m pip install -e . pyinstaller certifi
    python -m PyInstaller --onefile --name snitch --paths src `
        --collect-data snitch --collect-data certifi --clean -y `
        tools/pyinstaller-entry.py
    $destination = "$PSScriptRoot/platforms/win32-x64/bin"
    New-Item -ItemType Directory -Force $destination | Out-Null
    Copy-Item dist/snitch.exe $destination
    & "$destination/snitch.exe" --version
} finally {
    Pop-Location
}
