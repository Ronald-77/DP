import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EvidenceService, allowed } from './evidence-service.js';
import type { Role, User } from './types.js';

declare global { namespace Express { interface Request { actor: User } } }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.CUSTODIA_DATA_DIR || path.join(root, '.data');
const service = new EvidenceService(dataDir);
await service.init(process.env.CUSTODIA_SEED !== 'false');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use((request, _response, next) => {
  const selected = request.header('x-user-id') || 'usr-morgan';
  request.actor = service.getUsers().find((user) => user.id === selected) ?? service.getUsers()[0];
  next();
});

const requireAction = (action: 'upload' | 'verify' | 'repair' | 'audit' | 'admin') => (request: Request, response: Response, next: NextFunction) => {
  if (!allowed(request.actor.role as Role, action)) return response.status(403).json({ error: `${request.actor.role} role cannot perform ${action}` });
  next();
};
const asyncRoute = (handler: (request: Request, response: Response) => Promise<unknown>) => (request: Request, response: Response, next: NextFunction) => { Promise.resolve(handler(request, response)).catch(next); };

app.get('/api/health', (_request, response) => response.json({ status: 'ok', service: 'custodia-api', auditChain: service.verifyAuditChain() }));
app.get('/api/users', (_request, response) => response.json(service.getUsers()));
app.get('/api/overview', (_request, response) => response.json(service.getOverview()));
app.get('/api/evidence', (_request, response) => response.json(service.getEvidence()));
app.get('/api/evidence/:id', (request, response) => {
  const item = service.getEvidenceDetail(request.params.id);
  return item ? response.json(item) : response.status(404).json({ error: 'Evidence not found' });
});
app.get('/api/nodes', asyncRoute(async (_request, response) => response.json(await service.getNodes())));
app.get('/api/audit', requireAction('audit'), (request, response) => response.json({ chain: service.verifyAuditChain(), events: service.getAudit(Number(request.query.limit) || 100) }));
app.get('/api/evidence/:id/report', requireAction('audit'), (request, response) => response.json(service.getReport(String(request.params.id))));
app.get('/api/evidence/:id/download', requireAction('verify'), asyncRoute(async (request, response) => {
  const result = await service.readEvidence(String(request.params.id), request.query.version ? Number(request.query.version) : undefined);
  response.setHeader('Content-Type', result.evidence.mimeType);
  response.setHeader('Content-Disposition', `attachment; filename="${result.evidence.name.replaceAll('"', '')}"`);
  response.setHeader('X-Content-SHA256', result.version.fileHash);
  response.send(result.buffer);
}));
app.post('/api/evidence', requireAction('upload'), upload.single('file'), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'A file is required' });
  if (!request.body.caseId?.trim()) return response.status(400).json({ error: 'A case ID is required' });
  const result = await service.upload({ buffer: request.file.buffer, name: request.file.originalname, mimeType: request.file.mimetype, caseId: request.body.caseId, description: request.body.description, tags: String(request.body.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean), note: request.body.note }, request.actor);
  response.status(201).json(result);
}));
app.post('/api/evidence/:id/versions', requireAction('upload'), upload.single('file'), asyncRoute(async (request, response) => {
  if (!request.file) return response.status(400).json({ error: 'A file is required' });
  const existing = service.getEvidenceById(String(request.params.id));
  if (!existing) return response.status(404).json({ error: 'Evidence not found' });
  const result = await service.upload({ buffer: request.file.buffer, name: request.file.originalname, mimeType: request.file.mimetype, caseId: existing.caseId, description: existing.description, tags: existing.tags, note: request.body.note }, request.actor, existing.id);
  response.status(201).json(result);
}));
app.post('/api/evidence/:id/verify', requireAction('verify'), asyncRoute(async (request, response) => response.json(await service.verify(String(request.params.id), request.actor, false))));
app.post('/api/evidence/:id/repair', requireAction('repair'), asyncRoute(async (request, response) => response.json(await service.verify(String(request.params.id), request.actor, true))));
app.post('/api/evidence/:id/simulate-corruption', requireAction('admin'), asyncRoute(async (request, response) => response.json(await service.simulateCorruption(String(request.params.id), request.actor))));
app.patch('/api/nodes/:id', requireAction('admin'), asyncRoute(async (request, response) => {
  if (!['online', 'offline'].includes(request.body.state)) return response.status(400).json({ error: 'State must be online or offline' });
  response.json(await service.setNodeState(String(request.params.id), request.body.state, request.actor));
}));

const clientDir = path.join(root, 'dist');
app.use(express.static(clientDir));
app.use((_request, response) => response.sendFile(path.join(clientDir, 'index.html')));
app.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(error.message.includes('not found') ? 404 : error.message.includes('Quorum') ? 503 : 500).json({ error: error.message || 'Unexpected server error' });
});

const port = Number(process.env.PORT || 8787);
if (process.env.NODE_ENV !== 'test') app.listen(port, () => console.log(`Custodia API listening on http://localhost:${port}`));
export { app, service };
