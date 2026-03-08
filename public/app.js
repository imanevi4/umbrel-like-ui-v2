const state = {
  data: { servers: [], services: [], meta: {} },
  statuses: {},
  search: '',
  me: null,
  draggingServerId: null,
  draggingServiceId: null,
  discoveryItems: [],
};

const el = {
  meBox: document.getElementById('me-box'),
  logoutBtn: document.getElementById('logout-btn'),
  searchInput: document.getElementById('search-input'),
  summaryCards: document.getElementById('summary-cards'),
  serversRoot: document.getElementById('servers-root'),
  addServerBtn: document.getElementById('add-server-btn'),
  addServiceBtn: document.getElementById('add-service-btn'),
  checkAllBtn: document.getElementById('check-all-btn'),
  exportBtn: document.getElementById('export-btn'),
  importBtn: document.getElementById('import-btn'),
  importFile: document.getElementById('import-file'),
  serverModal: document.getElementById('server-modal'),
  serverForm: document.getElementById('server-form'),
  serverModalTitle: document.getElementById('server-modal-title'),
  serviceModal: document.getElementById('service-modal'),
  serviceForm: document.getElementById('service-form'),
  serviceModalTitle: document.getElementById('service-modal-title'),
  discoveryBtn: document.getElementById('discovery-btn'),
  discoveryModal: document.getElementById('discovery-modal'),
  discoveryServerSelect: document.getElementById('discovery-server-select'),
  discoveryRefreshBtn: document.getElementById('discovery-refresh-btn'),
  discoveryImportBtn: document.getElementById('discovery-import-btn'),
  discoveryStatus: document.getElementById('discovery-status'),
  discoveryList: document.getElementById('discovery-list'),
};

init().catch(handleFatal);

async function init() {
  bindCommonEvents();
  await loadMe();
  await loadState();
  await refreshStatuses();
  render();
}

function bindCommonEvents() {
  el.logoutBtn.addEventListener('click', logout);
  el.searchInput.addEventListener('input', () => {
    state.search = el.searchInput.value.trim().toLowerCase();
    render();
  });
  el.addServerBtn.addEventListener('click', () => openServerModal());
  el.addServiceBtn.addEventListener('click', () => openServiceModal());
  el.checkAllBtn.addEventListener('click', async () => {
    await refreshStatuses();
    render();
  });
  el.exportBtn.addEventListener('click', exportStateFile);
  el.importBtn.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', importStateFile);
  el.serverForm.addEventListener('submit', saveServerFromForm);
  el.serviceForm.addEventListener('submit', saveServiceFromForm);
  el.discoveryBtn.addEventListener('click', async () => {
    openDialog(el.discoveryModal);
    await refreshDiscovery();
  });
  el.discoveryRefreshBtn.addEventListener('click', refreshDiscovery);
  el.discoveryImportBtn.addEventListener('click', importSelectedDiscovery);
  document.querySelectorAll('[data-close]').forEach((btn) => btn.addEventListener('click', () => closeClosestDialog(btn)));
}

async function loadMe() {
  const response = await fetch('/api/me');
  if (!response.ok) {
    window.location.href = '/login';
    return;
  }
  const payload = await response.json();
  state.me = payload.user;
  el.meBox.textContent = state.me ? `User: ${state.me.username}` : '';
}

async function loadState() {
  const response = await fetch('/api/state');
  const payload = await response.json();
  state.data = payload;
}

async function refreshStatuses() {
  state.statuses = state.data.services.reduce((acc, item) => ({ ...acc, [item.id]: 'checking' }), {});
  render();
  const response = await fetch('/api/statuses');
  if (!response.ok) return;
  state.statuses = await response.json();
}

function render() {
  renderSummary();
  renderServers();
  renderServerSelects();
}

function renderSummary() {
  const services = getVisibleServicesFlat();
  const online = services.filter((item) => state.statuses[item.id] === 'online').length;
  const offline = services.filter((item) => state.statuses[item.id] === 'offline').length;
  const cards = [
    ['Серверов', state.data.servers.length],
    ['Сервисов', state.data.services.length],
    ['В сети', online],
    ['Не в сети', offline],
  ];
  el.summaryCards.innerHTML = cards.map(([label, value]) => `
    <div class="summary-card glass">
      <div class="muted">${escapeHtml(label)}</div>
      <div class="value">${value}</div>
    </div>
  `).join('');
}

