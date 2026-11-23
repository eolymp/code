import json
import os
import signal
import subprocess
import sys
import threading
import time


def linux(pid):
    status = open("/proc/%d/status" % pid)

    def read():
        status.seek(0)
        for line in status.read().splitlines():
            if line.startswith("VmHWM:"):
                return int(line.split()[1]) * 1024
        return 0

    return read


def darwin(pid):
    import ctypes

    libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    info = (ctypes.c_uint64 * 12)()

    def read():
        if libproc.proc_pidinfo(pid, 4, ctypes.c_uint64(0), info, 96) != 96:
            raise OSError("the process is gone")
        return info[1]

    return read


def watch(read, seen, limit, stop):
    try:
        while True:
            seen[0] = max(seen[0], read())
            if limit and seen[0] > limit:
                seen[1] = True
                stop(None, None)
                return
            time.sleep(0.002)
    except (OSError, ValueError):
        pass


def posix(command, limit):
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
    seen = [0, False]
    try:
        read = darwin(child.pid) if sys.platform == "darwin" else linux(child.pid)
        threading.Thread(target=watch, args=(read, seen, limit, stop), daemon=True).start()
    except OSError:
        pass
    _, status, usage = os.wait4(child.pid, 0)
    child.returncode = 0
    memory = usage.ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    if seen[0] and sys.platform != "darwin":
        import resource

        # on Linux the child's figure never drops below what this wrapper used when it started the child
        own = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
        if memory <= own:
            memory = seen[0]
    stats = {
        "cpu": round((usage.ru_utime + usage.ru_stime) * 1000),
        "memory": max(memory, seen[0]) if seen[1] else memory,
        "over": seen[1],
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


def windows(command, limit):
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
    kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]

    child = subprocess.Popen(command)
    handle = int(child._handle)
    job = kernel.CreateJobObjectW(None, None)
    if job:
        limits = Extended()
        limits.BasicLimitInformation.LimitFlags = 0x2000
        kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits))
        kernel.AssignProcessToJobObject(job, handle)
    over = [False]

    def guard():
        used = Counters()
        used.cb = ctypes.sizeof(used)
        while child.poll() is None and kernel.K32GetProcessMemoryInfo(handle, ctypes.byref(used), used.cb):
            if used.PeakWorkingSetSize > limit:
                over[0] = True
                kernel.TerminateProcess(handle, 1)
                return
            time.sleep(0.005)

    if limit:
        threading.Thread(target=guard, daemon=True).start()
    child.wait()
    code = child.returncode & 0xFFFFFFFF
    stats = {"signal": "0x%08X" % code} if code >= 0xC0000000 else {"code": child.returncode}
    stats["over"] = over[0]
    counters = Counters()
    counters.cb = ctypes.sizeof(counters)
    if kernel.K32GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb):
        stats["memory"] = counters.PeakWorkingSetSize
    times = [ctypes.c_uint64() for _ in range(4)]
    if kernel.GetProcessTimes(handle, *[ctypes.byref(value) for value in times]):
        stats["cpu"] = round((times[2].value + times[3].value) / 10000)
    return stats


def main():
    target, limit, command = sys.argv[1], int(sys.argv[2]), sys.argv[3:]
    started = time.monotonic()
    try:
        stats = windows(command, limit) if os.name == "nt" else posix(command, limit)
    except OSError as error:
        stats = {"error": str(error)}
    stats["wall"] = round((time.monotonic() - started) * 1000)
    with open(target, "x", encoding="utf-8") as file:
        json.dump(stats, file)


main()
