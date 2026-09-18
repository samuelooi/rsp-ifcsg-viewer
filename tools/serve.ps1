<#
  serve.ps1 — minimal static web server for local development.

  The viewer uses ES modules and fetches data/ifcsg-rules.json, so it cannot be
  opened as a file:// page; it has to be served over http. This avoids needing
  Node or Python installed just to look at the model.

      powershell -File tools/serve.ps1            # http://localhost:8080
      powershell -File tools/serve.ps1 -Port 9000

  Ctrl+C to stop.

  One small API rides along with the static files:

      GET /api/presets   data/value-presets.json (an empty list if it does not exist)
      PUT /api/presets   replaces that file with the JSON body

  The presets file is committed to git, which is how the team shares them.
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

$presetsFile = Join-Path $Root 'data\value-presets.json'
$maxPresetBytes = 1MB
$utf8 = New-Object System.Text.UTF8Encoding $false

function Send-Text($res, [int]$status, [string]$text, [string]$type = 'text/plain; charset=utf-8') {
  $res.StatusCode = $status
  $res.ContentType = $type
  $res.Headers.Add('Cache-Control', 'no-cache')
  $body = $utf8.GetBytes($text)
  $res.ContentLength64 = $body.Length
  $res.OutputStream.Write($body, 0, $body.Length)
}

<#
  /api/presets. Returns $true when the request was an API call and has been answered.

  The listener only accepts localhost, but any page open in the browser can still
  aim a request at it. Writes therefore require a JSON content type, which makes
  the browser send a CORS preflight that this server never approves, and any
  Origin header present must be this server's own.
#>
function Invoke-Api($req, $res) {
  $path = $req.Url.AbsolutePath.TrimEnd('/')
  if (-not $path.StartsWith('/api/', [StringComparison]::OrdinalIgnoreCase)) { return $false }

  if ($path -ne '/api/presets') {
    Send-Text $res 404 "Unknown API: $path"
    return $true
  }

  switch ($req.HttpMethod) {
    'GET' {
      $json = if (Test-Path -LiteralPath $presetsFile) {
        [System.IO.File]::ReadAllText($presetsFile, $utf8)
      } else {
        '{ "version": 1, "presets": [] }'
      }
      Send-Text $res 200 $json 'application/json; charset=utf-8'
    }
    'PUT' {
      $origin = $req.Headers['Origin']
      $self = "$($req.Url.Scheme)://$($req.Url.Authority)"
      if ($origin -and $origin -ne $self) {
        Send-Text $res 403 'Cross-origin writes are not allowed.'
        break
      }
      if (-not ($req.ContentType -like 'application/json*')) {
        Send-Text $res 415 'Send the presets as application/json.'
        break
      }
      if ($req.ContentLength64 -gt $maxPresetBytes) {
        Send-Text $res 413 'The presets file is too large.'
        break
      }

      $reader = New-Object System.IO.StreamReader($req.InputStream, $utf8)
      try { $text = $reader.ReadToEnd() } finally { $reader.Close() }
      if ($text.Length -gt $maxPresetBytes) {
        Send-Text $res 413 'The presets file is too large.'
        break
      }

      # Validate only. Windows PowerShell's ConvertTo-Json mangles nesting, so
      # the body is written exactly as the page formatted it.
      try {
        $doc = $text | ConvertFrom-Json
      } catch {
        Send-Text $res 400 'The body is not valid JSON.'
        break
      }
      if (-not ($doc.PSObject.Properties.Name -contains 'presets') -or -not ($doc.presets -is [array])) {
        Send-Text $res 400 'Expected an object with a "presets" array.'
        break
      }

      # Write beside the target, then swap, so a failed write never leaves a
      # half-written file for git to pick up.
      $dir = Split-Path $presetsFile
      if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
      $tmp = "$presetsFile.tmp"
      [System.IO.File]::WriteAllText($tmp, $text, $utf8)
      if (Test-Path -LiteralPath $presetsFile) {
        [System.IO.File]::Replace($tmp, $presetsFile, [NullString]::Value)
      } else {
        [System.IO.File]::Move($tmp, $presetsFile)
      }
      Write-Host "      saved $(@($doc.presets).Count) value preset(s)" -ForegroundColor DarkGray
      Send-Text $res 200 $text 'application/json; charset=utf-8'
    }
    default {
      $res.Headers.Add('Allow', 'GET, PUT')
      Send-Text $res 405 "Method $($req.HttpMethod) is not allowed."
    }
  }
  return $true
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
      if (Invoke-Api $req $res) {
        Write-Host ("  {0,-3} {1} {2}" -f $res.StatusCode, $req.HttpMethod, $req.Url.AbsolutePath)
        continue
      }

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
