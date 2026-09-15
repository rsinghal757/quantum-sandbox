class QuantumSandboxError(Exception):
    """Base exception for sandbox errors."""


class CircuitNotFoundError(QuantumSandboxError):
    """Raised when a circuit cannot be located in the store."""


class JobNotFoundError(QuantumSandboxError):
    """Raised when a job cannot be located in the store."""


class MissingMeasurementError(QuantumSandboxError):
    """Raised when shot-based execution is requested without measurements."""
