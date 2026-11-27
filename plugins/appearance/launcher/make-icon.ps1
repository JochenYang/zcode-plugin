# Makes a Windows .ico with four sizes (256, 48, 32, 16) from one PNG, using only the .NET
# types Windows ships. The 256px image is stored PNG-compressed (what Windows expects at that
# size); the small ones are stored as plain 32-bit bitmaps with their alpha, which every part
# of the shell has drawn since forever.
#
#   powershell -NoProfile -File make-icon.ps1 -Source icon.png -Out app.ico
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Out
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$image = [System.Drawing.Image]::FromFile($Source)
$sizes = @(256, 48, 32, 16)
$blobs = @()
foreach ($size in $sizes) {
  $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.Clear([System.Drawing.Color]::Transparent)
  $graphics.DrawImage($image, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $graphics.Dispose()

  if ($size -eq 256) {
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    $blobs += , @($size, 'png', $stream.ToArray())
    $stream.Dispose()
  } else {
    # A DIB: the header with the height doubled, then the rows from the bottom up as BGRA,
    # then a 1-bit transparency mask of all zeros (the alpha channel already says it).
    $stride = $size * 4
    $maskStride = [int]([math]::Floor(($size + 31) / 32)) * 4
    $dib = New-Object System.IO.MemoryStream
    $writer = New-Object System.IO.BinaryWriter($dib)
    $writer.Write([uint32]40)
    $writer.Write([int32]$size)
    $writer.Write([int32]($size * 2))
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]0)
    $writer.Write([uint32]($stride * $size + $maskStride * $size))
    for ($i = 0; $i -lt 4; $i++) { $writer.Write([int32]0) }
    for ($y = $size - 1; $y -ge 0; $y--) {
      for ($x = 0; $x -lt $size; $x++) {
        $pixel = $bitmap.GetPixel($x, $y)
        $writer.Write([byte]$pixel.B)
        $writer.Write([byte]$pixel.G)
        $writer.Write([byte]$pixel.R)
        $writer.Write([byte]$pixel.A)
      }
    }
    $writer.Write((New-Object byte[] ($maskStride * $size)))
    $writer.Flush()
    $blobs += , @($size, 'dib', $dib.ToArray())
    $writer.Dispose()
    $dib.Dispose()
  }
  $bitmap.Dispose()
}
$image.Dispose()

# (PowerShell variable names ignore case: `$Out` above is a string by its type constraint, so
# nothing in here may be called `$out`, or it would silently become a string too.)
$icoStream = New-Object System.IO.MemoryStream
$icoWriter = New-Object System.IO.BinaryWriter($icoStream)
$icoWriter.Write([uint16]0)
$icoWriter.Write([uint16]1)
$icoWriter.Write([uint16]$blobs.Count)
$offset = 6 + 16 * $blobs.Count
foreach ($blob in $blobs) {
  $size = $blob[0]
  $bytes = $blob[2]
  $icoWriter.Write([byte]$(if ($size -ge 256) { 0 } else { $size }))
  $icoWriter.Write([byte]$(if ($size -ge 256) { 0 } else { $size }))
  $icoWriter.Write([byte]0)
  $icoWriter.Write([byte]0)
  $icoWriter.Write([uint16]1)
  $icoWriter.Write([uint16]32)
  $icoWriter.Write([uint32]$bytes.Length)
  $icoWriter.Write([uint32]$offset)
  $offset += $bytes.Length
}
foreach ($blob in $blobs) { $icoWriter.Write([byte[]]$blob[2]) }
$icoWriter.Flush()
[System.IO.File]::WriteAllBytes($Out, $icoStream.ToArray())
$icoWriter.Dispose()
$icoStream.Dispose()
Write-Output ("icon: {0} bytes, sizes {1}" -f (Get-Item $Out).Length, ($sizes -join ', '))
