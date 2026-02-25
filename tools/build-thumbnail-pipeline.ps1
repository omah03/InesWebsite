param(
  [string]$PhotosDir = "photos",
  [string]$ThumbsSubDir = "_thumbs",
  [string]$WebImagesSubDir = "_web",
  [int]$ThumbMaxEdge = 720,
  [int]$WebMaxEdge = 2400,
  [int]$JpegQuality = 78,
  [int]$WebJpegQuality = 86,
  [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($ThumbMaxEdge -lt 160) {
  throw "ThumbMaxEdge must be >= 160."
}

if ($WebMaxEdge -lt 720) {
  throw "WebMaxEdge must be >= 720."
}

if ($JpegQuality -lt 40 -or $JpegQuality -gt 95) {
  throw "JpegQuality must be in range 40..95."
}

if ($WebJpegQuality -lt 40 -or $WebJpegQuality -gt 95) {
  throw "WebJpegQuality must be in range 40..95."
}

$heicExts = @(".heic", ".heif")
$imageExts = @(".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp") + $heicExts
$videoExts = @(".mp4", ".webm", ".ogg", ".mov")

$photosPath = Resolve-Path -Path $PhotosDir
$thumbsPath = Join-Path $photosPath $ThumbsSubDir
$webImagesPath = Join-Path $photosPath $WebImagesSubDir
if (-not (Test-Path $thumbsPath)) {
  New-Item -Path $thumbsPath -ItemType Directory | Out-Null
}
if (-not (Test-Path $webImagesPath)) {
  New-Item -Path $webImagesPath -ItemType Directory | Out-Null
}

try {
  Add-Type -AssemblyName System.Drawing
} catch {
  throw "System.Drawing is unavailable in this PowerShell runtime."
}

function Get-JpegCodec {
  [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq "image/jpeg" } |
    Select-Object -First 1
}

function Save-JpegThumbnail {
  param(
    [string]$SourcePath,
    [string]$TargetPath,
    [int]$MaxEdge,
    [int]$Quality
  )

  $sourceImage = $null
  $bitmap = $null
  $graphics = $null

  try {
    $sourceImage = [System.Drawing.Image]::FromFile($SourcePath)

    $sourceW = [double]$sourceImage.Width
    $sourceH = [double]$sourceImage.Height
    if ($sourceW -le 0 -or $sourceH -le 0) {
      throw "Invalid source dimensions."
    }

    $scale = [Math]::Min(1.0, [double]$MaxEdge / [Math]::Max($sourceW, $sourceH))
    $targetW = [Math]::Max(1, [int][Math]::Round($sourceW * $scale))
    $targetH = [Math]::Max(1, [int][Math]::Round($sourceH * $scale))

    $bitmap = New-Object System.Drawing.Bitmap($targetW, $targetH)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $graphics.DrawImage($sourceImage, 0, 0, $targetW, $targetH)

    $codec = Get-JpegCodec
    if ($null -eq $codec) {
      throw "JPEG codec not found."
    }

    $params = New-Object System.Drawing.Imaging.EncoderParameters(1)
    $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]$Quality)
    $bitmap.Save($TargetPath, $codec, $params)
  } finally {
    if ($graphics) { $graphics.Dispose() }
    if ($bitmap) { $bitmap.Dispose() }
    if ($sourceImage) { $sourceImage.Dispose() }
  }
}

function Escape-JsString {
  param([string]$Value)
  ($Value -replace "\\", "\\\\") -replace "'", "\\'"
}

$allMedia = Get-ChildItem -Path $photosPath -File | Sort-Object Name
$manifest = New-Object System.Collections.Generic.List[object]
$generated = 0
$reused = 0
$skipped = 0
$heicWebGenerated = 0
$heicWebReused = 0
$heicWebSkipped = 0

