# Сборка подписанного APK BookReader для установки на Android.
# Запуск: build-apk.bat (рядом). Первый раз создаёт ключ подписи, потом использует его же.
#
#   build-apk.bat                  — спросит, какое это обновление
#   build-apk.bat -Bump patch      — без вопроса: patch | minor | major | same
#   build-apk.bat -Bump patch -Notes "Исправлено то-то"
#
#   build-apk.bat -Version 1.0.1   — своя версия X.Y.Z (то же — пункт «5» в меню)
#
# Версия — X.Y.Z (ApplicationDisplayVersion в BookReaderClient.csproj). Код версии для Android
# (ApplicationVersion) считается из неё: X*10000 + Y*100 + Z — он всегда растёт, и обновление встаёт
# поверх установленного приложения. Готовые APK копятся в папке dist, список изменений — dist\CHANGELOG.txt.
#
# Ключ подписи — это «паспорт» приложения: обновления ставятся поверх только с тем же ключом.
# Потеряете ключ — новые версии придётся ставить, удалив старую (вместе с книгами в приложении).
# Поэтому ключ хранится вне репозитория (папка BookReader-keys в профиле) — сделайте его резервную копию.

param(
    [ValidateSet("", "patch", "minor", "major", "same", "manual")] [string]$Bump = "",
    [string]$Version = "",   # своя версия X.Y.Z (например, если прошлая сборка не сохранилась)
    [string]$Notes = ""
)
$ErrorActionPreference = "Stop"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$Repo    = $PSScriptRoot
$Proj    = Join-Path $Repo "BookReaderClient\BookReaderClient.csproj"
$KeyDir  = if ($env:BOOKREADER_KEYS) { $env:BOOKREADER_KEYS } else { Join-Path $env:USERPROFILE "BookReader-keys" }
$Store   = Join-Path $KeyDir "bookreader.keystore"
$Alias   = "bookreader"
$Dist    = Join-Path $Repo "dist"

# Windows PowerShell 5.1: строка внешней программы в потоке ошибок (тесты, dotnet, keytool пишут туда и обычный вывод)
# при $ErrorActionPreference = "Stop" становится аварийной ошибкой. Внешние программы запускаем без этого режима,
# успех проверяем по коду выхода; строки потока ошибок превращаем в обычный текст.
function Native([scriptblock]$sb) {
    $old = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { & $sb } finally { $ErrorActionPreference = $old }
}
function Lines { process { if ($_ -is [System.Management.Automation.ErrorRecord]) { $m = $_.Exception.Message; if ($m -and $m -ne "System.Management.Automation.RemoteException") { $m } else { "" } } else { "$_" } } }

function Fail($t) { Write-Host ""; Write-Host "Ошибка: $t" -ForegroundColor Red; exit 1 }
function Step($t) { Write-Host ""; Write-Host "== $t" -ForegroundColor Cyan }
function Plain($secure) { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)) }

# ---------- версии ----------
function Parse-Ver([string]$s) {
    $p = @(($s -replace '[^0-9.]', '').Split('.') | Where-Object { $_ -ne "" } | ForEach-Object { [int]$_ })
    while ($p.Count -lt 3) { $p += 0 }
    return [version]::new($p[0], $p[1], $p[2])
}
function Ver-Text([version]$v) { "$($v.Major).$($v.Minor).$($v.Build)" }
function Ver-Code([version]$v) { $v.Major * 10000 + $v.Minor * 100 + $v.Build }
function Bump-Ver([version]$v, [string]$kind) {
    switch ($kind) {
        "major" { [version]::new($v.Major + 1, 0, 0) }
        "minor" { [version]::new($v.Major, $v.Minor + 1, 0) }
        "patch" { [version]::new($v.Major, $v.Minor, $v.Build + 1) }
        default { $v }
    }
}

if (-not (Test-Path $Proj)) { Fail "не найден проект $Proj — запускайте build-apk.bat из папки BookReaderClient" }
if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { Fail "не найден dotnet (.NET SDK 10). Установите Visual Studio 2026 с MAUI или .NET SDK 10." }

