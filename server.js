const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const { execFile } = require('child_process');
const session = require('express-session');
const FileStoreFactory = require('session-file-store');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');

const app = express();
const FileStore = FileStoreFactory(session);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SSL_ENABLED = String(process.env.SSL_ENABLED || 'false').toLowerCase() === 'true';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || path.join(__dirname, 'certs', 'fullchain.pem');
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || path.join(__dirname, 'certs', 'privkey.pem');
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LEGACY_SERVICES_FILE = path.join(DATA_DIR, 'services.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SESSION_SECRET = process.env.SESSION_SECRET || 'CHANGE_ME_TO_A_LONG_RANDOM_SECRET';
const SESSION_COOKIE_SECURE = SSL_ENABLED;
const ADMIN_BOOTSTRAP_USERNAME = process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin';
const ADMIN_BOOTSTRAP_PASSWORD_HASH = process.env.ADMIN_BOOTSTRAP_PASSWORD_HASH || '';
const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_CONCURRENCY = 8;
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';

const VALID_CHECK_METHODS = new Set(['auto', 'http', 'ping', 'disabled']);

ensureDir(DATA_DIR);
ensureDir(SESSIONS_DIR);
ensureFile(USERS_FILE, '[]\n');
ensureStateFiles();
bootstrapAdminUser();

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  store: new FileStore({ path: SESSIONS_DIR, retries: 0, ttl: 60 * 60 * 24 * 7 }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: SESSION_COOKIE_SECURE,
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  return res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/login.js', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.js')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'styles.css')));
app.get('/favicon.ico', (req, res) => res.status(204).end());

app.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const users = loadUsers();
  const user = users.find((item) => item.username === username);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  req.session.user = { username };
  return res.json({ ok: true, username });
});

app.post('/logout', requireAuth, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, ssl: SSL_ENABLED, time: new Date().toISOString() });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user || null });
});

app.get('/', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/app.js', requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.js'));
});

app.get('/api/state', requireAuth, (_req, res) => {
  res.json(loadState());
});

app.put('/api/state', requireAuth, (req, res) => {
  const normalized = normalizeIncomingState(req.body);
  saveState(normalized);
  res.json(normalized);
});

app.post('/api/servers', requireAuth, (req, res) => {
  const state = loadState();
  const payload = normalizeServer({
    id: req.body.id || generateId('srv'),
    name: req.body.name,
    ip: req.body.ip,
    baseUrl: req.body.baseUrl,
    description: req.body.description,
    expanded: req.body.expanded,
    order: nextServerOrder(state),
    tags: req.body.tags,
  }, nextServerOrder(state));
  state.servers.push(payload);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.status(201).json(payload);
});

app.put('/api/servers/:id', requireAuth, (req, res) => {
  const state = loadState();
  const index = state.servers.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Server not found' });
  const current = state.servers[index];
  state.servers[index] = normalizeServer({ ...current, ...req.body, id: current.id }, current.order);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json(state.servers[index]);
});

app.delete('/api/servers/:id', requireAuth, (req, res) => {
  const state = loadState();
  const force = String(req.query.force || '').toLowerCase() === 'true';
  const server = state.servers.find((item) => item.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const relatedServices = state.services.filter((item) => item.serverId === server.id);
  if (relatedServices.length && !force) {
    return res.status(409).json({ error: 'Server has services', code: 'SERVER_NOT_EMPTY', servicesCount: relatedServices.length });
  }
  state.servers = state.servers.filter((item) => item.id !== server.id);
  state.services = state.services.filter((item) => item.serverId !== server.id);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true });
});

app.post('/api/services', requireAuth, (req, res) => {
  const state = loadState();
  const defaultServerId = getDefaultServerId(state);
  const payload = normalizeService({
    ...req.body,
    id: req.body.id || generateId('svc'),
    serverId: req.body.serverId || defaultServerId,
    order: nextServiceOrderForServer(state, req.body.serverId || defaultServerId),
  }, nextServiceOrderForServer(state, req.body.serverId || defaultServerId));

  if (!state.servers.some((item) => item.id === payload.serverId)) {
    return res.status(400).json({ error: 'serverId is invalid' });
  }

  state.services.push(payload);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.status(201).json(payload);
});

app.put('/api/services/:id', requireAuth, (req, res) => {
  const state = loadState();
  const index = state.services.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: 'Service not found' });
  const current = state.services[index];
  const nextServerId = req.body.serverId || current.serverId;
  if (!state.servers.some((item) => item.id === nextServerId)) {
    return res.status(400).json({ error: 'serverId is invalid' });
  }
  state.services[index] = normalizeService({ ...current, ...req.body, id: current.id, serverId: nextServerId }, current.order);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json(state.services[index]);
});

