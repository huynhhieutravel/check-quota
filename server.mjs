import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn, execSync } from 'child_process';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Bắt lỗi không mong muốn để server không bị crash vô cớ
process.on('uncaughtException', (err) => {
  console.error('Lỗi uncaughtException:', err);
  if (err.code === 'EADDRINUSE') {
    process.exit(1);
  }
});
process.on('SIGTERM', () => {
  console.log('Nhận tín hiệu SIGTERM - tiến trình đang được yêu cầu dừng');
});
process.on('SIGINT', () => {
  console.log('Nhận tín hiệu SIGINT');
});
process.on('SIGHUP', () => {
  console.log('Nhận tín hiệu SIGHUP - terminal đóng, bỏ qua để tiếp tục chạy');
});
process.on('exit', (code) => {
  console.log('Tiến trình server.mjs thoát với mã:', code);
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
const SNAPSHOT_FILE = path.join(__dirname, 'quota-snapshot.json');
let activeXaiProcess = null;

// Đọc Quota Snapshot bền vững từ đĩa (tự động hồi phục 100% nếu mốc reset tuần đã trôi qua)
function loadSnapshots() {
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const data = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
      let modified = false;
      const now = new Date();
      for (const email of Object.keys(data)) {
        const item = data[email];
        // Nếu đã qua mốc thời gian hồi phục tuần của Google, hạn mức đã được phục hồi 100%
        if (item && item.weeklyReset && new Date(item.weeklyReset) <= now) {
          item.weeklyRem = 100;
          item.weeklyReset = null;
          item.weeklyDesc = 'Đã sẵn sàng 100%';
          item.updatedAt = now.toISOString();
          modified = true;
        }
      }
      if (modified) {
        try { fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (e) {}
      }
      return data;
    }
  } catch (e) {}
  return {};
}

// Cập nhật Snapshot cho tài khoản
function updateSnapshot(email, data) {
  if (!email) return;
  const key = email.toLowerCase().trim();
  const all = loadSnapshots();
  all[key] = {
    ...(all[key] || {}),
    ...data,
    updatedAt: new Date().toISOString()
  };
  try {
    fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) {
    console.error('Lỗi lưu quota snapshot:', e.message);
  }
}

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

// Tự động nhận diện tài khoản Codex từ ~/.codex/auth.json nếu chưa có trong oauth dir
function syncExistingCodexAuth() {
  try {
    const codexAuthPath = path.join(HOME_DIR, '.codex', 'auth.json');
    if (!fs.existsSync(codexAuthPath)) return;
    const data = JSON.parse(fs.readFileSync(codexAuthPath, 'utf8'));
    const tokens = data.tokens || {};
    const idToken = tokens.id_token || '';
    if (!idToken) return;

    const parts = idToken.split('.');
    if (parts.length < 2) return;
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (payload.length % 4) payload += '=';
    const claims = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'));
    const email = claims.email;
    if (!email) return;

    if (!fs.existsSync(OAUTH_DIR)) return;
    const existingFiles = fs.readdirSync(OAUTH_DIR);

    // Nếu proxy đã tự sinh file chuẩn (dạng codex-<hash>-<email>-<plan>.json), tự dọn dẹp file codex-<email>.json cũ
    const plainFile = path.join(OAUTH_DIR, `codex-${email}.json`);
    const hasProxyFile = existingFiles.some(f => f.startsWith('codex-') && f !== `codex-${email}.json` && f.toLowerCase().includes(email.toLowerCase()));
    if (hasProxyFile && fs.existsSync(plainFile)) {
      try { fs.unlinkSync(plainFile); } catch {}
      return;
    }

    // Nếu đã có bất kỳ file nào chứa email này, không tạo thêm
    const alreadyExists = existingFiles.some(f => f.toLowerCase().includes(email.toLowerCase()));
    if (alreadyExists) return;

    const targetFile = plainFile;
    const cpaData = {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      id_token: idToken,
      token_type: 'Bearer',
      account_id: tokens.account_id,
      email,
      type: 'codex',
      provider: 'codex',
      plan_type: claims['https://api.openai.com/auth']?.chatgpt_plan_type || 'plus',
      user_id: claims['https://api.openai.com/auth']?.user_id,
      expired: claims.exp ? new Date(claims.exp * 1000).toISOString() : null,
      expires_in: 3600,
      timestamp: Date.now()
    };
    fs.writeFileSync(targetFile, JSON.stringify(cpaData, null, 2), 'utf8');
    console.log(`✅ Đã tự động đồng bộ tài khoản Codex: ${email}`);
  } catch (e) {
    console.error('Lỗi syncExistingCodexAuth:', e.message);
  }
}

// Tự động nhận diện và đồng bộ tài khoản Antigravity IDE từ ~/.gemini/jetski-standalone-oauth-token
function syncExistingAntigravityIdeAuth() {
  try {
    const tokenPath = path.join(HOME_DIR, '.gemini', 'jetski-standalone-oauth-token');
    if (!fs.existsSync(tokenPath)) return;
    const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    const email = (data.id_token_email || '').toLowerCase().trim();
    if (!email) return;

    if (!fs.existsSync(OAUTH_DIR)) return;
    const existingFiles = fs.readdirSync(OAUTH_DIR);
    const targetFile = path.join(OAUTH_DIR, `antigravity-${email}.json`);

    // Nếu chưa có file cho email này, tự động đồng bộ
    if (!existingFiles.some(f => f.startsWith('antigravity-') && f.toLowerCase().includes(email))) {
      const token = data.token || {};
      const fileData = {
        access_token: token.access_token || '',
        refresh_token: token.refresh_token || '',
        token_type: token.token_type || 'Bearer',
        email,
        account: email,
        type: 'antigravity',
        provider: 'antigravity',
        plan_type: 'Pro',
        expires_in: token.expires_in || 3600,
        timestamp: Date.now()
      };
      fs.writeFileSync(targetFile, JSON.stringify(fileData, null, 2), 'utf8');
      console.log(`✅ Đã tự động đồng bộ tài khoản Antigravity IDE: ${email}`);
    }
  } catch (e) {
    console.error('Lỗi syncExistingAntigravityIdeAuth:', e.message);
  }
}

// Lấy danh sách file OAuth
async function getAuthFiles() {
  syncExistingCodexAuth();
  syncExistingAntigravityIdeAuth();
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

// Lấy Quota trực tiếp thời gian thực từ TẤT CẢ các workspace Antigravity LanguageServer đang chạy trên máy
let cachedIdeQuotas = new Map();
let lastIdeQuotaTime = 0;

async function getLiveIdeQuotas() {
  const now = Date.now();
  if (cachedIdeQuotas.size > 0 && (now - lastIdeQuotaTime < 3000)) {
    return cachedIdeQuotas;
  }

  const freshMap = new Map();
  try {
    const ps = execSync("ps aux", { encoding: "utf8" });
    const lines = ps.split("\n").filter(l => (l.includes("language_server") || l.includes("bin/agy") || l.includes("agy --hub")) && l.includes("--csrf_token"));

    for (const line of lines) {
      const pidMatch = line.trim().match(/^\S+\s+(\d+)/);
      const csrfMatch = line.match(/--csrf_token[=\s]+([a-f0-9\-]+)/);
      if (!pidMatch || !csrfMatch) continue;

      const pid = pidMatch[1];
      const csrf = csrfMatch[1];

      let ports = [];
      const httpsPortMatch = line.match(/--https_server_port[=\s]+(\d+)/);
      if (httpsPortMatch) {
        ports.push(httpsPortMatch[1]);
      }
      try {
        const lsof = execSync(`lsof -Pan -p ${pid} -i`, { encoding: "utf8" });
        for (const l of lsof.split("\n")) {
          const m = l.match(/TCP (?:127\.0\.0\.1|localhost):(\d+) \(LISTEN\)/);
          if (m && !ports.includes(m[1])) ports.push(m[1]);
        }
      } catch {
        if (ports.length === 0) continue;
      }

      for (const port of ports) {
        try {
          const userStatus = await callLanguageServerRPC(port, csrf, "GetUserStatus");
          const email = userStatus?.userStatus?.email?.toLowerCase()?.trim();
          if (!email) continue;

          const quotaRes = await callLanguageServerRPC(port, csrf, "RetrieveUserQuotaSummary");
          if (quotaRes?.response?.groups && quotaRes.response.groups.length > 0) {
            const parsed = parseAntigravityQuota({ groups: quotaRes.response.groups });
            if (parsed.status === 'ok') {
              freshMap.set(email, parsed);

              // Tự động lưu tuần vào Snapshot bền vững để không bị mất khi IDE đóng
              const geminiGroup = parsed.groups.find(g => (g.name || '').toLowerCase().includes('gemini'));
              const weeklyBucket = geminiGroup?.buckets?.find(b => b.window === 'weekly');
              if (weeklyBucket && weeklyBucket.remainingPercent !== null) {
                updateSnapshot(email, {
                  weeklyRem: weeklyBucket.remainingPercent,
                  weeklyReset: weeklyBucket.resetTime || null,
                  weeklyDesc: weeklyBucket.description || ''
                });
              }
              break; // Đã kết nối thành công với tiến trình này
            }
          }
        } catch (e) {}
      }
    }
    if (freshMap.size > 0) {
      cachedIdeQuotas = freshMap;
      lastIdeQuotaTime = now;
    }
  } catch (err) {}
  return cachedIdeQuotas;
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
      timeout: 1500
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

function getGoogleClientCredentials() {
  const credPath = path.join(__dirname, 'antigravity-client.json');
  if (fs.existsSync(credPath)) {
    try {
      return JSON.parse(fs.readFileSync(credPath, 'utf8'));
    } catch {}
  }
  return {
    client_id: process.env.ANTIGRAVITY_CLIENT_ID || '',
    client_secret: process.env.ANTIGRAVITY_CLIENT_SECRET || ''
  };
}

// Tự động làm mới OAuth Token khi cần
async function refreshOAuthToken(content, filePath) {
  if (!content.refresh_token) return content.access_token;
  const creds = getGoogleClientCredentials();
  if (!creds.client_id || !creds.client_secret) return content.access_token;

  return new Promise((resolve) => {
    const postData = new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: content.refresh_token,
      grant_type: 'refresh_token'
    }).toString();

    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData)
      },
      timeout: 5000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(d);
          if (j.access_token) {
            content.access_token = j.access_token;
            content.timestamp = Date.now();
            try { fs.writeFileSync(filePath, JSON.stringify(content, null, 2)); } catch {}
            resolve(j.access_token);
            return;
          }
        } catch {}
        resolve(content.access_token);
      });
    });
    req.on('error', () => resolve(content.access_token));
    req.write(postData);
    req.end();
  });
}

