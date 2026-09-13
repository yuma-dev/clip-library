# Samples three screen points (30%, 50%, 70% of the width at 45% height) at
# ~25 ms intervals and prints "ms,r,g,b,r,g,b,r,g,b" lines. Used by
# cold-start.js --pixel-probe to detect white (or empty) frames between the
# window appearing and the library painting. Arg: duration in ms.
param([int]$DurationMs = 3000)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$y = [int]($screen.Height * 0.45)
$xs = @([int]($screen.Width * 0.3), [int]($screen.Width * 0.5), [int]($screen.Width * 0.7))
$bmp = New-Object System.Drawing.Bitmap 1, 1
$g = [System.Drawing.Graphics]::FromImage($bmp)
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$epoch = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
Write-Output "epoch,$epoch"
while ($sw.ElapsedMilliseconds -lt $DurationMs) {
  $line = "$($sw.ElapsedMilliseconds)"
  foreach ($x in $xs) {
    $g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
    $c = $bmp.GetPixel(0, 0)
    $line += ",$($c.R),$($c.G),$($c.B)"
  }
  Write-Output $line
  Start-Sleep -Milliseconds 20
}
