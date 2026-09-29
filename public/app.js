function showToast(message, type) {
  type = type || 'success';
  const toast = document.getElementById('toast');
  const toastMessage = document.getElementById('toastMessage');
  if (!toast || !toastMessage) return;
  toastMessage.textContent = message;
  toast.className = 'toast ' + type;
  toast.classList.add('show');
  setTimeout(function () {
    toast.classList.remove('show');
  }, 3000);
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function getApiKey() {
  const el = document.getElementById('apiKeyInput');
  return el ? el.value.trim() : '';
}

let botApps = [];
let selectedApps = new Set();
let editingConfigApp = null;
let editingConfigKey = null;

const venomBtn = document.getElementById('venomBtn');
const managerBtn = document.getElementById('managerBtn');
const venomSection = document.getElementById('venomSection');
const managerSection = document.getElementById('managerSection');

function setActiveTab(active) {
  if (!venomBtn || !managerBtn || !venomSection || !managerSection) return;
  venomBtn.classList.remove('active');
  managerBtn.classList.remove('active');
  if (active === 'deploy') {
    venomBtn.classList.add('active');
    venomSection.style.display = 'block';
    managerSection.style.display = 'none';
  } else {
    managerBtn.classList.add('active');
    managerSection.style.display = 'block';
    venomSection.style.display = 'none';
  }
}

if (venomBtn && managerBtn) {
  setActiveTab('deploy');
  venomBtn.addEventListener('click', function (e) {
    e.preventDefault();
    setActiveTab('deploy');
  });
  managerBtn.addEventListener('click', function (e) {
    e.preventDefault();
    setActiveTab('manage');
  });
}

const loadAppsBtn = document.getElementById('loadAppsBtn');
if (loadAppsBtn) {
  loadAppsBtn.addEventListener('click', async function () {
    const apiKey = getApiKey();
    if (!apiKey) {
      showToast('Please enter Heroku API key', 'error');
      return;
    }

    const loading = document.getElementById('loadingApps');
    const appsContainer = document.getElementById('appsContainer');
    loading.style.display = 'block';
    appsContainer.style.display = 'none';
    selectedApps.clear();

    try {
      const response = await axios.post('/api/manager/bot-apps', { herokuApiKey: apiKey });
      if (response.data.success) {
        botApps = response.data.apps;
        renderBotApps();
        showToast('Loaded ' + botApps.length + ' app(s)');
      } else {
        showToast(response.data.error || 'Failed to load apps', 'error');
      }
    } catch (error) {
      const msg = error.response && error.response.data && error.response.data.error
        ? error.response.data.error
        : 'Connection error';
      showToast(msg, 'error');
    } finally {
      loading.style.display = 'none';
    }
  });
}

function renderBotApps() {
  const grid = document.getElementById('appsGrid');
  const selectAllBar = document.getElementById('selectAllBar');
  const appsContainer = document.getElementById('appsContainer');

  if (botApps.length === 0) {
    grid.innerHTML = '<div class="empty-state"><i class="fas fa-robot"></i><p>No apps found</p></div>';
    selectAllBar.style.display = 'none';
  } else {
    grid.innerHTML = botApps.map(function (app) {
      return (
        '<div class="app-card">' +
          '<div class="app-header">' +
            '<div class="app-info">' +
              '<div class="app-name">' + escapeHtml(app.name) + '</div>' +
              '<div class="app-url">' + (app.web_url ? escapeHtml(app.web_url) : 'No URL') + '</div>' +
            '</div>' +
            '<input type="checkbox" class="app-checkbox" data-app="' + escapeHtml(app.name) + '" data-url="' + escapeHtml(app.web_url || '') + '" onchange="toggleAppSelection(this.dataset.app, this.checked)">' +
          '</div>' +
          '<div class="app-actions">' +
            '<button class="btn-sm btn-purple" onclick="showAppConfig(\'' + escapeHtml(app.name) + '\')"><i class="fas fa-cog"></i> Config</button>' +
          '</div>' +
        '</div>'
      );
    }).join('');
    selectAllBar.style.display = 'flex';
  }

  appsContainer.style.display = 'block';
  const selectAll = document.getElementById('selectAllApps');
  if (selectAll) selectAll.checked = false;
}

function toggleAppSelection(appName, checked) {
  if (checked) selectedApps.add(appName);
  else selectedApps.delete(appName);

  const checkboxes = document.querySelectorAll('.app-checkbox');
  const allChecked = checkboxes.length > 0 && Array.from(checkboxes).every(function (cb) { return cb.checked; });
  const selectAll = document.getElementById('selectAllApps');
  if (selectAll) selectAll.checked = allChecked;
}

const selectAllApps = document.getElementById('selectAllApps');
if (selectAllApps) {
  selectAllApps.addEventListener('change', function () {
    const checkboxes = document.querySelectorAll('.app-checkbox');
    const self = this;
    checkboxes.forEach(function (cb) {
      cb.checked = self.checked;
      const appName = cb.dataset.app;
      if (self.checked) selectedApps.add(appName);
      else selectedApps.delete(appName);
    });
  });
}

function copySelectedUrls() {
  const selected = Array.from(selectedApps);
  if (selected.length === 0) {
    showToast('No apps selected', 'error');
    return;
  }

  const lines = [];
  let index = 1;
  selected.forEach(function (appName) {
    const app = botApps.find(function (a) { return a.name === appName; });
    if (app && app.web_url) {
      let url = app.web_url;
      if (url.endsWith('/')) url = url.slice(0, -1);
      lines.push('"server' + index + '": "' + url + '"');
      index += 1;
    }
  });

  if (lines.length === 0) {
    showToast('No valid URLs found', 'error');
    return;
  }

  const plainText = lines.join(',\n  ');
  document.getElementById('urlPreview').textContent = plainText;
  document.getElementById('copyCount').textContent = selected.length;
  document.getElementById('copyModal').style.display = 'flex';
  window.pendingCopyText = plainText;
}

function closeCopyModal() {
  document.getElementById('copyModal').style.display = 'none';
  window.pendingCopyText = null;
}

async function confirmCopyUrls() {
  const text = window.pendingCopyText;
  if (!text) {
    closeCopyModal();
    return;
  }

  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied ' + document.getElementById('copyCount').textContent + ' URL(s)');
    closeCopyModal();
  } catch (err) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showToast('Copied ' + document.getElementById('copyCount').textContent + ' URL(s)');
    closeCopyModal();
  }
}

