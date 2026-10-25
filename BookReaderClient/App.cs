namespace BookReaderClient;

public class App : Application
{
    protected override Window CreateWindow(IActivationState? activationState)
    {
        var window = new Window(new NavigationPage(new MainPage())
        {
            BarBackgroundColor = Color.FromArgb("#B4532A"),
            BarTextColor = Colors.White,
        })
        {
            Title = "BookReader",
        };
#if WINDOWS
        window.Width = 1280;
        window.Height = 860;
#endif
        return window;
    }
}
