"""Windows APIs used by the CLI. Imported only on Windows."""

import ctypes as c
from ctypes import wintypes as w
import msvcrt

kernel32 = c.WinDLL("kernel32", use_last_error=True)
kernel32.SetDllDirectoryW.argtypes = [w.LPCWSTR]


def pid_alive(pid: int) -> bool:
    # Windows os.kill(pid, 0) terminates the process. Query a wait handle instead.
    handle = kernel32.OpenProcess(0x100000, False, pid)  # SYNCHRONIZE
    if not handle:
        return c.get_last_error() == 5  # Access denied: assume it's alive.
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 258  # WAIT_TIMEOUT
    finally:
        kernel32.CloseHandle(handle)


kernel32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
kernel32.OpenProcess.restype = w.HANDLE
kernel32.WaitForSingleObject.argtypes = [w.HANDLE, w.DWORD]
kernel32.CloseHandle.argtypes = [w.HANDLE]


def pipe_available(fd: int) -> int:
    available = w.DWORD()
    handle = msvcrt.get_osfhandle(fd)
    if not kernel32.PeekNamedPipe(handle, None, 0, None, c.byref(available), None):
        error = c.get_last_error()
        if error in (109, 232):  # Broken or closing pipe.
            return 0
        raise c.WinError(error)
    return available.value


kernel32.PeekNamedPipe.argtypes = [w.HANDLE, w.LPVOID, w.DWORD, w.LPVOID, w.LPVOID, w.LPVOID]


class DataBlob(c.Structure):
    _fields_ = [("size", w.DWORD), ("data", c.POINTER(c.c_ubyte))]


def protect_key(data: bytes, *, decrypt: bool = False) -> bytes:
    crypt32 = c.WinDLL("crypt32", use_last_error=True)
    transform = crypt32.CryptUnprotectData if decrypt else crypt32.CryptProtectData
    buffer = (c.c_ubyte * len(data)).from_buffer_copy(data)
    source = DataBlob(len(data), buffer)
    result = DataBlob()
    if not transform(c.byref(source), None, None, None, None, 1, c.byref(result)):
        raise c.WinError(c.get_last_error())
    try:
        return c.string_at(result.data, result.size)
    finally:
        kernel32.LocalFree(result.data)


kernel32.LocalFree.argtypes = [w.HLOCAL]
kernel32.LocalFree.restype = w.HLOCAL


class LastInputInfo(c.Structure):
    _fields_ = [("size", w.UINT), ("tick", w.DWORD)]


def idle_seconds() -> float | None:
    info = LastInputInfo(c.sizeof(LastInputInfo), 0)
    user32 = c.WinDLL("user32", use_last_error=True)
    if not user32.GetLastInputInfo(c.byref(info)):
        return None
    return ((kernel32.GetTickCount() - info.tick) & 0xFFFFFFFF) / 1000.0


kernel32.GetTickCount.restype = w.DWORD
