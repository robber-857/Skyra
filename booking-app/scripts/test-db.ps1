$ErrorActionPreference = 'Stop'
$originalUrl = $env:DATABASE_URL
try {
  $env:DATABASE_URL = 'postgresql://skyra:local-development-only@127.0.0.1:55432/skyra_booking_test?schema=public&connection_limit=25'
  $exists = docker compose exec -T postgres psql -U skyra -d postgres -Atc "SELECT 1 FROM pg_database WHERE datname = 'skyra_booking_test'"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect local test database' }
  if ($exists.Trim() -ne '1') {
    docker compose exec -T postgres psql -U skyra -d postgres -c "CREATE DATABASE skyra_booking_test"
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create local test database' }
  }
  npx.cmd prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { throw 'Test migration failed' }
  npx.cmd prisma generate
  if ($LASTEXITCODE -ne 0) { throw 'Prisma client generation failed' }
  npx.cmd vitest run
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
} finally { $env:DATABASE_URL = $originalUrl }