function renderServers() {
  const search = state.search;
  const visibleServers = getSortedServers().map((server) => {
    const services = getServicesByServer(server.id).filter((service) => matchesSearch(server, service, search));
    return { server, services };
  }).filter(({ server, services }) => !search || matchesServerSearch(server, search) || services.length > 0);

  if (!visibleServers.length) {
    el.serversRoot.innerHTML = `<div class="glass server-card"><div class="server-body empty-state">Ничего не найдено.</div></div>`;
    return;
  }

  el.serversRoot.innerHTML = '';
  for (const { server, services } of visibleServers) {
    const expanded = search ? true : server.expanded;
    const online = services.filter((item) => state.statuses[item.id] === 'online').length;
    const offline = services.filter((item) => state.statuses[item.id] === 'offline').length;
    const card = document.createElement('section');
    card.className = 'server-card glass';
    card.draggable = true;
    card.dataset.serverId = server.id;
    card.innerHTML = `
      <div class="server-header">
        <div>
          <div class="server-title">
            <span class="drag-handle">⋮⋮</span>
            <div>
              <h2>${escapeHtml(server.name)}</h2>
              <div class="server-meta">
                ${server.ip ? `<span>${escapeHtml(server.ip)}</span>` : ''}
                ${server.baseUrl ? `<span>${escapeHtml(server.baseUrl)}</span>` : ''}
                <span>services: ${services.length}</span>
                <span>online: ${online}</span>
                <span>offline: ${offline}</span>
              </div>
            </div>
          </div>
          ${server.description ? `<div class="muted small">${escapeHtml(server.description)}</div>` : ''}
          <div class="server-meta">${(server.tags || []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('')}</div>
        </div>
        <div class="server-actions">
          <button class="ghost-btn" data-toggle-server="${server.id}">${expanded ? 'Свернуть' : 'Развернуть'}</button>
          <button class="ghost-btn" data-add-service="${server.id}">+ Сервис</button>
          <button class="ghost-btn" data-edit-server="${server.id}">Редактировать</button>
          <button class="ghost-btn" data-delete-server="${server.id}">Удалить</button>
        </div>
      </div>
      <div class="server-body ${expanded ? '' : 'hidden'}">
        <div class="services-grid" data-services-grid="${server.id}"></div>
      </div>
    `;
    bindServerCardEvents(card, server.id);
    const grid = card.querySelector(`[data-services-grid="${server.id}"]`);
    if (!services.length) {
      grid.innerHTML = `<div class="glass service-card empty-state">Нет сервисов в этой группе.</div>`;
    } else {
      for (const service of services) {
        grid.appendChild(createServiceCard(server, service));
      }
    }
    el.serversRoot.appendChild(card);
  }
}

function bindServerCardEvents(card, serverId) {
  card.addEventListener('dragstart', () => { state.draggingServerId = serverId; });
  card.addEventListener('dragover', (event) => event.preventDefault());
  card.addEventListener('drop', async (event) => {
    event.preventDefault();
    if (!state.draggingServerId || state.draggingServerId === serverId) return;
    const sorted = getSortedServers().map((item) => item.id);
    const fromIndex = sorted.indexOf(state.draggingServerId);
    const toIndex = sorted.indexOf(serverId);
    sorted.splice(toIndex, 0, sorted.splice(fromIndex, 1)[0]);
    await api('/api/reorder/servers', { method: 'POST', body: JSON.stringify({ ids: sorted }) });
    state.draggingServerId = null;
    await loadState();
    render();
  });
  card.querySelector('[data-toggle-server]')?.addEventListener('click', async () => {
    const server = state.data.servers.find((item) => item.id === serverId);
    await api(`/api/servers/${serverId}`, { method: 'PUT', body: JSON.stringify({ expanded: !server.expanded }) });
    await loadState();
    render();
  });
  card.querySelector('[data-add-service]')?.addEventListener('click', () => openServiceModal({ serverId }));
  card.querySelector('[data-edit-server]')?.addEventListener('click', () => openServerModal(state.data.servers.find((item) => item.id === serverId)));
  card.querySelector('[data-delete-server]')?.addEventListener('click', async () => {
    const ok = window.confirm('Удалить сервер? Если внутри есть сервисы, нужно подтверждение каскадного удаления.');
    if (!ok) return;
    const response = await fetch(`/api/servers/${serverId}` , { method: 'DELETE' });
    if (response.status === 409) {
      const forceOk = window.confirm('В сервере есть сервисы. Удалить сервер вместе со всеми сервисами?');
      if (!forceOk) return;
      await api(`/api/servers/${serverId}?force=true`, { method: 'DELETE' });
    }
    await loadState();
    render();
  });
}