# ---------- 1. что уже собрано (папка dist) ----------
Step "Готовые APK в $Dist"
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$built = @(Get-ChildItem $Dist -Filter "BookReader-*.apk" -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.BaseName -match '^BookReader-(\d+(\.\d+){1,2})$') { [pscustomobject]@{ Ver = (Parse-Ver $Matches[1]); File = $_ } }
} | Sort-Object Ver)
if ($built.Count -eq 0) { Write-Host "  пока ни одного — это будет первая сборка" }
else { foreach ($b in $built) { Write-Host ("  {0,-10} {1,6:N1} МБ  {2:dd.MM.yyyy HH:mm}" -f (Ver-Text $b.Ver), ($b.File.Length / 1MB), $b.File.LastWriteTime) } }

$projText = [IO.File]::ReadAllText($Proj)
if ($projText -notmatch '<ApplicationDisplayVersion>([^<]*)</ApplicationDisplayVersion>') { Fail "в BookReaderClient.csproj нет ApplicationDisplayVersion" }
$projVer = Parse-Ver $Matches[1]
$last = if ($built.Count) { $built[-1].Ver } else { $null }
$base = if ($last -and $last -gt $projVer) { $last } else { $projVer }   # от самой свежей из проекта и собранных
$msg = "  версия в проекте: $(Ver-Text $projVer)"
if ($last) { $msg += ", последняя собранная: $(Ver-Text $last)" }
Write-Host $msg

# ---------- 2. какое это обновление ----------
if ($Version) { $Bump = "manual" }
if (-not $Bump) {
    if (-not $last) {
        Write-Host ""
        Write-Host "Первая сборка: версия $(Ver-Text $base). Enter — оставить, или 1/2/3 — повысить (см. ниже)."
    }
    Write-Host ""
    Write-Host "Какое это обновление?"
    Write-Host "  1 — минорное (исправления):      $(Ver-Text (Bump-Ver $base 'patch'))"
    Write-Host "  2 — среднее (новые возможности): $(Ver-Text (Bump-Ver $base 'minor'))"
    Write-Host "  3 — большое (крупные изменения): $(Ver-Text (Bump-Ver $base 'major'))"
    Write-Host "  4 — пересобрать $(Ver-Text $base) (файл заменится)"
    Write-Host "  5 — указать версию вручную (X.Y.Z)"
    Write-Host "  0 — отмена"
    $default = if ($last) { "1" } else { "4" }
    $ans = Read-Host "Выбор [$default]"
    if (-not $ans) { $ans = $default }
    $Bump = switch ($ans) { "1" { "patch" } "2" { "minor" } "3" { "major" } "4" { "same" } "5" { "manual" } default { "" } }
    if (-not $Bump) { Write-Host "Отменено."; exit 0 }
}
if ($Bump -eq "manual") {
    # своя версия: например, прошлые сборки не сохранились, а выпустить нужно следующую по счёту
    while ($Version -notmatch '^\s*\d+\.\d+\.\d+\s*$') {
        if ($Version) { Write-Host "  нужен формат X.Y.Z, например 1.0.1" -ForegroundColor Yellow }
        $Version = Read-Host "Версия (X.Y.Z, пусто — отмена)"
        if (-not $Version) { Write-Host "Отменено."; exit 0 }
    }
    $ver = Parse-Ver $Version.Trim()
    if ($last -and $ver -lt $last) {
        Write-Host "  $(Ver-Text $ver) меньше последней собранной $(Ver-Text $last)." -ForegroundColor Yellow
        Write-Host "  Телефон с более новой версией её не примет: обновление встаёт только поверх версии с меньшим кодом." -ForegroundColor Yellow
        $ans = Read-Host "Всё равно собрать $(Ver-Text $ver)? (д/Н)"
        if ($ans -notmatch '^(д|y)') { Write-Host "Отменено."; exit 0 }
    }
} else { $ver = Bump-Ver $base $Bump }
$verText = Ver-Text $ver
# код версии X*10000 + Y*100 + Z растёт, пока Y и Z меньше 100 — дальше пора поднимать старшую часть
if ($ver.Minor -ge 100 -or $ver.Build -ge 100) { Fail "версия ${verText}: средняя и младшая части должны быть меньше 100 — выберите обновление крупнее" }
$code = Ver-Code $ver
$final = Join-Path $Dist "BookReader-$verText.apk"
if ((Test-Path $final) -and $Bump -notin @("same", "manual")) { Fail "файл $final уже есть — выберите другое обновление" }
if (Test-Path $final) {
    $ans = Read-Host "BookReader-$verText.apk уже есть — заменить? (д/Н)"
    if ($ans -notmatch '^(д|y)') { Write-Host "Отменено."; exit 0 }
}
Write-Host "Собираю версию $verText (код $code)" -ForegroundColor Green
if (-not $Notes -and $Bump -ne "same") { $Notes = Read-Host "Что нового (одной строкой, можно пропустить)" }

