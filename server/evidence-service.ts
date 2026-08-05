import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MetadataStore } from './store.js';
import type { AuditEvent, DatabaseShape, Evidence, EvidenceVersion, Role, StorageNode, User, VerificationResult } from './types.js';

const sha256 = (input: Buffer | string) => createHash('sha256').update(input).digest('hex');
const now = () => new Date().toISOString();
const shortId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;
const GENESIS_HASH = '0'.repeat(64);

const users: User[] = [
  { id: 'usr-morgan', name: 'Morgan Reed', initials: 'MR', role: 'investigator', title: 'Lead investigator' },
  { id: 'usr-priya', name: 'Priya Shah', initials: 'PS', role: 'administrator', title: 'Evidence administrator' },
  { id: 'usr-james', name: 'James Okafor', initials: 'JO', role: 'auditor', title: 'Independent auditor' },
];

const nodes: StorageNode[] = [
  { id: 'node-atlas', name: 'Atlas', region: 'US East', state: 'online', lastSeen: now() },
  { id: 'node-boreal', name: 'Boreal', region: 'EU West', state: 'online', lastSeen: now() },
  { id: 'node-cinder', name: 'Cinder', region: 'AP Southeast', state: 'online', lastSeen: now() },
  { id: 'node-delta', name: 'Delta', region: 'US West', state: 'online', lastSeen: now() },
];

const emptyDatabase = (): DatabaseShape => ({ schemaVersion: 1, users, nodes, evidence: [], versions: [], audit: [] });

