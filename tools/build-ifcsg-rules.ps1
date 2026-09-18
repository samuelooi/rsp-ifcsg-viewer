<#
  build-ifcsg-rules.ps1

  Converts the CORENET X "industry mapping" workbook (the authority-issued
  source of truth) into data/ifcsg-rules.json, which the viewer loads at runtime.

  Re-run this whenever BCA publishes an updated mapping workbook:
      powershell -File tools/build-ifcsg-rules.ps1 -Xlsx "<path to mapping.xlsx>"

  Columns on the CX Pilot Mapping sheet are found by header text, not position,
  so a column inserted into the workbook does not shift the rest. Headers used:
      S/N, Agency, Gateway, Identified Component, Identified parameters,
      Suggested Revit Representation, Suggested Discipline, IFC4 Entities,
      IFC Sub Types, Property Set, Property Name, Property Type, Property Unit,
      IFC4 Material Set, Accepted Values, Sample Value

  "Gateway" is RSP's own column (DG = Design Gateway, CG = Construction Gateway),
  added to the authority workbook. It is read per row: within one component
  the Design Gateway can ask for fewer properties than the Construction Gateway.
#>
[CmdletBinding()]
param(
  [string]$Xlsx = "C:\Users\tx_samuel_ooi\OneDrive - RSP ARCHITECTS PLANNERS & ENGINEERS (PTE) LTD\Documents\20260305 IFC Model Checker\industry-mapping-4-dec-2025139335b79c8943d695c7b84984c9d50b_gateway mapping.xlsx",
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

# The Gateway column's codes, mapped to the ids js/ifcsg.js uses.
function Parse-Gateway {
  param([string]$s)
  $v = Norm $s
  if (-not $v) { return $null }
  switch -Regex ($v.ToUpperInvariant()) {
    '^(DG|DESIGN( GATEWAY)?)$'       { return 'design' }
    '^(CG|CONSTRUCTION( GATEWAY)?)$' { return 'construction' }
    default { throw "Unrecognised Gateway value '$s'. Expected DG or CG." }
  }
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

  # Locate each column by its header. Headers in the workbook wrap onto several
  # lines and carry parenthetical notes, so match on a leading fragment.
  $header = $mapRows[0]
  $col = @{}
  $wanted = [ordered]@{
    sn = 'S/N'; agency = 'Agency'; gateway = 'Gateway'
    component = 'Identified Component'; parameter = 'Identified parameters'
    revit = 'Suggested Revit'; discipline = 'Suggested Discipline'
    entity = 'IFC4 Entities'; subtypes = 'IFC Sub Types'
    pset = 'Property Set'; prop = 'Property Name'; dataType = 'Property Type'
    unit = 'Property Unit'; materialSet = 'IFC4 Material Set'
    accepted = 'Accepted Values'; sample = 'Sample Value'
  }
  foreach ($key in $wanted.Keys) {
    $label = $wanted[$key]
    for ($c = 0; $c -lt $header.Length; $c++) {
      $h = ($header[$c] -replace '\s+', ' ').Trim()
      if ($h.StartsWith($label, [System.StringComparison]::OrdinalIgnoreCase)) { $col[$key] = $c; break }
    }
    if (-not $col.ContainsKey($key)) {
      if ($key -eq 'gateway') { Write-Warning "No 'Gateway' column found; every rule will be Construction Gateway only." }
      else { throw "Column '$label' not found on the CX Pilot Mapping sheet." }
    }
  }
  function Cell { param($row, [string]$key) if ($col.ContainsKey($key)) { $row[$col[$key]] } else { '' } }

  $skipped = @{}
  for ($i = 1; $i -lt $mapRows.Count; $i++) {
    $r = $mapRows[$i]
    $entity = Norm (Cell $r 'entity')
    if (-not $entity) { continue }                      # blank / spacer row

    $disc = Norm (Cell $r 'discipline')
    if ($Disciplines -and $Disciplines.Count -and ($Disciplines -notcontains $disc)) {
      $k = if ($disc) { $disc } else { '(none)' }
      $skipped[$k] = 1 + $(if ($skipped.ContainsKey($k)) { $skipped[$k] } else { 0 })
      continue
    }

    $declaresOnly = (Test-Placeholder (Cell $r 'pset')) -or (Test-Placeholder (Cell $r 'prop'))
    if ($declaresOnly) { $pset = $null; $prop = $null }
    else { $pset = Norm (Cell $r 'pset'); $prop = Norm (Cell $r 'prop') }

    $agency = Norm (Cell $r 'agency')
    if ($agency) { $agency = $agency.ToUpperInvariant() }   # "NParks" -> "NPARKS"

    if ($pset -and $prop) { $kind = 'requirement' } else { $kind = 'subtype' }

    $rules.Add([pscustomobject]@{
        sn          = Norm (Cell $r 'sn')
        agency      = $agency
        # 'design' | 'construction' | null. Per row, not per component.
        gateway     = (Parse-Gateway (Cell $r 'gateway'))
        component   = Norm (Cell $r 'component')
        parameter   = Norm (Cell $r 'parameter')
        discipline  = $disc
        entity      = $entity
        subtypes    = (Parse-Subtypes (Cell $r 'subtypes'))
        # 'requirement' rows demand a property; 'subtype' rows only declare that
        # this entity+subtype belongs to the component.
        kind        = $kind
        pset        = $pset
        prop        = $prop
        dataType    = Norm (Cell $r 'dataType')
        unit        = Norm (Cell $r 'unit')
        materialSet = Norm (Cell $r 'materialSet')
        accepted    = (Parse-Accepted (Cell $r 'accepted'))
        sample      = Norm (Cell $r 'sample')
        revit       = Norm (Cell $r 'revit')
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
  # DG rows count for both gateways; CG and blank rows for Construction only.
  $gw = @{ design = 0; construction = 0; blank = 0 }
  foreach ($rule in $ruleArr) {
    if ($rule.gateway -eq 'design') { $gw.design++ } elseif (-not $rule.gateway) { $gw.blank++ }
    $gw.construction++
  }
  Write-Output ("  gateway:      design {0} (also in construction), construction {1}, blank {2}" -f $gw.design, $gw.construction, $gw.blank)
  Write-Output ("  space values: {0} properties" -f $spaceValuesOut.Keys.Count)
}
finally {
  Remove-Item -Recurse -Force $root -ErrorAction SilentlyContinue
}
