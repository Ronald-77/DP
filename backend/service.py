from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import uuid
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal


Role = Literal["administrator", "investigator", "auditor"]
GENESIS_HASH = "0" * 64


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def sha256(value: bytes | str) -> str:
    if isinstance(value, str):
        value = value.encode("utf-8")
    return hashlib.sha256(value).hexdigest()


def short_id(prefix: str) -> str:
    return f"{prefix}-{str(uuid.uuid4())[:8].upper()}"


def default_users() -> list[dict[str, Any]]:
    return [
        {"id": "usr-morgan", "name": "Morgan Reed", "initials": "MR", "role": "investigator", "title": "Lead investigator"},
        {"id": "usr-priya", "name": "Priya Shah", "initials": "PS", "role": "administrator", "title": "Evidence administrator"},
        {"id": "usr-james", "name": "James Okafor", "initials": "JO", "role": "auditor", "title": "Independent auditor"},
    ]


def default_nodes() -> list[dict[str, Any]]:
    timestamp = utc_now()
    return [
        {"id": "node-atlas", "name": "Atlas", "region": "US East", "state": "online", "lastSeen": timestamp},
        {"id": "node-boreal", "name": "Boreal", "region": "EU West", "state": "online", "lastSeen": timestamp},
        {"id": "node-cinder", "name": "Cinder", "region": "AP Southeast", "state": "online", "lastSeen": timestamp},
        {"id": "node-delta", "name": "Delta", "region": "US West", "state": "online", "lastSeen": timestamp},
    ]


def empty_database() -> dict[str, Any]:
    return {"schemaVersion": 1, "users": default_users(), "nodes": default_nodes(), "evidence": [], "versions": [], "audit": []}


