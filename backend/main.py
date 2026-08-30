from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import Body, Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from .service import EvidenceService, allowed


ROOT = Path(__file__).resolve().parent.parent
MAX_UPLOAD_SIZE = 100 * 1024 * 1024


def create_app(evidence_service: EvidenceService | None = None, serve_client: bool = True) -> FastAPI:
    service = evidence_service or EvidenceService(Path(os.getenv("CUSTODIA_DATA_DIR", ROOT / ".data")))
    if evidence_service is None:
        service.init(seed=os.getenv("CUSTODIA_SEED", "true").lower() != "false")

    app = FastAPI(
        title="Custodia Evidence API", version="2.0.0",
        description="Distributed content-addressed evidence storage with quorum reads and cryptographic custody tracking.",
    )
    app.state.evidence_service = service
    app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"], allow_credentials=True, allow_methods=["*"], allow_headers=["*"])

    def actor(x_user_id: str = Header(default="usr-morgan")) -> dict[str, Any]:
        return next((user for user in service.get_users() if user["id"] == x_user_id), service.get_users()[0])

    def authorize(user: dict[str, Any], action: Literal["upload", "verify", "repair", "audit", "admin"]) -> None:
        if not allowed(user["role"], action):
            raise HTTPException(status_code=403, detail=f"{user['role']} role cannot perform {action}")

    def translate_error(error: Exception) -> HTTPException:
        if isinstance(error, LookupError):
            return HTTPException(status_code=404, detail=str(error))
        if isinstance(error, ConnectionError):
            return HTTPException(status_code=503, detail=str(error))
        return HTTPException(status_code=500, detail=str(error) or "Unexpected server error")

    @app.get("/api/health")
    def health() -> dict[str, Any]:
        return {"status": "ok", "service": "custodia-api-python", "auditChain": service.verify_audit_chain()}

    @app.get("/api/users")
    def users() -> list[dict[str, Any]]:
        return service.get_users()

    @app.get("/api/overview")
    def overview() -> dict[str, Any]:
        return service.get_overview()

    @app.get("/api/evidence")
    def evidence_list() -> list[dict[str, Any]]:
        return service.get_evidence()

    @app.get("/api/evidence/{evidence_id}")
    def evidence_detail(evidence_id: str) -> dict[str, Any]:
        item = service.get_evidence_detail(evidence_id)
        if item is None:
            raise HTTPException(status_code=404, detail="Evidence not found")
        return item

    @app.get("/api/nodes")
    def nodes() -> list[dict[str, Any]]:
        return service.get_nodes()

    @app.get("/api/audit")
    def audit(limit: int = Query(default=100, ge=1, le=1000), user: dict[str, Any] = Depends(actor)) -> dict[str, Any]:
        authorize(user, "audit")
        return {"chain": service.verify_audit_chain(), "events": service.get_audit(limit)}

    @app.get("/api/evidence/{evidence_id}/report")
    def report(evidence_id: str, user: dict[str, Any] = Depends(actor)) -> dict[str, Any]:
        authorize(user, "audit")
        try:
            return service.get_report(evidence_id)
        except Exception as error:
            raise translate_error(error) from error

    @app.get("/api/evidence/{evidence_id}/download")
    def download(evidence_id: str, version: int | None = None, user: dict[str, Any] = Depends(actor)) -> Response:
        authorize(user, "verify")
        try:
            content, evidence, manifest = service.read_evidence(evidence_id, version)
            safe_name = quote(evidence["name"], safe="._-")
            return Response(
                content=content, media_type=evidence["mimeType"],
                headers={"Content-Disposition": f"attachment; filename*=UTF-8''{safe_name}", "X-Content-SHA256": manifest["fileHash"]},
            )
        except Exception as error:
            raise translate_error(error) from error

    async def read_upload(upload: UploadFile) -> bytes:
        content = await upload.read(MAX_UPLOAD_SIZE + 1)
        if len(content) > MAX_UPLOAD_SIZE:
            raise HTTPException(status_code=413, detail="Evidence file exceeds the 100 MB limit")
        return content

    @app.post("/api/evidence", status_code=201)
    async def upload_evidence(
        file: UploadFile = File(...), case_id: str = Form(..., alias="caseId"),
        description: str = Form(default=""), tags: str = Form(default=""), note: str = Form(default=""),
        user: dict[str, Any] = Depends(actor),
    ) -> dict[str, Any]:
        authorize(user, "upload")
        if not case_id.strip():
            raise HTTPException(status_code=400, detail="A case ID is required")
        return service.upload(
            content=await read_upload(file), name=file.filename or "evidence.bin",
            mime_type=file.content_type or "application/octet-stream", case_id=case_id,
            description=description, tags=[tag.strip() for tag in tags.split(",") if tag.strip()], note=note, actor=user,
        )

    @app.post("/api/evidence/{evidence_id}/versions", status_code=201)
    async def upload_version(
        evidence_id: str, file: UploadFile = File(...), note: str = Form(default=""),
        user: dict[str, Any] = Depends(actor),
    ) -> dict[str, Any]:
        authorize(user, "upload")
        existing = service.get_evidence_by_id(evidence_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="Evidence not found")
        return service.upload(
            content=await read_upload(file), name=file.filename or existing["name"],
            mime_type=file.content_type or "application/octet-stream", case_id=existing["caseId"],
            description=existing["description"], tags=existing["tags"], note=note,
            actor=user, evidence_id=evidence_id,
        )

    @app.post("/api/evidence/{evidence_id}/verify")
    def verify(evidence_id: str, user: dict[str, Any] = Depends(actor)) -> dict[str, Any]:
        authorize(user, "verify")
        try:
            return service.verify(evidence_id, user, repair=False)
        except Exception as error:
            raise translate_error(error) from error

    @app.post("/api/evidence/{evidence_id}/repair")
    def repair(evidence_id: str, user: dict[str, Any] = Depends(actor)) -> dict[str, Any]:
        authorize(user, "repair")
        try:
            return service.verify(evidence_id, user, repair=True)
        except Exception as error:
            raise translate_error(error) from error

    @app.post("/api/evidence/{evidence_id}/simulate-corruption")
    def simulate_corruption(evidence_id: str, user: dict[str, Any] = Depends(actor)) -> dict[str, str]:
        authorize(user, "admin")
        try:
            return service.simulate_corruption(evidence_id, user)
        except Exception as error:
            raise translate_error(error) from error

    @app.patch("/api/nodes/{node_id}")
    def set_node_state(
        node_id: str, state: Literal["online", "offline"] = Body(embed=True),
        user: dict[str, Any] = Depends(actor),
    ) -> dict[str, Any]:
        authorize(user, "admin")
        try:
            return service.set_node_state(node_id, state, user)
        except Exception as error:
            raise translate_error(error) from error

    if serve_client:
        assets = ROOT / "dist" / "assets"
        if assets.exists():
            app.mount("/assets", StaticFiles(directory=assets), name="assets")

        @app.get("/{path:path}", include_in_schema=False)
        def client(path: str) -> Response:
            index = ROOT / "dist" / "index.html"
            if not index.exists():
                raise HTTPException(status_code=404, detail="React build not found; run npm run build or use the Vite development server")
            return FileResponse(index)

    return app


app = create_app()
