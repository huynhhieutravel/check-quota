import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn, execSync } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bắt lỗi không mong muốn để server không bị crash
process.on('uncaughtException', (err) => {
  console.error('Lỗi uncaughtException:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Lỗi unhandledRejection:', reason);
});

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
      cwd: path.dirname(CORE_BINARY), // Quan trọng: cpa-core để ../oauth tìm đúng vị trí
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
      if (Array.isArray(data.files) && data.files.length > 0) {
        return data.files;
      }
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

// Lấy Quota trực tiếp thời gian thực từ Antigravity LanguageServer (khớp 100% với IDE)
let cachedIdeQuota = null;
let lastIdeQuotaTime = 0;

async function getLiveIdeQuota() {
  const now = Date.now();
  if (cachedIdeQuota && (now - lastIdeQuotaTime < 4000)) {
    return cachedIdeQuota;
  }

  try {
    const ps = execSync("ps aux | grep language_server_macos_arm | grep -v grep", { encoding: "utf8" });
    for (const line of ps.trim().split("\n")) {
      if (line.includes("--enable_lsp")) continue;
      const pidMatch = line.trim().match(/^\S+\s+(\d+)/);
      const csrfMatch = line.match(/--csrf_token\s+([a-f0-9\-]+)/);
      if (!pidMatch || !csrfMatch) continue;

      const pid = pidMatch[1];
      const csrf = csrfMatch[1];
      const lsof = execSync(`lsof -Pan -p ${pid} -i`, { encoding: "utf8" });
      const ports = [];
      for (const l of lsof.split("\n")) {
        const m = l.match(/TCP (?:127\.0\.0\.1|localhost):(\d+) \(LISTEN\)/);
        if (m && !ports.includes(m[1])) ports.push(m[1]);
      }

      for (const port of ports) {
        try {
          const userStatus = await callLanguageServerRPC(port, csrf, "GetUserStatus");
          const quotaRes = await callLanguageServerRPC(port, csrf, "RetrieveUserQuotaSummary");
          if (userStatus?.userStatus?.email && quotaRes?.response?.groups) {
            const parsed = parseAntigravityQuota({ groups: quotaRes.response.groups });
            cachedIdeQuota = {
              email: userStatus.userStatus.email.toLowerCase().trim(),
              name: userStatus.userStatus.name || '',
              quota: parsed
            };
            lastIdeQuotaTime = now;
            return cachedIdeQuota;
          }
        } catch (e) {}
      }
    }
  } catch (err) {}
  return null;
}

function callLanguageServerRPC(port, csrf, method, body = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "127.0.0.1",
      port,
      path: `/exa.language_server_pb.LanguageServerService/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-codeium-csrf-token": csrf
      },
      rejectUnauthorized: false,
      timeout: 2000
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// Truy vấn Quota chi tiết của từng tài khoản Antigravity
async function fetchQuotaForAccount(file) {
  // Ưu tiên lấy hạn mức thời gian thực từ LanguageServer nếu tài khoản đang mở trong IDE
  try {
    const ideData = await getLiveIdeQuota();
    const targetEmail = (file.email || file.account || file.name || '').toLowerCase();
    if (ideData && ideData.email && targetEmail.includes(ideData.email)) {
      return ideData.quota;
    }
  } catch (err) {}

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

  // Antigravity Quota API: cloudcode-pa.googleapis.com trả về đầy đủ Gemini Models & Claude/GPT
  // daily-cloudcode-pa.googleapis.com chỉ trả về Claude/GPT, nên ưu tiên cloudcode-pa trước
  const endpoints = [
    'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary'
  ];

  let lastError = null;
  let fallbackOkResult = null;

  for (const endpointUrl of endpoints) {
    const payloadsToTry = [
      project ? { project } : {},
      {}
    ];

    for (const bodyData of payloadsToTry) {
      const payload = {
        authIndex: String(authIndex),
        method: 'POST',
        url: endpointUrl,
        header: headers,
        data: JSON.stringify(bodyData)
      };

      try {
        const res = await fetch(`http://${PROXY_HOST}:${PROXY_PORT}/v0/management/api-call`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${secretKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(6000)
        });

        if (res.ok) {
          const data = await res.json();
          const parsed = parseAntigravityQuota(data);
          if (parsed.status === 'ok' && parsed.groups && parsed.groups.length > 0) {
            const hasGemini = parsed.groups.some(g => (g.name || '').toLowerCase().includes('gemini'));
            if (hasGemini) {
              return parsed;
            }
            if (!fallbackOkResult) {
              fallbackOkResult = parsed;
            }
          }
          if (parsed.status === 'error') {
            lastError = parsed;
          }
        }
      } catch (err) {
        lastError = { status: 'error', error: err.message };
      }
    }
  }

  return fallbackOkResult || lastError || { status: 'error', error: 'Không lấy được dữ liệu hạn mức từ Google' };
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

    // Kiểm tra lỗi từ Google API
    if (body.error) {
      const errMsg = body.error.message || 'Lỗi từ Google API';
      const reason = body.error.details?.[0]?.reason || '';
      const validationUrl = body.error.details?.[0]?.metadata?.validation_url || '';
      return {
        status: 'error',
        errorType: reason || 'API_ERROR',
        error: errMsg,
        validationUrl
      };
    }

    if (raw.status_code && raw.status_code !== 200) {
      return {
        status: 'error',
        error: `Google API trả về mã lỗi ${raw.status_code}`
      };
    }

    const rawGroups = body.groups || [];
    if (!rawGroups || rawGroups.length === 0) {
      return {
        status: 'warning',
        error: 'Google không trả về nhóm hạn mức',
        groups: []
      };
    }

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
  const publicDir = path.join(__dirname, 'public');
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