class MetadataStore:
    """Small atomic JSON adapter used by the local deployment."""

    def __init__(self, filename: Path) -> None:
        self.filename = filename

    def load(self, fallback: dict[str, Any]) -> dict[str, Any]:
        self.filename.parent.mkdir(parents=True, exist_ok=True)
        if not self.filename.exists():
            self.save(fallback)
            return deepcopy(fallback)
        with self.filename.open("r", encoding="utf-8") as handle:
            return json.load(handle)

    def save(self, value: dict[str, Any]) -> None:
        temporary = self.filename.with_suffix(f"{self.filename.suffix}.{uuid.uuid4().hex}.tmp")
        with temporary.open("w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, indent=2, ensure_ascii=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.filename)


class EvidenceService:
    def __init__(self, data_dir: Path | str, replication_factor: int = 3, chunk_size: int = 256 * 1024) -> None:
        self.data_dir = Path(data_dir)
        self.replication_factor = replication_factor
        self.chunk_size = chunk_size
        self.metadata = MetadataStore(self.data_dir / "metadata.json")
        self.db: dict[str, Any] = empty_database()
        self._mutation_lock = threading.RLock()

    def init(self, seed: bool = True) -> None:
        self.db = self.metadata.load(empty_database())
        for node in self.db["nodes"]:
            self.node_object_dir(node["id"]).mkdir(parents=True, exist_ok=True)
        if seed and not self.db["evidence"]:
            self.seed_demo_data()

    def get_users(self) -> list[dict[str, Any]]:
        return deepcopy(self.db["users"])

    def get_evidence(self) -> list[dict[str, Any]]:
        return sorted(deepcopy(self.db["evidence"]), key=lambda item: item["createdAt"], reverse=True)

    def get_audit(self, limit: int = 100) -> list[dict[str, Any]]:
        return list(reversed(deepcopy(self.db["audit"][-limit:])))

    def get_version(self, version_id: str) -> dict[str, Any] | None:
        return next((item for item in self.db["versions"] if item["id"] == version_id), None)

    def get_evidence_by_id(self, evidence_id: str) -> dict[str, Any] | None:
        return next((item for item in self.db["evidence"] if item["id"] == evidence_id), None)

    def get_evidence_detail(self, evidence_id: str) -> dict[str, Any] | None:
        evidence = self.get_evidence_by_id(evidence_id)
        if evidence is None:
            return None
        versions = sorted(
            (item for item in self.db["versions"] if item["evidenceId"] == evidence_id),
            key=lambda item: item["number"], reverse=True,
        )
        current = next(item for item in versions if item["id"] == evidence["currentVersionId"])
        return {**deepcopy(evidence), "versions": deepcopy(versions), "currentVersion": deepcopy(current)}

    def get_nodes(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for node in self.db["nodes"]:
            chunk_hashes: set[str] = set()
            byte_count = 0
            for version in self.db["versions"]:
                for chunk in version["chunks"]:
                    if node["id"] not in chunk["replicas"] or chunk["hash"] in chunk_hashes:
                        continue
                    chunk_hashes.add(chunk["hash"])
                    try:
                        byte_count += self.object_path(node["id"], chunk["hash"]).stat().st_size
                    except FileNotFoundError:
                        pass
            result.append({**node, "chunks": len(chunk_hashes), "bytes": byte_count, "utilization": min(92, 28 + len(chunk_hashes) * 3)})
        return deepcopy(result)

    def get_overview(self) -> dict[str, Any]:
        evidence = self.db["evidence"]
        verified = sum(item["status"] == "verified" for item in evidence)
        return {
            "evidence": len(evidence), "verified": verified, "attention": len(evidence) - verified,
            "cases": len({item["caseId"] for item in evidence}),
            "totalBytes": sum(item["size"] for item in evidence),
            "nodesOnline": sum(node["state"] == "online" for node in self.db["nodes"]),
            "nodesTotal": len(self.db["nodes"]), "auditEvents": len(self.db["audit"]),
            "recent": [{"time": event["timestamp"], "action": event["action"]} for event in self.db["audit"][-7:]],
        }

    def upload(
        self, *, content: bytes, name: str, mime_type: str, case_id: str,
        actor: dict[str, Any], description: str = "", tags: list[str] | None = None,
        note: str = "", evidence_id: str | None = None,
    ) -> dict[str, Any]:
        with self._mutation_lock:
            timestamp = utc_now()
            evidence = self.get_evidence_by_id(evidence_id) if evidence_id else None
            if evidence_id and evidence is None:
                raise LookupError("Evidence not found")
            item_id = evidence["id"] if evidence else short_id("EV")
            existing_versions = [item for item in self.db["versions"] if item["evidenceId"] == item_id]
            version_number = len(existing_versions) + 1
            chunks: list[dict[str, Any]] = []
            offsets = range(0, len(content), self.chunk_size) if content else [0]
            for index, offset in enumerate(offsets):
                chunk_content = content[offset : offset + self.chunk_size]
                chunk_hash = sha256(chunk_content)
                replica_nodes = self.replica_nodes(chunk_hash)
                for node_id in replica_nodes:
                    self.write_object(node_id, chunk_hash, chunk_content)
                chunks.append({"hash": chunk_hash, "index": index, "size": len(chunk_content), "replicas": replica_nodes})

            file_hash = sha256(content)
            root_hash = self.merkle_root([chunk["hash"] for chunk in chunks])
            version = {
                "id": short_id("VER"), "evidenceId": item_id, "number": version_number,
                "rootHash": root_hash, "fileHash": file_hash, "size": len(content),
                "chunkSize": self.chunk_size, "chunks": chunks, "createdAt": timestamp,
                "createdBy": actor["id"],
                "note": note or ("Initial evidence intake" if version_number == 1 else "New evidence version"),
            }
            self.db["versions"].append(version)
            if evidence is None:
                evidence = {
                    "id": item_id, "caseId": case_id.strip().upper(), "name": name,
                    "description": description, "mimeType": mime_type, "size": len(content),
                    "tags": tags or [], "status": "verified", "createdAt": timestamp,
                    "uploadedBy": actor["id"], "currentVersionId": version["id"],
                    "versionCount": 1, "lastVerifiedAt": timestamp,
                }
                self.db["evidence"].append(evidence)
            else:
                evidence.update({
                    "name": name, "mimeType": mime_type, "size": len(content),
                    "currentVersionId": version["id"], "versionCount": version_number,
                    "status": "verified", "lastVerifiedAt": timestamp,
                })
            self.append_audit(
                actor, "EVIDENCE_UPLOADED" if version_number == 1 else "VERSION_CREATED",
                f"Stored {name} as {len(chunks)} content-addressed chunk{'s' if len(chunks) != 1 else ''} with {self.replication_factor}× replication.",
                evidence, {"version": version_number, "fileHash": file_hash, "rootHash": root_hash, "chunks": len(chunks)},
            )
            self.metadata.save(self.db)
            return deepcopy({"evidence": evidence, "version": version})

    def read_evidence(self, evidence_id: str, version_number: int | None = None) -> tuple[bytes, dict[str, Any], dict[str, Any]]:
        evidence = self.get_evidence_by_id(evidence_id)
        if evidence is None:
            raise LookupError("Evidence not found")
        if version_number is not None:
            version = next((item for item in self.db["versions"] if item["evidenceId"] == evidence_id and item["number"] == version_number), None)
        else:
            version = self.get_version(evidence["currentVersionId"])
        if version is None:
            raise LookupError("Evidence version not found")

        output: list[bytes] = []
        for chunk in sorted(version["chunks"], key=lambda item: item["index"]):
            valid: list[bytes] = []
            for node_id in chunk["replicas"]:
                node = next((candidate for candidate in self.db["nodes"] if candidate["id"] == node_id), None)
                if node is None or node["state"] == "offline":
                    continue
                try:
                    replica = self.object_path(node_id, chunk["hash"]).read_bytes()
                    if sha256(replica) == chunk["hash"]:
                        valid.append(replica)
                except OSError:
                    pass
            quorum = len(chunk["replicas"]) // 2 + 1
            if len(valid) < quorum:
                raise ConnectionError(f"Quorum unavailable for chunk {chunk['hash'][:12]} ({len(valid)}/{quorum})")
            output.append(valid[0])
        reconstructed = b"".join(output)
        if sha256(reconstructed) != version["fileHash"]:
            raise ValueError("Reconstructed file failed whole-file integrity verification")
        return reconstructed, deepcopy(evidence), deepcopy(version)

    def verify(self, evidence_id: str, actor: dict[str, Any], repair: bool = False) -> dict[str, Any]:
        with self._mutation_lock:
            evidence = self.get_evidence_by_id(evidence_id)
            if evidence is None:
                raise LookupError("Evidence not found")
            version = self.get_version(evidence["currentVersionId"])
            assert version is not None
            corrupt_replicas: list[dict[str, Any]] = []
            healthy_replicas = 0
            repaired_replicas = 0
            unrecoverable = False
            for chunk in version["chunks"]:
                healthy: bytes | None = None
                bad: list[dict[str, str]] = []
                for node_id in chunk["replicas"]:
                    try:
                        replica = self.object_path(node_id, chunk["hash"]).read_bytes()
                        if sha256(replica) == chunk["hash"]:
                            healthy = replica
                            healthy_replicas += 1
                        else:
                            bad.append({"nodeId": node_id, "reason": "hash_mismatch"})
                    except OSError:
                        bad.append({"nodeId": node_id, "reason": "missing"})
                corrupt_replicas.extend({**item, "chunkHash": chunk["hash"]} for item in bad)
                if bad and healthy is None:
                    unrecoverable = True
                if repair and healthy is not None:
                    for bad_replica in bad:
                        if bad_replica["reason"] == "hash_mismatch":
                            self.quarantine(bad_replica["nodeId"], chunk["hash"])
                        self.write_object(bad_replica["nodeId"], chunk["hash"], healthy, overwrite=True)
                        repaired_replicas += 1

            status = "unrecoverable" if unrecoverable else "degraded" if corrupt_replicas else "healthy"
            evidence["status"] = "attention" if unrecoverable or (corrupt_replicas and not repair) else "verified"
            evidence["lastVerifiedAt"] = utc_now()
            self.append_audit(
                actor, "INTEGRITY_REPAIR" if repair else "INTEGRITY_VERIFIED",
                f"Integrity scan identified {len(corrupt_replicas)} invalid replica(s) and reconstructed {repaired_replicas} from healthy content."
                if repair else f"Integrity scan checked {len(version['chunks']) * self.replication_factor} replicas; {len(corrupt_replicas)} issue(s) found.",
                evidence, {"corruptReplicas": len(corrupt_replicas), "repairedReplicas": repaired_replicas, "rootHash": version["rootHash"]},
            )
            result = {
                "evidenceId": evidence_id, "version": version["number"], "checkedAt": utc_now(),
                "totalReplicas": len(version["chunks"]) * self.replication_factor,
                "healthyReplicas": healthy_replicas, "corruptReplicas": corrupt_replicas,
                "repairedReplicas": repaired_replicas,
                "status": "healthy" if repair and not unrecoverable else status,
            }
            self.metadata.save(self.db)
            return deepcopy(result)

    def simulate_corruption(self, evidence_id: str, actor: dict[str, Any]) -> dict[str, str]:
        with self._mutation_lock:
            evidence = self.get_evidence_by_id(evidence_id)
            if evidence is None:
                raise LookupError("Evidence not found")
            version = self.get_version(evidence["currentVersionId"])
            assert version is not None
            chunk = version["chunks"][0]
            node_id = chunk["replicas"][0]
            filename = self.object_path(node_id, chunk["hash"])
            original = filename.read_bytes()
            corrupted = bytearray(original)
            if corrupted:
                corrupted[0] ^= 0xFF
            else:
                corrupted.extend(b"corrupt")
            filename.write_bytes(corrupted)
            evidence["status"] = "attention"
            self.append_audit(
                actor, "CORRUPTION_SIMULATED",
                f"A controlled integrity fault was injected into replica {node_id} for recovery testing.",
                evidence, {"nodeId": node_id, "chunkHash": chunk["hash"]},
            )
            self.metadata.save(self.db)
            return {"nodeId": node_id, "chunkHash": chunk["hash"]}

    def set_node_state(self, node_id: str, state: Literal["online", "offline"], actor: dict[str, Any]) -> dict[str, Any]:
        with self._mutation_lock:
            node = next((item for item in self.db["nodes"] if item["id"] == node_id), None)
            if node is None:
                raise LookupError("Node not found")
            node.update({"state": state, "lastSeen": utc_now()})
            self.append_audit(actor, "NODE_STATE_CHANGED", f"{node['name']} marked {state}.", metadata={"nodeId": node_id, "state": state})
            self.metadata.save(self.db)
            return deepcopy(node)

    def verify_audit_chain(self) -> dict[str, Any]:
        previous_hash = GENESIS_HASH
        for event in self.db["audit"]:
            if event["previousHash"] != previous_hash or sha256(self.audit_body(event)) != event["hash"]:
                return {"valid": False, "brokenAt": event["sequence"], "events": len(self.db["audit"]), "head": previous_hash}
            previous_hash = event["hash"]
        return {"valid": True, "events": len(self.db["audit"]), "head": previous_hash}

    def get_report(self, evidence_id: str) -> dict[str, Any]:
        detail = self.get_evidence_detail(evidence_id)
        if detail is None:
            raise LookupError("Evidence not found")
        return {
            "generatedAt": utc_now(), "platform": "Custodia", "evidence": detail,
            "chainOfCustody": deepcopy([event for event in self.db["audit"] if event.get("evidenceId") == evidence_id]),
            "auditChain": self.verify_audit_chain(),
            "certification": {
                "algorithm": "SHA-256", "replicationFactor": self.replication_factor,
                "readConsistency": "majority quorum",
                "statement": "This report is generated from the append-only, hash-chained custody ledger.",
            },
        }

    def seed_demo_data(self) -> None:
        actor = self.db["users"][0]
        samples = [
            ("intersection-camera-04.txt", "CASE-2026-0142", "Extract metadata and immutable intake manifest from traffic camera 04.", ["video", "primary"], "CUSTODIA DEMO EVIDENCE\nCamera: Intersection 04\nCaptured: 2026-07-29T22:14:07Z\nFrames: 18422\n"),
            ("mobile-device-extract.json", "CASE-2026-0142", "Validated logical extraction manifest from seized mobile device.", ["mobile", "forensic-image"], json.dumps({"device": "MD-8841", "acquisition": "logical", "files": 2847, "validated": True}, indent=2)),
            ("firewall-session-log.csv", "CASE-2026-0151", "Network perimeter session log exported under warrant.", ["network", "log"], "timestamp,source,destination,action\n2026-07-30T08:10:12Z,10.20.4.18,198.51.100.42,ALLOW\n"),
        ]
        for name, case_id, description, tags, body in samples:
            self.upload(content=body.encode(), name=name, mime_type="text/plain", case_id=case_id, description=description, tags=tags, actor=actor)

    def replica_nodes(self, content_hash: str) -> list[str]:
        node_ids = [node["id"] for node in self.db["nodes"]]
        start = int(content_hash[:8], 16) % len(node_ids)
        return [node_ids[(start + offset) % len(node_ids)] for offset in range(min(self.replication_factor, len(node_ids)))]

    @staticmethod
    def merkle_root(hashes: list[str]) -> str:
        layer = hashes or [sha256(b"")]
        while len(layer) > 1:
            layer = [sha256(layer[index] + (layer[index + 1] if index + 1 < len(layer) else layer[index])) for index in range(0, len(layer), 2)]
        return layer[0]

    def node_object_dir(self, node_id: str) -> Path:
        return self.data_dir / "nodes" / node_id / "objects"

    def object_path(self, node_id: str, content_hash: str) -> Path:
        return self.node_object_dir(node_id) / content_hash[:2] / content_hash

    def write_object(self, node_id: str, content_hash: str, content: bytes, overwrite: bool = False) -> None:
        destination = self.object_path(node_id, content_hash)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.exists() and not overwrite:
            return
        temporary = destination.with_suffix(f".{uuid.uuid4().hex}.tmp")
        temporary.write_bytes(content)
        os.replace(temporary, destination)

    def quarantine(self, node_id: str, content_hash: str) -> None:
        source = self.object_path(node_id, content_hash)
        destination = self.data_dir / "nodes" / node_id / "quarantine" / f"{content_hash}.{int(datetime.now().timestamp() * 1000)}"
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.exists():
            shutil.move(source, destination)

    def append_audit(
        self, actor: dict[str, Any] | None, action: str, detail: str,
        evidence: dict[str, Any] | None = None, metadata: dict[str, Any] | None = None,
    ) -> None:
        last = self.db["audit"][-1] if self.db["audit"] else None
        event: dict[str, Any] = {
            "id": str(uuid.uuid4()), "sequence": (last["sequence"] if last else 0) + 1,
            "timestamp": utc_now(), "actorId": actor["id"] if actor else "system",
            "actorName": actor["name"] if actor else "Custodia integrity service",
            "actorRole": actor["role"] if actor else "system", "action": action,
        }
        if evidence:
            event.update({"evidenceId": evidence["id"], "caseId": evidence["caseId"]})
        event["detail"] = detail
        if metadata is not None:
            event["metadata"] = metadata
        event.update({"previousHash": last["hash"] if last else GENESIS_HASH, "hash": ""})
        event["hash"] = sha256(self.audit_body(event))
        self.db["audit"].append(event)

    @staticmethod
    def audit_body(event: dict[str, Any]) -> str:
        ordered_keys = ["id", "sequence", "timestamp", "actorId", "actorName", "actorRole", "action", "evidenceId", "caseId", "detail", "metadata", "previousHash"]
        body = {key: event[key] for key in ordered_keys if key in event and event[key] is not None}
        return json.dumps(body, ensure_ascii=False, separators=(",", ":"))


def allowed(role: Role, action: Literal["upload", "verify", "repair", "audit", "admin"]) -> bool:
    if role == "administrator":
        return True
    if role == "investigator":
        return action != "admin"
    return action in ("audit", "verify")
