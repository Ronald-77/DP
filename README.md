# Custodia — distributed digital evidence

Custodia is a runnable forensic evidence and chain-of-custody platform. It stores files as SHA-256-addressed chunks across isolated storage nodes, reads through a majority quorum, preserves immutable versions, and repairs modified or missing replicas from verified peers.

![Node](https://img.shields.io/badge/Node-24-244d3d) ![React](https://img.shields.io/badge/React-TypeScript-147d70) ![Integrity](https://img.shields.io/badge/integrity-SHA--256-246b61)

## Run it

Requirements: Node.js 20 or newer.

```powershell
npm.cmd install
npm.cmd run dev
```

Open <http://localhost:5173>. The first run creates a small demo registry. To run the compiled single-server application:

```powershell
npm.cmd run build
npm.cmd start
```

Then open <http://localhost:8787>.

## What is implemented

- Evidence intake with streamed multipart upload limits and SHA-256 hashing
- Fixed-size chunking and deterministic placement on three of four isolated node stores
- Content-addressed, deduplicated objects with atomic writes
- Majority-quorum reads (two valid replicas out of three) and whole-file revalidation
- Investigator, administrator, and auditor capabilities (switchable demo identities in the profile menu)
- Append-only audit ledger where every event includes the prior event hash
- Immutable evidence versions with retrievable historical content
- Online/offline node controls and quorum behavior
- Full-replica integrity scans, corrupt-object quarantine, and automatic reconstruction
- JSON chain-of-custody report export with manifests, versions, events, and certification data
- Responsive operational UI for evidence, storage nodes, ledger activity, and recovery drills

## Try the corruption-recovery drill

1. Use the profile menu to act as **Priya Shah (administrator)**.
2. Open any evidence artifact.
3. Select **Simulate corruption** at the bottom of the evidence view.
4. Select **Repair replicas**. Custodia locates the exact divergent node/object, quarantines it under `.data/nodes/<node>/quarantine`, and recreates it from a replica whose bytes match the immutable content hash.
5. Export the custody report or open the audit ledger to see both actions committed to the hash chain.

## Storage and consistency model

For each upload, the service computes a whole-file hash, splits the bytes into 256 KiB chunks, computes a SHA-256 address for each chunk, and calculates a Merkle root over the ordered chunk hashes. Placement starts at a node derived from the content hash and walks the node ring until the replication factor is met.

A normal read requires a majority of the assigned replicas to be available and independently match the expected hash. A repair needs at least one hash-valid source: divergent bytes are quarantined, then the correct bytes are atomically written back. The reconstructed file must also match the version's whole-file hash before being released.

Local deployment data lives in `.data/`:

```text
.data/
├── metadata.json             # evidence manifests and hash-chained ledger
└── nodes/
    ├── node-atlas/objects/   # independent content-addressed object store
    ├── node-boreal/objects/
    ├── node-cinder/objects/
    └── node-delta/objects/
```

## API highlights

| Method | Route | Capability |
| --- | --- | --- |
| `POST` | `/api/evidence` | Hash, chunk, distribute, and register evidence |
| `POST` | `/api/evidence/:id/versions` | Create an immutable version |
| `GET` | `/api/evidence/:id/download` | Quorum read and verified reconstruction |
| `POST` | `/api/evidence/:id/verify` | Scan every assigned replica |
| `POST` | `/api/evidence/:id/repair` | Quarantine and reconstruct bad replicas |
| `GET` | `/api/evidence/:id/report` | Generate a custody report |
| `GET` | `/api/audit` | Validate and return the custody hash chain |
| `PATCH` | `/api/nodes/:id` | Simulate node availability changes |

The demo identity is selected with the `x-user-id` header (`usr-morgan`, `usr-priya`, or `usr-james`). A production deployment should replace this adapter with OIDC/JWT validation and bind each action to a verified principal.

## Production stack path

The runnable edition deliberately uses filesystem and atomic-JSON adapters so it works with no external infrastructure. Its boundaries map directly to the suggested stack:

- Replace each node directory adapter with a MinIO bucket client; keep content hashes as object keys.
- Move manifests and identity grants into PostgreSQL with serializable transactions and row-level security.
- Publish committed audit events through Kafka using an outbox table; run verification/repair as consumer workers.
- Expose the same service contract through Go + gRPC for node-to-node traffic, retaining the HTTP gateway for React.
- Sign ledger heads with a KMS-backed asymmetric key and periodically anchor them to external trusted timestamps.

Before evidentiary production use, add organization-specific retention/legal-hold policy, OIDC/MFA, KMS signing, TLS/mTLS, malware isolation, external time-stamping, secrets management, and an accredited validation process.

## Verification

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

The tests cover deterministic chunk replication and quorum reconstruction, modified-replica detection and repair, audit-chain validity, version retrieval, and role capabilities.
