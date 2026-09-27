import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec, spawn } from 'child_process';
import os from 'os';

const PORT = 5200;
const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 8317;

const HOME_DIR = os.homedir();
const CPA_APP_DATA = path.join(HOME_DIR, 'Library', 'Application Support', 'com.cpa.gui');
const CONFIG_TOML_PATH = path.join(CPA_APP_DATA, 'config.toml');
const OAUTH_DIR = path.join(CPA_APP_DATA, 'oauth');
const CORE_BINARY = path.join(CPA_APP_DATA, 'cpa-core', 'cli-proxy-api');
const CORE_CONFIG = path.join(CPA_APP_DATA, 'cpa-core', 'config.yaml');

// Đọc management secret key từ config.toml
function getManagementKey() {
  try {
    if (fs.existsSync(CONFIG_TOML_PATH)) {
      const content = fs.readFileSync(CONFIG_TOML_PATH, 'utf8');
      const match = content.match(/management-secret-key\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    }
  } catch (e) {
    console.error('Lỗi đọc config.toml:', e.message);
  }
  return '';
}

// Đảm bảo Core Proxy đang chạy
async function ensureCoreRunning() {
  try {
    const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) return true;
  } catch {}

  // Nếu chưa chạy, khởi chạy core
  if (fs.existsSync(CORE_BINARY) && fs.existsSync(CORE_CONFIG)) {
    console.log('🔄 Đang khởi động CLIProxyAPI Core...');
    const child = spawn(CORE_BINARY, ['-config', CORE_CONFIG], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
    await new Promise(r => setTimeout(r, 1500));
  }
  return true;
}

// Lấy danh sách file OAuth
async function getAuthFiles() {
  const secretKey = getManagementKey();
  try {
    const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/v0/management/auth-files`, {
      headers: { Authorization: `Bearer ${secretKey}` },
      signal: AbortSignal.timeout(3000)
    });
    if (res.ok) {
      const data = await res.json();
      return data.files || [];
    }
  } catch (e) {
    console.error('Lỗi getAuthFiles:', e.message);
  }

  // Fallback đọc trực tiếp thư mục oauth
  try {
    if (fs.existsSync(OAUTH_DIR)) {
      const files = fs.readdirSync(OAUTH_DIR).filter(f => f.endsWith('.json'));
      return files.map(name => {
        const fullPath = path.join(OAUTH_DIR, name);
        const stat = fs.statSync(fullPath);
        let content = {};
        try { content = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch {}
        return {
          name,
          provider: content.provider || content.account_type || (name.includes('antigravity') ? 'antigravity' : 'unknown'),
          size: stat.size,
          updated_at: stat.mtime.toISOString(),
          ...content
        };
      });
    }
  } catch (e) {
    console.error('Fallback read oauth dir failed:', e.message);
  }
  return [];
}

// Truy vấn Quota chi tiết của từng tài khoản Antigravity
async function fetchQuotaForAccount(file) {
  const secretKey = getManagementKey();
  const authIndex = file.auth_index || file.authIndex || file.name;
  let project = file.project_id || file.projectId || file.gemini_virtual_project || '';

  // Nếu chưa có project_id trong metadata, đọc trực tiếp file
  if (!project && file.name) {
    const filePath = path.join(OAUTH_DIR, file.name);
    try {
      if (fs.existsSync(filePath)) {
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        project = content.project_id || content.projectId || content.gemini_virtual_project || (content.installed && content.installed.project_id) || '';
      }
    } catch {}
  }

  // Header chuẩn của Antigravity CLI
  const headers = {
    'Authorization': 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)'
  };

  const payload = {
    authIndex: String(authIndex),
    method: 'POST',
    url: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    header: headers,
    data: project ? JSON.stringify({ project }) : JSON.stringify({})
  };

  try {
    const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/v0/management/api-call`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });

    if (res.ok) {
      const data = await res.json();
      return parseAntigravityQuota(data);
    } else {
      const text = await res.text();
      return { status: 'error', error: `Lỗi máy chủ (${res.status}): ${text.slice(0, 100)}` };
    }
  } catch (err) {
    return { status: 'error', error: err.message };
  }
}