function createServiceCard(server, service) {
  const article = document.createElement('article');
  article.className = 'service-card glass';
  article.draggable = true;
  article.dataset.serviceId = service.id;
  const status = state.statuses[service.id] || 'unknown';
  const iconSrc = service.iconUrl || getFaviconUrl(service.url);
  article.innerHTML = `
    <div class="service-top">
      <div class="service-info">
        <div class="service-icon">${iconSrc ? `<img src="${escapeHtml(iconSrc)}" alt="${escapeHtml(service.name)}" onerror="this.parentNode.textContent='${escapeHtml(service.name.slice(0,1).toUpperCase())}'" />` : escapeHtml(service.name.slice(0,1).toUpperCase())}</div>
        <div>
          <h3 class="service-title">${escapeHtml(service.name)}</h3>
          <div class="service-subtitle">${escapeHtml(service.description || 'Без описания')}</div>
          <div class="service-url">${escapeHtml(service.url)}</div>
        </div>
      </div>
      <span class="status-dot status-${status}"></span>
    </div>
    <div class="service-tags">
      ${service.category ? `<span class="tag">${escapeHtml(service.category)}</span>` : ''}
      <span class="tag">${escapeHtml(service.checkMethod)}</span>
      ${service.pinned ? '<span class="tag">pinned</span>' : ''}
      <span class="tag">${escapeHtml(server.name)}</span>
    </div>
    ${renderCredentials(service.credentials)}
    ${renderLinks(service.links)}
    ${service.notes ? `<div class="service-note small">${escapeHtml(service.notes)}</div>` : ''}
    <div class="service-actions">
      <button class="ghost-btn" data-open="${escapeHtml(service.url)}">Открыть</button>
      <button class="ghost-btn" data-edit-service="${service.id}">Редактировать</button>
      <button class="ghost-btn" data-delete-service="${service.id}">Удалить</button>
    </div>
  `;
  article.addEventListener('dragstart', () => { state.draggingServiceId = service.id; });
  article.addEventListener('dragover', (event) => event.preventDefault());
  article.addEventListener('drop', async (event) => {
    event.preventDefault();
    if (!state.draggingServiceId || state.draggingServiceId === service.id) return;
    const ids = getServicesByServer(server.id).map((item) => item.id);
    const fromIndex = ids.indexOf(state.draggingServiceId);
    const toIndex = ids.indexOf(service.id);
    ids.splice(toIndex, 0, ids.splice(fromIndex, 1)[0]);
    await api('/api/reorder/services', { method: 'POST', body: JSON.stringify({ serverId: server.id, ids }) });
    state.draggingServiceId = null;
    await loadState();
    render();
  });
  article.querySelector('[data-open]')?.addEventListener('click', () => window.open(service.url, '_blank', 'noopener,noreferrer'));
  article.querySelector('[data-edit-service]')?.addEventListener('click', () => openServiceModal(service));
  article.querySelector('[data-delete-service]')?.addEventListener('click', async () => {
    if (!window.confirm('Удалить сервис?')) return;
    await api(`/api/services/${service.id}`, { method: 'DELETE' });
    await loadState();
    render();
  });
  article.querySelectorAll('[data-toggle-secret]').forEach((btn) => btn.addEventListener('click', () => {
    const target = article.querySelector(`[data-secret-value="${btn.dataset.toggleSecret}"]`);
    const current = target.dataset.rawValue || '';
    const isHidden = target.dataset.hidden === 'true';
    target.textContent = isHidden ? current : '************';
    target.dataset.hidden = String(!isHidden);
  }));
  article.querySelectorAll('[data-copy]').forEach((btn) => btn.addEventListener('click', async () => {
    await navigator.clipboard.writeText(btn.dataset.copy || '');
  }));
  return article;
}

