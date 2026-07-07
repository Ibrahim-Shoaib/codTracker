@echo off
REM ===========================================================================
REM  Daily Meta ad-tracking health check — Windows launcher
REM ---------------------------------------------------------------------------
REM  Double-click this file to check ALL connected stores for today.
REM  Or pass args, e.g.:
REM     check-ad-tracking.cmd --store=trendy
REM     check-ad-tracking.cmd --all --date=yesterday
REM     check-ad-tracking.cmd --list
REM
REM  Schedule it (every day 09:00, all stores, logged):
REM     schtasks /Create /SC DAILY /ST 09:00 /TN "AdTrackingCheck" ^
REM       /TR "C:\Users\ibrah\projects\codtracker\scripts\check-ad-tracking.cmd --all"
REM ===========================================================================
setlocal
cd /d "%~dp0\.."

if "%~1"=="" (
  set ARGS=--all
) else (
  set ARGS=%*
)

node scripts\check-ad-tracking.mjs %ARGS%
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo RESULT: PASS  ^(exit 0^) -- every order delivered to Meta
  exit /b 0
) else if "%RC%"=="1" (
  echo RESULT: FAIL  ^(exit 1^) -- a real tracking problem, read the WHAT TO DO block above
) else (
  echo RESULT: COULD NOT VERIFY  ^(exit %RC%^) -- NOT a pass, re-run when connectivity is back
)

REM Only stop on a PROBLEM so a human can't miss it. Scheduler-safe: a
REM scheduled run has no interactive window, so this pause is a harmless
REM no-op there; on PASS we already exited above without pausing.
pause
exit /b %RC%