// Tự động làm mới OAuth Token cho Codex khi hết hạn
async function refreshCodexOAuthToken(content, filePath) {
  if (!content.refresh_token) return null;
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      grant_type: "refresh_token",
      refresh_token: content.refresh_token
    });

    const req = https.request("https://auth.openai.com/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      timeout: 10000
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            content.access_token = json.access_token;
            if (json.refresh_token) content.refresh_token = json.refresh_token;
            if (json.id_token) content.id_token = json.id_token;
            content.expired = new Date(Date.now() + (json.expires_in || 3600) * 1000).toISOString();
            content.timestamp = Date.now();
            try { fs.writeFileSync(filePath, JSON.stringify(content, null, 2), 'utf8'); } catch (e) {}
            resolve(json.access_token);
            return;
          }
        } catch (e) {}
        resolve(null);
      });
    });
    req.on("error", () => resolve(null));
    req.write(postData);
    req.end();
  });
}

// Truy vấn Quota chi tiết từ OpenAI Codex API (/backend-api/wham/usage)
async function fetchQuotaForCodex(file) {
  const filePath = path.join(OAUTH_DIR, file.name);
  if (!fs.existsSync(filePath)) {
    return { status: 'error', error: 'File xác thực không tồn tại' };
  }

  let content = {};
  try { content = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return { status: 'error', error: 'Lỗi đọc file json' }; }

  let token = content.access_token;
  const accountId = content.account_id;
  const email = (content.email || file.name.replace(/^codex-|\.json$/g, '')).toLowerCase().trim();

  const makeReq = (bearerToken) => new Promise((resolve) => {
    const headers = {
      'Authorization': 'Bearer ' + bearerToken,
      'User-Agent': 'Codex Desktop',
      'Accept': 'application/json'
    };
    if (accountId) headers['ChatGPT-Account-ID'] = accountId;

    const req = https.request('https://chatgpt.com/backend-api/wham/usage', {
      method: 'GET',
      headers,
      timeout: 8000
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(d) });
        } catch (e) {
          resolve({ status: res.statusCode, data: null });
        }
      });
    });
    req.on('error', (err) => resolve({ status: 500, error: err.message }));
    req.end();
  });

  let res = await makeReq(token);
  if (res.status === 401 && content.refresh_token) {
    token = await refreshCodexOAuthToken(content, filePath);
    if (token) res = await makeReq(token);
  }

  if (res.status !== 200 || !res.data) {
    return { status: 'error', error: res.data?.detail || res.error || `HTTP ${res.status}` };
  }

  const data = res.data;
  const rateLimit = data.rate_limit || {};
  const primary = rateLimit.primary_window || {};
  const secondary = rateLimit.secondary_window || {};

  const fiveHourUsed = primary.used_percent !== undefined ? primary.used_percent : 0;
  const fiveHourRem = Math.max(0, 100 - fiveHourUsed);
  const fiveHourReset = primary.reset_at ? new Date(primary.reset_at * 1000).toISOString() : null;

  const weeklyUsed = secondary.used_percent !== undefined ? secondary.used_percent : 0;
  const weeklyRem = Math.max(0, 100 - weeklyUsed);
  const weeklyReset = secondary.reset_at ? new Date(secondary.reset_at * 1000).toISOString() : null;

  updateSnapshot(email, {
    weeklyRem,
    weeklyReset,
    weeklyDesc: weeklyReset ? 'Hồi phục hạn mức tuần Codex' : 'Đã sẵn sàng'
  });

  const planType = (data.plan_type || content.plan_type || 'plus').toUpperCase();
  const creditsBalance = data.credits?.balance || '0';

  return {
    status: 'ok',
    plan: planType,
    credits: creditsBalance,
    groups: [
      {
        name: 'Codex Models',
        description: `Gói: ${planType} | Credit: ${creditsBalance} credit`,
        buckets: [
          {
            bucketId: 'codex-5h',
            label: 'Giới Hạn 5 Giờ (Codex)',
            window: '5h',
            remainingPercent: fiveHourRem,
            usedPercent: fiveHourUsed,
            resetTime: fiveHourReset,
            description: fiveHourReset ? 'Thời gian hồi phục 5 giờ' : 'Đang đầy'
          },
          {
            bucketId: 'codex-weekly',
            label: 'Giới Hạn Hằng Tuần (Codex)',
            window: 'weekly',
            remainingPercent: weeklyRem,
            usedPercent: weeklyUsed,
            resetTime: weeklyReset,
            description: weeklyReset ? 'Thời gian hồi phục tuần' : 'Đang đầy'
          }
        ]
      }
    ]
  };
}

