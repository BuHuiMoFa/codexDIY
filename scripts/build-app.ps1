$ErrorActionPreference = 'Stop'

& npx tsc
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}

& npx vite build
exit $LASTEXITCODE
