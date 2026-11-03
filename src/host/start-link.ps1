
$ErrorActionPreference = 'Stop'
$lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Auroria.lnk'
if ((Test-Path $lnk) -and (New-Object -ComObject WScript.Shell).CreateShortcut($lnk).TargetPath -eq $env:A_EXE) { exit 0 }
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Runtime.InteropServices.ComTypes; using System.Text;
[ComImport, Guid("00021401-0000-0000-C000-000000000046")] class CShellLink {}
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("000214F9-0000-0000-C000-000000000046")]
interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr d, int fl); void GetIDList(out IntPtr p); void SetIDList(IntPtr p);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder n, int c); void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string n);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder d, int c); void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder a, int c); void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
  void GetHotkey(out short k); void SetHotkey(short k); void GetShowCmd(out int c); void SetShowCmd(int c);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder p, int c, out int i); void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string p, int i);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r); void Resolve(IntPtr h, int f); void SetPath([MarshalAs(UnmanagedType.LPWStr)] string f);
}
[StructLayout(LayoutKind.Sequential, Pack = 4)] struct PropKey { public Guid fmt; public uint pid; }
[StructLayout(LayoutKind.Explicit)] struct PropVar { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public IntPtr p; }
[ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
interface IPropertyStore { void GetCount(out uint c); void GetAt(uint i, out PropKey k); void GetValue(ref PropKey k, out PropVar v); void SetValue(ref PropKey k, ref PropVar v); void Commit(); }
public static class AuroriaStartLink {
  public static void Write(string lnk, string exe, string aumid) {
    var link = (IShellLinkW)new CShellLink();
    link.SetPath(exe); link.SetWorkingDirectory(System.IO.Path.GetDirectoryName(exe)); link.SetIconLocation(exe, 0); link.SetDescription("Auroria Minecraft launcher");
    var key = new PropKey { fmt = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
    var val = new PropVar { vt = 31, p = Marshal.StringToCoTaskMemUni(aumid) };
    var store = (IPropertyStore)link; store.SetValue(ref key, ref val); store.Commit(); Marshal.FreeCoTaskMem(val.p);
    ((IPersistFile)link).Save(lnk, true);
  }
}
"@
[AuroriaStartLink]::Write($lnk, $env:A_EXE, $env:A_ID)
