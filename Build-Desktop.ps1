param([string]$RuntimeZip)
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot
$version='1.0.0'
$electron='45.4.1'
$sha='2BA6223AFA9121F42831FEFE92C434334907540165294FC56697449D12E7CFE9'
$cache=Join-Path $PSScriptRoot '.cache'
New-Item -ItemType Directory -Force $cache | Out-Null
if(-not $RuntimeZip){$RuntimeZip=Join-Path $cache 'electron.zip';if(-not(Test-Path -LiteralPath $RuntimeZip)){Invoke-WebRequest "https://github.com/electron/electron/releases/download/v$electron/electron-v$electron-win32-x64.zip" -OutFile $RuntimeZip}}
if((Get-FileHash -LiteralPath $RuntimeZip -Algorithm SHA256).Hash -ne $sha){throw 'Electron checksum mismatch'}
$out=Join-Path $PSScriptRoot "dist/UO-Map-Tools-$version-win-x64"
if(Test-Path -LiteralPath $out){throw 'Output exists. Choose a fresh source checkout or move the old dist folder before building.'}
New-Item -ItemType Directory -Force $out | Out-Null
Expand-Archive -LiteralPath $RuntimeZip -DestinationPath $out
Rename-Item -LiteralPath (Join-Path $out 'electron.exe') -NewName 'UO Map Paint.exe'
New-Item -ItemType Directory -Force "$out/resources/app","$out/Map builder/source" | Out-Null
& node source/editor/build-map-paint.cjs source/desktop/map-paint.html
if($LASTEXITCODE -ne 0){throw 'Editor generation failed'}
Copy-Item source/desktop/* "$out/resources/app"
Copy-Item source/builder/* "$out/Map builder/source"
Copy-Item catalog "$out/Map builder/Data" -Recurse
& "$out/Map builder/source/Build.ps1"
Copy-Item source/desktop/map-paint.html "$out/map-paint.html"
Copy-Item docs "$out/docs" -Recurse
Copy-Item README.md,THIRD-PARTY-NOTICES.md $out
$files=Get-ChildItem -LiteralPath $out -File -Recurse | Sort-Object FullName
$files | ForEach-Object {(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash+'  '+$_.FullName.Substring($out.Length+1)} | Set-Content "$out/SHA256SUMS.txt"
Compress-Archive -LiteralPath $out -DestinationPath "$out.zip"
Get-FileHash "$out.zip" | Format-List
Write-Output "Built $out.zip"
