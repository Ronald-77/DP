import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvidenceService, allowed } from './evidence-service.js';

const temporaryDirectories: string[] = [];
async function service() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'custodia-test-'));
  temporaryDirectories.push(directory);
  const instance = new EvidenceService(directory, 3, 8);
  await instance.init(false);
  return instance;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('distributed evidence service', () => {
  it('chunks, replicates and reconstructs the exact original through quorum reads', async () => {
    const instance = await service();
    const actor = instance.getUsers()[0];
    const original = Buffer.from('immutable forensic payload split across several chunks');
    const intake = await instance.upload({ buffer: original, name: 'image.dd', mimeType: 'application/octet-stream', caseId: 'CASE-TEST-01' }, actor);

    expect(intake.version.chunks.length).toBeGreaterThan(1);
    expect(intake.version.chunks.every((chunk) => chunk.replicas.length === 3)).toBe(true);
    const reconstructed = await instance.readEvidence(intake.evidence.id);
    expect(reconstructed.buffer.equals(original)).toBe(true);
    expect(instance.verifyAuditChain().valid).toBe(true);
  });

  it('finds a modified replica, quarantines it and repairs it from healthy nodes', async () => {
    const instance = await service();
    const administrator = instance.getUsers().find((user) => user.role === 'administrator')!;
    const original = Buffer.from('known-good evidence that must survive replica corruption');
    const intake = await instance.upload({ buffer: original, name: 'capture.pcap', mimeType: 'application/vnd.tcpdump.pcap', caseId: 'CASE-TEST-02' }, administrator);

    const fault = await instance.simulateCorruption(intake.evidence.id, administrator);
    const degraded = await instance.verify(intake.evidence.id, administrator, false);
    expect(degraded.status).toBe('degraded');
    expect(degraded.corruptReplicas).toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: fault.nodeId, reason: 'hash_mismatch' })]));

    const repaired = await instance.verify(intake.evidence.id, administrator, true);
    expect(repaired.status).toBe('healthy');
    expect(repaired.repairedReplicas).toBe(1);
    expect((await instance.readEvidence(intake.evidence.id)).buffer.equals(original)).toBe(true);
    expect(instance.verifyAuditChain().valid).toBe(true);
  });

  it('keeps prior versions retrievable and enforces role capabilities', async () => {
    const instance = await service();
    const investigator = instance.getUsers().find((user) => user.role === 'investigator')!;
    const first = await instance.upload({ buffer: Buffer.from('version one'), name: 'notes.txt', mimeType: 'text/plain', caseId: 'CASE-TEST-03' }, investigator);
    await instance.upload({ buffer: Buffer.from('version two'), name: 'notes.txt', mimeType: 'text/plain', caseId: 'CASE-TEST-03' }, investigator, first.evidence.id);

    expect((await instance.readEvidence(first.evidence.id, 1)).buffer.toString()).toBe('version one');
    expect((await instance.readEvidence(first.evidence.id, 2)).buffer.toString()).toBe('version two');
    expect(instance.getEvidenceDetail(first.evidence.id)?.versionCount).toBe(2);
    expect(allowed('auditor', 'upload')).toBe(false);
    expect(allowed('auditor', 'audit')).toBe(true);
  });
});