function restartSelectedApps() {
  const apps = Array.from(selectedApps);
  if (apps.length === 0) {
    showToast('No apps selected', 'error');
    return;
  }
  document.getElementById('restartCount').textContent = apps.length;
  document.getElementById('restartModal').style.display = 'flex';
  window.pendingRestartApps = apps;
}

function closeRestartModal() {
  document.getElementById('restartModal').style.display = 'none';
  window.pendingRestartApps = null;
}

async function confirmRestart() {
  const apps = window.pendingRestartApps;
  if (!apps || apps.length === 0) {
    closeRestartModal();
    return;
  }

  const apiKey = getApiKey();
  closeRestartModal();
  showToast('Restarting ' + apps.length + ' app(s)...', 'warning');

  try {
    const githubEl = document.getElementById('githubRepo');
    const githubRepo = githubEl ? githubEl.value.trim() : '';
    const response = await axios.post('/api/manager/restart-bot-apps', {
      herokuApiKey: apiKey,
      appNames: apps,
      githubRepo: githubRepo
    }, { timeout: 900000 });
    if (response.data.success) {
      showToast(response.data.message);
      setTimeout(function () { document.getElementById('loadAppsBtn').click(); }, 2000);
    } else {
      showToast(response.data.error || response.data.message || 'Failed to restart', 'error');
    }
  } catch (error) {
    showToast('Failed to restart apps', 'error');
  }
}

function deleteSelectedApps() {
  const apps = Array.from(selectedApps);
  if (apps.length === 0) {
    showToast('No apps selected', 'error');
    return;
  }
  document.getElementById('deleteCount').textContent = apps.length;
  document.getElementById('deleteModal').style.display = 'flex';
  window.pendingDeleteApps = apps;
}

function closeDeleteModal() {
  document.getElementById('deleteModal').style.display = 'none';
  window.pendingDeleteApps = null;
}

async function confirmDelete() {
  const apps = window.pendingDeleteApps;
  if (!apps || apps.length === 0) {
    closeDeleteModal();
    return;
  }

  const apiKey = getApiKey();
  closeDeleteModal();
  showToast('Deleting ' + apps.length + ' app(s)...', 'warning');

  try {
    const response = await axios.post('/api/manager/delete-bot-apps', {
      herokuApiKey: apiKey,
      appNames: apps
    });
    if (response.data.success) {
      showToast(response.data.message);
      setTimeout(function () { document.getElementById('loadAppsBtn').click(); }, 1000);
    } else {
      showToast(response.data.error || response.data.message || 'Failed to delete', 'error');
    }
  } catch (error) {
    showToast('Failed to delete apps', 'error');
  }
}

