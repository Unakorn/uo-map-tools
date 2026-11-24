param([switch]$Test, [string]$ClientPath)
$ErrorActionPreference = 'Stop'
$studioRoot = Split-Path -Parent $PSScriptRoot
$studioCompiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $studioCompiler)) { throw 'The Windows .NET Framework 4.x compiler is required.' }
$studioSources = @('DecorationImages.cs','Core.cs','Catalog.cs','ClientAssets.cs','UopArchive.cs','ClientAudit.cs','ImageInputs.cs','AssetBrowser.cs','LandArtProjection.cs','TransitionLab.cs','TransitionLabForm.cs','WaterTexturePolicy.cs','MapBuildJob.cs','MapBuildForm.cs','MapBuildCommand.cs','Main.cs') | ForEach-Object { Join-Path $PSScriptRoot $_ }
$studioCommon = @('/nologo','/platform:x64','/optimize+','/r:System.Drawing.dll','/r:System.Windows.Forms.dll','/r:System.Xml.Linq.dll')
& $studioCompiler @studioCommon /target:winexe /main:TerrainStudio.Program "/out:$studioRoot\UO Map Builder.exe" @studioSources
if ($LASTEXITCODE -ne 0) { throw 'Application compilation failed.' }
& $studioCompiler @studioCommon /target:exe /main:TerrainStudio.MapBuildCommand "/out:$studioRoot\MapBuild.exe" @studioSources
if ($LASTEXITCODE -ne 0) { throw 'Command-line builder compilation failed.' }
Write-Output "Built $studioRoot\UO Map Builder.exe and MapBuild.exe"
if ($Test) {
    $studioTestRoot = Join-Path $studioRoot 'test-build'
    New-Item -ItemType Directory -Force -Path $studioTestRoot | Out-Null
    $studioSuites = @('CoreTests','CatalogTests','ClientAssetsTests','UopTests','ImageInputsTests','UiTests','TransitionLabTests','TransitionLabUiTests','MapBuildJobTests','MapBuildFormTests','WaterTexturePolicyTests')
    if ($ClientPath) { $studioSuites += @('ClientIntegrationTests','ClientAuditTests') }
    foreach ($studioSuite in $studioSuites) {
        $studioTestFile = Join-Path $PSScriptRoot ($studioSuite + '.cs')
        $studioTestExe = Join-Path $studioTestRoot ($studioSuite + '.exe')
        $studioEntry = if ($studioSuite -in @('CatalogTests','ClientAuditTests','TransitionLabTests')) { $studioSuite } else { "TerrainStudio.$studioSuite" }
        & $studioCompiler @studioCommon /target:exe "/main:$studioEntry" "/out:$studioTestExe" @studioSources $studioTestFile
        if ($LASTEXITCODE -ne 0) { throw "$studioSuite compilation failed." }
        if ($studioSuite -eq 'ClientIntegrationTests') { & $studioTestExe $ClientPath (Join-Path $studioRoot 'Data') }
        elseif ($studioSuite -eq 'TransitionLabUiTests' -and $ClientPath) { & $studioTestExe (Join-Path $studioRoot 'Data') $ClientPath }
        elseif ($studioSuite -eq 'ClientAuditTests') { & $studioTestExe (Join-Path $studioRoot 'Data') $ClientPath (Join-Path $studioTestRoot ('audit-' + [Guid]::NewGuid().ToString('N'))) }
        else { & $studioTestExe (Join-Path $studioRoot 'Data') }
        if ($LASTEXITCODE -ne 0) { throw "$studioSuite failed." }
    }
}
