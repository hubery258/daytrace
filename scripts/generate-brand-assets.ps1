param([string]$RepoRoot = "")

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $RepoRoot) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)

Add-Type -AssemblyName System.Drawing

function New-RoundedRectanglePath {
    param([float]$X, [float]$Y, [float]$Width, [float]$Height, [float]$Radius)
    $path = [Drawing.Drawing2D.GraphicsPath]::new()
    $diameter = $Radius * 2
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-RijiBitmap {
    param(
        [int]$Size,
        [ValidateSet('square', 'round', 'foreground')][string]$Background = 'square',
        [float]$LogoScale = 0.86
    )

    $bitmap = [Drawing.Bitmap]::new($Size, $Size, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.Clear([Drawing.Color]::Transparent)

    $warm = [Drawing.ColorTranslator]::FromHtml('#f8f5ed')
    $graphite = [Drawing.ColorTranslator]::FromHtml('#3b403f')
    $amber = [Drawing.ColorTranslator]::FromHtml('#e4a83d')
    $teal = [Drawing.ColorTranslator]::FromHtml('#286466')

    if ($Background -eq 'square') {
        $graphics.Clear($warm)
    } elseif ($Background -eq 'round') {
        $graphics.FillEllipse([Drawing.SolidBrush]::new($warm), 0, 0, $Size, $Size)
    }

    $unitScale = ($Size / 256.0) * $LogoScale
    $offset = ($Size - (256 * $unitScale)) / 2.0
    $graphics.TranslateTransform($offset, $offset)
    $graphics.ScaleTransform($unitScale, $unitScale)

    $roundCap = [Drawing.Drawing2D.LineCap]::Round
    $roundJoin = [Drawing.Drawing2D.LineJoin]::Round

    $amberPen = [Drawing.Pen]::new($amber, 7)
    $amberPen.StartCap = $roundCap
    $amberPen.EndCap = $roundCap
    foreach ($ray in @(@(128,68,128,81),@(96,79,104,90),@(160,79,152,90),@(78,104,92,109),@(178,104,164,109))) {
        $graphics.DrawLine($amberPen, $ray[0], $ray[1], $ray[2], $ray[3])
    }
    $graphics.FillEllipse([Drawing.SolidBrush]::new($amber), 97, 89, 62, 62)

    $horizon = [Drawing.Drawing2D.GraphicsPath]::new()
    $horizon.AddBezier(43, 134, 90, 117, 155, 111, 214, 131)
    $horizonPen = [Drawing.Pen]::new($graphite, 9)
    $horizonPen.StartCap = $roundCap
    $horizonPen.EndCap = $roundCap
    $graphics.DrawPath($horizonPen, $horizon)

    $track = [Drawing.Drawing2D.GraphicsPath]::new()
    $track.AddBezier(79, 190, 88, 169, 105, 160, 127, 152)
    $track.AddBezier(127, 152, 152, 144, 169, 135, 178, 119)
    $trackPen = [Drawing.Pen]::new($teal, 7)
    $trackPen.StartCap = $roundCap
    $trackPen.EndCap = $roundCap
    $trackPen.LineJoin = $roundJoin
    $graphics.DrawPath($trackPen, $track)

    $warmBrush = [Drawing.SolidBrush]::new($warm)
    $tealBrush = [Drawing.SolidBrush]::new($teal)
    foreach ($dot in @(@(79,190,12),@(119,158,9),@(153,143,7))) {
        $radius = $dot[2]
        $graphics.FillEllipse($warmBrush, $dot[0] - $radius - 3, $dot[1] - $radius - 3, ($radius + 3) * 2, ($radius + 3) * 2)
        $graphics.FillEllipse($tealBrush, $dot[0] - $radius, $dot[1] - $radius, $radius * 2, $radius * 2)
    }

    $calendarPath = New-RoundedRectanglePath -X 42 -Y 43 -Width 172 -Height 170 -Radius 35
    $calendarPen = [Drawing.Pen]::new($graphite, 13)
    $calendarPen.LineJoin = $roundJoin
    $graphics.DrawPath($calendarPen, $calendarPath)
    $graphics.DrawLine($calendarPen, 91, 31, 91, 58)
    $graphics.DrawLine($calendarPen, 165, 31, 165, 58)

    $amberPen.Dispose()
    $horizon.Dispose()
    $horizonPen.Dispose()
    $track.Dispose()
    $trackPen.Dispose()
    $warmBrush.Dispose()
    $tealBrush.Dispose()
    $calendarPath.Dispose()
    $calendarPen.Dispose()
    $graphics.Dispose()
    return $bitmap
}

function Save-Png {
    param([Drawing.Bitmap]$Bitmap, [string]$Path)
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
    $Bitmap.Save($Path, [Drawing.Imaging.ImageFormat]::Png)
    $Bitmap.Dispose()
}

$frontend = Join-Path $RepoRoot 'frontend'
Save-Png (New-RijiBitmap -Size 512) (Join-Path $frontend 'build\icon.png')
Save-Png (New-RijiBitmap -Size 180) (Join-Path $frontend 'public\apple-touch-icon.png')

$densitySizes = @{
    'mdpi' = 48
    'hdpi' = 72
    'xhdpi' = 96
    'xxhdpi' = 144
    'xxxhdpi' = 192
}
foreach ($density in $densitySizes.Keys) {
    $dir = Join-Path $frontend "android\app\src\main\res\mipmap-$density"
    Save-Png (New-RijiBitmap -Size $densitySizes[$density]) (Join-Path $dir 'ic_launcher.png')
    Save-Png (New-RijiBitmap -Size $densitySizes[$density] -Background round -LogoScale 0.76) (Join-Path $dir 'ic_launcher_round.png')
    Save-Png (New-RijiBitmap -Size ([int]($densitySizes[$density] * 2.25)) -Background foreground -LogoScale 0.66) (Join-Path $dir 'ic_launcher_foreground.png')
}

$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
$payloads = @()
foreach ($size in $icoSizes) {
    $bitmap = New-RijiBitmap -Size $size
    $stream = [IO.MemoryStream]::new()
    $bitmap.Save($stream, [Drawing.Imaging.ImageFormat]::Png)
    $payloads += ,$stream.ToArray()
    $stream.Dispose()
    $bitmap.Dispose()
}
$icoPath = Join-Path $frontend 'build\icon.ico'
$icoDirectory = Split-Path -Parent $icoPath
New-Item -ItemType Directory -Path $icoDirectory -Force | Out-Null
$file = [IO.File]::Create($icoPath)
$writer = [IO.BinaryWriter]::new($file)
$writer.Write([uint16]0)
$writer.Write([uint16]1)
$writer.Write([uint16]$icoSizes.Count)
$offset = 6 + (16 * $icoSizes.Count)
for ($index = 0; $index -lt $icoSizes.Count; $index++) {
    $size = $icoSizes[$index]
    $dimension = if ($size -ge 256) { 0 } else { $size }
    $writer.Write([byte]$dimension)
    $writer.Write([byte]$dimension)
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$payloads[$index].Length)
    $writer.Write([uint32]$offset)
    $offset += $payloads[$index].Length
}
foreach ($payload in $payloads) { $writer.Write($payload) }
$writer.Dispose()
$file.Dispose()

Write-Host "brand svg: $frontend\src\assets\brand\riji-logo.svg"
Write-Host "electron ico: $icoPath"
Write-Host "android icons: $frontend\android\app\src\main\res\mipmap-*"
