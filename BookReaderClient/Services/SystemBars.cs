namespace BookReaderClient.Services;

/// <summary>
/// Системные панели Android (строка состояния, кнопки навигации, вырез камеры, клавиатура).
/// С Android 15 приложение рисуется «от края до края», и отступы под панели нужно делать самим.
/// </summary>
public static class SystemBars
{
    /// <summary>Текущие отступы в единицах MAUI (dp).</summary>
    public static Thickness Insets { get; private set; }

    public static event Action<Thickness>? InsetsChanged;

    public static void Attach()
    {
#if ANDROID
        AndroidSystemBars.Attach();
#endif
    }

    /// <summary>Тёмная тема — светлые значки на панелях, и наоборот.</summary>
    public static void SetDark(bool dark)
    {
#if ANDROID
        AndroidSystemBars.SetDark(dark);
#endif
    }

    internal static void Report(Thickness t)
    {
        if (t == Insets) return;
        Insets = t;
        InsetsChanged?.Invoke(t);
    }
}

#if ANDROID
static class AndroidSystemBars
{
    static bool attached;

    public static void Attach()
    {
        if (attached) return;
        var activity = Microsoft.Maui.ApplicationModel.Platform.CurrentActivity;
        var content = activity?.FindViewById(global::Android.Resource.Id.Content);
        if (content == null) return;
        attached = true;
        AndroidX.Core.View.ViewCompat.SetOnApplyWindowInsetsListener(content, new Listener());
        AndroidX.Core.View.ViewCompat.RequestApplyInsets(content);
    }

    public static void SetDark(bool dark)
    {
        var window = Microsoft.Maui.ApplicationModel.Platform.CurrentActivity?.Window;
        if (window == null) return;
        var controller = AndroidX.Core.View.WindowCompat.GetInsetsController(window, window.DecorView);
        if (controller == null) return;
        controller.AppearanceLightStatusBars = !dark;
        controller.AppearanceLightNavigationBars = !dark;
    }

    sealed class Listener : Java.Lang.Object, AndroidX.Core.View.IOnApplyWindowInsetsListener
    {
        public AndroidX.Core.View.WindowInsetsCompat? OnApplyWindowInsets(global::Android.Views.View? v, AndroidX.Core.View.WindowInsetsCompat? insets)
        {
            if (v == null || insets == null) return insets;
            var mask = AndroidX.Core.View.WindowInsetsCompat.Type.SystemBars()
                     | AndroidX.Core.View.WindowInsetsCompat.Type.DisplayCutout()
                     | AndroidX.Core.View.WindowInsetsCompat.Type.Ime();
            var i = insets.GetInsets(mask);
            if (i == null) return insets;
            var d = v.Resources?.DisplayMetrics?.Density ?? 1f;
            var t = new Thickness(i.Left / d, i.Top / d, i.Right / d, i.Bottom / d);
            MainThread.BeginInvokeOnMainThread(() => SystemBars.Report(t));
            // не «съедаем» отступы — остальные элементы получат их как обычно
            return insets;
        }
    }
}
#endif