app.delete('/api/services/:id', requireAuth, (req, res) => {
  const state = loadState();
  state.services = state.services.filter((item) => item.id !== req.params.id);
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true });
});

app.post('/api/reorder/servers', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const state = loadState();
  const indexMap = new Map(ids.map((id, i) => [id, i + 1]));
  state.servers = state.servers.map((server, i) => ({ ...server, order: indexMap.get(server.id) || i + 1000 }));
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true, servers: normalized.servers });
});

app.post('/api/reorder/services', requireAuth, (req, res) => {
  const serverId = String(req.body.serverId || '');
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  const state = loadState();
  const set = new Set(ids);
  let order = 1;
  state.services = state.services.map((service) => {
    if (service.serverId !== serverId) return service;
    if (!set.has(service.id)) return { ...service, order: 9999 };
    return { ...service, order: order++ };
  });
  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true });
});

app.get('/api/export', requireAuth, (_req, res) => {
  res.json(loadState());
});

app.post('/api/import', requireAuth, (req, res) => {
  const normalized = normalizeIncomingState(req.body);
  saveState(normalized);
  res.json(normalized);
});

app.get('/api/statuses', requireAuth, async (_req, res) => {
  const state = loadState();
  const statuses = await mapLimit(state.services, HEALTH_CONCURRENCY, async (service) => {
    const status = await checkService(service);
    return [service.id, status];
  });
  res.json(Object.fromEntries(statuses));
});

app.get('/api/discovery/docker', requireAuth, async (_req, res) => {
  try {
    const result = await discoverDockerContainers();
    res.json({ ok: true, available: true, containers: result });
  } catch (error) {
    res.json({ ok: false, available: false, error: error.message, containers: [] });
  }
});

app.post('/api/discovery/import', requireAuth, (req, res) => {
  const state = loadState();
  const targetServerId = String(req.body.serverId || getDefaultServerId(state));
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!state.servers.some((item) => item.id === targetServerId)) {
    return res.status(400).json({ error: 'serverId is invalid' });
  }

  const created = [];
  for (const item of items) {
    const service = normalizeService({
      id: generateId('svc'),
      serverId: targetServerId,
      name: item.name || item.containerName || 'Discovered service',
      url: item.url || item.internalUrl || '',
      description: item.description || `Docker image: ${item.image || 'unknown'}`,
      category: item.category || inferCategory(item.name || item.containerName || ''),
      iconUrl: '',
      healthUrl: item.healthUrl || item.url || item.internalUrl || '',
      checkMethod: item.checkMethod || 'auto',
      pinned: false,
      order: nextServiceOrderForServer(state, targetServerId),
      credentials: [],
      links: [],
      notes: item.notes || '',
    }, nextServiceOrderForServer(state, targetServerId));
    state.services.push(service);
    created.push(service);
  }

  const normalized = normalizeIncomingState(state);
  saveState(normalized);
  res.json({ ok: true, created });
});

app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

startServer();

function startServer() {
  if (SSL_ENABLED) {
    if (!fs.existsSync(SSL_CERT_PATH) || !fs.existsSync(SSL_KEY_PATH)) {
      throw new Error(`SSL enabled but certificate files are missing: ${SSL_CERT_PATH}, ${SSL_KEY_PATH}`);
    }
    const server = https.createServer({
      cert: fs.readFileSync(SSL_CERT_PATH),
      key: fs.readFileSync(SSL_KEY_PATH),
    }, app);
    server.listen(PORT, HOST, () => {
      console.log(`Self-hosted portal listening on https://${HOST}:${PORT}`);
    });
  } else {
    const server = http.createServer(app);
    server.listen(PORT, HOST, () => {
      console.log(`Self-hosted portal listening on http://${HOST}:${PORT}`);
    });
  }
}

