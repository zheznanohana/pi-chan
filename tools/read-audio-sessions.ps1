Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;using System.Collections.Generic;
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface E2 {int EnumAudioEndpoints(int f,int s,out IntPtr p);int GetDefaultAudioEndpoint(int f,int r,out D2 d);}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface D2 {int Activate(ref Guid id,int ctx,IntPtr p,[MarshalAs(UnmanagedType.IUnknown)]out object o);int OpenPropertyStore(int mode,out IntPtr p);int GetId([MarshalAs(UnmanagedType.LPWStr)]out string id);}
[ComImport,Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]class EClass{}
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]interface Manager{int GetControl(IntPtr g,uint f,out IntPtr c);int GetVolume(IntPtr g,uint f,out IntPtr v);int GetEnumerator(out Sessions s);}
[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]interface Sessions{int GetCount(out int n);int GetSession(int i,out Control c);}
[Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]interface Control{int GetState(out int s);int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)]out string n);int SetDisplayName(string n,IntPtr g);int GetIconPath(out IntPtr p);int SetIconPath(string p,IntPtr g);int GetGrouping(out Guid g);int SetGrouping(ref Guid g,IntPtr p);int Register(IntPtr p);int Unregister(IntPtr p);int GetId(out IntPtr p);int GetInstanceId(out IntPtr p);int GetProcessId(out uint id);}
[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]interface SimpleVolume{int SetMaster(float v,IntPtr g);int GetMaster(out float v);int SetMute(bool m,IntPtr g);int GetMute([MarshalAs(UnmanagedType.Bool)]out bool m);}
public class SessionRead{public static string[] Read(){D2 d;var e=(E2)new EClass();Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0,1,out d));string id;d.GetId(out id);var list=new List<string>();list.Add("Endpoint="+id);object o;var g=typeof(Manager).GUID;d.Activate(ref g,23,IntPtr.Zero,out o);Sessions s;((Manager)o).GetEnumerator(out s);int n;s.GetCount(out n);for(int i=0;i<n;i++){Control c;s.GetSession(i,out c);uint pid;c.GetProcessId(out pid);float v;bool m;((SimpleVolume)c).GetMaster(out v);((SimpleVolume)c).GetMute(out m);list.Add("PID="+pid+" volume="+Math.Round(v*100)+" muted="+m);}return list.ToArray();}}
"@
[SessionRead]::Read()