function renderCredentials(credentials = []) {
  if (!credentials.length) return '';
  return `<div class="credentials-list">${credentials.map((item) => `
    <div class="credential-row">
      <span>${escapeHtml(item.label)}:</span>
      <span>
        <span class="credential-value" data-secret-value="${escapeHtml(item.id)}" data-hidden="${item.secret ? 'true' : 'false'}" data-raw-value="${escapeHtml(item.value)}">${item.secret ? '************' : escapeHtml(item.value)}</span>
        ${item.secret ? `<button class="copy-btn" type="button" data-toggle-secret="${escapeHtml(item.id)}">👁</button>` : ''}
        ${item.copyable ? `<button class="copy-btn" type="button" data-copy="${escapeHtml(item.value)}">⧉</button>` : ''}
      </span>
    </div>
  `).join('')}</div>`;
}

function renderLinks(links = []) {
  if (!links.length) return '';
  return `<div class="links-list">${links.map((item) => `
    <div class="link-row">
      <span>${escapeHtml(item.label)}</span>
      <a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">Link ↗</a>
    </div>
  `).join('')}</div>`;
}

function getSortedServers() {
  return [...state.data.servers].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function getServicesByServer(serverId) {
  return [...state.data.services]
    .filter((item) => item.serverId === serverId)
    .sort((a, b) => a.order - b.order || Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));
}

function getVisibleServicesFlat() {
  return getSortedServers().flatMap((server) => getServicesByServer(server.id).filter((service) => matchesSearch(server, service, state.search)));
}

function matchesSearch(server, service, query) {
  if (!query) return true;
  const values = [
    server.name, server.ip, server.baseUrl, server.description, (server.tags || []).join(' '),
    service.name, service.url, service.description, service.category, service.notes,
    JSON.stringify(service.credentials || []), JSON.stringify(service.links || []),
  ].join(' ').toLowerCase();
  return values.includes(query);
}

function matchesServerSearch(server, query) {
  if (!query) return true;
  return [server.name, server.ip, server.baseUrl, server.description, (server.tags || []).join(' ')].join(' ').toLowerCase().includes(query);
}

function renderServerSelects() {
  const options = getSortedServers().map((server) => `<option value="${escapeHtml(server.id)}">${escapeHtml(server.name)}</option>`).join('');
  el.serviceForm.elements.serverId.innerHTML = options;
  el.discoveryServerSelect.innerHTML = options;
}

function openServerModal(server = null) {
  el.serverModalTitle.textContent = server ? 'Редактировать сервер' : 'Добавить сервер';
  el.serverForm.reset();
  el.serverForm.elements.id.value = server?.id || '';
  el.serverForm.elements.name.value = server?.name || '';
  el.serverForm.elements.ip.value = server?.ip || '';
  el.serverForm.elements.baseUrl.value = server?.baseUrl || '';
  el.serverForm.elements.description.value = server?.description || '';
  el.serverForm.elements.tags.value = (server?.tags || []).join(', ');
  el.serverForm.elements.expanded.checked = server?.expanded !== false;
  openDialog(el.serverModal);
}

function openServiceModal(service = null) {
  el.serviceModalTitle.textContent = service ? 'Редактировать сервис' : 'Добавить сервис';
  el.serviceForm.reset();
  renderServerSelects();
  el.serviceForm.elements.id.value = service?.id || '';
  el.serviceForm.elements.serverId.value = service?.serverId || state.data.servers[0]?.id || '';
  el.serviceForm.elements.name.value = service?.name || '';
  el.serviceForm.elements.url.value = service?.url || '';
  el.serviceForm.elements.description.value = service?.description || '';
  el.serviceForm.elements.category.value = service?.category || '';
  el.serviceForm.elements.iconUrl.value = service?.iconUrl || '';
  el.serviceForm.elements.healthUrl.value = service?.healthUrl || '';
  el.serviceForm.elements.checkMethod.value = service?.checkMethod || 'auto';
  el.serviceForm.elements.pinned.checked = !!service?.pinned;
  el.serviceForm.elements.notes.value = service?.notes || '';
  el.serviceForm.elements.credentials.value = service?.credentials?.length ? JSON.stringify(service.credentials, null, 2) : '[]';
  el.serviceForm.elements.links.value = service?.links?.length ? JSON.stringify(service.links, null, 2) : '[]';
  openDialog(el.serviceModal);
}

