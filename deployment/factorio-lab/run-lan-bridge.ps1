$ErrorActionPreference = 'Continue'
$node = 'D:\nodejs\node.exe'
$dockerDirectory = 'C:\Program Files\Docker\Docker\resources\bin'
$env:Path = "$dockerDirectory;$env:Path"
$log = Join-Path $PSScriptRoot 'data\lan-bridge.log'

& $node (Join-Path $PSScriptRoot 'lan-udp-ingress.mjs') *>> $log
exit $LASTEXITCODE
