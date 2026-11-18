"""Qt widgets for the APNG frame compositor."""

__all__ = ["MainWindow", "run"]


def __getattr__(name):
    if name in __all__:
        from .main_window import MainWindow, run

        return {"MainWindow": MainWindow, "run": run}[name]
    raise AttributeError(name)
