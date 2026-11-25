import os
import runpy
import sys
import traceback

solution, tests, out, err = sys.argv[1:5]


def report(kind, error, trace):
    while trace and os.path.abspath(trace.tb_frame.f_code.co_filename) != os.path.abspath(solution):
        trace = trace.tb_next
    traceback.print_exception(kind, error, trace)


sys.stdin = open(tests, encoding="utf-8")
sys.stdout = open(out, "w", encoding="utf-8", buffering=1)
sys.stderr = open(err, "w", encoding="utf-8", buffering=1)
sys.excepthook = report
sys.argv = [solution]
runpy.run_path(solution, run_name="__main__")