async function showAppConfig(appName) {
  const modal = document.getElementById('configModal');
  const content = document.getElementById('configContent');
  const apiKey = getApiKey();

  if (!apiKey) {
    showToast('API key required', 'error');
    return;
  }

  modal.style.display = 'flex';
  content.innerHTML = '<div class="loading" style="display:block;"><div class="spinner"></div><p>Loading config for ' + escapeHtml(appName) + '...</p></div>';

  try {
    const response = await axios.get('/manage/' + encodeURIComponent(appName), {
      params: { herokuApiKey: apiKey }
    });
    if (response.data.success) {
      renderConfig(response.data.config, appName);
    } else {
      content.innerHTML = '<p style="color:#d0a0a0;padding:20px;">Failed to load config</p>';
    }
  } catch (error) {
    const msg = error.response && error.response.data && error.response.data.error
      ? error.response.data.error
      : 'Connection error';
    content.innerHTML = '<p style="color:#d0a0a0;padding:20px;">' + escapeHtml(msg) + '</p>';
  }
}

function renderConfig(config, appName) {
  const content = document.getElementById('configContent');
  const keys = Object.keys(config);
  editingConfigApp = appName;

  let html =
    '<p style="color:rgba(255,255,255,0.6);font-size:13px;margin-bottom:15px;text-align:left;">' +
      '<i class="fas fa-server"></i> <strong style="color:#c8c8c8;">' + escapeHtml(appName) + '</strong> - ' + keys.length + ' variables' +
    '</p>' +
    '<div style="text-align:left;margin-bottom:15px;">' +
      '<div class="add-config-row">' +
        '<input type="text" id="addConfigKey" placeholder="Aman TechX" style="flex:1;">' +
        '<input type="text" id="addConfigValue" placeholder="Aman TechX" style="flex:1;">' +
        '<button class="btn-sm btn-success" onclick="addConfigVar()"><i class="fas fa-plus"></i> Add</button>' +
      '</div>' +
    '</div>' +
    '<div id="configList">';

  if (keys.length === 0) {
    html += '<p style="color:rgba(255,255,255,0.5);padding:20px;text-align:center;">No config variables found</p>';
  } else {
    keys.forEach(function (key) {
      const value = config[key] || '';
      html +=
        '<div class="config-item-inline">' +
          '<span class="config-key">' + escapeHtml(key) + '</span>' +
          '<span class="config-value">' + escapeHtml(String(value)) + '</span>' +
          '<div class="config-actions">' +
            '<button class="config-edit-btn" data-key="' + encodeURIComponent(key) + '" data-value="' + encodeURIComponent(String(value)) + '" onclick="openEditConfig(decodeURIComponent(this.dataset.key), decodeURIComponent(this.dataset.value))"><i class="fas fa-edit"></i></button>' +
            '<button class="config-delete-btn" data-key="' + encodeURIComponent(key) + '" onclick="deleteConfigVar(decodeURIComponent(this.dataset.key))"><i class="fas fa-trash"></i></button>' +
          '</div>' +
        '</div>';
    });
  }

  html += '</div>';
  content.innerHTML = html;
}

async function addConfigVar() {
  const key = document.getElementById('addConfigKey').value.trim();
  const value = document.getElementById('addConfigValue').value.trim();
  const apiKey = getApiKey();

  if (!key) {
    showToast('Please enter a key', 'error');
    return;
  }
  if (!apiKey) {
    showToast('API key required', 'error');
    return;
  }

  try {
    const configVars = {};
    configVars[key] = value;
    await axios.put('/manage/' + encodeURIComponent(editingConfigApp) + '/config', {
      configVars: configVars,
      apiKey: apiKey
    });
    showToast('Added ' + key);
    document.getElementById('addConfigKey').value = '';
    document.getElementById('addConfigValue').value = '';
    showAppConfig(editingConfigApp);
  } catch (error) {
    const msg = error.response && error.response.data && error.response.data.error
      ? error.response.data.error
      : 'Failed to add config';
    showToast(msg, 'error');
  }
}