function requireAuth(req, res, next) {
  if (req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  return res.redirect('/login');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function ensureFile(filePath, content) {
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, content, 'utf8');
}

function ensureStateFiles() {
  if (fs.existsSync(STATE_FILE)) return;
  if (fs.existsSync(LEGACY_SERVICES_FILE)) {
    const legacyRaw = readJsonFile(LEGACY_SERVICES_FILE, []);
    const migrated = migrateLegacyServicesIfNeeded(legacyRaw);
    saveState(migrated);
    return;
  }
  saveState(normalizeIncomingState({ servers: [], services: [] }));
}

function bootstrapAdminUser() {
  if (!ADMIN_BOOTSTRAP_PASSWORD_HASH) return;
  const users = loadUsers();
  if (!users.some((item) => item.username === ADMIN_BOOTSTRAP_USERNAME)) {
    users.push({ username: ADMIN_BOOTSTRAP_USERNAME, passwordHash: ADMIN_BOOTSTRAP_PASSWORD_HASH });
    saveUsers(users);
  }
}

function loadUsers() {
  const users = readJsonFile(USERS_FILE, []);
  return Array.isArray(users) ? users : [];
}

function saveUsers(users) {
  writeJsonFile(USERS_FILE, users);
}

function loadState() {
  const raw = readJsonFile(STATE_FILE, {});
  return normalizeIncomingState(raw);
}

function saveState(state) {
  const normalized = normalizeIncomingState(state);
  writeJsonFile(STATE_FILE, normalized);
}

function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function normalizeIncomingState(input) {
  if (Array.isArray(input)) {
    return migrateLegacyServicesIfNeeded(input);
  }

  const state = {
    servers: Array.isArray(input.servers) ? input.servers : [],
    services: Array.isArray(input.services) ? input.services : [],
    meta: typeof input.meta === 'object' && input.meta ? input.meta : {},
  };

  if (state.servers.length === 0) {
    state.servers.push(normalizeServer({
      id: 'srv-default',
      name: 'Default Server',
      ip: '',
      baseUrl: '',
      description: 'Default group',
      expanded: true,
      order: 1,
      tags: [],
    }, 1));
  }

  state.servers = state.servers
    .map((server, index) => normalizeServer(server, index + 1))
    .sort((a, b) => a.order - b.order);

  const serverIds = new Set(state.servers.map((item) => item.id));
  const defaultServerId = state.servers[0].id;

  state.services = state.services
    .map((service, index) => normalizeService({
      ...service,
      serverId: serverIds.has(service.serverId) ? service.serverId : defaultServerId,
    }, index + 1))
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));

  state.meta = {
    version: 2,
    updatedAt: new Date().toISOString(),
    ...state.meta,
  };

  return state;
}

function normalizeServer(server, fallbackOrder) {
  return {
    id: sanitizeId(server.id || generateId('srv')),
    name: String(server.name || 'Untitled Server').trim(),
    ip: String(server.ip || '').trim(),
    baseUrl: String(server.baseUrl || '').trim(),
    description: String(server.description || '').trim(),
    expanded: server.expanded !== false,
    order: Number.isFinite(Number(server.order)) ? Number(server.order) : fallbackOrder,
    tags: Array.isArray(server.tags) ? server.tags.map((item) => String(item).trim()).filter(Boolean) : [],
  };
}

function normalizeService(service, fallbackOrder) {
  const method = String(service.checkMethod || 'auto').trim().toLowerCase();
  return {
    id: sanitizeId(service.id || generateId('svc')),
    serverId: sanitizeId(service.serverId || 'srv-default'),
    name: String(service.name || 'Untitled Service').trim(),
    url: String(service.url || '').trim(),
    description: String(service.description || '').trim(),
    category: String(service.category || '').trim(),
    iconUrl: String(service.iconUrl || '').trim(),
    healthUrl: String(service.healthUrl || '').trim(),
    checkMethod: VALID_CHECK_METHODS.has(method) ? method : 'auto',
    pinned: Boolean(service.pinned),
    order: Number.isFinite(Number(service.order)) ? Number(service.order) : fallbackOrder,
    credentials: normalizeCredentials(service.credentials),
    links: normalizeLinks(service.links),
    notes: String(service.notes || '').trim(),
  };
}

function normalizeCredentials(credentials) {
  if (!Array.isArray(credentials)) return [];
  return credentials.map((item, index) => ({
    id: sanitizeId(item.id || `cred-${index + 1}`),
    label: String(item.label || '').trim(),
    value: String(item.value || '').trim(),
    secret: Boolean(item.secret),
    copyable: item.copyable !== false,
  })).filter((item) => item.label);
}

function normalizeLinks(links) {
  if (!Array.isArray(links)) return [];
  return links.map((item, index) => ({
    id: sanitizeId(item.id || `link-${index + 1}`),
    label: String(item.label || '').trim(),
    url: String(item.url || '').trim(),
  })).filter((item) => item.label && item.url);
}

function migrateLegacyServicesIfNeeded(legacyServices) {
  const server = normalizeServer({
    id: 'srv-default',
    name: 'Default Server',
    ip: '',
    baseUrl: '',
    description: 'Migrated from flat services list',
    expanded: true,
    order: 1,
    tags: [],
  }, 1);

  return normalizeIncomingState({
    servers: [server],
    services: (Array.isArray(legacyServices) ? legacyServices : []).map((item, index) => ({
      ...item,
      serverId: 'srv-default',
      order: index + 1,
      credentials: Array.isArray(item.credentials) ? item.credentials : [],
      links: Array.isArray(item.links) ? item.links : [],
      notes: item.notes || '',
    })),
    meta: { version: 2, migratedFromLegacy: true },
  });
}

