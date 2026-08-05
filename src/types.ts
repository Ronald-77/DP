export type Role = 'administrator' | 'investigator' | 'auditor';
export interface User { id: string; name: string; initials: string; role: Role; title: string }
export interface Evidence {
  id: string; caseId: string; name: string; description: string; mimeType: string; size: number; tags: string[];
  status: 'verified' | 'attention'; createdAt: string; uploadedBy: string; currentVersionId: string; versionCount: number; lastVerifiedAt?: string;
}
export interface Chunk { hash: string; index: number; size: number; replicas: string[] }
export interface Version { id: string; evidenceId: string; number: number; rootHash: string; fileHash: string; size: number; chunkSize: number; chunks: Chunk[]; createdAt: string; createdBy: string; note: string }
export interface EvidenceDetail extends Evidence { versions: Version[]; currentVersion: Version }
export interface StorageNode { id: string; name: string; region: string; state: 'online' | 'offline'; lastSeen: string; chunks: number; bytes: number; utilization: number }
export interface AuditEvent { id: string; sequence: number; timestamp: string; actorId: string; actorName: string; actorRole: Role | 'system'; action: string; evidenceId?: string; caseId?: string; detail: string; metadata?: Record<string, unknown>; previousHash: string; hash: string }
export interface Overview { evidence: number; verified: number; attention: number; cases: number; totalBytes: number; nodesOnline: number; nodesTotal: number; auditEvents: number }
export interface Verification { evidenceId: string; version: number; checkedAt: string; totalReplicas: number; healthyReplicas: number; corruptReplicas: Array<{ nodeId: string; chunkHash: string; reason: string }>; repairedReplicas: number; status: string }
