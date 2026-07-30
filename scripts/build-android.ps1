param(
    [string]$AndroidSdk = "",
    [string]$JavaHome = "",
    [string]$GradlePath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot 'frontend'

if ($AndroidSdk) {
    $env:ANDROID_HOME = $AndroidSdk
    $env:ANDROID_SDK_ROOT = $AndroidSdk
}
if (-not $env:ANDROID_HOME -or -not (Test-Path -LiteralPath $env:ANDROID_HOME)) {
    throw 'Android SDK not found. Set ANDROID_HOME or pass -AndroidSdk.'
}

if ($JavaHome) {
    $env:JAVA_HOME = $JavaHome
} else {
    $localJdkRoot = Join-Path $repoRoot '.jdk-21'
    $localJava = Get-ChildItem -LiteralPath $localJdkRoot -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\bin\\java\.exe$' } |
        Select-Object -First 1
    if ($localJava) { $env:JAVA_HOME = $localJava.Directory.Parent.FullName }
}
$javaExe = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin\java.exe' } else { '' }
if (-not $javaExe -or -not (Test-Path -LiteralPath $javaExe)) {
    throw 'JDK 21 not found. Set JAVA_HOME, pass -JavaHome, or place a portable JDK under .jdk-21.'
}
$javaVersion = (& $javaExe --version | Select-Object -First 1) -join ''
if ($javaVersion -notmatch '(?<major>\d+)(?:\.\d+)+') { throw "Unable to detect Java version: $javaVersion" }
if ([int]$Matches.major -lt 21) { throw "Capacitor 8 Android build requires JDK 21 or newer; found: $javaVersion" }

Push-Location $frontendDir
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install frontend dependencies.' }
    npm run android:sync
    if ($LASTEXITCODE -ne 0) { throw 'Failed to sync the Capacitor Android project.' }

    if (-not $GradlePath) {
        $localGradle = Get-ChildItem -LiteralPath (Join-Path $repoRoot '.downloads\gradle-dist') -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\bin\\gradle\.bat$' } |
            Select-Object -First 1
        if ($localGradle) { $GradlePath = $localGradle.FullName }
    }

    Push-Location (Join-Path $frontendDir 'android')
    try {
        if ($GradlePath) {
            & $GradlePath --no-daemon --no-parallel --max-workers=1 assembleDebug
        } else {
            .\gradlew.bat --no-daemon --no-parallel --max-workers=1 assembleDebug
        }
        if ($LASTEXITCODE -ne 0) { throw 'Failed to build the Android debug APK.' }
    } finally {
        Pop-Location
    }

    $apk = Join-Path $frontendDir 'android\app\build\outputs\apk\debug\app-debug.apk'
    if (-not (Test-Path -LiteralPath $apk)) { throw "Missing Android artifact: $apk" }
    $releaseDir = Join-Path $repoRoot 'release\android'
    $stableApk = Join-Path $releaseDir 'riji-android-0.6.0-debug.apk'
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
    Copy-Item -LiteralPath $apk -Destination $stableApk -Force
    Write-Host "apk: $apk"
    Write-Host "release: $stableApk"
} finally {
    Pop-Location
}
