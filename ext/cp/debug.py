import io
import os
import runpy
import sys
import traceback

solution, tests, out, err = sys.argv[1:5]
binary = getattr(os, "O_BINARY", 0)


def report(kind, error, trace):
    while trace and os.path.abspath(trace.tb_frame.f_code.co_filename) != os.path.abspath(solution):
        trace = trace.tb_next
    traceback.print_exception(kind, error, trace)


os.dup2(os.open(tests, os.O_RDONLY | binary), 0)
os.dup2(os.open(out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | binary), 1)
os.dup2(os.open(err, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | binary), 2)
sys.stdin = open(0, encoding="utf-8", closefd=False)
sys.stdout = io.TextIOWrapper(open(1, "wb", buffering=0, closefd=False), encoding="utf-8", write_through=True)
sys.stderr = io.TextIOWrapper(open(2, "wb", buffering=0, closefd=False), encoding="utf-8", write_through=True)
sys.excepthook = report
sys.argv = [solution]
runpy.run_path(solution, run_name="__main__")
