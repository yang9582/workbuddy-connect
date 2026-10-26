@echo off
rem wbconnect wrapper: run python -m workbuddy.cli_main from the repo root.
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%" || exit /b 1
python -m workbuddy.cli_main %*
set "CODE=%ERRORLEVEL%"
popd
exit /b %CODE%
