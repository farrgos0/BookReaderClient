using BookReaderClient.Services;

namespace BookReaderClient;

/// <summary>Общее оформление нативных экранов (подключение к серверу, инструменты разработчика).</summary>
static class Ui
{
    public static readonly Color Accent = Color.FromArgb("#B4532A");
    public static readonly Color Ok = Color.FromArgb("#2E7D32");
    public static readonly Color Bad = Color.FromArgb("#C0392B");
    public static readonly Color Muted = Color.FromArgb("#7D7365");
    public static readonly Color Ink = Color.FromArgb("#2B2620");
    public static readonly Color PageBg = Color.FromArgb("#F4EFE4");
    public static readonly string MonoFont = DeviceInfo.Platform == DevicePlatform.WinUI ? "Consolas" : "monospace";

    /// <summary>Кнопка с асинхронным действием: пока выполняется — неактивна; исключение — в журнал сбоев, а не вылет.</summary>
    public static Button Primary(string text, Func<Task> action) =>
        Wire(new Button { Text = text, BackgroundColor = Accent, TextColor = Colors.White, CornerRadius = 9, FontAttributes = FontAttributes.Bold, Padding = new Thickness(16, 10) }, text, action);

    public static Button Secondary(string text, Func<Task> action) =>
        Wire(new Button { Text = text, BackgroundColor = Colors.White, TextColor = Accent, BorderColor = Accent, BorderWidth = 1, CornerRadius = 9, Padding = new Thickness(16, 10) }, text, action);

    public static Button Small(string text, Func<Task> action) =>
        Wire(new Button
        {
            Text = text, FontSize = 13, Padding = new Thickness(12, 6), Margin = new Thickness(0, 0, 8, 8),
            BackgroundColor = Colors.White, TextColor = Ink, BorderColor = Color.FromArgb("#E2D9C7"), BorderWidth = 1, CornerRadius = 8,
        }, text, action);

    static Button Wire(Button b, string text, Func<Task> action)
    {
        b.Clicked += (_, _) => SafeRun.Fire(async () =>
        {
            b.IsEnabled = false;
            try { await action(); }
            finally { b.IsEnabled = true; }
        }, "Ui." + text);
        return b;
    }

    public static Label Header(string text) => new() { Text = text, FontSize = 20, FontAttributes = FontAttributes.Bold, TextColor = Ink, Margin = new Thickness(0, 10, 0, 0) };
    public static Label Hint(string text) => new() { Text = text, FontSize = 13.5, TextColor = Muted };

    public static Border Card(View content) => new()
    {
        Content = content,
        Padding = new Thickness(14, 12),
        BackgroundColor = Color.FromArgb("#FBF8F1"),
        Stroke = Color.FromArgb("#E2D9C7"),
        StrokeThickness = 1,
        StrokeShape = new Microsoft.Maui.Controls.Shapes.RoundRectangle { CornerRadius = 10 },
    };

    /// <summary>Свой заголовок вместо панели навигации (корректные отступы Android).</summary>
    public static Grid TitleBar(string title, Func<Task> back)
    {
        var b = new Button
        {
            Text = "‹ Назад", FontSize = 16, BackgroundColor = Colors.Transparent, TextColor = Colors.White,
            Padding = new Thickness(12, 6), HorizontalOptions = LayoutOptions.Start,
        };
        b.Clicked += (_, _) => SafeRun.Fire(back, "Ui.Back");
        var g = new Grid
        {
            BackgroundColor = Accent,
            Padding = new Thickness(6, 8),
            ColumnDefinitions = { new ColumnDefinition(GridLength.Auto), new ColumnDefinition(GridLength.Star) },
        };
        g.Add(b, 0);
        g.Add(new Label { Text = title, TextColor = Colors.White, FontSize = 18, FontAttributes = FontAttributes.Bold, VerticalOptions = LayoutOptions.Center, LineBreakMode = LineBreakMode.TailTruncation }, 1);
        return g;
    }
}
