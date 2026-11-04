"""Print solver.py for AlgoTune's svm task: the task's reference solve() as `class Solver`.

    python make_solver.py <AlgoTune root> [task]

The module's imports and helpers are kept; the dataset and validation methods are dropped.
"""

import ast
import sys
import textwrap
from pathlib import Path


def reference_solver(root: Path, task: str) -> str:
    src = (root / "AlgoTuneTasks" / task / f"{task}.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    lines = src.splitlines()
    imports, consts, methods = [], [], []
    skip = {"generate_problem", "is_solution"}
    for node in tree.body:
        start = node.decorator_list[0].lineno if getattr(node, "decorator_list", None) else node.lineno
        seg = "\n".join(lines[start - 1: node.end_lineno])
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            if "AlgoTuneTasks" not in seg:
                imports.append(seg)
        elif isinstance(node, ast.ClassDef) and any(
                isinstance(d, ast.Call) and getattr(d.func, "id", "") == "register_task" for d in node.decorator_list):
            for item in node.body:
                if not isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)) or item.name in skip:
                    continue
                if item.name == "__init__":
                    # Task.__init__ takes registry kwargs; Solver() is built with none
                    item.body = [s for s in item.body if "super()" not in ast.unparse(s)] or [ast.Pass()]
                    item.args = ast.arguments(posonlyargs=[], args=[ast.arg("self")], vararg=None, kwonlyargs=[],
                                              kw_defaults=[], kwarg=ast.arg("kwargs"), defaults=[])
                    methods.append(ast.unparse(item))
                    continue
                s = item.decorator_list[0].lineno if item.decorator_list else item.lineno
                methods.append(textwrap.dedent("\n".join(lines[s - 1: item.end_lineno])))
        elif isinstance(node, (ast.FunctionDef, ast.Assign, ast.AnnAssign, ast.ClassDef)):
            consts.append(seg)
    body = textwrap.indent("\n\n".join(methods), "    ")
    return "\n".join(imports) + "\n\n" + "\n\n".join(consts) + "\n\n\nclass Solver:\n" + body + "\n"


if __name__ == "__main__":
    print(reference_solver(Path(sys.argv[1]), sys.argv[2] if len(sys.argv) > 2 else "svm"), end="")
