# Сторонние компоненты

Лицензия MIT-0 (файл `LICENSE`) относится только к коду BookReader. Сторонние компоненты
распространяются на своих условиях — они не меняются от того, что BookReader свободен.

| Компонент | Где используется | Лицензия | Что важно |
|---|---|---|---|
| **Модели Silero TTS (v5_ru)** | сервер, скачивается при установке | **CC BY-NC-SA 4.0** (© Silero Team) | **только некоммерческое использование, с указанием авторства Silero** (snakers4/silero-models). Продавать озвучку или сервис на её основе нельзя без лицензии от Silero |
| PyTorch | сервер | BSD-3-Clause | — |
| NumPy | сервер | BSD-3-Clause | — |
| OmegaConf | сервер (нужен Silero) | BSD-3-Clause | — |
| FFmpeg (через пакет imageio-ffmpeg) | сервер, сжатие в Opus | LGPL/GPL (зависит от сборки) | ставится установщиком из PyPI, в BookReader не вшит |
| CMUdict | сервер, произношение английских слов | BSD-2-Clause | скачивается при первом запуске |
| pdf.js (Mozilla) | веб-интерфейс, чтение PDF | Apache-2.0 | файл `web/vendor/pdfjs/LICENSE` |
| .NET MAUI, .NET | приложение | MIT | — |
| sqlite-net | приложение | MIT | — |
| SQLitePCLRaw | приложение | Apache-2.0 | — |
| SQLite | приложение | Public Domain | — |
| Concentus (декодер Opus) | приложение | BSD (лицензия Opus) | — |
| Python | установщик сервера | PSF License | — |
