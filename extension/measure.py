import json
import os
import signal
import subprocess
import sys
import threading
import time


def watch(pid, seen):
    try:
        with open("/proc/%d/status" % pid) as status:
            while True:
                status.seek(0)
                for line in status.read().splitlines():
                    if line.startswith("VmHWM:"):
                        seen[0] = max(seen[0], int(line.split()[1]) * 1024)
                time.sleep(0.002)
    except (OSError, ValueError):
        pass


def posix(command):
    child = subprocess.Popen(command)

    def stop(number, frame):
        try:
            child.kill()
        except ProcessLookupError:
            pass

    parent = os.getppid()

    def orphaned():
        while os.getppid() == parent:
            time.sleep(1)
        stop(None, None)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=orphaned, daemon=True).start()
    seen = [0]
    if sys.platform.startswith("linux"):
        threading.Thread(target=watch, args=(child.pid, seen), daemon=True).start()
    _, status, usage = os.wait4(child.pid, 0)
    child.returncode = 0
    memory = usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    if seen[0]:
        import resource

        # on Linux the child's figure never drops below what this wrapper used when it started the child
        own = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        if memory <= own:
            memory = seen[0]
    stats = {
        "cpu": round((usage.ru_utime + usage.ru_stime) * 1000),
        "memory": memory,
    }
    if os.WIFSIGNALED(status):
        number = os.WTERMSIG(status)
        try:
            stats["signal"] = signal.Signals(number).name
        except ValueError:
            stats["signal"] = "signal %d" % number
    else:
        stats["code"] = os.WEXITSTATUS(status)
    return stats


def windows(command):
    import ctypes
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class Basic(ctypes.Structure):
        _fields_ = [
            ("PerProcessUserTimeLimit", ctypes.c_int64),
            ("PerJobUserTimeLimit", ctypes.c_int64),
            ("LimitFlags", wintypes.DWORD),
            ("MinimumWorkingSetSize", ctypes.c_size_t),
            ("MaximumWorkingSetSize", ctypes.c_size_t),
            ("ActiveProcessLimit", wintypes.DWORD),
            ("Affinity", ctypes.c_size_t),
            ("PriorityClass", wintypes.DWORD),
            ("SchedulingClass", wintypes.DWORD),
        ]

    class Extended(ctypes.Structure):
        _fields_ = [
            ("BasicLimitInformation", Basic),
            ("IoInfo", ctypes.c_uint64 * 6),
            ("ProcessMemoryLimit", ctypes.c_size_t),
            ("JobMemoryLimit", ctypes.c_size_t),
            ("PeakProcessMemoryUsed", ctypes.c_size_t),
            ("PeakJobMemoryUsed", ctypes.c_size_t),
        ]

    class Counters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.K32GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.c_void_p] * 4

    child = subprocess.Popen(command)
    handle = int(child._handle)
    job = kernel.CreateJobObjectW(None, None)
    if job:
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000
        kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits))
        kernel.AssignProcessToJobObject(job, handle)
    child.wait()
    code = child.returncode & 0xFFFFFFFF
    stats = {"signal": "0x%08X" % code} if code >= 0xC0000000 else {"code": child.returncode}
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    if kernel.K32GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        stats["memory"] = counters.PeakWorkingSetSize
    times = [ctypes.c_uint64() for _ in range(4)]
    if kernel.GetProcessTimes(handle, *[ctypes.byref(value) for value in times]):
        stats["cpu"] = round((times[2].value + times[3].value) / 10000)
    return stats


def main():
    target, command = sys.argv[1], sys.argv[2:]
    started = time.monotonic()
    try:
        stats = windows(command) if os.name == "nt" else posix(command)
    except OSError as error:
        stats = {"error": str(error)}
    stats["wall"] = round((time.monotonic() - started) * 1000)
    with open(target, "x", encoding="utf-8") as file:
        json.dump(stats, file)


main()
