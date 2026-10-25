using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace BookReaderClient;

public static class MauiProgram
{
    public static MauiApp CreateMauiApp()
    {
        BookReaderClient.Services.CrashLog.Install(); // вылеты пишутся в журнал (Подключение к серверу → «Журнал сбоев»)
        var builder = MauiApp.CreateBuilder();
        builder.UseMauiApp<App>();

#if DEBUG
        // F12 / chrome://inspect для веб-части внутри приложения
        builder.Services.AddHybridWebViewDeveloperTools();
        builder.Logging.AddDebug();
#endif
        return builder.Build();
    }
}