async function saveServerFromForm(event) {
  event.preventDefault();
  const payload = {
    id: el.serverForm.elements.id.value || undefined,
    name: el.serverForm.elements.name.value,
    ip: el.serverForm.elements.ip.value,
    baseUrl: el.serverForm.elements.baseUrl.value,
    description: el.serverForm.elements.description.value,
    tags: el.serverForm.elements.tags.value.split(',').map((item) => item.trim()).filter(Boolean),
    expanded: el.serverForm.elements.expanded.checked,
  };
  const isEdit = Boolean(payload.id);
  await api(isEdit ? `/api/servers/${payload.id}` : '/api/servers', {
    method: isEdit ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  await loadState();
  closeDialog(el.serverModal);
  render();
}

async function saveServiceFromForm(event) {
  event.preventDefault();
  let credentials = [];
  let links = [];
  try {
    credentials = JSON.parse(el.serviceForm.elements.credentials.value || '[]');
    links = JSON.parse(el.serviceForm.elements.links.value || '[]');
  } catch {
    window.alert('Credentials или Links содержат невалидный JSON');
    return;
  }
  const payload = {
    id: el.serviceForm.elements.id.value || undefined,
    serverId: el.serviceForm.elements.serverId.value,
    name: el.serviceForm.elements.name.value,
    url: el.serviceForm.elements.url.value,
    description: el.serviceForm.elements.description.value,
    category: el.serviceForm.elements.category.value,
    iconUrl: el.serviceForm.elements.iconUrl.value,
    healthUrl: el.serviceForm.elements.healthUrl.value,
    checkMethod: el.serviceForm.elements.checkMethod.value,
    pinned: el.serviceForm.elements.pinned.checked,
    notes: el.serviceForm.elements.notes.value,
    credentials,
    links,
  };
  const isEdit = Boolean(payload.id);
  await api(isEdit ? `/api/services/${payload.id}` : '/api/services', {
    method: isEdit ? 'PUT' : 'POST',
    body: JSON.stringify(payload),
  });
  await loadState();
  closeDialog(el.serviceModal);
  await refreshStatuses();
  render();
}

async function logout() {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
}

async function exportStateFile() {
  const response = await fetch('/api/export');
  const payload = await response.json();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'portal-state.json';
  link.click();
  URL.revokeObjectURL(url);
}

async function importStateFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    await api('/api/import', { method: 'POST', body: JSON.stringify(parsed) });
    await loadState();
    await refreshStatuses();
    render();
  } catch (error) {
    window.alert(`Import failed: ${error.message}`);
  } finally {
    event.target.value = '';
  }
}

async function refreshDiscovery() {
  el.discoveryStatus.textContent = 'Сканирование Docker...';
  const response = await fetch('/api/discovery/docker');
  const payload = await response.json();
  state.discoveryItems = payload.containers || [];
  if (!payload.available) {
    el.discoveryStatus.textContent = payload.error || 'Docker autodiscovery недоступен';
    el.discoveryList.innerHTML = '';
    return;
  }
  el.discoveryStatus.textContent = `Найдено контейнеров: ${state.discoveryItems.length}`;
  el.discoveryList.innerHTML = state.discoveryItems.map((item) => `
    <label class="discovery-item glass">
      <div class="discovery-row">
        <span><input type="checkbox" data-discovery-id="${escapeHtml(item.id)}" /> ${escapeHtml(item.name)}</span>
        <span class="muted small">${escapeHtml(item.image)}</span>
      </div>
      <div class="muted small">${escapeHtml(item.description || '')}</div>
      <div class="muted small">internal: ${escapeHtml(item.internalUrl || '-')}</div>
      <div class="muted small">published: ${escapeHtml(item.url || '-')}</div>
    </label>
  `).join('');
}

async function importSelectedDiscovery() {
  const checkedIds = [...el.discoveryList.querySelectorAll('[data-discovery-id]:checked')].map((item) => item.dataset.discoveryId);
  const items = state.discoveryItems.filter((item) => checkedIds.includes(item.id));
  if (!items.length) {
    window.alert('Ничего не выбрано');
    return;
  }
  await api('/api/discovery/import', {
    method: 'POST',
    body: JSON.stringify({ serverId: el.discoveryServerSelect.value, items }),
  });
  await loadState();
  await refreshStatuses();
  render();
  closeDialog(el.discoveryModal);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(payload.error || 'Request failed');
  }
  return response;
}

function getFaviconUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return '';
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function openDialog(dialog) { dialog.showModal(); }
function closeDialog(dialog) { dialog.close(); }
function closeClosestDialog(node) { node.closest('dialog')?.close(); }

function handleFatal(error) {
  console.error(error);
  document.body.innerHTML = `<pre style="padding:20px;color:white">${escapeHtml(error.stack || error.message)}</pre>`;
}