export class EvidenceService {
  private db: DatabaseShape = emptyDatabase();
  private readonly metadata: MetadataStore;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly replicationFactor = 3,
    private readonly chunkSize = 256 * 1024,
  ) {
    this.metadata = new MetadataStore(path.join(dataDir, 'metadata.json'));
  }

  async init(seed = true) {
    this.db = await this.metadata.load(emptyDatabase());
    for (const node of this.db.nodes) await mkdir(this.nodeObjectDir(node.id), { recursive: true });
    if (seed && this.db.evidence.length === 0) await this.seedDemoData();
  }

  getUsers() { return structuredClone(this.db.users); }
  getEvidence() { return structuredClone(this.db.evidence).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }
  getAudit(limit = 100) { return structuredClone(this.db.audit.slice(-limit).reverse()); }
  getVersion(id: string) { return this.db.versions.find((version) => version.id === id); }
  getEvidenceById(id: string) { return this.db.evidence.find((item) => item.id === id); }

  getEvidenceDetail(id: string) {
    const evidence = this.getEvidenceById(id);
    if (!evidence) return undefined;
    const versions = this.db.versions.filter((version) => version.evidenceId === id).sort((a, b) => b.number - a.number);
    const current = versions.find((version) => version.id === evidence.currentVersionId)!;
    return { ...structuredClone(evidence), versions: structuredClone(versions), currentVersion: structuredClone(current) };
  }

  async getNodes() {
    const result = [];
    for (const node of this.db.nodes) {
      const chunkHashes = new Set<string>();
      let bytes = 0;
      for (const version of this.db.versions) {
        for (const chunk of version.chunks) {
          if (!chunk.replicas.includes(node.id) || chunkHashes.has(chunk.hash)) continue;
          chunkHashes.add(chunk.hash);
          try { bytes += (await stat(this.objectPath(node.id, chunk.hash))).size; } catch { /* missing replica */ }
        }
      }
      result.push({ ...node, chunks: chunkHashes.size, bytes, utilization: Math.min(92, 28 + chunkHashes.size * 3) });
    }
    return result;
  }

  getOverview() {
    const totalBytes = this.db.evidence.reduce((sum, item) => sum + item.size, 0);
    const verified = this.db.evidence.filter((item) => item.status === 'verified').length;
    const cases = new Set(this.db.evidence.map((item) => item.caseId)).size;
    const recent = this.db.audit.slice(-7).map((event) => ({ time: event.timestamp, action: event.action }));
    return { evidence: this.db.evidence.length, verified, attention: this.db.evidence.length - verified, cases, totalBytes, nodesOnline: this.db.nodes.filter((node) => node.state === 'online').length, nodesTotal: this.db.nodes.length, auditEvents: this.db.audit.length, recent };
  }

  async upload(input: { buffer: Buffer; name: string; mimeType: string; caseId: string; description?: string; tags?: string[]; note?: string }, actor: User, evidenceId?: string) {
    return this.mutate(async () => {
      const timestamp = now();
      let evidence = evidenceId ? this.getEvidenceById(evidenceId) : undefined;
      if (evidenceId && !evidence) throw new Error('Evidence not found');
      const id = evidence?.id ?? shortId('EV');
      const existingVersions = this.db.versions.filter((version) => version.evidenceId === id);
      const versionNumber = existingVersions.length + 1;
      const chunks = [];
      for (let offset = 0, index = 0; offset < input.buffer.length || (input.buffer.length === 0 && index === 0); offset += this.chunkSize, index++) {
        const content = input.buffer.subarray(offset, Math.min(offset + this.chunkSize, input.buffer.length));
        const hash = sha256(content);
        const replicaNodes = this.replicaNodes(hash);
        for (const nodeId of replicaNodes) await this.writeObject(nodeId, hash, content);
        chunks.push({ hash, index, size: content.length, replicas: replicaNodes });
      }
      const fileHash = sha256(input.buffer);
      const rootHash = this.merkleRoot(chunks.map((chunk) => chunk.hash));
      const version: EvidenceVersion = {
        id: shortId('VER'), evidenceId: id, number: versionNumber, rootHash, fileHash,
        size: input.buffer.length, chunkSize: this.chunkSize, chunks, createdAt: timestamp,
        createdBy: actor.id, note: input.note || (versionNumber === 1 ? 'Initial evidence intake' : 'New evidence version'),
      };
      this.db.versions.push(version);
      if (!evidence) {
        evidence = {
          id, caseId: input.caseId.trim().toUpperCase(), name: input.name, description: input.description || '', mimeType: input.mimeType,
          size: input.buffer.length, tags: input.tags ?? [], status: 'verified', createdAt: timestamp,
          uploadedBy: actor.id, currentVersionId: version.id, versionCount: 1, lastVerifiedAt: timestamp,
        };
        this.db.evidence.push(evidence);
      } else {
        Object.assign(evidence, { name: input.name, mimeType: input.mimeType, size: input.buffer.length, currentVersionId: version.id, versionCount: versionNumber, status: 'verified', lastVerifiedAt: timestamp });
      }
      this.appendAudit(actor, versionNumber === 1 ? 'EVIDENCE_UPLOADED' : 'VERSION_CREATED', `Stored ${input.name} as ${chunks.length} content-addressed chunk${chunks.length === 1 ? '' : 's'} with ${this.replicationFactor}× replication.`, evidence, { version: versionNumber, fileHash, rootHash, chunks: chunks.length });
      return structuredClone({ evidence, version });
    });
  }

  async readEvidence(evidenceId: string, versionNumber?: number) {
    const evidence = this.getEvidenceById(evidenceId);
    if (!evidence) throw new Error('Evidence not found');
    const version = versionNumber
      ? this.db.versions.find((item) => item.evidenceId === evidenceId && item.number === versionNumber)
      : this.getVersion(evidence.currentVersionId);
    if (!version) throw new Error('Evidence version not found');
    const output: Buffer[] = [];
    for (const chunk of [...version.chunks].sort((a, b) => a.index - b.index)) {
      const valid: Buffer[] = [];
      for (const nodeId of chunk.replicas) {
        const node = this.db.nodes.find((candidate) => candidate.id === nodeId);
        if (!node || node.state === 'offline') continue;
        try {
          const content = await readFile(this.objectPath(nodeId, chunk.hash));
          if (sha256(content) === chunk.hash) valid.push(content);
        } catch { /* replica unavailable */ }
      }
      const quorum = Math.floor(chunk.replicas.length / 2) + 1;
      if (valid.length < quorum) throw new Error(`Quorum unavailable for chunk ${chunk.hash.slice(0, 12)} (${valid.length}/${quorum})`);
      output.push(valid[0]);
    }
    const buffer = Buffer.concat(output);
    if (sha256(buffer) !== version.fileHash) throw new Error('Reconstructed file failed whole-file integrity verification');
    return { buffer, evidence, version };
  }

  async verify(evidenceId: string, actor: User, repair = false): Promise<VerificationResult> {
    return this.mutate(async () => {
      const evidence = this.getEvidenceById(evidenceId);
      if (!evidence) throw new Error('Evidence not found');
      const version = this.getVersion(evidence.currentVersionId)!;
      const corruptReplicas: VerificationResult['corruptReplicas'] = [];
      let healthyReplicas = 0;
      let repairedReplicas = 0;
      let unrecoverable = false;
      for (const chunk of version.chunks) {
        let healthy: Buffer | undefined;
        const bad: Array<{ nodeId: string; reason: 'missing' | 'hash_mismatch' }> = [];
        for (const nodeId of chunk.replicas) {
          try {
            const content = await readFile(this.objectPath(nodeId, chunk.hash));
            if (sha256(content) === chunk.hash) { healthy = content; healthyReplicas++; }
            else bad.push({ nodeId, reason: 'hash_mismatch' });
          } catch { bad.push({ nodeId, reason: 'missing' }); }
        }
        corruptReplicas.push(...bad.map((item) => ({ ...item, chunkHash: chunk.hash })));
        if (bad.length && !healthy) unrecoverable = true;
        if (repair && healthy) {
          for (const badReplica of bad) {
            if (badReplica.reason === 'hash_mismatch') await this.quarantine(badReplica.nodeId, chunk.hash);
            await this.writeObject(badReplica.nodeId, chunk.hash, healthy, true);
            repairedReplicas++;
          }
        }
      }
      const status = unrecoverable ? 'unrecoverable' : corruptReplicas.length ? 'degraded' : 'healthy';
      evidence.status = unrecoverable || (corruptReplicas.length > 0 && !repair) ? 'attention' : 'verified';
      evidence.lastVerifiedAt = now();
      this.appendAudit(actor, repair ? 'INTEGRITY_REPAIR' : 'INTEGRITY_VERIFIED', repair
        ? `Integrity scan identified ${corruptReplicas.length} invalid replica(s) and reconstructed ${repairedReplicas} from healthy content.`
        : `Integrity scan checked ${version.chunks.length * this.replicationFactor} replicas; ${corruptReplicas.length} issue(s) found.`, evidence,
      { corruptReplicas: corruptReplicas.length, repairedReplicas, rootHash: version.rootHash });
      return { evidenceId, version: version.number, checkedAt: now(), totalReplicas: version.chunks.length * this.replicationFactor, healthyReplicas, corruptReplicas, repairedReplicas, status: repair && !unrecoverable ? 'healthy' : status };
    });
  }

  async simulateCorruption(evidenceId: string, actor: User) {
    return this.mutate(async () => {
      const evidence = this.getEvidenceById(evidenceId);
      if (!evidence) throw new Error('Evidence not found');
      const version = this.getVersion(evidence.currentVersionId)!;
      const chunk = version.chunks[0];
      const nodeId = chunk.replicas[0];
      const filename = this.objectPath(nodeId, chunk.hash);
      const original = await readFile(filename);
      const corrupt = Buffer.from(original);
      if (corrupt.length) corrupt[0] ^= 0xff; else await writeFile(filename, Buffer.from('corrupt'));
      if (corrupt.length) await writeFile(filename, corrupt);
      evidence.status = 'attention';
      this.appendAudit(actor, 'CORRUPTION_SIMULATED', `A controlled integrity fault was injected into replica ${nodeId} for recovery testing.`, evidence, { nodeId, chunkHash: chunk.hash });
      return { nodeId, chunkHash: chunk.hash };
    });
  }

  async setNodeState(nodeId: string, state: 'online' | 'offline', actor: User) {
    return this.mutate(async () => {
      const node = this.db.nodes.find((item) => item.id === nodeId);
      if (!node) throw new Error('Node not found');
      node.state = state; node.lastSeen = now();
      this.appendAudit(actor, 'NODE_STATE_CHANGED', `${node.name} marked ${state}.`, undefined, { nodeId, state });
      return structuredClone(node);
    });
  }

  verifyAuditChain() {
    let previousHash = GENESIS_HASH;
    for (const event of this.db.audit) {
      const body = this.auditBody({ ...event, hash: '' });
      if (event.previousHash !== previousHash || sha256(body) !== event.hash) return { valid: false, brokenAt: event.sequence, events: this.db.audit.length, head: previousHash };
      previousHash = event.hash;
    }
    return { valid: true, events: this.db.audit.length, head: previousHash };
  }

  getReport(evidenceId: string) {
    const detail = this.getEvidenceDetail(evidenceId);
    if (!detail) throw new Error('Evidence not found');
    const audit = this.db.audit.filter((event) => event.evidenceId === evidenceId);
    return { generatedAt: now(), platform: 'Custodia', evidence: detail, chainOfCustody: audit, auditChain: this.verifyAuditChain(), certification: { algorithm: 'SHA-256', replicationFactor: this.replicationFactor, readConsistency: 'majority quorum', statement: 'This report is generated from the append-only, hash-chained custody ledger.' } };
  }

  private async seedDemoData() {
    const actor = this.db.users[0];
    const samples = [
      { name: 'intersection-camera-04.txt', caseId: 'CASE-2026-0142', description: 'Extract metadata and immutable intake manifest from traffic camera 04.', tags: ['video', 'primary'], body: 'CUSTODIA DEMO EVIDENCE\nCamera: Intersection 04\nCaptured: 2026-07-29T22:14:07Z\nFrames: 18422\n' },
      { name: 'mobile-device-extract.json', caseId: 'CASE-2026-0142', description: 'Validated logical extraction manifest from seized mobile device.', tags: ['mobile', 'forensic-image'], body: JSON.stringify({ device: 'MD-8841', acquisition: 'logical', files: 2847, validated: true }, null, 2) },
      { name: 'firewall-session-log.csv', caseId: 'CASE-2026-0151', description: 'Network perimeter session log exported under warrant.', tags: ['network', 'log'], body: 'timestamp,source,destination,action\n2026-07-30T08:10:12Z,10.20.4.18,198.51.100.42,ALLOW\n' },
    ];
    for (const sample of samples) await this.upload({ buffer: Buffer.from(sample.body), name: sample.name, mimeType: 'text/plain', caseId: sample.caseId, description: sample.description, tags: sample.tags }, actor);
  }

  private replicaNodes(hash: string) {
    const online = this.db.nodes.map((node) => node.id);
    const start = Number.parseInt(hash.slice(0, 8), 16) % online.length;
    return Array.from({ length: Math.min(this.replicationFactor, online.length) }, (_, offset) => online[(start + offset) % online.length]);
  }

  private merkleRoot(hashes: string[]) {
    let layer = hashes.length ? hashes : [sha256(Buffer.alloc(0))];
    while (layer.length > 1) {
      const next: string[] = [];
      for (let index = 0; index < layer.length; index += 2) next.push(sha256(layer[index] + (layer[index + 1] ?? layer[index])));
      layer = next;
    }
    return layer[0];
  }

  private nodeObjectDir(nodeId: string) { return path.join(this.dataDir, 'nodes', nodeId, 'objects'); }
  private objectPath(nodeId: string, hash: string) { return path.join(this.nodeObjectDir(nodeId), hash.slice(0, 2), hash); }

  private async writeObject(nodeId: string, hash: string, content: Buffer, overwrite = false) {
    const destination = this.objectPath(nodeId, hash);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!overwrite) {
      try { await access(destination); return; } catch { /* new object */ }
    }
    const temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, content);
    await rename(temporary, destination);
  }

  private async quarantine(nodeId: string, hash: string) {
    const source = this.objectPath(nodeId, hash);
    const destination = path.join(this.dataDir, 'nodes', nodeId, 'quarantine', `${hash}.${Date.now()}`);
    await mkdir(path.dirname(destination), { recursive: true });
    try { await rename(source, destination); } catch { /* replica disappeared */ }
  }

  private appendAudit(actor: User | undefined, action: string, detail: string, evidence?: Evidence, metadata?: Record<string, unknown>) {
    const last = this.db.audit.at(-1);
    const event: AuditEvent = {
      id: randomUUID(), sequence: (last?.sequence ?? 0) + 1, timestamp: now(), actorId: actor?.id ?? 'system', actorName: actor?.name ?? 'Custodia integrity service', actorRole: actor?.role ?? 'system',
      action, evidenceId: evidence?.id, caseId: evidence?.caseId, detail, metadata, previousHash: last?.hash ?? GENESIS_HASH, hash: '',
    };
    event.hash = sha256(this.auditBody(event));
    this.db.audit.push(event);
  }

  private auditBody(event: AuditEvent) {
    return JSON.stringify({ id: event.id, sequence: event.sequence, timestamp: event.timestamp, actorId: event.actorId, actorName: event.actorName, actorRole: event.actorRole, action: event.action, evidenceId: event.evidenceId, caseId: event.caseId, detail: event.detail, metadata: event.metadata, previousHash: event.previousHash });
  }

  private mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation) as Promise<T>;
    this.mutationQueue = result.then(async () => { await this.metadata.save(this.db); }, async () => { await this.metadata.save(this.db); });
    return result.then(async (value) => { await this.mutationQueue; return value; });
  }
}

export function allowed(role: Role, action: 'upload' | 'verify' | 'repair' | 'audit' | 'admin') {
  if (role === 'administrator') return true;
  if (role === 'investigator') return action !== 'admin';
  return action === 'audit' || action === 'verify';
}
