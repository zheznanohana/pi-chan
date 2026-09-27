#!/usr/bin/env python3
"""
派娘一键启动器

做三件事：
  1. 起 harness-server.js（含 pi agent RPC、Jev、ASR、TTS、唤醒词判定）
  2. 拉起桌面宠物（Electron 透明窗口，常驻唤醒「小派小派」）
  3. 打开完整仪表盘

全程不留黑窗口。已经在跑的部分不会重复启动。
"""

import os
import sys
import time
import json
import socket
import shutil
import subprocess
import webbrowser

DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_SCRIPT = os.path.join(DIR, "harness-server.js")
PET_MAIN = os.path.join(DIR, "pet", "main.js")
PORT = 31415
URL = f"http://127.0.0.1:{PORT}"

CREATE_NO_WINDOW = 0x08000000

# 哪些部分要启动，可以按需改
START_SERVER = True
START_PET = True
OPEN_DASHBOARD = False   # 仪表盘由桌宠的 Electron 窗口打开，避免浏览器授权弹窗


def is_port_open(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) == 0


def server_is_healthy():
    """端口开着还不够，要确认应答的是我们的服务而不是别的程序占了端口。"""
    if not is_port_open(PORT):
        return False
    try:
        import urllib.request
        with urllib.request.urlopen(URL + "/api/tts/info", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def start_server_if_needed():
    if server_is_healthy():
        # A live old server can serve updated JS while retaining old API routes.
        # Do not silently call that a successful restart.
        try:
            import urllib.request
            with urllib.request.urlopen(URL + "/api/jev/utterance", timeout=3) as r:
                capability = json.load(r)
            if capability.get("available") is not True:
                return "outdated-backend"
        except Exception:
            return "outdated-backend"
        return "already-running"
    if is_port_open(PORT):
        # An occupied port is not proof of ownership; preserve other processes.
        return "port-conflict"

    node = shutil.which("node") or "node"
    subprocess.Popen([node, SERVER_SCRIPT], cwd=DIR,
                     creationflags=CREATE_NO_WINDOW)

    # 等服务真正就绪：模型加载（ASR 约 2s + TTS 若干）比端口监听慢，给足时间
    for _ in range(120):          # 最多 24 秒
        if server_is_healthy():
            return "started"
        time.sleep(0.2)
    return "timeout"


def start_pet():
    if not os.path.exists(PET_MAIN):
        return "missing"
    # 不用进程名判断是否已在运行 —— Electron 会开多个子进程，
    # 别的 Electron 应用也叫 electron.exe，很容易误判。
    # pet/main.js 里有 requestSingleInstanceLock()，重复启动会自己退出并聚焦已有窗口。
    # 优先用本地装好的 electron，避免 npx 每次解析
    electron_bin = os.path.join(DIR, "node_modules", "electron", "dist", "electron.exe")
    if os.path.exists(electron_bin):
        cmd = [electron_bin, PET_MAIN]
    else:
        npx = shutil.which("npx")
        if not npx:
            return "no-electron"
        cmd = [npx, "electron", PET_MAIN]

    subprocess.Popen(cmd, cwd=DIR, creationflags=CREATE_NO_WINDOW)
    return "started"


def open_dashboard():
    # 用 Edge 的 --app 模式开成独立窗口，没有地址栏，更像个应用
    for p in (r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"):
        if os.path.exists(p):
            subprocess.Popen([p, f"--app={URL}", "--window-size=1280,840"],
                             creationflags=CREATE_NO_WINDOW)
            return "edge-app"
    webbrowser.open(URL)
    return "default-browser"


def main():
    log = {}
    if START_SERVER:
        log["server"] = start_server_if_needed()
        if log["server"] in ("outdated-backend", "port-conflict"):
            import ctypes
            message = ("检测到仍在运行的旧版后台，Jev 语义接口尚未加载。\n\n"
                       "关闭窗口或再次双击启动器只会复用它。请在小派托盘菜单选择完整退出，"
                       "等待后台退出后再启动。现有任务未被中断。"
                       if log["server"] == "outdated-backend" else
                       "31415 端口被未确认的服务占用，已保留该进程。请先确认占用程序。")
            ctypes.windll.user32.MessageBoxW(0, message, "小派后台尚未更新", 0x30)
            return 1
        if log["server"] == "timeout":
            # 服务没起来，后面两步没意义，弹个提示
            try:
                import ctypes
                ctypes.windll.user32.MessageBoxW(
                    0,
                    "harness-server 启动超时。\n\n"
                    "可以在 pi-chan-dashboard 目录手动跑 node harness-server.js 看报错。",
                    "派娘启动失败", 0x10)
            except Exception:
                pass
            return 1
    if START_PET:
        log["pet"] = start_pet()
    if OPEN_DASHBOARD:
        log["dashboard"] = open_dashboard()

    try:
        with open(os.path.join(DIR, "launcher-last-run.json"), "w", encoding="utf-8") as f:
            json.dump({"at": time.strftime("%Y-%m-%d %H:%M:%S"), **log}, f, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
