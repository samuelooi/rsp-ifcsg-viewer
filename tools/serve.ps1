<#
  serve.ps1 — minimal static web server for local development.

  The viewer uses ES modules and fetches data/ifcsg-rules.json, so it cannot be
  opened as a file:// page; it has to be served over http. This avoids needing
  Node or Python installed just to look at the model.

      powershell -File tools/serve.ps1            # http://localhost:8080
      powershell -File tools/serve.ps1 -Port 9000

  Ctrl+C to stop.
#>
[CmdletBinding()]
param(
  [int]$Port = 8080,
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
if ($Root -eq '') { $Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$Root = (Resolve-Path $Root).Path

# ES modules are rejected by browsers unless served with a JavaScript MIME type,
# so the map below matters more than it looks.
$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.wasm' = 'application/wasm'
  '.ifc'  = 'application/octet-stream'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.ico'  = 'image/x-icon'
  '.woff2' = 'font/woff2'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  throw "Could not listen on port $Port. Is something already using it? ($($_.Exception.Message))"
}

Write-Host ""
Write-Host "  RSP IFC-SG Viewer" -ForegroundColor Cyan
Write-Host "  serving $Root"
Write-Host "  http://localhost:$Port/" -ForegroundColor Green
Write-Host "  Ctrl+C to stop"
Write-Host ""

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $req = $ctx.Request
    $res = $ctx.Response

    try {
      $rel = [Uri]::UnescapeDataString($req.Url.AbsolutePath).TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }

      $full = Join-Path $Root ($rel -replace '/', '\')

      # Refuse anything that resolves outside the served root.
      $resolved = $null
      try { $resolved = (Resolve-Path -LiteralPath $full -ErrorAction Stop).Path } catch { $resolved = $null }

      if (-not $resolved -or -not $resolved.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        $res.StatusCode = 404
        $body = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: /$rel")
        $res.ContentType = 'text/plain; charset=utf-8'
        $res.ContentLength64 = $body.Length
        $res.OutputStream.Write($body, 0, $body.Length)
      } else {
        $ext = [System.IO.Path]::GetExtension($resolved).ToLowerInvariant()
        $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
        $res.Headers.Add('Cache-Control', 'no-cache')
        $bytes = [System.IO.File]::ReadAllBytes($resolved)
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
      Write-Host ("  {0,-3} {1}" -f $res.StatusCode, "/$rel")
    } catch {
      Write-Host "  500 $($_.Exception.Message)" -ForegroundColor Red
      try { $res.StatusCode = 500 } catch { }
    } finally {
      try { $res.OutputStream.Close() } catch { }
    }
  }
} finally {
  $listener.Stop()
  $listener.Close()
}
