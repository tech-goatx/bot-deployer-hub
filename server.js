const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

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

function parseAppNameStart(rawName) {
  const base = sanitizeName(rawName);
  const match = base.match(/^(.*?)(\d+)$/);
  if (match) {
    const start = parseInt(match[2], 10);
    if (Number.isFinite(start) && start >= 0) {
      return { prefix: match[1], start: start };
    }
  }
  return { prefix: base, start: 1 };
}

async function herokuAppExists(client, appName) {
  try {
    await client.get('/apps/' + encodeURIComponent(appName));
    return true;
  } catch (err) {
    const status = err.response && err.response.status;
    if (status === 404) return false;
    if (status === 403) return true;
    throw err;
  }
}

function herokuWebUrl(app) {
  const url = app && app.web_url ? String(app.web_url).replace(/\/$/, '') : '';
  if (url) return url;
  const n = app && app.name ? String(app.name) : '';
  return n ? 'https://' + n + '.herokuapp.com' : '';
}

function parseGithubRepo(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const match = raw.match(/(?:github\.com|codeload\.github\.com)[/:]([^/]+)\/([^/#?\s]+)/i);
  if (match) {
    return { owner: match[1], repo: match[2].replace(/\.git$/i, '') };
  }
  const api = raw.match(/api\.github\.com\/repos\/([^/]+)\/([^/#?\s]+)/i);
  if (api) {
    return { owner: api[1], repo: api[2].replace(/\.git$/i, '') };
  }
  const short = raw.match(/^([^/\s]+)\/([^/#?\s]+)$/);
  if (short && !short[1].includes('.') && short[2]) {
    return { owner: short[1], repo: short[2].replace(/\.git$/i, '') };
  }
  return null;
}

function findGithubInValue(value) {
  if (value == null) return null;
  if (typeof value === 'string') return parseGithubRepo(value);
  if (typeof value !== 'object') return null;
  const owner = value.org || value.owner || value.repoOwner || value.gitOwner || value.login;
  const repo = value.repo || value.repository || value.repo_name || value.repoName || value.name;
  if (owner && repo && typeof repo === 'string' && !String(repo).includes('/')) {
    return { owner: String(owner), repo: String(repo).replace(/\.git$/i, '') };
  }
  if (typeof repo === 'string' && repo.includes('/')) {
    const parsed = parseGithubRepo(repo);
    if (parsed) return parsed;
  }
  return parseGithubRepo(JSON.stringify(value));
}

function findGithubDeep(obj, depth) {
  if (obj == null || depth > 5) return null;
  const direct = findGithubInValue(obj);
  if (direct) return direct;
  if (typeof obj !== 'object') return null;
  const keys = Array.isArray(obj) ? obj : Object.values(obj);
  for (const val of keys) {
    const found = findGithubDeep(val, depth + 1);
    if (found) return found;
  }
  return null;
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

function privateRepoHint() {
  return 'Connect GitHub in Heroku Dashboard (Account > Applications > GitHub) to deploy private repos. No GitHub token needed.';
}

function kolkrabbiHeaderSets(apiKey) {
  const token = normalizeHerokuToken(apiKey);
  const accept = 'application/vnd.heroku+json; version=3';
  return [
    {
      Authorization: 'Bearer ' + token,
      Accept: accept,
      'Content-Type': 'application/json',
      'User-Agent': 'Aman-TechX'
    },
    herokuHeaders(apiKey)
  ];
}

const KOLKRABBI_BASES = [
  'https://kolkrabbi.heroku.com',
  'https://kolkrabbi.herokuapp.com'
];

async function kolkrabbiRequest(apiKey, method, relPath, body) {
  let lastErr = null;
  for (const base of KOLKRABBI_BASES) {
    for (const headers of kolkrabbiHeaderSets(apiKey)) {
      try {
        const res = await axios({
          method: method,
          url: base + relPath,
          headers: headers,
          data: body || undefined,
          timeout: 30000,
          validateStatus: function (s) { return s < 500; },
          maxRedirects: 5
        });
        if (res.status >= 400) {
          lastErr = new Error(herokuErrorMessage({ response: res }) || ('kolkrabbi ' + res.status));
          continue;
        }
        return res.data == null ? {} : res.data;
      } catch (err) {
        lastErr = err;
      }
    }
  }
  if (lastErr) throw lastErr;
  return null;
}

function extractGithubToken(data) {
  if (!data) return '';
  if (typeof data === 'string' && data.trim()) return data.trim();
  const nested = data.github || data.account || data.user || {};
  return String(
    data.token ||
    data.access_token ||
    data.github_token ||
    nested.token ||
    nested.access_token ||
    ''
  ).trim();
}

async function fetchHerokuGithubToken(herokuApiKey) {
  const paths = [
    '/account/github/token',
    '/account/get-github-token',
    '/account/github',
    '/account/info',
    '/github/token',
    '/github/auth-token'
  ];
  for (const p of paths) {
    try {
      const data = await kolkrabbiRequest(herokuApiKey, 'get', p);
      const t = extractGithubToken(data);
      if (t) return t;
    } catch (_) {}
  }
  return '';
}

async function herokuAppId(client, appName) {
  const res = await client.get('/apps/' + encodeURIComponent(appName));
  return (res.data && (res.data.id || res.data.name)) || appName;
}

async function kolkrabbiLinkedRepo(apiKey, appId) {
  try {
    const data = await kolkrabbiRequest(apiKey, 'get', '/apps/' + encodeURIComponent(appId) + '/github');
    if (!data) return null;
    const repo = data.repo_name || data.repo || data.repository || (data.github && data.github.repo);
    const parsed = parseGithubRepo(repo);
    const branch = data.branch || data.default_branch || (data.github && data.github.branch) || 'main';
    if (parsed) parsed.branch = branch;
    return parsed;
  } catch (_) {
    return null;
  }
}

function githubRepoFull(data) {
  if (!data) return '';
  return String(
    data.repo_name ||
    data.repo ||
    data.repository ||
    (data.github && (data.github.repo_name || data.github.repo)) ||
    ''
  ).replace(/\.git$/i, '');
}

async function kolkrabbiDeploy(apiKey, appId, owner, repo, branch) {
  const full = owner + '/' + repo;
  const rel = '/apps/' + encodeURIComponent(appId) + '/github';
  let linked = null;
  try {
    linked = await kolkrabbiRequest(apiKey, 'get', rel);
  } catch (_) {}

  const linkedFull = githubRepoFull(linked).replace(/^https?:\/\/github\.com\//i, '');
  const already = linkedFull.toLowerCase() === full.toLowerCase();
  const br = branch || (linked && (linked.branch || linked.default_branch)) || 'main';

  if (!already) {
    const bodies = [
      { repo: full, branch: br, auto_deploy: false },
      { repo_name: full, branch: br },
      { repo: full },
      { repo_name: full },
      { repository: full, branch: br }
    ];
    let ok = false;
    let lastErr = null;
    for (const method of ['patch', 'put', 'post']) {
      for (const body of bodies) {
        try {
          await kolkrabbiRequest(apiKey, method, rel, body);
          ok = true;
          break;
        } catch (err) {
          lastErr = err;
        }
      }
      if (ok) break;
    }
    if (!ok && lastErr) throw lastErr;
  }

  const pushBodies = [{ branch: br }, { ref: br }, { branch: 'master' }, {}];
  let lastPushErr = null;
  for (const body of pushBodies) {
    try {
      return await kolkrabbiRequest(apiKey, 'post', rel + '/push', body);
    } catch (err) {
      lastPushErr = err;
    }
  }
  throw lastPushErr || new Error(privateRepoHint());
}

async function resolveDefaultBranch(owner, repo, githubToken) {
  const branches = ['main', 'master'];
  try {
    const info = await axios.get('https://api.github.com/repos/' + owner + '/' + repo, {
      headers: githubHeaders(githubToken),
      timeout: 20000,
      validateStatus: function (s) { return s < 500; }
    });
    if (info.status === 200 && info.data && info.data.default_branch) {
      return [info.data.default_branch].concat(branches.filter(function (b) {
        return b !== info.data.default_branch;
      }));
    }
  } catch (_) {}
  return branches;
}

async function downloadGithubTarball(owner, repo, githubToken) {
  const token = String(githubToken || '').trim();
  const branches = await resolveDefaultBranch(owner, repo, token);
  let lastStatus = 0;
  const auth = encodeURIComponent(token);

  for (const branch of branches) {
    const enc = encodeURIComponent(branch);
    const urls = [];
    if (token) {
      urls.push('https://x-access-token:' + auth + '@codeload.github.com/' + owner + '/' + repo + '/tar.gz/refs/heads/' + enc);
      urls.push('https://x-access-token:' + auth + '@github.com/' + owner + '/' + repo + '/archive/refs/heads/' + enc + '.tar.gz');
      urls.push('https://api.github.com/repos/' + owner + '/' + repo + '/tarball/' + enc);
    }
    urls.push('https://codeload.github.com/' + owner + '/' + repo + '/tar.gz/refs/heads/' + enc);
    urls.push('https://github.com/' + owner + '/' + repo + '/archive/refs/heads/' + enc + '.tar.gz');
    urls.push('https://api.github.com/repos/' + owner + '/' + repo + '/tarball/' + enc);

    for (const url of urls) {
      try {
        const headers = githubHeaders(token);
        if (url.indexOf('x-access-token:') !== -1) {
          delete headers.Authorization;
        }
        const res = await axios.get(url, {
          headers: headers,
          responseType: 'arraybuffer',
          timeout: 120000,
          maxRedirects: 5,
          maxContentLength: Infinity,
          validateStatus: function (s) { return s < 400; },
          beforeRedirect: function (options) {
            const host = options.hostname || options.host || '';
            if (host && host !== 'api.github.com' && options.headers) {
              delete options.headers.Authorization;
              delete options.headers.authorization;
            }
          }
        });
        if (res.data && res.data.byteLength > 200) {
          return Buffer.from(res.data);
        }
      } catch (err) {
        lastStatus = (err.response && err.response.status) || lastStatus;
      }
    }
  }

  if (lastStatus === 404 || lastStatus === 401 || lastStatus === 403) {
    throw new Error(privateRepoHint());
  }
  throw new Error('Could not download GitHub repository. ' + privateRepoHint());
}

async function uploadSourceAndBuild(client, appName, tarballBuf, version) {
  const src = await client.post('/apps/' + encodeURIComponent(appName) + '/sources');
  const blob = src.data && src.data.source_blob;
  if (!blob || !blob.put_url || !blob.get_url) {
    throw new Error('Could not create Heroku source blob');
  }
  await axios.put(blob.put_url, tarballBuf, {
    headers: {
      'Content-Type': '',
      'Content-Length': tarballBuf.length
    },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    timeout: 180000,
    transformRequest: [function (data) { return data; }]
  });
  const buildRes = await client.post('/apps/' + encodeURIComponent(appName) + '/builds', {
    source_blob: {
      url: blob.get_url,
      version: version || ('deploy-' + Date.now())
    }
  });
  return buildRes.data;
}

async function pushAppFromGithub(client, apiKey, appName, owner, repo, githubToken) {
  const appId = await herokuAppId(client, appName);
  try {
    const linked = await kolkrabbiLinkedRepo(apiKey, appId);
    const branch = (linked && linked.branch) || 'main';
    await kolkrabbiDeploy(apiKey, appId, owner, repo, branch);
    return { method: 'github' };
  } catch (_) {}

  const buf = await downloadGithubTarball(owner, repo, githubToken);
  const build = await uploadSourceAndBuild(client, appName, buf, 'push-' + Date.now());
  return { method: 'blob', buildId: build && build.id };
}

function normalizeMongodbUrl(url) {
  return String(url || '').trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function latestBuildId(client, appName) {
  try {
    const res = await client.get('/apps/' + encodeURIComponent(appName) + '/builds');
    const list = Array.isArray(res.data) ? res.data : [];
    if (list.length && list[0] && list[0].id) return list[0].id;
  } catch (_) {}
  return null;
}

async function waitForBuilds(client, pending, timeoutMs) {
  const startedAt = Date.now();
  while (pending.some((item) => !item.buildStatus)) {
    if (Date.now() - startedAt > timeoutMs) break;
    const open = pending.filter((item) => !item.buildStatus);
    await Promise.all(open.map(async (item) => {
      if (!item.buildId) {
        item.buildId = await latestBuildId(client, item.appName);
        if (!item.buildId) return;
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

app.get('/download.zip', (req, res) => {
  const zip = path.join(__dirname, 'aman-techx-heroku-deployer.zip');
  if (fs.existsSync(zip)) return res.download(zip, 'aman-techx-heroku-deployer.zip');
  return res.status(404).send('Zip not ready');
});

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
  const named = parseAppNameStart(baseAppName);
  if (!sanitizeName(baseAppName)) {
    return res.status(400).json({ error: 'Invalid base app name' });
  }

  const client = herokuClient(herokuApiKey);
  const plannedNames = [];
  for (let n = 0; n < appCount; n++) {
    plannedNames.push(named.prefix + (named.start + n));
  }
  const existingNames = [];
  for (const planned of plannedNames) {
    try {
      if (await herokuAppExists(client, planned)) existingNames.push(planned);
    } catch (err) {
      return res.status(400).json({ error: herokuErrorMessage(err) });
    }
  }
  if (existingNames.length) {
    return res.status(400).json({
      error: 'App name already exists: ' + existingNames.join(', ')
    });
  }

  const dashboardToken = await fetchHerokuGithubToken(herokuApiKey);
  const ghToken = String(githubToken || dashboardToken || '').trim();

  let tarballBuf = null;
  let tarballErr = null;
  try {
    tarballBuf = await downloadGithubTarball(parsed.owner, parsed.repo, ghToken);
  } catch (err) {
    tarballErr = err;
  }

  const mongo = normalizeMongodbUrl(mongodbUrl);
  const results = [];
  const failedApps = [];
  const servers = {};
  const pending = [];

  for (let n = 0; n < appCount; n++) {
    const i = n + 1;
    const appName = `${named.prefix}${named.start + n}`;
    try {
      if (await herokuAppExists(client, appName)) {
        throw new Error('App "' + appName + '" already exists');
      }

      let created;
      try {
        const createRes = await client.post('/apps', {
          name: appName,
          stack: 'heroku-24',
          region: 'us'
        });
        created = createRes.data;
      } catch (createErr) {
        const status = createErr.response && createErr.response.status;
        const msg = herokuErrorMessage(createErr);
        if (status === 422 && /taken|exists|already/i.test(msg)) {
          throw new Error('App "' + appName + '" already exists');
        }
        throw createErr;
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
        GITHUB_REPO: 'https://github.com/' + parsed.owner + '/' + parsed.repo,
        GITHUB_REPOSITORY: parsed.owner + '/' + parsed.repo
      };

      await client.patch('/apps/' + encodeURIComponent(realName) + '/config-vars', configVars);

      let buildId = null;
      let gitOk = false;
      try {
        const appId = created && created.id ? created.id : await herokuAppId(client, realName);
        const pushed = await kolkrabbiDeploy(herokuApiKey, appId, parsed.owner, parsed.repo, 'main');
        gitOk = true;
        buildId = pushed && (pushed.build && pushed.build.id || pushed.id || pushed.build_id) || null;
      } catch (_) {
        gitOk = false;
      }

      if (!gitOk) {
        if (!tarballBuf) throw tarballErr || new Error(privateRepoHint());
        const build = await uploadSourceAndBuild(
          client,
          realName,
          tarballBuf,
          'deploy-' + Date.now() + '-' + i
        );
        buildId = build && build.id;
      }

      pending.push({
        index: i,
        appName: realName,
        created: created,
        buildId: buildId
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
        message = 'Build failed. Check Heroku build logs, or connect GitHub in Heroku Dashboard for private repos.';
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

async function resolveGithubFromApp(client, apiKey, appName, fallbackRepo) {
  let token = '';
  let parsed = fallbackRepo ? parseGithubRepo(fallbackRepo) : null;
  try {
    const appId = await herokuAppId(client, appName);
    const linked = await kolkrabbiLinkedRepo(apiKey, appId);
    if (linked && linked.owner && linked.repo) {
      if (!parsed) parsed = linked;
      if (linked.branch) parsed.branch = linked.branch;
    }
  } catch (_) {}
  try {
    const cfg = await client.get('/apps/' + encodeURIComponent(appName) + '/config-vars');
    const vars = cfg.data || {};
    token = vars.GITHUB_TOKEN || vars.GH_TOKEN || '';
    if (!parsed) {
      const preferred = ['GITHUB_REPO', 'GITHUB_REPOSITORY', 'REPO_URL', 'GIT_REPO', 'REPOSITORY'];
      for (const key of preferred) {
        parsed = parseGithubRepo(vars[key]);
        if (parsed) break;
      }
    }
    if (!parsed) {
      for (const value of Object.values(vars)) {
        parsed = parseGithubRepo(value);
        if (parsed) break;
      }
    }
  } catch (_) {}
  if (!parsed) {
    try {
      const builds = await client.get('/apps/' + encodeURIComponent(appName) + '/builds');
      const list = Array.isArray(builds.data) ? builds.data : [];
      for (const item of list) {
        parsed = findGithubDeep(item, 0) || parseGithubRepo(item && item.source_blob && item.source_blob.url);
        if (parsed) break;
      }
    } catch (_) {}
  }
  if (!parsed) {
    try {
      const rels = await client.get('/apps/' + encodeURIComponent(appName) + '/releases', {
        headers: { Range: 'version ..; order=desc,max=10' }
      });
      const list = Array.isArray(rels.data) ? rels.data : [];
      for (const item of list) {
        parsed = findGithubDeep(item, 0) || parseGithubRepo(item && item.description);
        if (parsed) break;
      }
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

  const dashboardToken = await fetchHerokuGithubToken(herokuApiKey);
  const sharedGh = String(githubToken || dashboardToken || '').trim();

  for (const name of appNames) {
    try {
      const parsed = await resolveGithubFromApp(client, herokuApiKey, name, githubRepo);
      const gh = String(githubToken || (parsed && parsed.token) || sharedGh || '').trim();
      if (parsed && parsed.owner && parsed.repo) {
        try {
          await client.patch('/apps/' + encodeURIComponent(name) + '/config-vars', {
            GITHUB_REPO: 'https://github.com/' + parsed.owner + '/' + parsed.repo,
            GITHUB_REPOSITORY: parsed.owner + '/' + parsed.repo
          });
        } catch (_) {}
      }
      const beforeId = await latestBuildId(client, name);
      let pushed = null;
      if (parsed && parsed.owner && parsed.repo) {
        pushed = await pushAppFromGithub(client, herokuApiKey, name, parsed.owner, parsed.repo, gh);
      } else {
        const appId = await herokuAppId(client, name);
        try {
          const linked = await kolkrabbiLinkedRepo(herokuApiKey, appId);
          if (linked && linked.owner && linked.repo) {
            pushed = await pushAppFromGithub(client, herokuApiKey, name, linked.owner, linked.repo, gh);
          } else {
            const br = (linked && linked.branch) || 'main';
            await kolkrabbiRequest(herokuApiKey, 'post', '/apps/' + encodeURIComponent(appId) + '/github/push', { branch: br });
            pushed = { method: 'github' };
          }
        } catch (_) {
          const builds = await client.get('/apps/' + encodeURIComponent(name) + '/builds');
          const list = Array.isArray(builds.data) ? builds.data : [];
          const blobUrl = list.map(function (b) {
            return b && b.source_blob && b.source_blob.url;
          }).find(Boolean);
          if (!blobUrl) {
            throw new Error('Could not find this app\'s GitHub repo. Deploy once from this tool, then Push will work automatically.');
          }
          const build = await client.post('/apps/' + encodeURIComponent(name) + '/builds', {
            source_blob: { url: blobUrl, version: 'push-' + Date.now() }
          });
          pushed = { method: 'blob', buildId: build && build.id };
        }
      }
      let afterId = pushed && pushed.buildId ? pushed.buildId : null;
      if (!afterId || afterId === beforeId) {
        for (let t = 0; t < 12; t++) {
          await sleep(1500);
          afterId = await latestBuildId(client, name);
          if (afterId && afterId !== beforeId) break;
        }
      }
      if (!afterId || afterId === beforeId) {
        throw new Error('Push did not start a new Heroku build. Connect GitHub in Heroku Dashboard or check the repo link.');
      }
      restarted += 1;
    } catch (err) {
      let message = herokuErrorMessage(err);
      if (/not found|private|Could not download|Could not access/i.test(message)) {
        message = privateRepoHint();
      }
      errors.push({
        appName: name,
        error: message
      });
    }
    await sleep(300);
  }

  return res.json({
    success: errors.length === 0,
    message: 'Pushed latest GitHub code to ' + restarted + ' app(s)' + (errors.length ? ', ' + errors.length + ' failed' : ''),
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
