namespace BookReaderClient.Services;

/// <summary>
/// Запуск асинхронной работы из обработчиков событий без <c>async void</c>.
/// Исключение не роняет приложение: пишется в журнал сбоев (Настройки → «Журнал сбоев»).
/// Отмена (<see cref="OperationCanceledException"/>) — штатная ситуация, не ошибка.
/// </summary>
public static class SafeRun
{
    /// <summary>Запустить и не ждать (обработчик клика и т. п.).</summary>
    public static void Fire(Func<Task> work, string where) => _ = Guard(work, where);

    /// <summary>То же, но на главном потоке (работа с элементами интерфейса).</summary>
    public static void OnMain(Func<Task> work, string where) =>
        Fire(() => MainThread.InvokeOnMainThreadAsync(work), where);

    public static async Task Guard(Func<Task> work, string where)
    {
        try { await work(); }
        catch (OperationCanceledException) { }
        catch (Exception ex) { CrashLog.Write(where, ex); }
    }
}
