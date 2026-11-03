
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class AW {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetLong(IntPtr h, int i, IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int w, int hh, uint f);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);
  public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new StringBuilder(256); GetWindowText(h, t, 256);
      if (t.ToString() != title) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      if (!c.ToString().StartsWith("Chrome_WidgetWin")) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static MONITORINFO Work(IntPtr h) { var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO)); GetMonitorInfo(MonitorFromWindow(h, 2), ref mi); return mi; }
}
"@
$script:h = [IntPtr]::Zero
$script:saved = $null
function Say($t) { [Console]::Out.WriteLine($t); [Console]::Out.Flush() }
Say 'READY'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  if ($script:h -eq [IntPtr]::Zero -or -not [AW]::IsWindow($script:h)) { $script:h = [AW]::Find('Auroria') }
  $w = $script:h
  if ($w -eq [IntPtr]::Zero) { Say 'NOWIN'; continue }
  switch ($p[0]) {
    'STRIP' {
      $s = [AW]::GetLong($w, -16).ToInt64()
      $ns = $s -band (-bnot [int64]0x00C40000)
      if ($ns -ne $s) {
        [void][AW]::SetLong($w, -16, [IntPtr]$ns)
        [void][AW]::SetWindowPos($w, [IntPtr]::Zero, 0, 0, 0, 0, 0x27)
        $v = 2; [void][AW]::DwmSetWindowAttribute($w, 33, [ref]$v, 4)
      }
      Say 'OK'
    }
    'MIN' { [void][AW]::ShowWindow($w, 6); Say 'OK' }
    'MAX' {
      if ($script:saved -eq $null) {
        $r = New-Object AW+RECT; [void][AW]::GetWindowRect($w, [ref]$r); $script:saved = $r
        $m = [AW]::Work($w).rcWork
        [void][AW]::SetWindowPos($w, [IntPtr]::Zero, $m.L, $m.T, $m.R - $m.L, $m.B - $m.T, 0x24)
        Say 'MAX 1'
      } else {
        $r = $script:saved; $script:saved = $null
        [void][AW]::SetWindowPos($w, [IntPtr]::Zero, $r.L, $r.T, $r.R - $r.L, $r.B - $r.T, 0x24)
        Say 'MAX 0'
      }
    }
    'CLOSE' { [void][AW]::PostMessage($w, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero); Say 'OK' }
    'RECT' { $r = New-Object AW+RECT; [void][AW]::GetWindowRect($w, [ref]$r); Say ("RECT " + $r.L + " " + $r.T + " " + ($script:saved -ne $null)) }
    'POS' { $script:saved = $null; [void][AW]::SetWindowPos($w, [IntPtr]::Zero, [int]$p[1], [int]$p[2], 0, 0, 0x15); Say 'OK' }
    default { Say 'ERR' }
  }
}