async function deleteConfigVar(key) {
  const apiKey = getApiKey();
  if (!apiKey) {
    showToast('API key required', 'error');
    return;
  }
  if (!confirm('Delete "' + key + '"?')) return;

  try {
    const configVars = {};
    configVars[key] = null;
    await axios.put('/manage/' + encodeURIComponent(editingConfigApp) + '/config', {
      configVars: configVars,
      apiKey: apiKey
    });
    showToast('Deleted ' + key);
    showAppConfig(editingConfigApp);
  } catch (error) {
    const msg = error.response && error.response.data && error.response.data.error
      ? error.response.data.error
      : 'Failed to delete';
    showToast(msg, 'error');
  }
}

function openEditConfig(key, value) {
  document.getElementById('editConfigKey').value = key;
  document.getElementById('editConfigValue').value = value;
  editingConfigKey = key;
  document.getElementById('editConfigModal').style.display = 'flex';
}

function closeEditConfig() {
  document.getElementById('editConfigModal').style.display = 'none';
  editingConfigKey = null;
}

async function saveConfigEdit() {
  const key = document.getElementById('editConfigKey').value;
  const value = document.getElementById('editConfigValue').value.trim();
  const apiKey = getApiKey();

  if (!apiKey) {
    showToast('API key required', 'error');
    return;
  }

  try {
    const configVars = {};
    configVars[key] = value;
    await axios.put('/manage/' + encodeURIComponent(editingConfigApp) + '/config', {
      configVars: configVars,
      apiKey: apiKey
    });
    showToast('Config updated successfully');
    closeEditConfig();
    showAppConfig(editingConfigApp);
  } catch (error) {
    const msg = error.response && error.response.data && error.response.data.error
      ? error.response.data.error
      : 'Failed to update config';
    showToast(msg, 'error');
  }
}

async function deleteConfigKey() {
  const key = document.getElementById('editConfigKey').value;
  const apiKey = getApiKey();

  if (!apiKey) {
    showToast('API key required', 'error');
    return;
  }
  if (!confirm('Delete "' + key + '"?')) return;

  try {
    const configVars = {};
    configVars[key] = null;
    await axios.put('/manage/' + encodeURIComponent(editingConfigApp) + '/config', {
      configVars: configVars,
      apiKey: apiKey
    });
    showToast('Config key deleted');
    closeEditConfig();
    showAppConfig(editingConfigApp);
  } catch (error) {
    const msg = error.response && error.response.data && error.response.data.error
      ? error.response.data.error
      : 'Failed to delete';
    showToast(msg, 'error');
  }
}

function closeConfigModal() {
  document.getElementById('configModal').style.display = 'none';
}

