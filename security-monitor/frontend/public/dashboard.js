'use strict';

(() => {
  const loginScreen = document.getElementById('loginScreen');
  const dashboard = document.getElementById('dashboard');
  const pageContent = document.getElementById('pageContent');
  const toastNode = document.getElementById('toast');
  const apiBaseUrl = String(window.SECURITY_MONITOR_API_URL || '').replace(/\/+$/, '');
  const state = { user: null, view: 'overview', page: 1, timer: null, range: '1h' };
  const labels = {
    overview: 'Overview',
    traffic: 'Live traffic',
    events: 'Security events',
    'failed-logins': 'Failed logins',
    alerts: 'Alerts',
    blocked: 'Blocked IPs',
    settings: 'Detection settings',
    audit: 'Audit log',
  };
  let toastTimer;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  async function api(path, options) {
    const request = options || {};
    const headers = { 'X-Requested-With': 'SecurityMonitor' };
    if (request.body !== undefined) headers['Content-Type'] = 'application/json';
    const response = await fetch(`${apiBaseUrl}${path}`, {
      method: request.method || 'GET',
      credentials: 'include',
      headers,
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401 && state.user) signOut(false);
      const error = new Error(data.error && data.error.message || data.message || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function toast(message, error) {
    toastNode.textContent = message;
    toastNode.classList.toggle('error', !!error);
    toastNode.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastNode.classList.remove('show'), 3500);
  }

  function number(value) {
    return new Intl.NumberFormat().format(Number(value || 0));
  }

  function date(value) {
    if (!value) return '—';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString();
  }

  function badge(value) {
    const label = String(value || '—');
    const className = label.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    return `<span class="badge ${className}">${escapeHtml(label)}</span>`;
  }

  function table(headers, rows, emptyMessage) {
    if (!rows.length) return `<div class="empty">${escapeHtml(emptyMessage || 'No records found.')}</div>`;
    return `<div class="table-wrap"><table><thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function heading(title, subtitle, extra) {
    return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle || '')}</p></div>${extra || ''}</div>`;
  }

  function panel(title, subtitle, content, action) {
    return `<section class="panel"><div class="panel-head"><div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}</div>${action || ''}</div>${content}</section>`;
  }

  function isAnalyst() {
    return state.user && ['analyst', 'admin'].includes(state.user.role);
  }

  function isAdmin() {
    return state.user && state.user.role === 'admin';
  }

  function setSession(user) {
    state.user = user;
    loginScreen.hidden = !!user;
    dashboard.hidden = !user;
    if (!user) {
      clearInterval(state.timer);
      state.timer = null;
      return;
    }
    document.getElementById('userName').textContent = user.username;
    document.getElementById('userRole').textContent = user.role;
    document.getElementById('userInitial').textContent = (user.username || 'A').slice(0, 1).toUpperCase();
    document.querySelectorAll('.admin-only').forEach((node) => { node.hidden = !isAdmin(); });
    loadView('overview');
    clearInterval(state.timer);
    state.timer = setInterval(() => {
      if (state.view === 'overview' || state.view === 'traffic') loadView(state.view, true);
    }, 5000);
  }

  function updateNav() {
    document.getElementById('pageName').textContent = labels[state.view] || 'Overview';
    document.querySelectorAll('.nav-item').forEach((button) => {
      button.classList.toggle('active', button.dataset.view === state.view);
    });
  }

  async function loadView(view, quiet) {
    if (!state.user) return;
    state.view = view;
    updateNav();
    if (!quiet) pageContent.innerHTML = '<div class="loading">Loading security data…</div>';
    try {
      if (view === 'overview') await renderOverview();
      else if (view === 'traffic') await renderTraffic();
      else if (view === 'events') await renderEvents();
      else if (view === 'failed-logins') await renderFailedLogins();
      else if (view === 'alerts') await renderAlerts();
      else if (view === 'blocked') await renderBlocked();
      else if (view === 'settings') await renderSettings();
      else if (view === 'audit') await renderAudit();
      document.getElementById('lastUpdated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (!quiet) pageContent.innerHTML = `<section class="panel empty">${escapeHtml(error.message)}<br><button class="button" data-action="retry">Try again</button></section>`;
    }
  }

  function statCard(label, value, note, tone) {
    return `<div class="stat-card"><span class="stat-label">${escapeHtml(label)}</span><strong class="stat-value ${tone || ''}">${escapeHtml(value)}</strong><span class="stat-note">${escapeHtml(note || '')}</span></div>`;
  }

  function chart(series) {
    const points = (series || []).slice(-18);
    const max = Math.max(1, ...points.map((point) => Number(point.requests || 0)));
    if (!points.length) return '<div class="empty">Traffic history will appear here as requests arrive.</div>';
    return `<div class="chart" role="img" aria-label="Recent request volume">${points.map((point) => {
      const requestHeight = Math.max(2, Math.round(Number(point.requests || 0) / max * 100));
      const alertHeight = point.suspicious ? Math.max(3, Math.round(Number(point.suspicious) / max * 100)) : 0;
      const time = new Date(point.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      return `<div class="chart-column ${alertHeight ? 'alert' : ''}" title="${escapeHtml(`${time}: ${point.requests} requests, ${point.suspicious} suspicious`)}"><progress class="chart-bar" max="100" value="${requestHeight}" aria-label="${escapeHtml(`${point.requests} requests`)}"></progress><span class="chart-time">${escapeHtml(time)}</span></div>`;
    }).join('')}</div><div class="legend"><span><i></i>Requests</span><span><i class="red-dot"></i>Suspicious activity</span></div>`;
  }

  function quickRows(items, label, valueKey) {
    if (!items || !items.length) return '<div class="empty">No activity yet.</div>';
    return `<div class="panel-body quick-list">${items.map((item) => `<div class="quick-row"><code>${escapeHtml(item[label])}</code><span class="quick-value">${escapeHtml(number(item[valueKey]))}</span></div>`).join('')}</div>`;
  }

  function trafficRows(items) {
    return (items || []).map((item) => `<tr><td>${escapeHtml(date(item.ts))}</td><td><code>${escapeHtml(item.ip)}</code></td><td>${escapeHtml(item.method)}</td><td><code>${escapeHtml(item.endpoint)}</code></td><td>${escapeHtml(item.status)}</td><td>${escapeHtml(`${item.ms || 0} ms`)}</td><td>${item.suspicious ? badge('Suspicious') : item.blocked ? badge('Blocked') : '—'}</td></tr>`);
  }

  async function renderOverview() {
    const [stats, traffic, recent, ips, endpoints, alerts] = await Promise.all([
      api('/api/security/stats?range=1h'),
      api('/api/security/traffic?range=1h'),
      api('/api/security/recent-traffic?limit=8'),
      api('/api/security/top-ips?range=1h&limit=5'),
      api('/api/security/endpoints?range=1h&limit=5'),
      api('/api/security/alerts?status=OPEN&page=1&pageSize=5'),
    ]);
    document.getElementById('navAlertCount').textContent = number(stats.openAlerts);
    document.getElementById('navAlertCount').hidden = !stats.openAlerts;
    const summary = `<div class="stat-grid">${statCard('Requests · 1 hour', number(stats.totalRequests), `${number(stats.rpm)} req/min`)}${statCard('Suspicious requests', number(stats.suspiciousRequests), 'Flagged by detection rules', stats.suspiciousRequests ? 'tone-red' : '')}${statCard('Failed logins', number(stats.failedLogins), 'Across monitored IPs', stats.failedLogins ? 'tone-yellow' : '')}${statCard('Open alerts', number(stats.openAlerts), stats.openAlerts ? 'Review recommended' : 'No open alerts', stats.openAlerts ? 'tone-yellow' : 'tone-green')}${statCard('Temporary blocks', number(stats.blockedIps), 'Active now')}${statCard('Avg. response', `${number(stats.avgResponseMs)} ms`, 'Normal requests')}</div>`;
    const chartPanel = panel('Request volume', 'Requests and detections over the last hour', `<div class="panel-body">${chart(traffic.series)}</div>`);
    const alertRows = (alerts.items || []).map((item) => `<div class="quick-row"><div><strong>${escapeHtml(item.title)}</strong><span class="subline">${escapeHtml(item.ip)} · ${escapeHtml(date(item.timestamp))}</span></div>${badge(item.severity)}</div>`);
    const recentPanel = panel('Open alerts', 'Latest detections needing review', `<div class="panel-body quick-list">${alertRows.length ? alertRows.join('') : '<div class="empty">No open alerts.</div>'}</div>`, '<button class="button quiet" data-view="alerts">View all</button>');
    const ipPanel = panel('Top source IPs', 'Most active in the last hour', quickRows(ips.items, 'ip', 'count'));
    const endpointsPanel = panel('Top endpoints', 'Request volume by normalized route', quickRows(endpoints.items, 'endpoint', 'requests'));
    const recentPanel2 = panel('Recent traffic', 'Latest requests captured by the monitor', table(['Time', 'Source IP', 'Method', 'Endpoint', 'Status', 'Duration', 'Signal'], trafficRows(recent.items), 'No requests received yet.'));
    pageContent.innerHTML = `${heading('Security overview', 'Live visibility into abusive traffic, authentication failures, and temporary blocks.', `<select id="rangeSelect" class="select" aria-label="Time range"><option value="15m">Last 15 minutes</option><option value="1h" selected>Last hour</option><option value="6h">Last 6 hours</option><option value="24h">Last 24 hours</option></select>`)}${summary}<div class="content-grid">${chartPanel}${recentPanel}</div><div class="content-grid">${ipPanel}${endpointsPanel}</div>${recentPanel2}`;
    document.getElementById('rangeSelect').addEventListener('change', async (event) => {
      state.range = event.target.value;
      try { await renderOverviewRange(); } catch (error) { toast(error.message, true); }
    });
  }

  async function renderOverviewRange() {
    const range = encodeURIComponent(state.range);
    const [stats, traffic, ips, endpoints] = await Promise.all([
      api(`/api/security/stats?range=${range}`),
      api(`/api/security/traffic?range=${range}`),
      api(`/api/security/top-ips?range=${range}&limit=5`),
      api(`/api/security/endpoints?range=${range}&limit=5`),
    ]);
    const summary = `<div class="stat-grid">${statCard('Requests', number(stats.totalRequests), `${number(stats.rpm)} req/min`)}${statCard('Suspicious requests', number(stats.suspiciousRequests), 'Flagged by detection rules', stats.suspiciousRequests ? 'tone-red' : '')}${statCard('Failed logins', number(stats.failedLogins), 'Across monitored IPs', stats.failedLogins ? 'tone-yellow' : '')}${statCard('Open alerts', number(stats.openAlerts), stats.openAlerts ? 'Review recommended' : 'No open alerts', stats.openAlerts ? 'tone-yellow' : 'tone-green')}${statCard('Temporary blocks', number(stats.blockedIps), 'Active now')}${statCard('Avg. response', `${number(stats.avgResponseMs)} ms`, 'Normal requests')}</div>`;
    const content = pageContent;
    const old = content.querySelector('.stat-grid');
    if (old) old.outerHTML = summary;
    const chartNode = content.querySelector('.chart')?.parentElement;
    if (chartNode) chartNode.innerHTML = chart(traffic.series);
    const panels = content.querySelectorAll('.content-grid');
    if (panels[1]) {
      const bodies = panels[1].querySelectorAll('.panel-body');
      if (bodies[0]) bodies[0].outerHTML = quickRows(ips.items, 'ip', 'count');
      if (bodies[1]) bodies[1].outerHTML = quickRows(endpoints.items, 'endpoint', 'requests');
    }
  }

  async function renderTraffic() {
    const [traffic, recent] = await Promise.all([
      api(`/api/security/traffic?range=${encodeURIComponent(state.range)}`),
      api('/api/security/recent-traffic?limit=100'),
    ]);
    pageContent.innerHTML = `${heading('Live traffic', 'Recent inbound requests with source, response, and detection status.', `<select id="trafficRange" class="select"><option value="15m">15 minutes</option><option value="1h">1 hour</option><option value="6h">6 hours</option><option value="24h">24 hours</option></select>`)}<div class="stat-grid">${statCard('Requests', number(traffic.totals.requests), 'Selected period')}${statCard('Suspicious', number(traffic.totals.suspicious), 'Detection rule matches', traffic.totals.suspicious ? 'tone-red' : '')}${statCard('Failed logins', number(traffic.totals.failedLogins), 'Selected period', traffic.totals.failedLogins ? 'tone-yellow' : '')}${statCard('Peak requests/min', number(traffic.peakRpm), 'Highest completed minute')}${statCard('4xx responses', number(traffic.totals.status['4xx']), 'Client errors')}${statCard('5xx responses', number(traffic.totals.status['5xx']), 'Server errors')}</div>${panel('Recent requests', 'Requests are normalized to route templates where available.', table(['Time', 'Source IP', 'Method', 'Endpoint', 'Status', 'Duration', 'Signal'], trafficRows(recent.items), 'No requests received yet.'))}`;
    const range = document.getElementById('trafficRange');
    range.value = state.range;
    range.addEventListener('change', (event) => { state.range = event.target.value; loadView('traffic'); });
  }

  function queryString(values) {
    return new URLSearchParams(values).toString();
  }

  function eventRows(items) {
    return (items || []).map((item) => `<tr><td>${escapeHtml(date(item.timestamp))}</td><td><code>${escapeHtml(item.ip)}</code></td><td>${escapeHtml(item.eventType)}</td><td>${badge(item.severity)}</td><td><code>${escapeHtml(item.endpoint || '—')}</code><span class="description">${escapeHtml(item.description)}</span></td><td>${badge(item.action)}</td></tr>`);
  }

  async function renderEvents() {
    const q = state.search || '';
    const data = await api(`/api/security/events?${queryString({ page: state.page, pageSize: 25, q })}`);
    pageContent.innerHTML = `${heading('Security events', 'Rule detections and authentication audit events.')}<section class="panel"><div class="toolbar"><form id="searchForm"><input class="input" name="q" value="${escapeHtml(q)}" placeholder="Search events" maxlength="100"><button class="button" type="submit">Search</button></form><span class="muted small">${number(data.total)} events</span></div>${table(['Time', 'Source IP', 'Event', 'Severity', 'Details', 'Action'], eventRows(data.items), 'No security events match this filter.')}${pager(data)}</section>`;
    bindPager();
    document.getElementById('searchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      state.search = new FormData(event.currentTarget).get('q');
      state.page = 1;
      loadView('events');
    });
  }

  async function renderFailedLogins() {
    const data = await api(`/api/security/failed-logins?${queryString({ page: state.page, pageSize: 25 })}`);
    const rows = (data.items || []).map((item) => `<tr><td>${escapeHtml(date(item.timestamp))}</td><td><code>${escapeHtml(item.ip)}</code></td><td><code>${escapeHtml(item.endpoint || '/api/auth/login')}</code></td><td>${badge(item.severity)}</td><td><span class="description">${escapeHtml(item.description)}</span></td><td>${badge(item.action)}</td></tr>`);
    pageContent.innerHTML = `${heading('Failed logins', 'Authentication failures grouped into low-noise alerts; account IDs are never shown as raw emails.')}<section class="panel">${table(['Time', 'Source IP', 'Endpoint', 'Severity', 'Details', 'Action'], rows, 'No failed login events recorded.')}${pager(data)}</section>`;
    bindPager();
  }

  async function renderAlerts() {
    const status = state.alertStatus || 'OPEN';
    const data = await api(`/api/security/alerts?${queryString({ page: state.page, pageSize: 25, status })}`);
    const rows = (data.items || []).map((item) => `<tr><td>${escapeHtml(date(item.timestamp))}</td><td><strong>${escapeHtml(item.title)}</strong><span class="subline">${escapeHtml(item.rule)}</span></td><td><code>${escapeHtml(item.ip)}</code></td><td>${badge(item.severity)}</td><td><span class="description">${escapeHtml(item.message)}</span></td><td>${badge(item.status)}</td><td>${item.status === 'OPEN' && isAnalyst() ? `<button class="button" data-action="resolve-alert" data-id="${escapeHtml(item.id)}">Resolve</button>` : escapeHtml(item.resolvedBy || '—')}</td></tr>`);
    pageContent.innerHTML = `${heading('Alerts', 'Review and triage detections. Resolving an alert records an audit event.')}<section class="panel"><div class="toolbar"><div class="heading-actions"><button class="button ${status === 'OPEN' ? 'primary' : ''}" data-action="alert-status" data-status="OPEN">Open</button><button class="button ${status === 'RESOLVED' ? 'primary' : ''}" data-action="alert-status" data-status="RESOLVED">Resolved</button></div><span class="muted small">${number(data.total)} alerts</span></div>${table(['Time', 'Alert', 'Source IP', 'Severity', 'Details', 'Status', 'Triage'], rows, `No ${status.toLowerCase()} alerts.`)}${pager(data)}</section>`;
    bindPager();
  }

  async function renderBlocked() {
    const data = await api(`/api/security/blocked-ips?${queryString({ status: state.blockStatus || 'active', page: state.page, pageSize: 25 })}`);
    const rows = (data.items || []).map((item) => `<tr><td><code>${escapeHtml(item.ip)}</code></td><td>${escapeHtml(item.reason)}</td><td>${badge(item.source)}</td><td>${escapeHtml(date(item.detectedAt))}</td><td>${escapeHtml(item.status === 'ACTIVE' ? `${Math.ceil(item.remainingSeconds / 60)} min remaining` : date(item.expiresAt))}</td><td>${badge(item.status)}</td><td>${isAdmin() && item.status === 'ACTIVE' ? `<button class="button danger" data-action="unblock" data-ip="${escapeHtml(item.ip)}">Unblock</button>` : '—'}</td></tr>`);
    const form = isAdmin() ? `<form id="blockForm" class="inline-form"><input class="input" name="ip" placeholder="IP address" required maxlength="64"><input class="input" name="minutes" type="number" min="1" max="1440" placeholder="Minutes"><input class="input" name="reason" placeholder="Reason" required minlength="3" maxlength="200"><button class="button primary" type="submit">Block IP</button></form>` : '';
    pageContent.innerHTML = `${heading('Blocked IPs', 'Temporary blocks only. Loopback and private addresses are allowlisted.')}<section class="panel">${form}<div class="toolbar"><button class="button" data-action="block-status">${(state.blockStatus || 'active') === 'active' ? 'Show history' : 'Show active only'}</button><span class="muted small">${number(data.total)} records</span></div>${table(['IP address', 'Reason', 'Source', 'Detected', 'Expiry', 'Status', 'Action'], rows, 'No matching block records.')}${pager(data)}</section>`;
    bindPager();
    const blockForm = document.getElementById('blockForm');
    if (blockForm) blockForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const formData = new FormData(blockForm);
      try {
        await api('/api/security/blocked-ips', {
          method: 'POST',
          body: {
            ip: formData.get('ip'),
            minutes: formData.get('minutes') ? Number(formData.get('minutes')) : undefined,
            reason: formData.get('reason'),
          },
        });
        toast('Temporary IP block created.');
        loadView('blocked');
      } catch (error) { toast(error.message, true); }
    });
  }

  async function renderSettings() {
    if (!isAdmin()) throw new Error('Administrator access is required.');
    const settings = await api('/api/security/settings');
    pageContent.innerHTML = `${heading('Detection settings', 'Advanced JSON editor for detection thresholds, allowlists, and data retention.')}<div class="settings-warning">Changes affect live detections. Keep the configured thresholds conservative to avoid blocking legitimate users.</div><section class="panel"><div class="panel-body"><textarea id="settingsEditor" class="textarea" spellcheck="false" aria-label="Detection settings JSON">${escapeHtml(JSON.stringify(settings, null, 2))}</textarea><div class="heading-actions settings-actions"><button class="button" data-action="reload-settings">Discard changes</button><button class="button primary" data-action="save-settings">Save settings</button></div></div></section>`;
  }

  async function renderAudit() {
    if (!isAdmin()) throw new Error('Administrator access is required.');
    const data = await api(`/api/security/audit-logs?${queryString({ page: state.page, pageSize: 25 })}`);
    const rows = (data.items || []).map((item) => `<tr><td>${escapeHtml(date(item.timestamp))}</td><td>${escapeHtml(item.adminUsername || 'system')}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.target || '—')}</td><td><code>${escapeHtml(item.ip || '—')}</code></td><td><span class="description">${escapeHtml(JSON.stringify(item.details || {}))}</span></td></tr>`);
    pageContent.innerHTML = `${heading('Audit log', 'Administrative actions in the security monitor.')}<section class="panel">${table(['Time', 'Admin', 'Action', 'Target', 'Source IP', 'Details'], rows, 'No administrative actions recorded.')}${pager(data)}</section>`;
    bindPager();
  }

  function pager(data) {
    const pages = Math.max(1, Math.ceil(Number(data.total || 0) / Number(data.pageSize || 25)));
    return `<div class="pager"><span>Page ${number(data.page || 1)} of ${number(pages)} · ${number(data.total)} records</span><span class="heading-actions"><button class="button" data-action="page" data-page="${Math.max(1, state.page - 1)}" ${state.page <= 1 ? 'disabled' : ''}>Previous</button><button class="button" data-action="page" data-page="${Math.min(pages, state.page + 1)}" ${state.page >= pages ? 'disabled' : ''}>Next</button></span></div>`;
  }

  function bindPager() {
    pageContent.querySelectorAll('[data-action="page"]').forEach((button) => {
      button.addEventListener('click', () => {
        state.page = Number(button.dataset.page);
        loadView(state.view);
      });
    });
  }

  async function signOut(callApi) {
    if (callApi !== false) {
      try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch (error) { /* Clear local view even if the session expired. */ }
    }
    setSession(null);
  }

  document.getElementById('loginForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const errorNode = document.getElementById('loginError');
    errorNode.textContent = '';
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: { username: data.get('username'), password: data.get('password') },
      });
      form.reset();
      setSession(result.user);
    } catch (error) {
      errorNode.textContent = error.message;
    }
  });

  document.getElementById('navigation').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) {
      state.page = 1;
      loadView(button.dataset.view);
    }
  });
  document.getElementById('adminNavigation').addEventListener('click', (event) => {
    const button = event.target.closest('[data-view]');
    if (button) {
      state.page = 1;
      loadView(button.dataset.view);
    }
  });
  document.getElementById('logoutButton').addEventListener('click', () => signOut(true));
  document.getElementById('refreshButton').addEventListener('click', () => loadView(state.view));

  pageContent.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    try {
      if (button.dataset.action === 'retry') await loadView(state.view);
      if (button.dataset.action === 'resolve-alert') {
        await api(`/api/security/alerts/${encodeURIComponent(button.dataset.id)}/resolve`, { method: 'POST', body: {} });
        toast('Alert resolved.');
        await loadView('alerts');
      }
      if (button.dataset.action === 'alert-status') {
        state.alertStatus = button.dataset.status;
        state.page = 1;
        await loadView('alerts');
      }
      if (button.dataset.action === 'unblock') {
        await api(`/api/security/blocked-ips/${encodeURIComponent(button.dataset.ip)}`, { method: 'DELETE' });
        toast('IP unblocked.');
        await loadView('blocked');
      }
      if (button.dataset.action === 'block-status') {
        state.blockStatus = (state.blockStatus || 'active') === 'active' ? 'all' : 'active';
        state.page = 1;
        await loadView('blocked');
      }
      if (button.dataset.action === 'reload-settings') await loadView('settings');
      if (button.dataset.action === 'save-settings') {
        const settings = JSON.parse(document.getElementById('settingsEditor').value);
        await api('/api/security/settings', { method: 'PUT', body: settings });
        toast('Settings saved. New thresholds apply shortly.');
        await loadView('settings');
      }
    } catch (error) { toast(error.message, true); }
  });

  async function init() {
    loginScreen.hidden = true;
    dashboard.hidden = true;
    try {
      const result = await api('/api/auth/me');
      setSession(result.user);
    } catch (error) {
      setSession(null);
      if (error.status !== 401) document.getElementById('loginError').textContent = error.message;
    }
  }

  init();
})();
