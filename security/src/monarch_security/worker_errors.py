"""Stable errors shared by transport and held process ownership."""


class WorkerError(RuntimeError):
    """Never include raw output, credentials or paths in an error code."""