const venomForm = document.getElementById('venomForm');
if (venomForm) {
  const venomResults = document.getElementById('venomResults');
  const venomLoading = document.getElementById('venomLoading');
  const venomLoadingText = document.getElementById('venomLoadingText');
  const deployBtn = document.getElementById('deployBtn');

  const appCountInput = document.getElementById('appCount');
  const deployCountLabel = document.getElementById('deployCountLabel');
  function parseDeployCount(raw) {
    const n = parseInt(String(raw || '').replace(/\D/g, ''), 10);
    if (!Number.isFinite(n)) return 10;
    return Math.min(Math.max(n, 1), 100);
  }
  function updateDeployLabel() {
    if (!appCountInput || !deployCountLabel) return;
    const raw = String(appCountInput.value || '').replace(/\D/g, '');
    if (raw === '') {
      deployCountLabel.textContent = '1-100';
      return;
    }
    deployCountLabel.textContent = parseDeployCount(raw);
  }
  if (appCountInput) {
    appCountInput.value = '';
    appCountInput.setAttribute('placeholder', '1-100');
    appCountInput.addEventListener('input', function () {
      const cleaned = String(appCountInput.value || '').replace(/\D/g, '').slice(0, 3);
      appCountInput.value = cleaned;
      updateDeployLabel();
    });
    appCountInput.addEventListener('focus', function () {
      if (appCountInput.value === '10' && !appCountInput.dataset.touched) {
        appCountInput.value = '';
        updateDeployLabel();
      }
    });
    appCountInput.addEventListener('blur', function () {
      if (String(appCountInput.value || '').trim() === '') return;
      appCountInput.dataset.touched = '1';
      appCountInput.value = String(parseDeployCount(appCountInput.value));
      updateDeployLabel();
    });
    setTimeout(function () {
      if (!appCountInput.dataset.touched) {
        appCountInput.value = '';
        updateDeployLabel();
      }
    }, 50);
    updateDeployLabel();
  }

  venomForm.addEventListener('submit', async function (e) {
    e.preventDefault();

    const githubRepo = document.getElementById('githubRepo').value.trim();
    const herokuApiKey = document.getElementById('venomApiKey').value.trim();
    const baseAppName = document.getElementById('baseAppName').value.trim();
    const mongodbUrl = document.getElementById('mongodbUrl').value.trim();
    const dbName = document.getElementById('dbName').value.trim();
    const appCountRaw = String(document.getElementById('appCount').value || '').trim();
    if (!appCountRaw) {
      showToast('Enter number of apps (1-100)', 'error');
      return;
    }
    const appCount = parseDeployCount(appCountRaw);

    if (!githubRepo || !herokuApiKey || !baseAppName || !mongodbUrl || !dbName) {
      showToast('All fields are required', 'error');
      return;
    }

    if (!confirm('Deploy ' + appCount + ' apps with names: ' + baseAppName + '1 to ' + baseAppName + appCount + '?')) {
      return;
    }

    venomLoading.style.display = 'block';
    venomLoadingText.textContent = 'Deploying ' + appCount + ' apps...';
    deployBtn.disabled = true;
    venomResults.style.display = 'none';

    try {
      const response = await axios.post('/venom/deploy-apps', {
        githubRepo: githubRepo,
        herokuApiKey: herokuApiKey,
        baseAppName: baseAppName,
        mongodbUrl: mongodbUrl,
        dbName: dbName,
        count: appCount
      }, { timeout: 900000 });

      const results = response.data.results || [];
      const failedApps = response.data.failedApps || [];
      showToast('Deployed ' + results.length + ' apps');

      const allResults = results.map(function (r) {
        return Object.assign({}, r, { status: 'success' });
      }).concat(failedApps.map(function (f) {
        return Object.assign({}, f, { status: 'failed' });
      }));

      let content =
        '<div style="margin-bottom:15px;font-weight:600;color:' + (failedApps.length > 0 ? '#d0a0a0' : '#c8c8c8') + '">' +
          'Deployment Results (Success: ' + results.length + ', Failed: ' + failedApps.length + ')' +
        '</div>';

      allResults.forEach(function (r) {
        content +=
          '<div class="result-item" style="color:' + (r.status === 'success' ? '#c8c8c8' : '#d0a0a0') + '">' +
            '<strong>' + escapeHtml(r.appName) + ':</strong> ' + escapeHtml(r.status) +
            (r.error ? '<br><small>Error: ' + escapeHtml(r.error) + '</small>' : '') +
            (r.appUrl ? '<br><small>URL: ' + escapeHtml(r.appUrl) + '</small>' : '') +
          '</div>';
      });

      if (response.data.servers && Object.keys(response.data.servers).length > 0) {
        content +=
          '<div style="margin-top:20px;padding-top:15px;border-top:1px solid rgba(255,255,255,0.06);">' +
            '<div style="font-weight:600;margin-bottom:10px;color:#c8c8c8;">Generated Server List:</div>' +
            '<pre style="background:rgba(0,0,0,0.35);padding:10px;border-radius:8px;font-size:12px;overflow-x:auto;color:#c8c8c8;text-align:left;border:1px solid rgba(255,255,255,0.06);">' +
              escapeHtml(JSON.stringify(response.data.servers, null, 2)) +
            '</pre>' +
          '</div>';
      }

      venomResults.innerHTML = content;
      venomResults.className = 'result-box ' + (failedApps.length > 0 ? 'error' : 'success');
      venomResults.style.display = 'block';
    } catch (error) {
      const msg = error.response && error.response.data && error.response.data.error
        ? error.response.data.error
        : 'Deployment failed';
      showToast(msg, 'error');
    } finally {
      venomLoading.style.display = 'none';
      deployBtn.disabled = false;
    }
  });
}

window.addEventListener('click', function (event) {
  if (event.target.classList.contains('modal')) {
    event.target.style.display = 'none';
  }
});

const apiKeyInput = document.getElementById('apiKeyInput');
if (apiKeyInput) {
  apiKeyInput.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') document.getElementById('loadAppsBtn').click();
  });
}
