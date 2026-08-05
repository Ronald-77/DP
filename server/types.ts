export type Role = 'administrator' | 'investigator' | 'auditor';

export interface User {
  id: string;
  name: string;
  initials: string;
  role: Role;
  title: string;
}

export interface StorageNode {
  id: string;
  name: string;
  region: string;
  state: 'online' | 'offline';
  lastSeen: string;
}

export interface ChunkRef {
  hash: string;
  index: number;
  size: number;
  replicas: string[];
}

export interface EvidenceVersion {
  id: string;
  evidenceId: string;
  number: number;
  rootHash: string;
  fileHash: string;
  size: number;
  chunkSize: number;
  chunks: ChunkRef[];
  createdAt: string;
  createdBy: string;
  note: string;
}

export interface Evidence {
  id: string;
  caseId: string;
  name: string;
  description: string;
  mimeType: string;
  size: number;
  tags: string[];
  status: 'verified' | 'attention';
  createdAt: string;
  uploadedBy: string;
  currentVersionId: string;
  versionCount: number;
  lastVerifiedAt?: string;
}

export interface AuditEvent {
  id: string;
  sequence: number;
  timestamp: string;
  actorId: string;
  actorName: string;
  actorRole: Role | 'system';
  action: string;
  evidenceId?: string;
  caseId?: string;
  detail: string;
  metadata?: Record<string, unknown>;
  previousHash: string;
  hash: string;
}

export interface DatabaseShape {
  schemaVersion: 1;
  users: User[];
  nodes: StorageNode[];
  evidence: Evidence[];
  versions: EvidenceVersion[];
  audit: AuditEvent[];
}

export interface VerificationResult {
  evidenceId: string;
  version: number;
  checkedAt: string;
  totalReplicas: number;
  healthyReplicas: number;
  corruptReplicas: Array<{ nodeId: string; chunkHash: string; reason: 'missing' | 'hash_mismatch' }>;
  repairedReplicas: number;
  status: 'healthy' | 'degraded' | 'unrecoverable';
}
