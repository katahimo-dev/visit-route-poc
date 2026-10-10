"""最適化ソルバー（Firebase に依存しない純粋モジュール）。"""

from .errors import InvalidArgument
from .service import SOLVER_VERSION, ortools_version, solve

__all__ = ["SOLVER_VERSION", "InvalidArgument", "ortools_version", "solve"]
