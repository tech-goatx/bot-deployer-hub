const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HEROKU_API = 'https://api.heroku.com';

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false, maxAge: 0 }));

function normalizeHerokuToken(apiKey) {
  let token = String(apiKey || '').trim();
  token = token.replace(/^["']|["']$/g, '');
  token = token.replace(/^Bearer\s+/i, '').replace(/^Basic\s+/i, '').trim();
  token = token.replace(/\s+/g, '');
  return token;
}

function herokuHeaders(apiKey) {
  const token = normalizeHerokuToken(apiKey);
  const basic = Buffer.from(':' + token).toString('base64');
  return {
    Authorization: `Basic ${basic}`,
    Accept: 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json',
    'User-Agent': 'Aman-TechX'
  };
}

function herokuErrorMessage(err) {
  const data = err.response && err.response.data;
  if (typeof data === 'string' && data.trim()) return data.trim();
  if (data && typeof data === 'object') {
    if (data.message) return data.message;
    if (data.id) return data.id;
  }
  return err.message || 'Unknown error';
}

function herokuClient(apiKey) {
  return axios.create({
    baseURL: HEROKU_API,
    headers: herokuHeaders(apiKey),
    timeout: 120000
  });
}

function sanitizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 28);
}

function herokuWebUrl(app) {
  const url = app && app.web_url ? String(app.web_url).replace(/\/$/, '') : '';
  if (url) return url;
  const n = app && app.name ? String(app.name) : '';
  return n ? 'https://' + n + '.herokuapp.com' : '';
}

