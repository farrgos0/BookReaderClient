@echo off
chcp 65001 >nul
REM Сборка подписанного APK BookReader (dist\BookReader-<версия>.apk)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build-apk.ps1" %*
pause
