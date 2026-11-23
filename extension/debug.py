import runpy
import sys

solution, tests = sys.argv[1], sys.argv[2]
sys.stdin = open(tests, encoding="utf-8")
sys.argv = [solution]
runpy.run_path(solution, run_name="__main__")
