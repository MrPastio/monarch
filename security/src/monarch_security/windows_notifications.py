"""One in-process Windows notification icon and a bounded, coalescing queue.

Never launches a shell: notification delivery must not create new process alerts.
"""
from __future__ import annotations

import ctypes
import atexit
from ctypes import wintypes
import threading
import time


class _Guid(ctypes.Structure):
    _fields_ = [('a', wintypes.DWORD), ('b', wintypes.WORD), ('c', wintypes.WORD), ('d', ctypes.c_ubyte * 8)]


class _NotifyData(ctypes.Structure):
    _fields_ = [('cbSize', wintypes.DWORD), ('hWnd', wintypes.HWND), ('uID', wintypes.UINT),
                ('uFlags', wintypes.UINT), ('uCallbackMessage', wintypes.UINT), ('hIcon', wintypes.HICON),
                ('szTip', wintypes.WCHAR * 128), ('dwState', wintypes.DWORD), ('dwStateMask', wintypes.DWORD),
                ('szInfo', wintypes.WCHAR * 256), ('uTimeout', wintypes.UINT),
                ('szInfoTitle', wintypes.WCHAR * 64), ('dwInfoFlags', wintypes.DWORD),
                ('guidItem', _Guid), ('hBalloonIcon', wintypes.HICON)]


class WindowsBalloon:
    def __init__(self):
        self.user = ctypes.WinDLL('user32', use_last_error=True)
        self.shell = ctypes.WinDLL('shell32', use_last_error=True)
        self.user.CreateWindowExW.argtypes = [wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR,
            wintypes.DWORD, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
            wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID]
        self.user.CreateWindowExW.restype = wintypes.HWND
        self.user.LoadIconW.argtypes = [wintypes.HINSTANCE, ctypes.c_void_p]
        self.user.LoadIconW.restype = wintypes.HICON
        self.user.DestroyWindow.argtypes = [wintypes.HWND]
        self.user.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT, wintypes.UINT]
        self.user.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        self.user.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        self.user.DispatchMessageW.restype = ctypes.c_ssize_t
        self.shell.Shell_NotifyIconW.argtypes = [wintypes.DWORD, ctypes.POINTER(_NotifyData)]
        self.shell.Shell_NotifyIconW.restype = wintypes.BOOL
        self.window = self.user.CreateWindowExW(0, 'STATIC', 'Monarch Security notifications', 0,
                                               0, 0, 0, 0, None, None, None, None)
        if not self.window:
            raise ctypes.WinError(ctypes.get_last_error())
        self.data = _NotifyData()
        self.data.cbSize = ctypes.sizeof(_NotifyData)
        self.data.hWnd = self.window
        self.data.uID = 1
        self.data.hIcon = self.user.LoadIconW(None, 32515)
        self.data.szTip = 'Monarch Security'
        self.visible = False

    def show(self, title, body, seconds):
        self.data.uFlags = 2 | 4 | 16  # ICON | TIP | INFO
        self.data.szInfoTitle = title.encode('utf-16-le')[:126].decode('utf-16-le', errors='ignore')
        self.data.szInfo = body.encode('utf-16-le')[:510].decode('utf-16-le', errors='ignore')
        self.data.dwInfoFlags = 2  # NIIF_WARNING
        self.data.uTimeout = int(seconds * 1000)
        if not self.shell.Shell_NotifyIconW(1 if self.visible else 0, ctypes.byref(self.data)):
            raise ctypes.WinError(ctypes.get_last_error())
        self.visible = True
        deadline = time.monotonic() + seconds
        message = wintypes.MSG()
        while time.monotonic() < deadline:
            while self.user.PeekMessageW(ctypes.byref(message), self.window, 0, 0, 1):
                self.user.TranslateMessage(ctypes.byref(message))
                self.user.DispatchMessageW(ctypes.byref(message))
            time.sleep(.05)

    def hide(self):
        if self.visible:
            self.shell.Shell_NotifyIconW(2, ctypes.byref(self.data))  # NIM_DELETE
            self.visible = False

    def close(self):
        self.hide()
        if self.window:
            self.user.DestroyWindow(self.window)
            self.window = None


class NotificationChannel:
    def __init__(self, factory=WindowsBalloon):
        self._factory = factory
        self._condition = threading.Condition()
        self._pending = None
        self._count = 0
        self._thread = None
        self._closed = False
        self.last_error = None

    def submit(self, title, body, seconds):
        with self._condition:
            if self._closed:
                return False
            self._pending = (title, body, min(10.0, max(1.0, float(seconds))))
            self._count += 1
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name='security-notifications', daemon=True)
                self._thread.start()
            self._condition.notify()
        return True

    def close(self):
        with self._condition:
            self._closed = True
            self._condition.notify_all()
            thread = self._thread
        if thread is not None:
            thread.join(timeout=11)

    def _run(self):
        balloon = None
        try:
            balloon = self._factory()
            while True:
                with self._condition:
                    if self._pending is None:
                        balloon.hide()
                        self._condition.wait_for(lambda: self._pending is not None or self._closed)
                    if self._closed:
                        return
                    title, body, seconds = self._pending
                    count = self._count
                    self._pending, self._count = None, 0
                if count > 1:
                    title = f'Monarch Security: {count} событий'
                    body = 'Подробности — в разделе «События». Последнее:\n' + body
                balloon.show(title, body, seconds)
                self.last_error = None
        except Exception as exc:
            self.last_error = type(exc).__name__
        finally:
            with self._condition:
                try:
                    if balloon is not None:
                        balloon.close()
                finally:
                    self._thread = None
                    self._pending, self._count = None, 0


channel = NotificationChannel()
atexit.register(channel.close)