// Xử lý dữ liệu trả về từ Google Cloud Code Quota
function parseAntigravityQuota(raw) {
  try {
    let body = raw;
    if (typeof raw === 'string') {
      try { body = JSON.parse(raw); } catch {}
    }
    if (body.body && typeof body.body === 'string') {
      try { body = JSON.parse(body.body); } catch {}
    } else if (body.body && typeof body.body === 'object') {
      body = body.body;
    }

    const rawGroups = body.groups || [];
    const groups = [];

    for (const g of rawGroups) {
      const groupName = g.display_name || g.displayName || 'Gemini Models';
      const groupDesc = g.description || '';
      const rawBuckets = g.buckets || [];
      const buckets = [];

      for (const b of rawBuckets) {
        const remainingFraction = b.remaining_fraction !== undefined ? b.remaining_fraction : b.remainingFraction;
        const remainingPercent = remainingFraction !== undefined ? Math.round(Number(remainingFraction) * 100) : null;
        const resetTime = b.reset_time || b.resetTime || null;
        const window = b.window || '5h';
        const label = window === '5h' ? 'Hạn Mức 5 Giờ' : window === 'weekly' ? 'Hạn Mức Hàng Tuần' : (b.display_name || b.displayName || window);
        const desc = b.description || '';

        buckets.push({
          bucketId: b.bucketId || window,
          label,
          window,
          remainingPercent,
          usedPercent: remainingPercent !== null ? 100 - remainingPercent : null,
          resetTime,
          description: desc
        });
      }

      groups.push({
        name: groupName,
        description: groupDesc,
        buckets
      });
    }

    return {
      status: 'ok',
      groups
    };
  } catch (e) {
    return { status: 'error', error: 'Lỗi bóc tách hạn mức: ' + e.message };
  }
}

// Server HTTP
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // API: Lấy trạng thái hệ thống
  if (url.pathname === '/api/status') {
    await ensureCoreRunning();
    let isProxyRunning = false;
    try {
      const ping = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/`, { signal: AbortSignal.timeout(1000) });
      isProxyRunning = ping.ok;
    } catch {}

    const authFiles = await getAuthFiles();
    const antigravityAccounts = authFiles.filter(f => {
      const p = (f.provider || f.type || f.name || '').toLowerCase();
      return p.includes('antigravity') || p.includes('anti-gravity') || p.includes('gemini');
    });

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      proxy: {
        host: PROXY_HOST,
        port: PROXY_PORT,
        running: isProxyRunning,
        endpoint: `http://${PROXY_HOST}:${PROXY_PORT}/v1`
      },
      accountCount: antigravityAccounts.length
    }));
    return;
  }

  // API: Lấy danh sách tài khoản kèm chi tiết Quota
  if (url.pathname === '/api/accounts') {
    await ensureCoreRunning();
    const authFiles = await getAuthFiles();
    const accounts = [];

    for (const f of authFiles) {
      const isAntigravity = (f.provider || f.type || f.name || '').toLowerCase().includes('antigravity');
      let quotaData = { status: 'loading' };

      // Đọc thông tin chi tiết từ file cục bộ
      let email = f.email || f.account || '';
      let plan = f.plan_type || f.plan || 'Gemini Pro';
      let projectId = f.project_id || f.projectId || '';

      const localFilePath = path.join(OAUTH_DIR, f.name);
      if (fs.existsSync(localFilePath)) {
        try {
          const content = JSON.parse(fs.readFileSync(localFilePath, 'utf8'));
          email = email || content.email || content.account || content.user_email || '';
          projectId = projectId || content.project_id || content.projectId || '';
        } catch {}
      }

      if (isAntigravity) {
        quotaData = await fetchQuotaForAccount(f);
      }

      accounts.push({
        name: f.name,
        email: email || f.name.replace(/\.json$/, ''),
        provider: f.provider || 'antigravity',
        plan,
        projectId,
        updatedAt: f.updated_at || null,
        quota: quotaData
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ accounts }));
    return;
  }

  // API: Bắt đầu đăng nhập tài khoản Antigravity mới
  if (url.pathname === '/api/login-antigravity' && req.method === 'POST') {
    await ensureCoreRunning();
    const secretKey = getManagementKey();
    try {
      const targetUrl = `http://${PROXY_HOST}:${PROXY_PORT}/v0/management/antigravity-auth-url?is_webui=true`;
      const response = await fetch(targetUrl, {
        headers: { Authorization: `Bearer ${secretKey}` }
      });
      const data = await response.json();
      if (data.url) {
        // Tự động mở trình duyệt trên máy Mac
        exec(`open "${data.url}"`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, url: data.url, state: data.state }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: data.error || 'Không lấy được URL OAuth' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // API: Xóa tài khoản
  if (url.pathname.startsWith('/api/account/') && req.method === 'DELETE') {
    const filename = decodeURIComponent(url.pathname.replace('/api/account/', ''));
    const secretKey = getManagementKey();
    try {
      // Xóa qua management api
      await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/v0/management/auth-files?name=${encodeURIComponent(filename)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${secretKey}` }
      });
      // Hoặc xóa trực tiếp file
      const filePath = path.join(OAUTH_DIR, filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // Serve giao diện Frontend Tiếng Việt
  const publicDir = path.join(process.cwd(), 'public');
  let filePath = path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    const contentTypes = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': contentTypes[ext] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Không tìm thấy trang');
  }
});

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`🚀 Dashboard Quota Antigravity (Tiếng Việt) đang chạy tại: http://127.0.0.1:${PORT}`);
  await ensureCoreRunning();
});
