param(
    [string]$AndroidSdk = "",
    [string]$JavaHome = "",
    [string]$GradlePath = "",
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug',
    [switch]$SkipNpmInstall,
    [switch]$SkipTests
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendDir = Join-Path $repoRoot 'frontend'
$androidDir = Join-Path $frontendDir 'android'

if ($AndroidSdk) {
    if (-not [IO.Path]::IsPathRooted($AndroidSdk)) {
        $AndroidSdk = [IO.Path]::GetFullPath((Join-Path $repoRoot $AndroidSdk))
    }
    $env:ANDROID_HOME = $AndroidSdk
    $env:ANDROID_SDK_ROOT = $AndroidSdk
}
if (-not $env:ANDROID_HOME -or -not (Test-Path -LiteralPath $env:ANDROID_HOME)) {
    throw 'Android SDK not found. Set ANDROID_HOME or pass -AndroidSdk.'
}

if ($JavaHome) {
    if (-not [IO.Path]::IsPathRooted($JavaHome)) {
        $JavaHome = [IO.Path]::GetFullPath((Join-Path $repoRoot $JavaHome))
    }
    $providedJava = Join-Path $JavaHome 'bin\java.exe'
    if (-not (Test-Path -LiteralPath $providedJava)) {
        $providedJava = Get-ChildItem -LiteralPath $JavaHome -Recurse -Filter java.exe -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\bin\\java\.exe$' } |
            Select-Object -First 1
        if ($providedJava) { $JavaHome = $providedJava.Directory.Parent.FullName }
    }
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

$variant = $Configuration.ToLowerInvariant()
$gradleTask = if ($Configuration -eq 'Release') { 'assembleRelease' } else { 'assembleDebug' }
if ($Configuration -eq 'Release') {
    $keystoreProperties = Join-Path $androidDir 'keystore.properties'
    if (-not (Test-Path -LiteralPath $keystoreProperties)) {
        throw 'Release signing is not configured. Copy frontend/android/keystore.properties.example to frontend/android/keystore.properties and fill it locally.'
    }
    $propertiesText = [IO.File]::ReadAllText($keystoreProperties, [Text.Encoding]::UTF8)
    foreach ($requiredKey in @('storeFile', 'storePassword', 'keyAlias', 'keyPassword')) {
        if ($propertiesText -notmatch "(?m)^\s*$requiredKey\s*=\s*(?!CHANGE_ME\s*$).+\S\s*$") {
            throw "Release signing property is missing or still a placeholder: $requiredKey"
        }
    }
}

Push-Location $frontendDir
try {
    if (-not $SkipNpmInstall) {
        npm ci
        if ($LASTEXITCODE -ne 0) { throw 'Failed to install locked frontend dependencies.' }
    }
    if (-not $SkipTests) {
        npm run test:contract
        if ($LASTEXITCODE -ne 0) { throw 'Frontend contract tests failed.' }
        npm run test:mobile --if-present
        if ($LASTEXITCODE -ne 0) { throw 'Frontend mobile tests failed.' }
        npm run test:zju --if-present
        if ($LASTEXITCODE -ne 0) { throw 'Frontend ZJU tests failed.' }
        npm run test:platform --if-present
        if ($LASTEXITCODE -ne 0) { throw 'Frontend platform tests failed.' }
        npm run test:ai --if-present
        if ($LASTEXITCODE -ne 0) { throw 'Frontend AI tests failed.' }
    }
    npm run android:sync
    if ($LASTEXITCODE -ne 0) { throw 'Failed to sync the Capacitor Android project.' }

    if (-not $GradlePath) {
        $localGradle = Get-ChildItem -LiteralPath (Join-Path $repoRoot '.downloads\gradle-dist') -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -match '\\bin\\gradle\.bat$' } |
            Select-Object -First 1
        if ($localGradle) { $GradlePath = $localGradle.FullName }
    }

    Push-Location $androidDir
    try {
        $gradleExecutable = if ($GradlePath) { $GradlePath } else { Join-Path $androidDir 'gradlew.bat' }
        if (-not $SkipTests) {
            & $gradleExecutable --no-daemon --no-parallel --max-workers=1 testDebugUnitTest
            if ($LASTEXITCODE -ne 0) { throw 'Android unit tests failed.' }
        }
        & $gradleExecutable --no-daemon --no-parallel --max-workers=1 $gradleTask
        if ($LASTEXITCODE -ne 0) { throw "Failed to build the Android $Configuration APK." }
    } finally {
        Pop-Location
    }

    $apk = Join-Path $androidDir "app\build\outputs\apk\$variant\app-$variant.apk"
    if (-not (Test-Path -LiteralPath $apk)) { throw "Missing Android artifact: $apk" }
    $releaseDir = Join-Path $repoRoot 'release\android'
    $appVersion = ([IO.File]::ReadAllText((Join-Path $frontendDir 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json).version
    $stableApk = Join-Path $releaseDir "riji-android-$appVersion-$variant.apk"
    New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
    Copy-Item -LiteralPath $apk -Destination $stableApk -Force
    $sha256 = (Get-FileHash -LiteralPath $stableApk -Algorithm SHA256).Hash
    Write-Host "apk: $apk"
    Write-Host "release: $stableApk"
    Write-Host "sha256: $sha256"
} finally {
    Pop-Location
}
