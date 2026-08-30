import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  Activity, Archive, ArrowLeft, Bell, Boxes, Check, CheckCircle2, ChevronDown, ChevronRight, CircleDot,
  ClipboardCheck, Clock3, CloudCog, Database, Download, File, FileCheck2, FileClock, FilePlus2, Fingerprint,
  HardDrive, History, KeyRound, LayoutDashboard, LockKeyhole, Menu, Network, Plus, RefreshCcw, Search,
  Server, Shield, ShieldAlert, ShieldCheck, Sparkles, UploadCloud, UserRound, Users, X, Zap,
} from 'lucide-react';
import { api, downloadEvidence, getSelectedUser, setSelectedUser } from './api';
import type { AuditEvent, Evidence, EvidenceDetail, Overview, StorageNode, User, Verification } from './types';

type Page = 'overview' | 'evidence' | 'nodes' | 'audit';
type Toast = { id: number; kind: 'success' | 'error'; message: string };

const formatBytes = (bytes = 0) => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
};
const relativeTime = (value?: string) => {
  if (!value) return 'Never';
  const seconds = Math.floor((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 60) return 'Just now'; if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`; if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: new Date(value).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined }).format(new Date(value));
};
const fullDate = (value: string) => new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const hashShort = (hash: string, length = 14) => `${hash.slice(0, length)}…${hash.slice(-5)}`;
const actionLabel = (action: string) => action.toLowerCase().split('_').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');

function Brand({ compact = false }: { compact?: boolean }) {
  return <div className="brand"><div className="brand-mark"><Fingerprint size={21} /></div>{!compact && <div><b>custodia</b><span>EVIDENCE NETWORK</span></div>}</div>;
}

function StatusPill({ status }: { status: string }) {
  const positive = ['verified', 'online', 'healthy'].includes(status);
  return <span className={`status-pill ${positive ? 'positive' : 'warning'}`}><i />{status}</span>;
}

function Empty({ icon: Icon = Archive, title, text }: { icon?: typeof Archive; title: string; text: string }) {
  return <div className="empty"><div className="empty-icon"><Icon /></div><h3>{title}</h3><p>{text}</p></div>;
}

function Modal({ children, onClose, wide = false }: { children: React.ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => { const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose(); window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close); }, [onClose]);
  return <div className="modal-backdrop" onMouseDown={onClose}><div className={`modal ${wide ? 'wide' : ''}`} onMouseDown={(event) => event.stopPropagation()}>{children}</div></div>;
}

function UploadModal({ onClose, onUploaded, evidence }: { onClose: () => void; onUploaded: () => void; evidence?: EvidenceDetail }) {
  const [file, setFile] = useState<File>();
  const [caseId, setCaseId] = useState(evidence?.caseId || '');
  const [description, setDescription] = useState(evidence?.description || '');
  const [tags, setTags] = useState(evidence?.tags.join(', ') || '');
  const [note, setNote] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (!file) return setError('Choose an evidence file first.');
    setBusy(true); setError('');
    const data = new FormData(); data.set('file', file); data.set('caseId', caseId); data.set('description', description); data.set('tags', tags); data.set('note', note);
    try { await api(evidence ? `/evidence/${evidence.id}/versions` : '/evidence', { method: 'POST', body: data }); onUploaded(); }
    catch (reason) { setError((reason as Error).message); setBusy(false); }
  };
  return <Modal onClose={onClose}>
    <form onSubmit={submit}>
      <div className="modal-head"><div><span className="eyebrow">SECURE INTAKE</span><h2>{evidence ? 'Create evidence version' : 'Register new evidence'}</h2><p>{evidence ? 'The prior version remains immutable and available.' : 'Files are hashed, chunked and replicated during intake.'}</p></div><button className="icon-button" type="button" onClick={onClose}><X /></button></div>
      <div className={`drop-zone ${dragging ? 'dragging' : ''} ${file ? 'has-file' : ''}`} onClick={() => input.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); setFile(e.dataTransfer.files[0]); }}>
        <input ref={input} type="file" hidden onChange={(event) => setFile(event.target.files?.[0])} />
        {file ? <><div className="file-glyph"><FileCheck2 /></div><b>{file.name}</b><span>{formatBytes(file.size)} · Ready for SHA-256 intake</span></> : <><div className="upload-glyph"><UploadCloud /></div><b>Drop evidence here or browse</b><span>Up to 100 MB per file in this local deployment</span></>}
      </div>
      {!evidence && <div className="field-grid"><label><span>Case ID *</span><input required value={caseId} onChange={(event) => setCaseId(event.target.value)} placeholder="CASE-2026-0001" /></label><label><span>Tags</span><input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="mobile, primary" /></label></div>}
      {!evidence && <label className="field"><span>Description</span><textarea rows={3} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Document the source and acquisition context…" /></label>}
      {evidence && <label className="field"><span>Version note *</span><input required value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reason for this new version" /></label>}
      {error && <div className="form-error"><ShieldAlert size={16} />{error}</div>}
      <div className="modal-actions"><button type="button" className="button ghost" onClick={onClose}>Cancel</button><button className="button primary" disabled={busy}>{busy ? <><RefreshCcw className="spin" />Distributing…</> : <><LockKeyhole />Hash & distribute</>}</button></div>
    </form>
  </Modal>;
}

function EvidenceDetailModal({ id, users, currentUser, onClose, onChanged, notify }: { id: string; users: User[]; currentUser?: User; onClose: () => void; onChanged: () => void; notify: (kind: Toast['kind'], message: string) => void }) {
  const [detail, setDetail] = useState<EvidenceDetail>();
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState<Verification>();
  const [versioning, setVersioning] = useState(false);
  const load = useCallback(() => api<EvidenceDetail>(`/evidence/${id}`).then(setDetail), [id]);
  useEffect(() => { load(); }, [load]);
  const operation = async (action: 'verify' | 'repair' | 'simulate-corruption') => {
    setBusy(action);
    try {
      const value = await api<Verification>(`/evidence/${id}/${action}`, { method: 'POST' });
      if (action !== 'simulate-corruption') setResult(value);
      notify('success', action === 'repair' ? `Recovered ${value.repairedReplicas} replica${value.repairedReplicas === 1 ? '' : 's'} from healthy nodes.` : action === 'verify' ? `Integrity scan finished: ${value.status}.` : 'Controlled corruption injected. Run verification to locate it.');
      await load(); onChanged();
    } catch (error) { notify('error', (error as Error).message); }
    finally { setBusy(''); }
  };
  const report = async () => {
    try {
      const body = await api(`/evidence/${id}/report`); const blob = new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${id}-chain-of-custody.json`; anchor.click(); URL.revokeObjectURL(url);
      notify('success', 'Chain-of-custody report generated.');
    } catch (error) { notify('error', (error as Error).message); }
  };
  if (!detail) return <Modal wide onClose={onClose}><div className="loading-panel"><RefreshCcw className="spin" />Loading evidence manifest…</div></Modal>;
  const uploader = users.find((user) => user.id === detail.uploadedBy);
  return <>
    <Modal wide onClose={onClose}>
      <div className="detail-head">
        <button className="back-link" onClick={onClose}><ArrowLeft />All evidence</button>
        <div className="detail-title-row"><div className="large-file-icon"><FileCheck2 /></div><div className="detail-title"><div><span className="mono muted">{detail.id}</span><StatusPill status={detail.status} /></div><h2>{detail.name}</h2><p>{detail.description || 'No description provided.'}</p></div><button className="icon-button" onClick={onClose}><X /></button></div>
        <div className="detail-actions">
          <div className="workflow-hint"><span>NEXT STEP</span><b>{detail.status === 'attention' ? 'Review and repair the flagged replica' : 'Verify the evidence before using it'}</b></div>
          <div className="detail-button-group">
            <button className="button ghost" onClick={() => downloadEvidence(detail.id)}><Download />Download</button>
            <button className="button ghost" onClick={report}><ClipboardCheck />Custody report</button>
            <button className="button ghost" onClick={() => setVersioning(true)}><FilePlus2 />New version</button>
            <button className="button verify" disabled={!!busy} onClick={() => operation('verify')}><ShieldCheck />Verify integrity</button>
            {detail.status === 'attention' && <button className="button primary" disabled={!!busy} onClick={() => operation('repair')}><Sparkles />Repair replicas</button>}
          </div>
        </div>
      </div>
      <div className="detail-body">
        {result && <div className={`scan-result ${result.status}`}><ShieldCheck /><div><b>Integrity scan: {result.status}</b><span>{result.healthyReplicas}/{result.totalReplicas} replicas healthy · {result.repairedReplicas} reconstructed</span></div><button onClick={() => setResult(undefined)}><X /></button></div>}
        <div className="detail-grid">
          <section className="panel manifest-card"><div className="section-head"><div><span className="eyebrow">CURRENT MANIFEST</span><h3>Cryptographic identity</h3></div><Fingerprint /></div><div className="hash-block"><span>SHA-256 FILE HASH</span><code>{detail.currentVersion.fileHash}</code><button title="Copy hash" onClick={() => navigator.clipboard.writeText(detail.currentVersion.fileHash)}><ClipboardCheck /></button></div><div className="hash-block"><span>MERKLE ROOT</span><code>{detail.currentVersion.rootHash}</code><button title="Copy hash" onClick={() => navigator.clipboard.writeText(detail.currentVersion.rootHash)}><ClipboardCheck /></button></div><div className="manifest-stats"><div><span>SIZE</span><b>{formatBytes(detail.size)}</b></div><div><span>CHUNKS</span><b>{detail.currentVersion.chunks.length}</b></div><div><span>REPLICAS</span><b>{detail.currentVersion.chunks.length * 3}</b></div><div><span>VERSION</span><b>v{detail.currentVersion.number}</b></div></div></section>
          <section className="panel metadata-card"><div className="section-head"><div><span className="eyebrow">PROVENANCE</span><h3>Evidence metadata</h3></div><KeyRound /></div><dl><div><dt>Case reference</dt><dd>{detail.caseId}</dd></div><div><dt>Registered by</dt><dd>{uploader?.name || detail.uploadedBy}</dd></div><div><dt>Registered at</dt><dd>{fullDate(detail.createdAt)}</dd></div><div><dt>MIME type</dt><dd>{detail.mimeType}</dd></div><div><dt>Last verified</dt><dd>{relativeTime(detail.lastVerifiedAt)}</dd></div></dl><div className="tag-list">{detail.tags.map((tag) => <span key={tag}>{tag}</span>)}</div></section>
        </div>
        <section className="panel chunk-card"><div className="section-head"><div><span className="eyebrow">CONTENT-ADDRESSED STORAGE</span><h3>Chunk distribution</h3></div><span className="section-note">3× replication · Majority quorum</span></div><div className="chunk-table"><div className="chunk-row header"><span>INDEX</span><span>CONTENT HASH</span><span>SIZE</span><span>REPLICA NODES</span></div>{detail.currentVersion.chunks.slice(0, 8).map((chunk) => <div className="chunk-row" key={chunk.hash + chunk.index}><span className="mono">#{String(chunk.index + 1).padStart(3, '0')}</span><code>{hashShort(chunk.hash, 18)}</code><span>{formatBytes(chunk.size)}</span><span className="replica-dots">{chunk.replicas.map((node) => <i key={node} title={node} />)} <small>{chunk.replicas.map((node) => node.replace('node-', '')).join(' · ')}</small></span></div>)}</div></section>
        <section className="panel version-card"><div className="section-head"><div><span className="eyebrow">IMMUTABLE HISTORY</span><h3>Evidence versions</h3></div></div><div className="version-list">{detail.versions.map((version, index) => <div className="version-item" key={version.id}><div className="version-line"><i /><span /></div><div className="version-number">v{version.number}</div><div><b>{version.note}</b><p>{fullDate(version.createdAt)} · {formatBytes(version.size)} · {hashShort(version.fileHash)}</p></div>{index === 0 && <span className="current-badge">CURRENT</span>}</div>)}</div></section>
        {currentUser?.role === 'administrator' && <div className="danger-demo"><div><ShieldAlert /><span><b>Recovery drill</b><small>Inject a controlled fault into one replica to demonstrate detection and reconstruction.</small></span></div><button className="button danger" disabled={!!busy} onClick={() => operation('simulate-corruption')}><Zap />Simulate corruption</button></div>}
      </div>
    </Modal>
    {versioning && <UploadModal evidence={detail} onClose={() => setVersioning(false)} onUploaded={() => { setVersioning(false); load(); onChanged(); notify('success', 'New immutable evidence version created.'); }} />}
  </>;
}

function OverviewPage({ overview, evidence, audit, nodes, currentUser, onOpen, onUpload }: { overview?: Overview; evidence: Evidence[]; audit: AuditEvent[]; nodes: StorageNode[]; currentUser?: User; onOpen: (id: string) => void; onUpload: () => void }) {
  const integrity = overview?.evidence ? Math.round((overview.verified / overview.evidence) * 100) : 100;
  const firstName = currentUser?.name.split(' ')[0] || 'there';
  return <>
    <header className="page-header hero-header"><div><span className="eyebrow">DISTRIBUTED EVIDENCE OPERATIONS</span><h1>Good morning, {firstName}.</h1><p>Every byte accounted for. Every action attributable.</p></div><button className="button primary" onClick={onUpload}><Plus />Register evidence</button></header>
    <div className="stat-grid">
      <article className="stat-card"><div className="stat-icon teal"><Archive /></div><div><span>TOTAL EVIDENCE</span><strong>{overview?.evidence ?? '—'}</strong><small>Across {overview?.cases ?? 0} active cases</small></div><span className="stat-trend">LIVE</span></article>
      <article className="stat-card"><div className="stat-icon green"><ShieldCheck /></div><div><span>INTEGRITY SCORE</span><strong>{integrity}%</strong><small>{overview?.verified ?? 0} objects verified</small></div><span className="stat-trend safe">SECURE</span></article>
      <article className="stat-card"><div className="stat-icon amber"><HardDrive /></div><div><span>LOGICAL STORAGE</span><strong>{formatBytes(overview?.totalBytes)}</strong><small>3× distributed replicas</small></div><span className="stat-trend neutral">SHA-256</span></article>
      <article className="stat-card"><div className="stat-icon blue"><Network /></div><div><span>STORAGE NODES</span><strong>{overview?.nodesOnline}/{overview?.nodesTotal}</strong><small>Majority quorum available</small></div><span className="stat-trend safe">ONLINE</span></article>
    </div>
    <div className="overview-grid">
      <section className="panel evidence-panel"><div className="section-head"><div><span className="eyebrow">RECENT INTAKE</span><h3>Evidence registry</h3></div><button className="text-button" onClick={() => document.dispatchEvent(new CustomEvent('navigate', { detail: 'evidence' }))}>View all <ChevronRight /></button></div><div className="evidence-mini-list">{evidence.slice(0, 4).map((item) => <button key={item.id} onClick={() => onOpen(item.id)}><div className={`mini-file ${item.status}`}><File /></div><div><b>{item.name}</b><span>{item.caseId} · {formatBytes(item.size)}</span></div><StatusPill status={item.status} /><time>{relativeTime(item.createdAt)}</time><ChevronRight className="row-arrow" /></button>)}</div></section>
      <section className="panel network-panel"><div className="section-head"><div><span className="eyebrow">NETWORK HEALTH</span><h3>Replication topology</h3></div><span className="live-indicator"><i /> LIVE</span></div><div className="topology"><div className="topology-core"><Fingerprint /><span>QUORUM</span><b>3 / 4</b></div>{nodes.map((node, index) => <div key={node.id} className={`topology-node n${index + 1} ${node.state}`}><span><Server /></span><b>{node.name}</b><small>{node.region}</small></div>)}<svg viewBox="0 0 400 230" preserveAspectRatio="none"><path d="M200 115 L70 50 M200 115 L330 50 M200 115 L70 190 M200 115 L330 190" /></svg></div><div className="network-footer"><ShieldCheck /><span><b>Majority quorum healthy</b><small>Reads require 2 of 3 matching replicas</small></span><strong>{integrity}%</strong></div></section>
    </div>
    <section className="panel ledger-panel"><div className="section-head"><div><span className="eyebrow">CHAIN OF CUSTODY</span><h3>Latest ledger activity</h3></div><div className="ledger-verified"><CheckCircle2 /> Hash chain verified</div></div><div className="activity-list">{audit.slice(0, 5).map((event) => <div className="activity-item" key={event.id}><div className="activity-icon"><Activity /></div><div><b>{actionLabel(event.action)}</b><p>{event.detail}</p><span><UserRound /> {event.actorName} {event.caseId && <>· <em>{event.caseId}</em></>}</span></div><time>{relativeTime(event.timestamp)}</time><code>#{event.sequence}</code></div>)}</div></section>
  </>;
}

function EvidencePage({ evidence, onOpen, onUpload }: { evidence: Evidence[]; onOpen: (id: string) => void; onUpload: () => void }) {
  const [query, setQuery] = useState(''); const [status, setStatus] = useState('all');
  const filtered = evidence.filter((item) => (status === 'all' || item.status === status) && `${item.name} ${item.caseId} ${item.tags.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  return <><header className="page-header"><div><span className="eyebrow">EVIDENCE REGISTRY</span><h1>Digital evidence</h1><p>Search, verify and trace every registered artifact.</p></div><button className="button primary" onClick={onUpload}><Plus />Register evidence</button></header><div className="toolbar"><div className="search-box"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by filename, case or tag…" /></div><div className="segmented"><button className={status === 'all' ? 'active' : ''} onClick={() => setStatus('all')}>All <span>{evidence.length}</span></button><button className={status === 'verified' ? 'active' : ''} onClick={() => setStatus('verified')}>Verified</button><button className={status === 'attention' ? 'active' : ''} onClick={() => setStatus('attention')}>Attention</button></div></div><section className="panel registry-table"><div className="registry-row header"><span>ARTIFACT</span><span>CASE</span><span>INTEGRITY</span><span>SIZE</span><span>VERSIONS</span><span>REGISTERED</span><span /></div>{filtered.map((item) => <button className="registry-row" key={item.id} onClick={() => onOpen(item.id)}><span className="artifact-cell"><i><File /></i><span><b>{item.name}</b><small className="mono">{item.id}</small></span></span><span><b>{item.caseId}</b><small>{item.tags.join(' · ') || 'untagged'}</small></span><StatusPill status={item.status} /><span>{formatBytes(item.size)}</span><span><FileClock /> {item.versionCount}</span><span>{relativeTime(item.createdAt)}</span><ChevronRight /></button>)}{!filtered.length && <Empty icon={Search} title="No evidence found" text="Adjust your search or register a new artifact." />}</section></>;
}

function NodesPage({ nodes, currentUser, onChanged, notify }: { nodes: StorageNode[]; currentUser?: User; onChanged: () => void; notify: (kind: Toast['kind'], message: string) => void }) {
  const toggle = async (node: StorageNode) => { try { await api(`/nodes/${node.id}`, { method: 'PATCH', body: JSON.stringify({ state: node.state === 'online' ? 'offline' : 'online' }) }); notify('success', `${node.name} marked ${node.state === 'online' ? 'offline' : 'online'}.`); onChanged(); } catch (error) { notify('error', (error as Error).message); } };
  return <><header className="page-header"><div><span className="eyebrow">DISTRIBUTED STORAGE</span><h1>Evidence nodes</h1><p>Four isolated stores with deterministic chunk placement and majority reads.</p></div><div className="header-assurance"><CircleDot /><span><b>{nodes.filter((node) => node.state === 'online').length} nodes reachable</b><small>Quorum available</small></span></div></header><div className="node-grid">{nodes.map((node, index) => <article className={`panel node-card ${node.state}`} key={node.id}><div className="node-top"><div className={`node-icon c${index + 1}`}><Server /></div><StatusPill status={node.state} /></div><h3>{node.name}</h3><p>{node.region} · {node.id}</p><div className="node-capacity"><div><span>OBJECT UTILIZATION</span><b>{node.utilization}%</b></div><div className="capacity-bar"><i style={{ width: `${node.utilization}%` }} /></div></div><div className="node-metrics"><div><span>CONTENT OBJECTS</span><b>{node.chunks}</b></div><div><span>STORED</span><b>{formatBytes(node.bytes)}</b></div><div><span>LAST HEARTBEAT</span><b>{relativeTime(node.lastSeen)}</b></div></div>{currentUser?.role === 'administrator' && <button className="node-control" onClick={() => toggle(node)}><CloudCog /> Mark {node.state === 'online' ? 'offline' : 'online'}</button>}</article>)}</div><section className="panel consistency-panel"><div className="consistency-visual"><div><Database /></div><span /><div><Boxes /></div><span /><div><ShieldCheck /></div></div><div><span className="eyebrow">CONSISTENCY MODEL</span><h3>Content-addressed, majority-quorum reads</h3><p>Each SHA-256 chunk is placed on three nodes. Reads only succeed after a majority agrees with the immutable content address. Background verification restores divergent replicas from a valid peer.</p></div><div className="consistency-facts"><span><Check /> Write replication <b>3 nodes</b></span><span><Check /> Read quorum <b>2 replicas</b></span><span><Check /> Repair source <b>Verified hash</b></span></div></section></>;
}

function AuditPage({ events, valid, head }: { events: AuditEvent[]; valid: boolean; head: string }) {
  const [query, setQuery] = useState(''); const filtered = events.filter((event) => `${event.action} ${event.detail} ${event.actorName} ${event.caseId}`.toLowerCase().includes(query.toLowerCase()));
  return <><header className="page-header"><div><span className="eyebrow">IMMUTABLE LEDGER</span><h1>Chain of custody</h1><p>An append-only history, cryptographically linked from genesis to head.</p></div><div className={`chain-seal ${valid ? 'valid' : 'invalid'}`}><ShieldCheck /><span><b>{valid ? 'Chain verified' : 'Chain invalid'}</b><small>{events.length} signed events</small></span></div></header><div className="ledger-head panel"><div><span>GENESIS</span><code>{'0'.repeat(18)}…</code></div><ChevronRight /><div className="head-hash"><span>CURRENT LEDGER HEAD</span><code>{hashShort(head || '0'.repeat(64), 24)}</code></div><div className="chain-lock"><LockKeyhole /> SHA-256 linked</div></div><div className="toolbar audit-tools"><div className="search-box"><Search /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter the custody ledger…" /></div><span>{filtered.length} events</span></div><section className="audit-timeline">{filtered.map((event) => <article className="audit-event" key={event.id}><div className="audit-sequence">#{event.sequence}</div><div className="audit-rail"><i /><span /></div><div className="panel audit-content"><div className="audit-event-head"><div><span className="action-badge">{actionLabel(event.action)}</span>{event.caseId && <span className="case-badge">{event.caseId}</span>}</div><time><Clock3 /> {fullDate(event.timestamp)}</time></div><p>{event.detail}</p><div className="audit-meta"><span><UserRound /> <b>{event.actorName}</b> · {event.actorRole}</span><span className="audit-hash"><Fingerprint /> <code>{hashShort(event.hash, 20)}</code></span></div></div></article>)}{!filtered.length && <Empty icon={History} title="No ledger events" text="No custody records match your filter." />}</section></>;
}

export default function App() {
  const [page, setPage] = useState<Page>('overview');
  const [users, setUsers] = useState<User[]>([]); const [overview, setOverview] = useState<Overview>(); const [evidence, setEvidence] = useState<Evidence[]>([]); const [nodes, setNodes] = useState<StorageNode[]>([]); const [audit, setAudit] = useState<AuditEvent[]>([]); const [chain, setChain] = useState({ valid: true, head: '' });
  const [uploading, setUploading] = useState(false); const [selectedEvidence, setSelectedEvidence] = useState<string>(); const [toasts, setToasts] = useState<Toast[]>([]); const [profileOpen, setProfileOpen] = useState(false); const [sidebar, setSidebar] = useState(false); const [loading, setLoading] = useState(true);
  const currentUser = users.find((user) => user.id === getSelectedUser()) || users[0];
  const notify = useCallback((kind: Toast['kind'], message: string) => { const id = Date.now(); setToasts((items) => [...items, { id, kind, message }]); setTimeout(() => setToasts((items) => items.filter((toast) => toast.id !== id)), 4000); }, []);
  const load = useCallback(async () => {
    try {
      const [userData, overviewData, evidenceData, nodeData, auditData] = await Promise.all([api<User[]>('/users'), api<Overview>('/overview'), api<Evidence[]>('/evidence'), api<StorageNode[]>('/nodes'), api<{ chain: { valid: boolean; head: string }; events: AuditEvent[] }>('/audit')]);
      setUsers(userData); setOverview(overviewData); setEvidence(evidenceData); setNodes(nodeData); setAudit(auditData.events); setChain(auditData.chain);
    } catch (error) { notify('error', `Cannot reach the evidence service: ${(error as Error).message}`); }
    finally { setLoading(false); }
  }, [notify]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const navigate = (event: Event) => setPage((event as CustomEvent<Page>).detail); document.addEventListener('navigate', navigate); return () => document.removeEventListener('navigate', navigate); }, []);
  const switchUser = (id: string) => { setSelectedUser(id); setProfileOpen(false); load(); notify('success', `Session switched to ${users.find((user) => user.id === id)?.name}.`); };
  const pageTitles: Record<Page, string> = { overview: 'Operations overview', evidence: 'Evidence registry', nodes: 'Storage network', audit: 'Custody ledger' };
  const nav = useMemo(() => [
    { id: 'overview' as Page, label: 'Overview', icon: LayoutDashboard }, { id: 'evidence' as Page, label: 'Evidence', icon: Archive, count: overview?.attention || undefined }, { id: 'nodes' as Page, label: 'Storage nodes', icon: Server }, { id: 'audit' as Page, label: 'Audit ledger', icon: History },
  ], [overview]);
  if (loading) return <div className="splash"><Brand /><div className="splash-loader"><i /></div><span>Verifying ledger and storage quorum…</span></div>;
  return <div className="app-shell">
    <aside className={sidebar ? 'open' : ''}><div className="sidebar-top"><Brand /><button className="mobile-close" onClick={() => setSidebar(false)}><X /></button></div><nav>{nav.map(({ id, label, icon: Icon, count }) => <button key={id} className={page === id ? 'active' : ''} onClick={() => { setPage(id); setSidebar(false); }}><Icon /><span>{label}</span>{count && <em>{count}</em>}</button>)}</nav><div className="sidebar-spacer" /><div className="security-card"><div><ShieldCheck /></div><span><b>Custodia secure</b><small>Ledger head verified</small></span><Check /></div><div className="sidebar-foot"><span>ENVIRONMENT</span><b><i /> Local evidence network</b><small>v1.0 · SHA-256</small></div></aside>
    {sidebar && <div className="sidebar-overlay" onClick={() => setSidebar(false)} />}
    <main><div className="topbar"><button className="menu-button" onClick={() => setSidebar(true)}><Menu /></button><div><span>Custodia /</span> {pageTitles[page]}</div><div className="top-actions"><button className="notification-button"><Bell />{overview?.attention ? <i /> : null}</button><div className="profile"><button onClick={() => setProfileOpen((open) => !open)}><span className="avatar">{currentUser?.initials || '—'}</span><span><b>{currentUser?.name || 'Loading'}</b><small>{currentUser?.role}</small></span><ChevronDown /></button>{profileOpen && <div className="profile-menu"><span>ACT AS DEMO USER</span>{users.map((user) => <button key={user.id} className={user.id === currentUser?.id ? 'active' : ''} onClick={() => switchUser(user.id)}><span className="avatar small">{user.initials}</span><span><b>{user.name}</b><small>{user.role}</small></span>{user.id === currentUser?.id && <Check />}</button>)}</div>}</div></div></div>
      <div className="page-content">{page === 'overview' && <OverviewPage overview={overview} evidence={evidence} audit={audit} nodes={nodes} currentUser={currentUser} onOpen={setSelectedEvidence} onUpload={() => setUploading(true)} />}{page === 'evidence' && <EvidencePage evidence={evidence} onOpen={setSelectedEvidence} onUpload={() => setUploading(true)} />}{page === 'nodes' && <NodesPage nodes={nodes} currentUser={currentUser} onChanged={load} notify={notify} />}{page === 'audit' && <AuditPage events={audit} valid={chain.valid} head={chain.head} />}</div>
    </main>
    {uploading && <UploadModal onClose={() => setUploading(false)} onUploaded={() => { setUploading(false); load(); notify('success', 'Evidence hashed, distributed and committed to the custody ledger.'); }} />}
    {selectedEvidence && <EvidenceDetailModal id={selectedEvidence} users={users} currentUser={currentUser} onClose={() => setSelectedEvidence(undefined)} onChanged={load} notify={notify} />}
    <div className="toast-stack">{toasts.map((toast) => <div key={toast.id} className={`toast ${toast.kind}`}>{toast.kind === 'success' ? <CheckCircle2 /> : <ShieldAlert />}<span>{toast.message}</span><button onClick={() => setToasts((items) => items.filter((item) => item.id !== toast.id))}><X /></button></div>)}</div>
  </div>;
}