// Đọc cache mức sử dụng thực tế của ứng dụng Grok Bot trên macOS
function readGrokBotUsageFromSystem() {
  const baseDir = path.join(HOME_DIR, 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence');
  if (!fs.existsSync(baseDir)) return null;

  try {
    const files = fs.readdirSync(baseDir);
    let latestData = null;
    let latestMtime = 0;

    for (const f of files) {
      if (!f.endsWith('.blob')) continue;
      const fullPath = path.join(baseDir, f);
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (content.includes('percentUsed') && content.includes('nextResetMs')) {
          const json = JSON.parse(content);
          const reading = json?.value?.reading;
          if (reading?.usage) {
            const stat = fs.statSync(fullPath);
            if (stat.mtimeMs > latestMtime) {
              latestMtime = stat.mtimeMs;
              latestData = {
                percentUsed: reading.usage.percentUsed,
                nextResetMs: reading.usage.nextResetMs,
                readAtMs: reading.readAtMs,
                plan: reading.usage.unifiedPlanName || reading.usage.grokPlanLabel || 'Premium'
              };
            }
          }
        }
      } catch {}
    }
    return latestData;
  } catch (e) {
    console.error('Lỗi đọc Grok Bot cache:', e.message);
    return null;
  }
}

// Hạn mức và trạng thái tài khoản xAI Grok
async function fetchQuotaForXAI(file) {
  const filePath = path.join(OAUTH_DIR, file.name);
  let content = {};
  if (fs.existsSync(filePath)) {
    try { content = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch {}
  }

  const hasToken = !!(content.access_token || content.token || file.access_token);
  const email = (content.email || file.email || file.name.replace(/^xai-|\.json$/g, '')).toLowerCase().trim();

  // Đọc mức sử dụng thực tế từ cache của Grok Bot
  const grokUsage = readGrokBotUsageFromSystem();

  let usedPercent = 0;
  let remainingPercent = 100;
  let resetTime = null;
  let planType = content.plan_type || content.plan || 'Premium';

  if (grokUsage) {
    const rawUsed = grokUsage.percentUsed || 0;
    usedPercent = Math.round(rawUsed);
    remainingPercent = Math.max(0, 100 - usedPercent);
    if (grokUsage.nextResetMs) {
      resetTime = new Date(grokUsage.nextResetMs).toISOString();
    }
    if (grokUsage.plan) {
      planType = grokUsage.plan;
    }
  }

  const daysLeft = resetTime ? Math.max(1, Math.round((new Date(resetTime) - Date.now()) / (1000 * 60 * 60 * 24))) : 7;
  
  // Lưu snapshot hạn mức tuần riêng biệt cho Grok (dùng prefix grok: để tránh xung đột với Antigravity)
  updateSnapshot(`grok:${email}`, {
    weeklyRem: remainingPercent,
    weeklyReset: resetTime,
    weeklyDesc: resetTime ? `Đặt lại sau ${daysLeft} ngày` : 'Đã sẵn sàng'
  });

  return {
    status: hasToken ? 'ok' : 'error',
    error: hasToken ? null : 'Không tìm thấy access token xAI hợp lệ',
    plan: planType,
    usedPercent,
    groups: [
      {
        name: 'Grok Bot Models',
        description: `Gói: ${planType} | Mô hình: Grok 4.5, 4.3, Grok Vision, Grok Code`,
        buckets: [
          {
            bucketId: 'grok-main',
            label: `Hạn Mức Grok (${planType})`,
            window: '5h',
            remainingPercent,
            usedPercent,
            resetTime,
            description: resetTime ? `Đặt lại sau ${daysLeft} ngày` : 'Sẵn sàng'
          },
          {
            bucketId: 'grok-weekly',
            label: 'Hạn Mức Chu Kỳ (Grok)',
            window: 'weekly',
            remainingPercent,
            usedPercent,
            resetTime,
            description: resetTime ? `Đặt lại sau ${daysLeft} ngày` : 'Đã sẵn sàng'
          }
        ]
      }
    ]
  };
}

// Lấy Quota trực tiếp từ Google Antigravity Internal Backend (daily-cloudcode-pa)
async function fetchDailyQuotaDirect(file) {
  const filePath = path.join(OAUTH_DIR, file.name);
  if (!fs.existsSync(filePath)) return null;

  let content = {};
  try { content = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }

  let token = content.access_token;
  if (!token) return null;
  const email = (content.email || content.account || file.name.replace(/^antigravity-|\.json$/g, '')).toLowerCase().trim();

  const makeReq = (url, bearerToken) => new Promise(resolve => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + bearerToken,
        'Content-Type': 'application/json',
        'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)'
      },
      timeout: 5000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(d) }); } catch(e) { resolve({ status: res.statusCode, data: null }); }
      });
    });
    req.on('error', () => resolve({ status: 500, data: null }));
    req.write('{}');
    req.end();
  });

  let quotaRes = await makeReq('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', token);
  if (quotaRes.status === 401 && content.refresh_token) {
    token = await refreshOAuthToken(content, filePath);
    quotaRes = await makeReq('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', token);
  }

  if (!quotaRes.data || !quotaRes.data.buckets) return null;

  const summaryRes = await makeReq('https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', token);

  const geminiBucket = quotaRes.data.buckets.find(b => b.modelId?.includes('gemini-2.5-pro') || b.modelId?.includes('gemini-3.8') || b.modelId?.includes('gemini-2.5-flash'));

  const snapshots = loadSnapshots();
  const existingSnapshot = snapshots[email] || {};

  let weeklyRem = existingSnapshot.weeklyRem !== undefined ? existingSnapshot.weeklyRem : null;
  let weeklyReset = existingSnapshot.weeklyReset || null;
  let weeklyDesc = existingSnapshot.weeklyDesc || '';
  let fiveHourRem = 100;
  let fiveHourReset = null;

  if (geminiBucket) {
    const fraction = geminiBucket.remainingFraction !== undefined ? geminiBucket.remainingFraction : 1;
    const resetTime = geminiBucket.resetTime;
    const diffHours = resetTime ? (new Date(resetTime) - Date.now()) / 3600000 : 0;

    if (diffHours > 6) {
      // Hạn mức tuần vì thời gian hồi > 6 giờ (lên tới 7 ngày)
      weeklyRem = Math.round(fraction * 100);
      weeklyReset = resetTime;
      fiveHourRem = 100;
      fiveHourReset = null;
      updateSnapshot(email, { weeklyRem, weeklyReset });
    } else {
      // Hạn mức 5 giờ đang tiêu tốn hoặc đang hồi
      fiveHourRem = Math.round(fraction * 100);
      fiveHourReset = resetTime;
      // QUAN TRỌNG: Giữ nguyên weeklyRem từ Snapshot, TUYỆT ĐỐI không ép về 100%!
    }
  }

  const geminiBuckets = [
    {
      bucketId: 'gemini-5h',
      label: 'Hạn Mức 5 Giờ',
      window: '5h',
      remainingPercent: fiveHourRem,
      usedPercent: 100 - fiveHourRem,
      resetTime: fiveHourReset,
      description: fiveHourReset ? 'Hồi phục hạn mức 5 giờ' : ''
    },
    {
      bucketId: 'gemini-weekly',
      label: 'Hạn Mức Hàng Tuần',
      window: 'weekly',
      remainingPercent: weeklyRem,
      usedPercent: weeklyRem !== null ? 100 - weeklyRem : null,
      resetTime: weeklyReset,
      description: weeklyReset ? (weeklyDesc || 'Hồi phục hạn mức tuần') : ''
    }
  ];

  const groups = [
    {
      name: 'Gemini Models',
      description: 'Models within this group: Gemini Flash, Gemini Pro',
      buckets: geminiBuckets
    }
  ];

  return { status: 'ok', groups };
}

