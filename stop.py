#!/usr/bin/env python3
"""Stop only positively identified processes belonging to this checkout.
Relative script paths without a verified working directory are deliberately skipped.
"""
import ctypes
import json
import ntpath
from pathlib import Path
import subprocess
import sys
import time

PORT = 31415
ROOT = str(Path(__file__).resolve().parent)
CREATE_NO_WINDOW = 0x08000000


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True,
                          creationflags=CREATE_NO_WINDOW)


def command_argv(command):
    if not isinstance(command, str) or not command.strip():
        return []
    # Use Windows' actual command-line parser, not substring or shell matching.
    argc = ctypes.c_int()
    shell = ctypes.WinDLL('shell32', use_last_error=True)
    shell.CommandLineToArgvW.argtypes = [ctypes.c_wchar_p, ctypes.POINTER(ctypes.c_int)]
    shell.CommandLineToArgvW.restype = ctypes.POINTER(ctypes.c_wchar_p)
    pointer = shell.CommandLineToArgvW(command, ctypes.byref(argc))
    if not pointer:
        return []
    try:
        return [pointer[i] for i in range(argc.value)]
    finally:
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree(pointer)


def normalized(value):
    return ntpath.normcase(ntpath.normpath(value)) if isinstance(value, str) else ''


def owns_process(process, kind, root=ROOT):
    executable = process.get('ExecutablePath') or ''
    expected_name = 'node.exe' if kind == 'harness' else 'electron.exe'
    if ntpath.basename(executable).lower() != expected_name:
        return False
    args = command_argv(process.get('CommandLine'))
    if len(args) < 2 or normalized(args[0]) != normalized(executable):
        return False
    target = ntpath.join(root, 'harness-server.js' if kind == 'harness' else r'pet\main.js')
    # Known launcher forms: node ABS_SCRIPT / electron ABS_SCRIPT. No -e,
    # inspector, child --type=renderer, wrapper, or relative-path inference.
    return len(args) == 2 and ntpath.isabs(args[1]) and normalized(args[1]) == normalized(target)


def process_snapshot(pid=None):
    where = f' -Filter "ProcessId={int(pid)}"' if pid is not None else ''
    result = run(['powershell', '-NoProfile', '-Command',
                  f'Get-CimInstance Win32_Process{where} | '
                  'Select-Object ProcessId,ExecutablePath,CommandLine,CreationDate | ConvertTo-Json -Compress'])
    if result.returncode != 0:
        return []
    data = json.loads(result.stdout.strip() or '[]')
    return data if isinstance(data, list) else [data] if isinstance(data, dict) else []


def listening_pids(output, port):
    pids = set()
    for line in output.splitlines():
        fields = line.split()
        if len(fields) != 5 or fields[0].upper() != 'TCP' or fields[3] != 'LISTENING':
            continue
        host, sep, number = fields[1].rpartition(':')
        if sep and number == str(port) and fields[4].isdigit():
            pids.add(int(fields[4]))
    return pids


def stop_candidates(kind, allowed_pids=None):
    killed = []
    for process in process_snapshot():
        pid = process.get('ProcessId')
        if not isinstance(pid, int) or pid <= 0 or (allowed_pids is not None and pid not in allowed_pids):
            continue
        if not owns_process(process, kind):
            continue
        # Refresh identity immediately before stopping; skip exited/reused PIDs.
        fresh = process_snapshot(pid)
        if len(fresh) != 1 or not owns_process(fresh[0], kind):
            continue
        if not process.get('CreationDate') or fresh[0].get('CreationDate') != process['CreationDate']:
            continue
        result = run(['taskkill', '/F', '/T', '/PID', str(pid)])
        if result.returncode == 0:
            killed.append(str(pid))
    return killed


def kill_port(port):
    try:
        result = run(['netstat', '-ano'])
        if result.returncode != 0:
            return []
        return stop_candidates('harness', listening_pids(result.stdout, port))
    except Exception as error:
        print('服务身份检查失败，保留未确认进程:', error)
        return []


def kill_pet():
    try:
        return stop_candidates('pet')
    except Exception as error:
        print('桌宠身份检查失败，保留未确认进程:', error)
        return []


if __name__ == '__main__':
    pet = kill_pet()
    time.sleep(0.5)
    srv = kill_port(PORT)
    print(f'本项目桌宠关闭 {len(pet)} 个；本项目服务关闭 {len(srv)} 个')
    if not pet and not srv:
        print('没有发现可确认归属本项目的启动实例；相对路径启动或其他程序保持运行。')
    sys.exit(0)
