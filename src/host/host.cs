
using System; using System.Drawing; using System.IO; using System.Reflection; using System.Threading; using System.Windows.Forms; using System.Runtime.InteropServices;
using Microsoft.Web.WebView2.Core; using Microsoft.Web.WebView2.WinForms;
public static class AuroriaResolver {
  static string dir;
  public static void Install(string d) { dir = d; AppDomain.CurrentDomain.AssemblyResolve += Resolve; }
  static Assembly Resolve(object s, ResolveEventArgs e) {
    string p = Path.Combine(dir, new AssemblyName(e.Name).Name + ".dll");
    return File.Exists(p) ? Assembly.LoadFrom(p) : null;
  }
}
public class AuroriaHost : Form {
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SetCurrentProcessExplicitAppUserModelID(string id);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadLibrary(string p);
  static readonly object Gate = new object();
  static void Say(string s) { lock (Gate) { Console.Out.WriteLine(s); Console.Out.Flush(); } }
  const int Grip = 6;
  readonly WebView2 web;
  public AuroriaHost(string url, string profile, string icon) {
    Text = "Auroria"; FormBorderStyle = FormBorderStyle.None; StartPosition = FormStartPosition.CenterScreen;
    BackColor = Color.FromArgb(20, 12, 8);
    try { Icon = Icon.ExtractAssociatedIcon(icon); } catch { }
    float scale = 1f; using (Graphics g = CreateGraphics()) scale = g.DpiX / 96f;
    Rectangle wa = Screen.PrimaryScreen.WorkingArea;
    ClientSize = new Size(Math.Min((int)(1300 * scale), wa.Width - 40), Math.Min((int)(800 * scale), wa.Height - 40));
    MinimumSize = new Size((int)(960 * scale), (int)(600 * scale));
    Opacity = 0;
    System.Windows.Forms.Timer failsafe = new System.Windows.Forms.Timer(); failsafe.Interval = 7000; failsafe.Tick += (o, a) => { failsafe.Stop(); Reveal(); }; failsafe.Start();
    web = new WebView2(); web.Dock = DockStyle.Fill; web.DefaultBackgroundColor = BackColor;
    CoreWebView2CreationProperties props = new CoreWebView2CreationProperties(); props.UserDataFolder = profile;
    props.AdditionalBrowserArguments = Environment.GetEnvironmentVariable("AURORIA_WV_ARGS") ?? ""; web.CreationProperties = props;
    web.CoreWebView2InitializationCompleted += OnReady;
    Controls.Add(web);
    web.Source = new Uri(url);
  }
  protected override CreateParams CreateParams { get { CreateParams cp = base.CreateParams; cp.Style |= 0x20000 | 0x80000; cp.ClassStyle |= 0x20000; return cp; } }
  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    int round = 2; try { DwmSetWindowAttribute(Handle, 33, ref round, 4); } catch { }
    Thread t = new Thread(ReadCommands); t.IsBackground = true; t.Start();
  }
  void ReadCommands() {
    string line;
    while ((line = Console.In.ReadLine()) != null) { string l = line; try { BeginInvoke((Action)(() => Command(l, true))); } catch { } }
    try { BeginInvoke((Action)(() => Close())); } catch { }
  }
  void OnReady(object sender, CoreWebView2InitializationCompletedEventArgs e) {
    if (!e.IsSuccess) { Say("FAIL " + (e.InitializationException != null ? e.InitializationException.Message.Replace("\n", " ") : "WebView2 did not start")); Environment.Exit(3); return; }
    CoreWebView2Settings st = web.CoreWebView2.Settings;
    st.IsStatusBarEnabled = false; st.IsZoomControlEnabled = false; st.AreDevToolsEnabled = false; st.AreBrowserAcceleratorKeysEnabled = false;
    web.CoreWebView2.WebMessageReceived += OnMessage;
    web.CoreWebView2.NewWindowRequested += (o, a) => { a.Handled = true; try { System.Diagnostics.Process.Start(a.Uri); } catch { } };
    Say("SHOWN");
  }
  void Reveal() { if (Opacity < 1) { Opacity = 1; try { Activate(); } catch { } } }
  void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
    string m; try { m = e.TryGetWebMessageAsString(); } catch { return; }
    if (m == "ready") { Reveal(); return; }
    if (m == "drag") { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); }
    else Command(m.ToUpperInvariant(), false);
  }
  void ToggleMax() {
    if (WindowState == FormWindowState.Maximized) { WindowState = FormWindowState.Normal; return; }
    Screen sc = Screen.FromHandle(Handle); Rectangle wa = sc.WorkingArea;
    MaximizedBounds = new Rectangle(wa.X - sc.Bounds.X, wa.Y - sc.Bounds.Y, wa.Width, wa.Height);
    WindowState = FormWindowState.Maximized;
  }
  void Command(string line, bool reply) {
    string[] p = line.Split(' ');
    string r = "OK";
    switch (p[0]) {
      case "STRIP": break;
      case "MIN": WindowState = FormWindowState.Minimized; break;
      case "MAX": ToggleMax(); r = WindowState == FormWindowState.Maximized ? "MAX 1" : "MAX 0"; break;
      case "CLOSE": Close(); break;
      case "SHOW": if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal; Show(); Activate(); SetForegroundWindow(Handle); break;
      case "RECT": r = "RECT " + Left + " " + Top + " " + (WindowState == FormWindowState.Maximized ? "True" : "False"); break;
      case "POS": if (p.Length > 2) Location = new Point(int.Parse(p[1]), int.Parse(p[2])); break;
      case "MEM": gameRunning = p.Length > 1 && p[1] == "LOW"; ApplyMemory(); break;
      default: r = "ERR"; break;
    }
    if (reply) Say(r);
  }
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x84 && WindowState == FormWindowState.Normal) {
      long lp = m.LParam.ToInt64();
      Point pt = PointToClient(new Point((short)(lp & 0xFFFF), (short)((lp >> 16) & 0xFFFF)));
      bool l = pt.X < Grip, rr = pt.X >= ClientSize.Width - Grip, t = pt.Y < Grip, b = pt.Y >= ClientSize.Height - Grip;
      int hit = t && l ? 13 : t && rr ? 14 : b && l ? 16 : b && rr ? 17 : l ? 10 : rr ? 11 : t ? 12 : b ? 15 : 0;
      if (hit != 0) { m.Result = (IntPtr)hit; return; }
    }
    base.WndProc(ref m);
  }
  protected override void OnResize(EventArgs e) { base.OnResize(e); Padding = WindowState == FormWindowState.Maximized ? new Padding(0) : new Padding(2); ApplyMemory(); }
  // WebView2 trims its caches and working set when told memory is low: while minimized, or while a game runs and the window is in the background.
  bool gameRunning;
  protected override void OnActivated(EventArgs e) { base.OnActivated(e); ApplyMemory(); }
  protected override void OnDeactivate(EventArgs e) { base.OnDeactivate(e); ApplyMemory(); }
  void ApplyMemory() {
    if (web == null || web.CoreWebView2 == null) return;
    bool low = WindowState == FormWindowState.Minimized || (gameRunning && Form.ActiveForm != this);
    try { web.CoreWebView2.MemoryUsageTargetLevel = low ? CoreWebView2MemoryUsageTargetLevel.Low : CoreWebView2MemoryUsageTargetLevel.Normal; } catch { }
  }
  public static void Run(string url, string profile, string icon, string sdk) {
    try { SetProcessDpiAwarenessContext((IntPtr)(-4)); } catch { try { SetProcessDPIAware(); } catch { } }
    try { SetCurrentProcessExplicitAppUserModelID("Auroria.Launcher"); } catch { }
    if (LoadLibrary(Path.Combine(sdk, "x64", "WebView2Loader.dll")) == IntPtr.Zero) LoadLibrary(Path.Combine(sdk, "arm64", "WebView2Loader.dll"));
    Application.EnableVisualStyles();
    Application.Run(new AuroriaHost(url, profile, icon));
  }
}
// Entry point when the host is compiled to its own exe (no PowerShell). The resolver must be in place before
// any WebView2 type loads, so the WebView2-facing code sits behind a method that is not inlined.
public static class AuroriaEntry {
  [STAThread] public static int Main() {
    string sdk = Environment.GetEnvironmentVariable("AURORIA_SDK");
    AuroriaResolver.Install(sdk);
    Console.Out.WriteLine("READY"); Console.Out.Flush();
    Go(sdk); return 0;
  }
  [System.Runtime.CompilerServices.MethodImpl(System.Runtime.CompilerServices.MethodImplOptions.NoInlining)]
  static void Go(string sdk) { AuroriaHost.Run(Environment.GetEnvironmentVariable("AURORIA_URL"), Environment.GetEnvironmentVariable("AURORIA_PROFILE"), Environment.GetEnvironmentVariable("AURORIA_ICON"), sdk); }
}