function sanitizeId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || generateId('id');
}

function generateId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function getDefaultServerId(state) {
  return state.servers[0]?.id || 'srv-default';
}

function nextServerOrder(state) {
  return (Math.max(0, ...state.servers.map((item) => Number(item.order) || 0)) + 1);
}

function nextServiceOrderForServer(state, serverId) {
  return (Math.max(0, ...state.services.filter((item) => item.serverId === serverId).map((item) => Number(item.order) || 0)) + 1);
}

async function mapLimit(items, limit, mapper) {
  const result = [];
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index++;
      result[current] = await mapper(items[current], current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return result;
}

async function checkService(service) {
  if (service.checkMethod === 'disabled') return 'unknown';
  if (service.checkMethod === 'ping') return pingTarget(pickHost(service.healthUrl || service.url));
  if (service.checkMethod === 'http') return httpTarget(service.healthUrl || service.url);
  const httpStatus = await httpTarget(service.healthUrl || service.url);
  if (httpStatus === 'online') return 'online';
  return pingTarget(pickHost(service.healthUrl || service.url));
}

async function httpTarget(targetUrl) {
  if (!targetUrl) return 'unknown';
  try {
    const url = new URL(targetUrl);
    return await new Promise((resolve) => {
      const lib = url.protocol === 'https:' ? https : http;
      const req = lib.request({
        method: 'GET',
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        timeout: HEALTH_TIMEOUT_MS,
        rejectUnauthorized: false,
      }, (response) => {
        response.resume();
        resolve(response.statusCode && response.statusCode < 500 ? 'online' : 'offline');
      });
      req.on('timeout', () => {
        req.destroy();
        resolve('offline');
      });
      req.on('error', () => resolve('offline'));
      req.end();
    });
  } catch {
    return 'offline';
  }
}

async function pingTarget(host) {
  if (!host) return 'unknown';
  return await new Promise((resolve) => {
    execFile('ping', ['-c', '1', '-W', '2', host], { timeout: HEALTH_TIMEOUT_MS }, (error) => {
      resolve(error ? 'offline' : 'online');
    });
  });
}

function pickHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || '').trim();
  }
}

async function discoverDockerContainers() {
  if (!fs.existsSync(DOCKER_SOCKET_PATH)) {
    throw new Error(`Docker socket not found at ${DOCKER_SOCKET_PATH}`);
  }
  const containers = await dockerRequest('/containers/json?all=0');
  const detailed = [];
  for (const container of containers) {
    const inspect = await dockerRequest(`/containers/${container.Id}/json`);
    const ports = Array.isArray(container.Ports) ? container.Ports : [];
    const labels = inspect.Config?.Labels || {};
    const exposed = Object.keys(inspect.Config?.ExposedPorts || {});
    const names = Array.isArray(container.Names) ? container.Names.map((item) => item.replace(/^\//, '')) : [];
    const name = names[0] || inspect.Name?.replace(/^\//, '') || container.Id.slice(0, 12);
    const servicePort = ports.find((item) => item.PublicPort)?.PublicPort || ports[0]?.PrivatePort || guessPort(exposed);
    const hostPort = ports.find((item) => item.PublicPort)?.PublicPort || null;
    detailed.push({
      id: container.Id,
      containerName: name,
      name: prettifyName(name),
      image: container.Image,
      state: container.State,
      status: container.Status,
      labels,
      internalUrl: servicePort ? `http://${name}:${ports[0]?.PrivatePort || servicePort}` : '',
      url: hostPort ? `http://HOST:${hostPort}` : '',
      healthUrl: hostPort ? `http://HOST:${hostPort}` : '',
      checkMethod: hostPort ? 'auto' : 'disabled',
      category: inferCategory(name),
      ports,
      exposedPorts: exposed,
      description: `Docker image: ${container.Image}`,
    });
  }
  return detailed.sort((a, b) => a.name.localeCompare(b.name));
}

function dockerRequest(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: DOCKER_SOCKET_PATH,
      path: pathname,
      method: 'GET',
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Docker API error ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body || 'null'));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function guessPort(exposed) {
  const first = String(exposed[0] || '');
  const match = first.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

function prettifyName(name) {
  return String(name || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inferCategory(name) {
  const value = String(name || '').toLowerCase();
  if (/(postgres|redis|valkey|mysql|mongo|weaviate|qdrant|db)/.test(value)) return 'Database';
  if (/(n8n|automation|workflow)/.test(value)) return 'Automation';
  if (/(ollama|openwebui|rag|llm|ai|crawl)/.test(value)) return 'AI';
  if (/(portainer|proxy|nginx|infra|docker)/.test(value)) return 'Infra';
  return 'Service';
}
