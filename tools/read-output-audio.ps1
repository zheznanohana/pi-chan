Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
[ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMEnumerator {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IEnum {int EnumAudioEndpoints(int f,int s,out IntPtr p); int GetDefaultAudioEndpoint(int f,int r,out IDevice d);}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IDevice {int Activate(ref Guid id,int ctx,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)] out object o);}
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface IVolume {
 int Register(IntPtr p);int Unregister(IntPtr p);int GetChannelCount(out uint n);int SetMasterDb(float v,IntPtr p);int SetMasterScalar(float v,IntPtr p);int GetMasterDb(out float v);int GetMasterScalar(out float v);int SetChannelDb(uint c,float v,IntPtr p);int SetChannelScalar(uint c,float v,IntPtr p);int GetChannelDb(uint c,out float v);int GetChannelScalar(uint c,out float v);int SetMute([MarshalAs(UnmanagedType.Bool)] bool v,IntPtr p);int GetMute([MarshalAs(UnmanagedType.Bool)]out bool v);
}
public class AudioRead {public static string Status(){IDevice d;var e=(IEnum)new MMEnumerator();Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0,1,out d));var g=typeof(IVolume).GUID;object o;Marshal.ThrowExceptionForHR(d.Activate(ref g,23,IntPtr.Zero,out o));float level;bool mute;var v=(IVolume)o;Marshal.ThrowExceptionForHR(v.GetMasterScalar(out level));Marshal.ThrowExceptionForHR(v.GetMute(out mute));return "Default multimedia output: volume="+Math.Round(level*100)+"%, muted="+mute;}}
"@
[AudioRead]::Status()
