"""Exact held Windows job ownership shared by workers and runtime guardian."""
from __future__ import annotations
import ctypes
import subprocess
import time
from .worker_errors import WorkerError

class WindowsJob:
    def __init__(self, process: subprocess.Popen, memory_bytes: int | None):
        from ctypes import wintypes as w

        class Basic(ctypes.Structure):
            _fields_ = [("process_time", ctypes.c_longlong), ("job_time", ctypes.c_longlong),
                        ("flags", w.DWORD), ("min_ws", ctypes.c_size_t), ("max_ws", ctypes.c_size_t),
                        ("active", w.DWORD), ("affinity", ctypes.c_size_t),
                        ("priority", w.DWORD), ("scheduling", w.DWORD)]

        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", ctypes.c_ulonglong * 6),
                        ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                        ("peak_process", ctypes.c_size_t), ("peak_job", ctypes.c_size_t)]

        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        signatures = {
            "CreateJobObjectW": ([w.LPVOID, w.LPCWSTR], w.HANDLE),
            "SetInformationJobObject": ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD], w.BOOL),
            "AssignProcessToJobObject": ([w.HANDLE, w.HANDLE], w.BOOL),
            "TerminateJobObject": ([w.HANDLE, w.UINT], w.BOOL),
            "CloseHandle": ([w.HANDLE], w.BOOL),
            "QueryInformationJobObject": ([w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, w.LPVOID], w.BOOL),
        }
        for name, (args, result) in signatures.items():
            function = getattr(self.api, name)
            function.argtypes, function.restype = args, result
        self.handle = self.api.CreateJobObjectW(None, None)
        if not self.handle:
            raise WorkerError("worker-job-create-failed")
        try:
            info = Extended()
            info.basic.flags = 0x2000 | (0x200 if memory_bytes is not None else 0)
            info.job_memory = memory_bytes or 0
            if not self.api.SetInformationJobObject(self.handle, 9, ctypes.byref(info), ctypes.sizeof(info)):
                raise WorkerError("worker-job-limit-failed")
            if not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
                raise WorkerError("worker-job-assignment-failed")
        except BaseException:
            self.close()
            raise

    def terminate(self):
        if self.handle and not self.api.TerminateJobObject(self.handle, 1):
            raise WorkerError("worker-job-terminate-failed")

    def wait_empty(self, timeout):
        from ctypes import wintypes as w
        class Accounting(ctypes.Structure):
            _fields_ = [('user', ctypes.c_longlong), ('kernel', ctypes.c_longlong),
                        ('period_user', ctypes.c_longlong), ('period_kernel', ctypes.c_longlong),
                        ('page_faults', w.DWORD), ('total', w.DWORD),
                        ('active', w.DWORD), ('terminated', w.DWORD)]
        deadline = time.monotonic() + timeout
        while self.handle:
            info = Accounting()
            if not self.api.QueryInformationJobObject(self.handle, 1, ctypes.byref(info), ctypes.sizeof(info), None):
                raise WorkerError('worker-job-accounting-failed')
            if info.active == 0:
                return
            if time.monotonic() >= deadline:
                raise WorkerError('worker-job-cleanup-incomplete')
            time.sleep(0.01)

    def close(self):
        if self.handle:
            if not self.api.CloseHandle(self.handle):
                raise WorkerError("worker-job-close-failed")
            self.handle = None
