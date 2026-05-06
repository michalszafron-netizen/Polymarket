@echo off
title KRONOS TERMINAL — Startup
echo.
echo ╔══════════════════════════════════════════════════╗
echo ║         KRONOS TERMINAL — Starting...           ║
echo ╚══════════════════════════════════════════════════╝
echo.

:: 1. Start Kronos Sidecar (Python FastAPI)
echo [1/3] Starting Kronos Sidecar (port 8000)...
start "Kronos Sidecar" cmd /k "cd /d %~dp0sidecar && python -m uvicorn main:app --host 0.0.0.0 --port 8000"

:: Wait for sidecar to boot
echo      Waiting 10s for model to load...
timeout /t 10 /nobreak >nul

:: 2. Start Scanner Bot (Node.js)
echo [2/3] Starting Scanner Bot...
start "Scanner Bot" cmd /k "cd /d %~dp0scanner && npx tsx bot.ts"

:: 3. Start Dashboard (Next.js)
echo [3/3] Starting Dashboard (port 3000)...
start "Dashboard" cmd /k "cd /d %~dp0dashboard && pnpm dev"

echo.
echo ══════════════════════════════════════════════════
echo   All services starting!
echo   Sidecar:   http://localhost:8000/health
echo   Dashboard: http://localhost:3000
echo ══════════════════════════════════════════════════
echo.
pause
