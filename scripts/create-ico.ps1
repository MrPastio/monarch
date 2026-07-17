param (
    [string]$SourceFile,
    [string]$DestIco,
    [string]$DestPng
)

Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile($SourceFile)

$sizes = @(256, 128, 64, 48, 32, 16)
$pngStreams = @()

foreach ($size in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $size, $size)
    
    if ($size -eq 256) {
        $bmp.Save($DestPng, [System.Drawing.Imaging.ImageFormat]::Png)
    }

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngStreams += $ms
    
    $g.Dispose()
    $bmp.Dispose()
}

$fs = [System.IO.File]::Create($DestIco)
$bw = New-Object System.IO.BinaryWriter($fs)

# ICO Header
$bw.Write([uint16]0) # Reserved
$bw.Write([uint16]1) # Type: ICO
$bw.Write([uint16]$sizes.Length) # Image count

$offset = 6 + (16 * $sizes.Length)

for ($i = 0; $i -lt $sizes.Length; $i++) {
    $size = $sizes[$i]
    $stream = $pngStreams[$i]
    $data = $stream.ToArray()
    
    $bWidth = if ($size -eq 256) { [byte]0 } else { [byte]$size }
    $bHeight = if ($size -eq 256) { [byte]0 } else { [byte]$size }
    $bw.Write($bWidth) # Width
    $bw.Write($bHeight) # Height
    $bw.Write([byte]0) # Color palette count
    $bw.Write([byte]0) # Reserved
    $bw.Write([uint16]1) # Color planes
    $bw.Write([uint16]32) # BPP
    $bw.Write([uint32]$data.Length) # Size of image data
    $bw.Write([uint32]$offset) # Offset of image data
    
    $offset += $data.Length
}

for ($i = 0; $i -lt $sizes.Length; $i++) {
    $stream = $pngStreams[$i]
    $bw.Write($stream.ToArray())
    $stream.Close()
}

$bw.Close()
$fs.Close()
$img.Dispose()
