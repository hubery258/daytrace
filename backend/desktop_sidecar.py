"""PyInstaller entry point for the Electron FastAPI sidecar."""

import os

import uvicorn
from app.main import app


def main() -> None:
    port = int(os.environ.get("RIJI_SIDECAR_PORT", "8000"))
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=port,
        log_level=os.environ.get("RIJI_LOG_LEVEL", "warning"),
        access_log=False,
    )


if __name__ == "__main__":
    main()
