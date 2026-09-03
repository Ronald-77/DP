from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import create_app
from backend.service import EvidenceService, allowed


def make_service(directory: Path) -> EvidenceService:
    service = EvidenceService(directory, replication_factor=3, chunk_size=8)
    service.init(seed=False)
    return service


def test_chunks_replicates_and_reconstructs_through_quorum(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    actor = service.get_users()[0]
    original = b"immutable forensic payload split across several chunks"
    intake = service.upload(content=original, name="image.dd", mime_type="application/octet-stream", case_id="CASE-TEST-01", actor=actor)

    assert len(intake["version"]["chunks"]) > 1
    assert all(len(chunk["replicas"]) == 3 for chunk in intake["version"]["chunks"])
    reconstructed, _, _ = service.read_evidence(intake["evidence"]["id"])
    assert reconstructed == original
    assert service.verify_audit_chain()["valid"] is True


def test_finds_quarantines_and_repairs_modified_replica(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    administrator = next(user for user in service.get_users() if user["role"] == "administrator")
    original = b"known-good evidence that must survive replica corruption"
    intake = service.upload(content=original, name="capture.pcap", mime_type="application/vnd.tcpdump.pcap", case_id="CASE-TEST-02", actor=administrator)

    fault = service.simulate_corruption(intake["evidence"]["id"], administrator)
    degraded = service.verify(intake["evidence"]["id"], administrator, repair=False)
    assert degraded["status"] == "degraded"
    assert any(item["nodeId"] == fault["nodeId"] and item["reason"] == "hash_mismatch" for item in degraded["corruptReplicas"])

    repaired = service.verify(intake["evidence"]["id"], administrator, repair=True)
    assert repaired["status"] == "healthy"
    assert repaired["repairedReplicas"] == 1
    assert service.read_evidence(intake["evidence"]["id"])[0] == original
    assert service.verify_audit_chain()["valid"] is True
    assert any((tmp_path / "nodes" / fault["nodeId"] / "quarantine").iterdir())


def test_integrity_verification_respects_offline_nodes(tmp_path: Path) -> None:
    service = EvidenceService(tmp_path, replication_factor=3, chunk_size=1024)
    service.init(seed=False)
    administrator = next(user for user in service.get_users() if user["role"] == "administrator")
    intake = service.upload(content=b"offline node test", name="offline.txt", mime_type="text/plain", case_id="CASE-OFFLINE", actor=administrator)
    evidence_id = intake["evidence"]["id"]
    replicas = intake["version"]["chunks"][0]["replicas"]

    service.set_node_state(replicas[0], "offline", administrator)
    degraded = service.verify(evidence_id, administrator, repair=False)
    assert degraded["status"] == "degraded"
    assert degraded["healthyReplicas"] == 2
    assert degraded["corruptReplicas"][0]["reason"] == "offline"

    service.verify(evidence_id, administrator, repair=True)
    assert service.get_evidence_by_id(evidence_id)["status"] == "attention"

    service.set_node_state(replicas[0], "online", administrator)
    healthy = service.verify(evidence_id, administrator, repair=False)
    assert healthy["status"] == "healthy"

    for node_id in replicas:
        service.set_node_state(node_id, "offline", administrator)
    unavailable = service.verify(evidence_id, administrator, repair=False)
    assert unavailable["status"] == "unrecoverable"
    assert unavailable["healthyReplicas"] == 0


def test_versions_permissions_and_http_contract(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    investigator = next(user for user in service.get_users() if user["role"] == "investigator")
    first = service.upload(content=b"version one", name="notes.txt", mime_type="text/plain", case_id="CASE-TEST-03", actor=investigator)
    service.upload(content=b"version two", name="notes.txt", mime_type="text/plain", case_id="CASE-TEST-03", actor=investigator, evidence_id=first["evidence"]["id"])

    assert service.read_evidence(first["evidence"]["id"], 1)[0] == b"version one"
    assert service.read_evidence(first["evidence"]["id"], 2)[0] == b"version two"
    assert service.get_evidence_detail(first["evidence"]["id"])["versionCount"] == 2
    assert allowed("auditor", "upload") is False
    assert allowed("auditor", "audit") is True

    client = TestClient(create_app(service, serve_client=False))
    health = client.get("/api/health")
    assert health.status_code == 200
    assert health.json()["auditChain"]["valid"] is True
    forbidden = client.post(
        "/api/evidence", headers={"x-user-id": "usr-james"},
        files={"file": ("blocked.txt", b"not accepted", "text/plain")},
        data={"caseId": "CASE-DENIED"},
    )
    assert forbidden.status_code == 403
    download = client.get(f"/api/evidence/{first['evidence']['id']}/download?version=1")
    assert download.status_code == 200
    assert download.content == b"version one"
