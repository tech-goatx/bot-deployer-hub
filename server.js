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
    'User-Agent': 'Aman-TechX',
    Range: 'id ..; max=1000'
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
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 28);
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

async function resolveTarballUrl(owner, repo) {
  const branches = ['main', 'master'];
  for (const branch of branches) {
    const url = `https://github.com/${owner}/${repo}/tarball/${branch}`;
    try {
      const res = await axios.head(url, {
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: (s) => s < 400
      });
      if (res.status < 400) return url;
    } catch (_) {
      /* try next branch */
    }
  }
  return `https://github.com/${owner}/${repo}/tarball/main`;
}

function normalizeMongodbUrl(url) {
  return String(url || '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    tarballUrl = await resolveTarballUrl(parsed.owner, parsed.repo);
  } catch (err) {
    return res.status(400).json({ error: 'Could not access GitHub repository' });
  }

  const mongo = normalizeMongodbUrl(mongodbUrl);
  const results = [];
  const failedApps = [];
  const servers = {};

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

      await client.patch(`/apps/${appName}/config-vars`, configVars);

      try {
        await client.post(`/apps/${appName}/formation`, {
          updates: [{ type: 'web', quantity: 1, size: 'eco' }]
        });
      } catch (_) {
        /* formation may not exist until first build */
      }

      await client.post(`/apps/${appName}/builds`, {
        source_blob: {
          url: tarballUrl,
          version: `deploy-${Date.now()}-${i}`
        }
      });

      const appUrl = created.web_url
        ? created.web_url.replace(/\/$/, '')
        : `https://${appName}.herokuapp.com`;

      results.push({
        appName,
        status: 'success',
        appUrl
      });
      servers[`server${i}`] = appUrl;
    } catch (err) {
      const message = herokuErrorMessage(err);
      failedApps.push({
        appName,
        status: 'failed',
        error: message
      });
    }

    if (i < appCount) await sleep(400);
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
    const response = await client.get('/apps');
    const apps = (response.data || [])
      .map((item) => ({
        name: item.name,
        web_url: item.web_url,
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
  if (fallbackRepo) {
    const parsed = parseGithubRepo(fallbackRepo);
    if (parsed) return parsed;
  }
  try {
    const cfg = await client.get(`/apps/${encodeURIComponent(appName)}/config-vars`);
    const parsed = parseGithubRepo(cfg.data && cfg.data.GITHUB_REPO);
    if (parsed) return parsed;
  } catch (_) {}
  try {
    const builds = await client.get(`/apps/${encodeURIComponent(appName)}/builds`);
    const list = Array.isArray(builds.data) ? builds.data : [];
    const latest = list[0] || {};
    const parsed = parseGithubRepo(latest.source_blob && latest.source_blob.url);
    if (parsed) return parsed;
  } catch (_) {}
  return null;
}

app.post('/api/manager/restart-bot-apps', async (req, res) => {
  const { herokuApiKey, appNames, githubRepo } = req.body || {};
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
        const tarballUrl = await resolveTarballUrl(parsed.owner, parsed.repo);
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