foreach ($file in $allMedia) {
  $ext = $file.Extension.ToLowerInvariant()

  if ($imageExts -contains $ext) {
    $isHeic = $heicExts -contains $ext
    $webRelPath = ""
    $thumbSourcePath = $file.FullName
    if ($isHeic) {
      $webName = "{0}.web.jpg" -f [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
      $webDiskPath = Join-Path $webImagesPath $webName
      $webRelPath = "{0}/{1}" -f $WebImagesSubDir, $webName

      $shouldBuildWeb = $Force.IsPresent -or -not (Test-Path $webDiskPath) -or ((Get-Item $webDiskPath).LastWriteTimeUtc -lt $file.LastWriteTimeUtc)
      if ($shouldBuildWeb) {
        try {
          Save-JpegThumbnail -SourcePath $file.FullName -TargetPath $webDiskPath -MaxEdge $WebMaxEdge -Quality $WebJpegQuality
          $heicWebGenerated += 1
        } catch {
          Write-Warning ("Skipping HEIC web conversion for {0}: {1}" -f $file.Name, $_.Exception.Message)
          $webRelPath = ""
          $heicWebSkipped += 1
        }
      } else {
        $heicWebReused += 1
      }

      # HEIC/HEIF files are included only when web-safe conversion is available.
      if ([string]::IsNullOrWhiteSpace($webRelPath)) {
        continue
      }

      $thumbSourcePath = $webDiskPath
    }

    $thumbName = "{0}.thumb.jpg" -f [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $thumbDiskPath = Join-Path $thumbsPath $thumbName
    $thumbRelPath = "{0}/{1}" -f $ThumbsSubDir, $thumbName
    $thumbSourceItem = Get-Item -LiteralPath $thumbSourcePath

    $shouldBuild = $Force.IsPresent -or -not (Test-Path $thumbDiskPath) -or ((Get-Item $thumbDiskPath).LastWriteTimeUtc -lt $thumbSourceItem.LastWriteTimeUtc)
    if ($shouldBuild) {
      try {
        Save-JpegThumbnail -SourcePath $thumbSourcePath -TargetPath $thumbDiskPath -MaxEdge $ThumbMaxEdge -Quality $JpegQuality
        $generated += 1
      } catch {
        Write-Warning ("Skipping thumbnail for {0}: {1}" -f $file.Name, $_.Exception.Message)
        $thumbRelPath = ""
        $skipped += 1
      }
    } else {
      $reused += 1
    }

    if ([string]::IsNullOrWhiteSpace($thumbRelPath) -and -not [string]::IsNullOrWhiteSpace($webRelPath)) {
      $thumbRelPath = $webRelPath
    }

    $manifest.Add([pscustomobject]@{
      file = $file.Name
      kind = "image"
      thumb = $thumbRelPath
      web = $webRelPath
    }) | Out-Null
    continue
  }

  if ($videoExts -contains $ext) {
    $posterName = "{0}.poster.jpg" -f [System.IO.Path]::GetFileNameWithoutExtension($file.Name)
    $posterDiskPath = Join-Path $thumbsPath $posterName
    $posterRelPath = ""
    if (Test-Path $posterDiskPath) {
      $posterRelPath = "{0}/{1}" -f $ThumbsSubDir, $posterName
    }

    $manifest.Add([pscustomobject]@{
      file = $file.Name
      kind = "video"
      thumb = $posterRelPath
      web = ""
    }) | Out-Null
  }
}

$manifestPath = Join-Path $photosPath "media-manifest.js"
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("window.PHOTO_MEDIA = [")

for ($i = 0; $i -lt $manifest.Count; $i++) {
  $entry = $manifest[$i]
  $suffix = if ($i -lt $manifest.Count - 1) { "," } else { "" }
  $lines.Add(
    ("  {{ file: '{0}', kind: '{1}', thumb: '{2}', web: '{3}' }}{4}" -f
      (Escape-JsString $entry.file),
      (Escape-JsString $entry.kind),
      (Escape-JsString $entry.thumb),
      (Escape-JsString $entry.web),
      $suffix)
  )
}

$lines.Add("];")
$lines.Add("")

Set-Content -Path $manifestPath -Value $lines -Encoding UTF8

Write-Host ("Processed media: {0}" -f $manifest.Count)
Write-Host ("Image thumbs generated: {0}" -f $generated)
Write-Host ("Image thumbs reused: {0}" -f $reused)
Write-Host ("Image thumbs skipped: {0}" -f $skipped)
Write-Host ("HEIC web images generated: {0}" -f $heicWebGenerated)
Write-Host ("HEIC web images reused: {0}" -f $heicWebReused)
Write-Host ("HEIC web images skipped: {0}" -f $heicWebSkipped)
Write-Host ("Manifest written: {0}" -f $manifestPath)