// Truy vấn Quota chi tiết của từng tài khoản Antigravity
async function fetchQuotaForAccount(file, liveMap = null) {
  const targetEmail = (file.email || file.account || file.name || '').toLowerCase().trim();
  const cleanTarget = targetEmail.replace(/^antigravity-|\.json$/g, '').trim();

  // 1. Ưu tiên số 1: Hạn mức từ Antigravity LanguageServer đang chạy trên máy (khớp 100% tất cả workspace IDE)
  try {
    const map = liveMap || await getLiveIdeQuotas();
    for (const [ideEmail, ideQuota] of map) {
      if (cleanTarget === ideEmail || cleanTarget.includes(ideEmail) || ideEmail.includes(cleanTarget)) {
        return ideQuota;
      }
    }
  } catch (err) {}

  // 2. Ưu tiên số 2: Gọi trực tiếp Google Antigravity Internal API (daily-cloudcode-pa) cho tài khoản offline
  try {
    const dailyQuota = await fetchDailyQuotaDirect(file);
    if (dailyQuota && dailyQuota.status === 'ok' && dailyQuota.groups && dailyQuota.groups.length > 0) {
      return dailyQuota;
    }
  } catch (err) {}

  // 3. Fallback: Proxy core api-call
  const secretKey = getManagementKey();
  const authIndex = file.auth_index || file.authIndex;
  if (!authIndex) {
    return { status: 'error', error: 'Không tìm thấy thông tin xác thực' };
  }

  const payload = {
    authIndex: String(authIndex),
    method: 'POST',
    url: 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
    header: {
      'Authorization': 'Bearer $TOKEN$',
      'Content-Type': 'application/json',
      'User-Agent': 'antigravity/cli/1.0.13 (aidev_client; os_type=darwin; arch=arm64)'
    },
    data: '{}'
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
      return parseAntigravityQuota(data);
    }
  } catch (err) {}

  return { status: 'error', error: 'Không lấy được dữ liệu hạn mức từ Google' };
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
      // Chỉ theo dõi nhóm Gemini Models
      if (!groupName.toLowerCase().includes('gemini')) continue;
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
    const uniqueFiles = [];
    const seenFiles = new Set();
    for (const f of authFiles) {
      const raw = (f.provider || f.type || f.name || '').toLowerCase();
      let p = 'antigravity';
      if (raw.includes('codex')) p = 'codex';
      else if (raw.includes('xai') || raw.includes('grok')) p = 'grok';
      const email = (f.email || f.name || '').toLowerCase().replace(/^(antigravity|codex|xai|grok)-|\.json$/g, '').trim();
      const key = `${p}:${email}`;
      if (!seenFiles.has(key)) {
        seenFiles.add(key);
        uniqueFiles.push({ ...f, provider: p });
      }
    }
    const antigravityAccounts = uniqueFiles.filter(f => f.provider === 'antigravity');
    const codexAccounts = uniqueFiles.filter(f => f.provider === 'codex');
    const grokAccounts = uniqueFiles.filter(f => f.provider === 'grok');

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      proxy: {
        host: PROXY_HOST,
        port: PROXY_PORT,
        running: isProxyRunning,
        endpoint: `http://${PROXY_HOST}:${PROXY_PORT}/v1`
      },
      accountCount: uniqueFiles.length,
      antigravityCount: antigravityAccounts.length,
      codexCount: codexAccounts.length,
      grokCount: grokAccounts.length
    }));
    return;
  }

  // API: Lấy danh sách tài khoản kèm chi tiết Quota
  if (url.pathname === '/api/accounts') {
    await ensureCoreRunning();
    const authFiles = await getAuthFiles();
    const liveMap = await getLiveIdeQuotas();
    const accounts = await Promise.all(authFiles.map(async (f) => {
      const raw = (f.provider || f.type || f.name || '').toLowerCase();
      const isCodex = raw.includes('codex');
      const isGrok = raw.includes('xai') || raw.includes('grok');
      const isAntigravity = !isCodex && !isGrok;
      let quotaData = { status: 'loading' };

      // Đọc thông tin chi tiết từ file cục bộ
      let email = f.email || f.account || '';
      let plan = f.plan_type || f.plan || (isCodex ? 'Plus' : isGrok ? 'xAI Grok' : 'Gemini Pro');
      let projectId = f.project_id || f.projectId || '';

      const localFilePath = path.join(OAUTH_DIR, f.name);
      if (fs.existsSync(localFilePath)) {
        try {
          const content = JSON.parse(fs.readFileSync(localFilePath, 'utf8'));
          email = email || content.email || content.account || content.user_email || '';
          projectId = projectId || content.project_id || content.projectId || '';
          plan = content.plan_type || content.plan || plan;
        } catch {}
      }

      if (isAntigravity) {
        quotaData = await fetchQuotaForAccount(f, liveMap);
      } else if (isCodex) {
        quotaData = await fetchQuotaForCodex(f);
      } else if (isGrok) {
        quotaData = await fetchQuotaForXAI(f);
      }

      const finalPlan = (quotaData && quotaData.plan) || plan || (isCodex ? 'PLUS' : isGrok ? 'PREMIUM' : 'GEMINI PRO');
      return {
        name: f.name,
        email: email || f.name.replace(/\.json$/, ''),
        provider: isCodex ? 'codex' : isGrok ? 'grok' : 'antigravity',
        plan: finalPlan.toUpperCase(),
        projectId,
        updatedAt: f.updated_at || null,
        quota: quotaData
      };
    }));

    // Deduplicate theo provider + email (tránh trường hợp có 2 file oauth cùng một email)
    const uniqueAccounts = [];
    const seen = new Set();
    for (const acc of accounts) {
      const key = `${acc.provider}:${(acc.email || '').toLowerCase().trim()}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueAccounts.push(acc);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ accounts: uniqueAccounts }));
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

  // API: Bắt đầu đăng nhập tài khoản Codex mới (OpenAI OAuth)
  if (url.pathname === '/api/login-codex' && req.method === 'POST') {
    await ensureCoreRunning();
    const secretKey = getManagementKey();
    try {
      const targetUrl = `http://${PROXY_HOST}:${PROXY_PORT}/v0/management/codex-auth-url?is_webui=true`;
      const response = await fetch(targetUrl, {
        headers: { Authorization: `Bearer ${secretKey}` }
      });
      const data = await response.json();
      if (data.url) {
        exec(`open "${data.url}"`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: true, url: data.url, state: data.state }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ success: false, error: data.error || 'Không lấy được URL OAuth Codex' }));
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ success: false, error: e.message }));
    }
    return;
  }

  // API: Bắt đầu đăng nhập tài khoản xAI Grok mới (OAuth Device Flow)
  if (url.pathname === '/api/login-xai' && req.method === 'POST') {
    await ensureCoreRunning();
    try {
      if (activeXaiProcess) {
        try { activeXaiProcess.kill(); } catch {}
        activeXaiProcess = null;
      }

      const child = spawn(CORE_BINARY, ['-config', CORE_CONFIG, '-xai-login', '-no-browser'], {
        cwd: path.dirname(CORE_BINARY)
      });
      activeXaiProcess = child;

      let captured = '';
      let responded = false;

      const timer = setTimeout(() => {
        if (!responded) {
          responded = true;
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ success: false, error: 'Quá thời gian khởi tạo xác thực xAI Grok' }));
        }
      }, 10000);

      const checkOutput = (data) => {
        captured += data.toString();
        const urlMatch = captured.match(/(https:\/\/accounts\.x\.ai\/oauth2\/device\S*)/);
        const codeMatch = captured.match(/enter this code:\s*([A-Z0-9-]+)/i);
        if (urlMatch && !responded) {
          responded = true;
          clearTimeout(timer);
          const deviceUrl = urlMatch[1];
          const userCode = codeMatch ? codeMatch[1] : (deviceUrl.match(/user_code=([A-Z0-9-]+)/) || [])[1] || '';
          exec(`open "${deviceUrl}"`);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({
            success: true,
            url: deviceUrl,
            user_code: userCode,
            provider: 'xai'
          }));
        }
      };

      child.stdout.on('data', checkOutput);
      child.stderr.on('data', checkOutput);

      child.on('exit', () => {
        activeXaiProcess = null;
      });
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

server.listen(PORT, async () => {
  console.log(`🚀 Dashboard Quota Antigravity (Tiếng Việt) đang chạy tại: http://localhost:${PORT} và http://127.0.0.1:${PORT}`);
  await ensureCoreRunning();
});
