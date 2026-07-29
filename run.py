import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host=os.getenv("GREE_HOST", "0.0.0.0"),
        port=int(os.getenv("GREE_PORT", "8765")),
        reload=False,
    )