# ---------- 3. ключ подписи (папка ключа) ----------
Step "Ключ подписи: $KeyDir"
$keytool = $null
function Find-Keytool {
    $cands = @()
    if ($env:JAVA_HOME) { $cands += Join-Path $env:JAVA_HOME "bin\keytool.exe" }
    $k = Get-Command keytool -ErrorAction SilentlyContinue
    if ($k) { $cands += $k.Source }
    foreach ($base in @("$env:ProgramFiles\Microsoft", "$env:ProgramFiles\Android\openjdk", "$env:ProgramFiles\Android\Android Studio\jbr", "$env:ProgramFiles\Eclipse Adoptium", "$env:ProgramFiles\Java")) {
        if (Test-Path $base) { $cands += Get-ChildItem $base -Recurse -Filter keytool.exe -ErrorAction SilentlyContinue | ForEach-Object FullName }
    }
    $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}
$keytool = Find-Keytool

if (-not (Test-Path $Store)) {
    $others = @(Get-ChildItem $KeyDir -Include *.keystore, *.jks -Recurse -ErrorAction SilentlyContinue)
    Write-Host "  ключа bookreader.keystore нет" -ForegroundColor Yellow
    if ($others.Count) { Write-Host "  в папке есть другие ключи: $($others.Name -join ', ')" }
    Write-Host ""
    Write-Host "  1 — создать новый ключ (первый выпуск)"
    Write-Host "  2 — указать файл ключа (восстановить из резервной копии)"
    Write-Host "  0 — отмена"
    Write-Host "  Если приложение уже установлено у людей, нужен ТОТ ЖЕ ключ — новым его не обновить." -ForegroundColor Yellow
    $ans = Read-Host "Выбор"
    if ($ans -eq "2") {
        $src = (Read-Host "Путь к файлу .keystore / .jks").Trim('"', ' ')
        if (-not (Test-Path $src)) { Fail "файл не найден: $src" }
        New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
        Copy-Item $src $Store
        Write-Host "  ключ скопирован в $Store" -ForegroundColor Green
        $env:BR_KEYPASS = Plain (Read-Host "Пароль ключа" -AsSecureString)
    } elseif ($ans -eq "1") {
        if (-not $keytool) { Fail "не найден keytool (идёт с JDK). Visual Studio ставит его вместе с MAUI (Microsoft OpenJDK)." }
        New-Item -ItemType Directory -Force -Path $KeyDir | Out-Null
        do {
            $p1 = Plain (Read-Host "Придумайте пароль ключа (не меньше 6 символов)" -AsSecureString)
            $p2 = Plain (Read-Host "Повторите пароль" -AsSecureString)
            if ($p1 -ne $p2) { Write-Host "Пароли не совпали" -ForegroundColor Yellow }
            elseif ($p1.Length -lt 6) { Write-Host "Слишком короткий" -ForegroundColor Yellow }
        } until ($p1 -eq $p2 -and $p1.Length -ge 6)
        $name = Read-Host "Имя или псевдоним владельца ключа (видно в свойствах APK, можно любое)"
        if (-not $name) { $name = "BookReader" }
        $env:BR_KEYPASS = $p1
        Native { & $keytool -genkeypair -keystore $Store -alias $Alias -keyalg RSA -keysize 4096 -validity 36500 `
            -storepass:env BR_KEYPASS -keypass:env BR_KEYPASS -dname "CN=$name, O=BookReader" 2>&1 | Out-Null }
        if ($LASTEXITCODE -ne 0) { Fail "keytool не смог создать ключ" }
        Write-Host ""
        Write-Host "Ключ создан. СДЕЛАЙТЕ РЕЗЕРВНУЮ КОПИЮ папки $KeyDir и запомните пароль —" -ForegroundColor Yellow
        Write-Host "без них нельзя выпустить обновление, которое встанет поверх установленного приложения." -ForegroundColor Yellow
    } else { Write-Host "Отменено."; exit 0 }
} else {
    $age = (Get-Item $Store).LastWriteTime
    Write-Host "  найден: bookreader.keystore (создан $($age.ToString('dd.MM.yyyy')))"
    $env:BR_KEYPASS = Plain (Read-Host "Пароль ключа подписи" -AsSecureString)
}

# пароль проверяем сразу, а не после нескольких минут сборки
if ($keytool) {
    Native { & $keytool -list -keystore $Store -alias $Alias -storepass:env BR_KEYPASS 2>&1 | Out-Null }
    if ($LASTEXITCODE -ne 0) {
        Remove-Item Env:BR_KEYPASS -ErrorAction SilentlyContinue
        Fail "неверный пароль ключа или в ключе нет записи «$Alias»"
    }
    Write-Host "  пароль подходит" -ForegroundColor Green
}

# ---------- 4. версия → проект ----------
$newText = $projText -replace '<ApplicationDisplayVersion>[^<]*</ApplicationDisplayVersion>', "<ApplicationDisplayVersion>$verText</ApplicationDisplayVersion>" `
                     -replace '<ApplicationVersion>[^<]*</ApplicationVersion>', "<ApplicationVersion>$code</ApplicationVersion>"
if ($newText -ne $projText) {
    [IO.File]::WriteAllText($Proj, $newText, [Text.UTF8Encoding]::new($false))
    Write-Host ""
    Write-Host "В проект записана версия $verText (код $code)"
}

# ---------- 5. сборка ----------
Step "Сборка Release для Android (несколько минут)"
$out = Join-Path $Repo "BookReaderClient\bin\publish-apk"
if (Test-Path $out) { Remove-Item $out -Recurse -Force }
# полный вывод dotnet дублируется в dist\build-last.log (пароль туда не попадает — он передаётся через переменную окружения)
New-Item -ItemType Directory -Force -Path $Dist | Out-Null
$log = Join-Path $Dist "build-last.log"
Native { & dotnet publish $Proj -f net10.0-android -c Release -o $out `
    -p:AndroidKeyStore=true "-p:AndroidSigningKeyStore=$Store" "-p:AndroidSigningKeyAlias=$Alias" `
    "-p:AndroidSigningKeyPass=env:BR_KEYPASS" "-p:AndroidSigningStorePass=env:BR_KEYPASS" 2>&1 | Lines | Tee-Object -FilePath $log | ForEach-Object { Write-Host $_ } }
$rc = $LASTEXITCODE
Remove-Item Env:BR_KEYPASS -ErrorAction SilentlyContinue
if ($rc -ne 0) {
    # ошибки — ещё раз внизу, чтобы не искать их в длинном выводе
    $errs = @(Get-Content $log -ErrorAction SilentlyContinue | Where-Object { $_ -match '(?i)\berror\b\s*[A-Z]*\d*\s*:' } | Select-Object -Unique -First 15)
    if ($errs.Count) { Write-Host ""; Write-Host "Ошибки сборки:" -ForegroundColor Red; $errs | ForEach-Object { Write-Host "  $_" -ForegroundColor Red } }
    Fail "сборка не удалась (код $rc). Полный вывод сохранён: $log"
}

$apk = Get-ChildItem $out -Filter "*-Signed.apk" | Select-Object -First 1
if (-not $apk) { Fail "подписанный APK не найден в $out" }
Copy-Item $apk.FullName $final -Force
$hash = (Get-FileHash $final -Algorithm SHA256).Hash.ToLower()
"$hash  $(Split-Path $final -Leaf)" | Out-File -FilePath "$final.sha256" -Encoding ascii

if ($Bump -ne "same" -or $Notes) {
    $log = Join-Path $Dist "CHANGELOG.txt"
    $line = "$(Get-Date -Format 'yyyy-MM-dd')  $verText" + $(if ($Notes) { "  — $Notes" } else { "" })
    Add-Content -Path $log -Value $line -Encoding UTF8
}

Write-Host ""
Write-Host "Готово: $final ($([math]::Round((Get-Item $final).Length / 1MB, 1)) МБ), версия $verText" -ForegroundColor Green
Write-Host "Контрольная сумма: $final.sha256"
Write-Host "Скопируйте файл на телефон и откройте его. Android попросит разрешить установку из этого источника — разрешите."
try { explorer.exe "/select,$final" } catch {}
