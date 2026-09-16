from __future__ import annotations


LENS_SCHEMA = "vibe-logisim.circuit-lens/v0"


SELECTION_SCHEMA = "vibe-logisim.circuit-lens.selection/v0"


REVIEW_SCHEMA = "vibe-logisim.circuit-lens.review/v0"


QUERY_SCHEMA = "vibe-logisim.circuit-lens.query-result/v0"


DESKTOP_CONTROL_SCHEMA = "vibe-logisim.circuit-lens.desktop-control/v0"


MAX_UPLOAD_BYTES = 128 * 1024 * 1024


class LensError(Exception):
    def __init__(self, status: int, code: str, message: str, detail: str | None = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail

    def as_json(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "schema": LENS_SCHEMA,
            "error": {"code": self.code, "message": self.message},
        }
        if self.detail:
            value["error"]["detail"] = self.detail
        return value

