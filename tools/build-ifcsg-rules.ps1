<#
  build-ifcsg-rules.ps1

  Converts the CORENET X "industry mapping" workbook (the authority-issued
  source of truth) into data/ifcsg-rules.json, which the viewer loads at runtime.

  Re-run this whenever BCA publishes an updated mapping workbook:
      powershell -File tools/build-ifcsg-rules.ps1 -Xlsx "<path to mapping.xlsx>"

  Workbook layout this expects (CX Pilot Mapping sheet, 19 columns):
      1 S/N   2 Agency   3 Identified Component   4 Identified parameters
      5-8 Suggested authoring-tool representations   9 Suggested Discipline
      10 IFC4 Entities   11 IFC Sub Types (* = USERDEFINED)
      12 Property Set   13 Property Name   14 Property Type   15 Property Unit
      16 IFC4 Material Set   17 Accepted Values   18 Sample Value
#>
[CmdletBinding()]
param(
  [string]$Xlsx = "C:\Users\tx_samuel_ooi\OneDrive - RSP ARCHITECTS PLANNERS & ENGINEERS (PTE) LTD\Documents\20260305 IFC Model Checker\industry-mapping-4-dec-2025139335b79c8943d695c7b84984c9d50b (1).xlsx",
  [string]$Out = '',

  # Which "Suggested Discipline" rows to keep. Defaults to the architectural
  # scope; pass 'ARC','STR','MEP','External Works' (or @() for everything) to
  # bring the engineering disciplines back in.
  [string[]]$Disciplines = @('ARC', 'External Works')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

if ($Out -eq '') { $Out = Join-Path $PSScriptRoot '..\data\ifcsg-rules.json' }
if (-not (Test-Path $Xlsx)) { throw "Mapping workbook not found: $Xlsx" }

# ------------------------------------------------------------------ unpack xlsx
$root = Join-Path ([System.IO.Path]::GetTempPath()) ("ifcsg-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$work = $root

# Copy first: if the workbook is open in Excel, ExtractToDirectory cannot open it
# in place, but Copy-Item still can. Working off the copy also keeps the
# authority-issued original untouched.
$localCopy = Join-Path $work 'source.xlsx'
Copy-Item -LiteralPath $Xlsx -Destination $localCopy -Force

$unpack = Join-Path $work 'unpacked'
[System.IO.Compression.ZipFile]::ExtractToDirectory($localCopy, $unpack)
$work = $unpack

# The workbook uses "N.A" and friends as an explicit "not applicable" marker.
$script:NaMarkers = @('n.a', 'n.a.', 'na', 'n/a', '-', '')

function Norm {
  param([string]$s)
  if ($null -eq $s) { return $null }
  $v = ($s -replace '\s+', ' ').Trim()
  if ($script:NaMarkers -contains $v.ToLowerInvariant()) { return $null }
  return $v
}

# Placeholder text on rows that only declare a subtype, with the real property
# requirements listed on the rows beneath them.
function Test-Placeholder {
  param([string]$s)
  if (-not $s) { return $false }
  return [bool]($s -match '(?i)please refer to (property sets|properties) below')
}

# "*FOO, BAR" -> two subtypes. A leading * means the IFC PredefinedType is
# USERDEFINED and the literal name is carried on ObjectType instead.
function Parse-Subtypes {
  param([string]$s)
  $v = Norm $s
  $list = New-Object System.Collections.Generic.List[object]
  if (-not $v) { return , @($list.ToArray()) }
  if ($v -match '(?i)^all subtypes listed in cop$') {
    return , @([pscustomobject]@{ value = $null; userDefined = $false; anySubtype = $true })
  }
  foreach ($part in $v.Split(',')) {
    $p = $part.Trim()
    if (-not $p -or ($script:NaMarkers -contains $p.ToLowerInvariant())) { continue }
    $ud = $p.StartsWith('*')
    if ($ud) { $p = $p.Substring(1).Trim() }
    $list.Add([pscustomobject]@{ value = $p; userDefined = $ud; anySubtype = $false })
  }
  return , @($list.ToArray())
}

# Accepted Values is either an enumeration, a cross-reference to the Space Values
# sheet, or a free-text constraint. Classify rather than guess.
function Parse-Accepted {
  param([string]$s)
  $v = Norm $s
  if (-not $v) { return [pscustomobject]@{ kind = 'any'; values = @(); note = $null } }
  if ($v -match '(?i)refer to space values sheet') {
    return [pscustomobject]@{ kind = 'spaceValues'; values = @(); note = $v }
  }
  if ($v -match '(?i)^true\s*/\s*false$') {
    return [pscustomobject]@{ kind = 'boolean'; values = @('TRUE', 'FALSE'); note = $null }
  }
  if ($v -match '(?i)^any positive number$') {
    return [pscustomobject]@{ kind = 'positiveNumber'; values = @(); note = $v }
  }
  # Otherwise a comma-separated enumeration. Individual values may contain "/"
  # or "(...)" (e.g. "PT (Pre)", "Civil engineering works / Infrastructure"),
  # so the comma is the only separator.
  $vals = @($v.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  return [pscustomobject]@{ kind = 'enum'; values = $vals; note = $null }
}

try {
  # --------------------------------------------------------- shared string table
  $shared = New-Object System.Collections.Generic.List[string]
  $ssPath = Join-Path $work 'xl\sharedStrings.xml'
  if (Test-Path $ssPath) {
    $sx = New-Object System.Xml.XmlDocument
    $sx.Load($ssPath)
    foreach ($si in $sx.DocumentElement.ChildNodes) {
      $sb = New-Object System.Text.StringBuilder
      foreach ($t in $si.SelectNodes('.//*[local-name()="t"]')) { [void]$sb.Append($t.InnerText) }
      $shared.Add($sb.ToString())
    }
  }

  # Reads a worksheet into a list of string[] rows indexed by real column position,
  # so blank cells do not shift later columns.
  function Read-Sheet {
    param([string]$File, [int]$MinWidth = 19)
    $doc = New-Object System.Xml.XmlDocument
    $doc.Load((Join-Path $work "xl\worksheets\$File"))
    $out = New-Object System.Collections.Generic.List[object]
    foreach ($row in $doc.SelectNodes('//*[local-name()="sheetData"]/*[local-name()="row"]')) {
      $cells = @{}; $max = 0
      foreach ($c in $row.ChildNodes) {
        # Cell ref "AB12" -> column index 28
        $col = ($c.GetAttribute('r') -replace '[0-9]', '')
        $idx = 0
        foreach ($ch in $col.ToCharArray()) { $idx = $idx * 26 + ([int][char]$ch - 64) }
        $t = $c.GetAttribute('t'); $v = ''
        if ($t -eq 'inlineStr') {
          $n = $c.SelectSingleNode('.//*[local-name()="t"]'); if ($n) { $v = $n.InnerText }
        } else {
          $n = $c.SelectSingleNode('*[local-name()="v"]')
          if ($n) { $v = $n.InnerText }
          if ($t -eq 's' -and $v -ne '') { $v = $shared[[int]$v] }
        }
        $cells[$idx] = $v
        if ($idx -gt $max) { $max = $idx }
      }
      $width = [Math]::Max($max, $MinWidth)
      $arr = New-Object 'string[]' $width
      for ($i = 1; $i -le $width; $i++) {
        if ($cells.ContainsKey($i)) { $arr[$i - 1] = $cells[$i] } else { $arr[$i - 1] = '' }
      }
      $out.Add($arr)
    }
    return $out
  }

  # ------------------------------------------------------------------ mapping rows
  $mapRows = Read-Sheet -File 'sheet3.xml' -MinWidth 19
  $rules = New-Object System.Collections.Generic.List[object]

  $skipped = @{}
  for ($i = 1; $i -lt $mapRows.Count; $i++) {
    $r = $mapRows[$i]
    $entity = Norm $r[9]
    if (-not $entity) { continue }                      # blank / spacer row

    $disc = Norm $r[8]
    if ($Disciplines -and $Disciplines.Count -and ($Disciplines -notcontains $disc)) {
      $k = if ($disc) { $disc } else { '(none)' }
      $skipped[$k] = 1 + $(if ($skipped.ContainsKey($k)) { $skipped[$k] } else { 0 })
      continue
    }

    $declaresOnly = (Test-Placeholder $r[11]) -or (Test-Placeholder $r[12])
    if ($declaresOnly) { $pset = $null; $prop = $null }
    else { $pset = Norm $r[11]; $prop = Norm $r[12] }

    $agency = Norm $r[1]
    if ($agency) { $agency = $agency.ToUpperInvariant() }   # "NParks" -> "NPARKS"

    if ($pset -and $prop) { $kind = 'requirement' } else { $kind = 'subtype' }

    $rules.Add([pscustomobject]@{
        sn          = Norm $r[0]
        agency      = $agency
        component   = Norm $r[2]
        parameter   = Norm $r[3]
        discipline  = Norm $r[8]
        entity      = $entity
        subtypes    = (Parse-Subtypes $r[10])
        # 'requirement' rows demand a property; 'subtype' rows only declare that
        # this entity+subtype belongs to the component.
        kind        = $kind
        pset        = $pset
        prop        = $prop
        dataType    = Norm $r[13]
        unit        = Norm $r[14]
        materialSet = Norm $r[15]
        accepted    = (Parse-Accepted $r[16])
        sample      = Norm $r[17]
        revit       = Norm $r[4]
      })
  }

  # ------------------------------------------------------------------ space values
  # Allowed values for the IfcSpace properties whose Accepted Values cell reads
  # "Refer to Space Values sheet". AGF_Name is further scoped by development use.
  $svRows = Read-Sheet -File 'sheet4.xml' -MinWidth 3
  $spaceValues = @{}
  for ($i = 1; $i -lt $svRows.Count; $i++) {
    $p = Norm $svRows[$i][0]; $v = Norm $svRows[$i][1]; $scope = Norm $svRows[$i][2]
    if (-not $p -or -not $v) { continue }
    if (-not $spaceValues.ContainsKey($p)) {
      $spaceValues[$p] = New-Object System.Collections.Generic.List[object]
    }
    $spaceValues[$p].Add([pscustomobject]@{ value = $v; scope = $scope })
  }
  $spaceValuesOut = [ordered]@{}
  foreach ($k in ($spaceValues.Keys | Sort-Object)) { $spaceValuesOut[$k] = @($spaceValues[$k].ToArray()) }

  # ----------------------------------------------------------------- emit JSON
  $ruleArr = @($rules.ToArray())
  $reqCount = @($ruleArr | Where-Object { $_.kind -eq 'requirement' }).Count

  $doc = [ordered]@{
    meta        = [ordered]@{
      source       = [System.IO.Path]::GetFileName($Xlsx)
      generated    = (Get-Date).ToString('yyyy-MM-ddTHH:mm:ssK')
      sheet        = 'CX Pilot Mapping'
      disciplines  = @(if ($Disciplines -and $Disciplines.Count) { $Disciplines } else { 'all' })
      ruleCount    = $ruleArr.Count
      requirements = $reqCount
      note         = 'Generated from the CORENET X industry mapping workbook. Do not hand-edit; re-run tools/build-ifcsg-rules.ps1.'
    }
    agencies    = @($ruleArr | ForEach-Object { $_.agency } | Where-Object { $_ } | Sort-Object -Unique)
    disciplines = @($ruleArr | ForEach-Object { $_.discipline } | Where-Object { $_ } | Sort-Object -Unique)
    entities    = @($ruleArr | ForEach-Object { $_.entity } | Where-Object { $_ } | Sort-Object -Unique)
    psets       = @($ruleArr | ForEach-Object { $_.pset } | Where-Object { $_ } | Sort-Object -Unique)
    rules       = $ruleArr
    spaceValues = $spaceValuesOut
  }

  # Compressed: this is a generated artefact the viewer fetches at startup, so
  # transfer size matters more than diff readability.
  $json = $doc | ConvertTo-Json -Depth 12 -Compress
  $dir = Split-Path -Parent $Out
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  [System.IO.File]::WriteAllText($Out, $json, (New-Object System.Text.UTF8Encoding($false)))

  Write-Output "Wrote $Out"
  Write-Output ("  disciplines:  {0}" -f $(if ($Disciplines -and $Disciplines.Count) { $Disciplines -join ', ' } else { 'all' }))
  if ($skipped.Count) {
    Write-Output ("  excluded:     {0}" -f (($skipped.GetEnumerator() | Sort-Object Name |
          ForEach-Object { "$($_.Name) ($($_.Value) rows)" }) -join ', '))
  }
  Write-Output ("  rules:        {0}" -f $ruleArr.Count)
  Write-Output ("  requirements: {0}" -f $reqCount)
  Write-Output ("  agencies:     {0}" -f ($doc.agencies -join ', '))
  Write-Output ("  space values: {0} properties" -f $spaceValuesOut.Keys.Count)
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