function parseGithubRepo(input) {
  const raw = String(input || '').trim();
  const match = raw.match(
    /github\.com[/:]([^/]+)\/([^/#?]+)/i
  );
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  return { owner, repo };
}

function githubHeaders(token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Aman-TechX',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  const t = String(token || '').trim();
  if (t) headers.Authorization = 'Bearer ' + t;
  return headers;
}

function githubRedirectUrl(errOrRes) {
  const res = errOrRes && errOrRes.response ? errOrRes.response : errOrRes;
  const headers = res && res.headers ? res.headers : {};
  return headers.location || headers.Location || '';
}

async function resolveTarballUrl(owner, repo, githubToken) {
  const token = String(githubToken || '').trim();
  const apiBase = 'https://api.github.com/repos/' + owner + '/' + repo;
  let defaultBranch = 'main';

  try {
    const info = await axios.get(apiBase, {
      headers: githubHeaders(token),
      timeout: 20000,
      validateStatus: function (s) { return s < 500; }
    });
    if (info.status === 401 || info.status === 403) {
      throw new Error('GitHub token invalid or missing repo permission.');
    }
    if (info.status === 404) {
      throw new Error(token
        ? 'GitHub repo not found, or this token cannot access the private repo.'
        : 'GitHub repo not found. Private repos need a GitHub token (ghp_...).');
    }
    if (info.status >= 400) {
      throw new Error('Could not access GitHub repository');
    }
    if (info.data && info.data.default_branch) defaultBranch = info.data.default_branch;
  } catch (err) {
    if (err.message && /GitHub/.test(err.message)) throw err;
    throw new Error('Could not access GitHub repository');
  }

  const branches = [defaultBranch, 'main', 'master'].filter(function (b, i, arr) {
    return arr.indexOf(b) === i;
  });

  for (const branch of branches) {
    const tarballApi = apiBase + '/tarball/' + branch;
    try {
      const res = await axios.get(tarballApi, {
        headers: githubHeaders(token),
        timeout: 20000,
        maxRedirects: 0,
        validateStatus: function (s) { return s === 200 || s === 301 || s === 302; }
      });
      const loc = githubRedirectUrl(res);
      if (loc) return loc;
    } catch (err) {
      const loc = githubRedirectUrl(err);
      const status = err.response && err.response.status;
      if (loc && (status === 301 || status === 302)) return loc;
    }
  }

  if (token) {
    return 'https://x-access-token:' + encodeURIComponent(token) +
      '@api.github.com/repos/' + owner + '/' + repo + '/tarball/' + defaultBranch;
  }
  return 'https://github.com/' + owner + '/' + repo + '/tarball/' + defaultBranch;
}

function normalizeMongodbUrl(url) {
  return String(url || '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForBuilds(client, pending, timeoutMs) {
  const startedAt = Date.now();
  while (pending.some((item) => !item.buildStatus)) {
    if (Date.now() - startedAt > timeoutMs) break;
    const open = pending.filter((item) => !item.buildStatus);
    await Promise.all(open.map(async (item) => {
      if (!item.buildId) {
        item.buildStatus = 'error';
        item.buildError = 'Build did not start';
        return;
      }
      try {
        const res = await client.get(
          '/apps/' + encodeURIComponent(item.appName) + '/builds/' + encodeURIComponent(item.buildId)
        );
        const status = res.data && res.data.status;
        if (status === 'succeeded' || status === 'failed') {
          item.buildStatus = status;
        }
      } catch (err) {
        const status = err.response && err.response.status;
        if (status === 404) {
          item.buildStatus = 'error';
          item.buildError = 'Build not found';
        }
      }
    }));
    if (pending.some((item) => !item.buildStatus)) await sleep(5000);
  }
  pending.forEach((item) => {
    if (!item.buildStatus) {
      item.buildStatus = 'timeout';
      item.buildError = 'Build timed out. Open Heroku dashboard and check build logs.';
    }
  });
}

async function scaleWebDyno(client, appName) {
  const sizes = ['eco', 'basic', 'standard-1x'];
  let lastErr = null;
  for (const size of sizes) {
    try {
      await client.patch('/apps/' + encodeURIComponent(appName) + '/formation', {
        updates: [{ type: 'web', quantity: 1, size: size }]
      });
      return size;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not start web dyno');
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/manager', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manager.html'));
});

app.post('/venom/deploy-apps', async (req, res) => {
  const {
    githubRepo,
    herokuApiKey,
    githubToken,
    baseAppName,
    mongodbUrl,
    dbName,
    count
  } = req.body || {};

  if (!githubRepo || !herokuApiKey || !baseAppName || !mongodbUrl || !dbName) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  const parsed = parseGithubRepo(githubRepo);
  if (!parsed) {
    return res.status(400).json({ error: 'Invalid GitHub repository URL' });
  }

  const parsedCount = parseInt(count, 10);
  const appCount = Math.min(Math.max(Number.isFinite(parsedCount) ? parsedCount : 10, 1), 100);
  const base = sanitizeName(baseAppName);
  if (!base) {
    return res.status(400).json({ error: 'Invalid base app name' });
  }

  const client = herokuClient(herokuApiKey);
  let tarballUrl;
  try {
    tarballUrl = await resolveTarballUrl(parsed.owner, parsed.repo, githubToken);
  } catch (err) {
    return res.status(400).json({ error: err.message || 'Could not access GitHub repository' });
  }

  const mongo = normalizeMongodbUrl(mongodbUrl);
  const results = [];
  const failedApps = [];
  const servers = {};
  const pending = [];

  for (let i = 1; i <= appCount; i++) {
    const appName = `${base}${i}`;
    try {
      let created;
      try {
        const createRes = await client.post('/apps', {
          name: appName,
          stack: 'heroku-24',
          region: 'us'
        });
        created = createRes.data;
      } catch (createErr) {
        const status = createErr.response?.status;
        if (status === 422) {
          const existing = await client.get(`/apps/${appName}`);
          created = existing.data;
        } else {
          throw createErr;
        }
      }

      const realName = (created && created.name) || appName;
      const configVars = {
        MONGODB_URI: mongo,
        MONGODB_URL: mongo,
        MONGO_URI: mongo,
        MONGO_URL: mongo,
        DB_NAME: dbName,
        DATABASE_NAME: dbName,
        DATABASE: dbName,
        GITHUB_REPO: `https://github.com/${parsed.owner}/${parsed.repo}`
      };
      if (githubToken) {
        configVars.GITHUB_TOKEN = String(githubToken).trim();
      }

      await client.patch(`/apps/${encodeURIComponent(realName)}/config-vars`, configVars);

      const buildRes = await client.post(`/apps/${encodeURIComponent(realName)}/builds`, {
        source_blob: {
          url: tarballUrl,
          version: `deploy-${Date.now()}-${i}`
        }
      });

      pending.push({
        index: i,
        appName: realName,
        created: created,
        buildId: buildRes.data && buildRes.data.id
      });
    } catch (err) {
      failedApps.push({
        appName,
        status: 'failed',
        error: herokuErrorMessage(err)
      });
    }

    if (i < appCount) await sleep(400);
  }

  await waitForBuilds(client, pending, 300000);

  for (const item of pending) {
    if (item.buildStatus !== 'succeeded') {
      let message = item.buildError || 'Build failed';
      if (item.buildStatus === 'failed') {
        message = 'Build failed. Private GitHub repos need a valid GitHub token, or check Heroku build logs.';
      }
      failedApps.push({
        appName: item.appName,
        status: 'failed',
        error: message
      });
      continue;
    }

    try {
      await scaleWebDyno(client, item.appName);
      let fresh = item.created;
      try {
        const latest = await client.get('/apps/' + encodeURIComponent(item.appName));
        if (latest && latest.data) fresh = latest.data;
      } catch (_) {}
      const appUrl = herokuWebUrl(fresh);
      results.push({
        appName: item.appName,
        status: 'success',
        appUrl
      });
      servers[`server${item.index}`] = appUrl;
    } catch (err) {
      failedApps.push({
        appName: item.appName,
        status: 'failed',
        error: herokuErrorMessage(err) || 'Build ok but web dyno did not start'
      });
    }
  }

  return res.json({
    success: true,
    results,
    failedApps,
    servers
  });
});

app.post('/api/manager/bot-apps', async (req, res) => {
  const { herokuApiKey } = req.body || {};
  if (!herokuApiKey) {
    return res.status(400).json({ success: false, error: 'Heroku API key required' });
  }

  try {
    const client = herokuClient(herokuApiKey);
    const response = await client.get('/apps', {
      headers: { Range: 'id ..; max=1000' }
    });
    const apps = (response.data || [])
      .map((item) => ({
        name: item.name,
        web_url: herokuWebUrl(item),
        created_at: item.created_at,
        updated_at: item.updated_at,
        region: item.region?.name || item.region,
        stack: item.stack?.name || item.stack
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return res.json({ success: true, apps });
  } catch (err) {
    const status = err.response?.status || 500;
    let message = herokuErrorMessage(err);
    if (/base64/i.test(message) || status === 401) {
      message = 'Invalid Heroku API key. Copy the key from Heroku Account Settings > API Key.';
    } else if (!message || message === 'Unknown error') {
      message = 'Failed to load apps';
    }
    return res.status(status === 401 ? 401 : 500).json({
      success: false,
      error: message
    });
  }
});

async function resolveGithubFromApp(client, appName, fallbackRepo) {
  let token = '';
  let parsed = fallbackRepo ? parseGithubRepo(fallbackRepo) : null;
  try {
    const cfg = await client.get(`/apps/${encodeURIComponent(appName)}/config-vars`);
    if (!parsed) parsed = parseGithubRepo(cfg.data && cfg.data.GITHUB_REPO);
    token = (cfg.data && (cfg.data.GITHUB_TOKEN || cfg.data.GH_TOKEN)) || '';
  } catch (_) {}
  if (!parsed) {
    try {
      const builds = await client.get(`/apps/${encodeURIComponent(appName)}/builds`);
      const list = Array.isArray(builds.data) ? builds.data : [];
      const latest = list[0] || {};
      parsed = parseGithubRepo(latest.source_blob && latest.source_blob.url);
    } catch (_) {}
  }
  if (!parsed) return null;
  parsed.token = token;
  return parsed;
}

app.post('/api/manager/restart-bot-apps', async (req, res) => {
  const { herokuApiKey, appNames, githubRepo, githubToken } = req.body || {};
  if (!herokuApiKey) {
    return res.status(400).json({ success: false, error: 'Heroku API key required' });
  }
  if (!Array.isArray(appNames) || appNames.length === 0) {
    return res.status(400).json({ success: false, error: 'No apps selected' });
  }

  const client = herokuClient(herokuApiKey);
  let restarted = 0;
  const errors = [];

  for (const name of appNames) {
    try {
      const parsed = await resolveGithubFromApp(client, name, githubRepo);
      if (parsed) {
        const tarballUrl = await resolveTarballUrl(
          parsed.owner,
          parsed.repo,
          githubToken || parsed.token
        );
        await client.post(`/apps/${encodeURIComponent(name)}/builds`, {
          source_blob: {
            url: tarballUrl,
            version: `restart-${Date.now()}`
          }
        });
      }
      await client.delete(`/apps/${encodeURIComponent(name)}/dynos`);
      restarted += 1;
    } catch (err) {
      errors.push({
        appName: name,
        error: herokuErrorMessage(err)
      });
    }
    await sleep(300);
  }

  return res.json({
    success: errors.length === 0,
    message: `Pushed latest GitHub code and restarted ${restarted} app(s)${errors.length ? `, ${errors.length} failed` : ''}`,
    restarted,
    errors
  });
});

app.post('/api/manager/delete-bot-apps', async (req, res) => {
  const { herokuApiKey, appNames } = req.body || {};
  if (!herokuApiKey) {
    return res.status(400).json({ success: false, error: 'Heroku API key required' });
  }
  if (!Array.isArray(appNames) || appNames.length === 0) {
    return res.status(400).json({ success: false, error: 'No apps selected' });
  }

  const client = herokuClient(herokuApiKey);
  let deleted = 0;
  const errors = [];

  for (const name of appNames) {
    try {
      await client.delete(`/apps/${encodeURIComponent(name)}`);
      deleted += 1;
    } catch (err) {
      errors.push({
        appName: name,
        error: herokuErrorMessage(err)
      });
    }
  }

  return res.json({
    success: errors.length === 0,
    message: `Deleted ${deleted} app(s)${errors.length ? `, ${errors.length} failed` : ''}`,
    deleted,
    errors
  });
});

app.get('/manage/:appName', async (req, res) => {
  const apiKey = req.query.herokuApiKey || req.query.apiKey;
  const { appName } = req.params;
  if (!apiKey) {
    return res.status(400).json({ success: false, error: 'API key required' });
  }

  try {
    const client = herokuClient(apiKey);
    const response = await client.get(
      `/apps/${encodeURIComponent(appName)}/config-vars`
    );
    return res.json({ success: true, config: response.data || {} });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      success: false,
      error: herokuErrorMessage(err) || 'Failed to load config'
    });
  }
});

app.put('/manage/:appName/config', async (req, res) => {
  const { appName } = req.params;
  const { configVars, apiKey, herokuApiKey } = req.body || {};
  const key = apiKey || herokuApiKey;

  if (!key) {
    return res.status(400).json({ success: false, error: 'API key required' });
  }
  if (!configVars || typeof configVars !== 'object') {
    return res.status(400).json({ success: false, error: 'configVars required' });
  }

  try {
    const client = herokuClient(key);
    const response = await client.patch(
      `/apps/${encodeURIComponent(appName)}/config-vars`,
      configVars
    );
    return res.json({ success: true, config: response.data || {} });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      success: false,
      error: herokuErrorMessage(err) || 'Failed to update config'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Aman TechX running on http://0.0.0.0:${PORT}`);
});
