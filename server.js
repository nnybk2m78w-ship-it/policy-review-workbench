/**
 * 政策审核工作台 - Node.js 服务器 (Render 部署版)
 * 使用飞书 user_access_token 更新多维表格
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ---- 飞书配置 (从环境变量读取，密钥不能写死在代码里) ----
const APP_ID = process.env.FEISHU_APP_ID || 'cli_aaace35ed1389cde';
const APP_SECRET = process.env.FEISHU_APP_SECRET;
const BASE_TOKEN = process.env.FEISHU_BASE_TOKEN || 'EpBObMv3GaBOe3slKxdcOwJwnWc';
const TABLE_ID = process.env.FEISHU_TABLE_ID || 'tblYWwuBfs3oylsh';

// ---- Token 存储 (文件 + 环境变量双备份) ----
const TOKEN_FILE = path.join(__dirname, '.feishu_tokens.json');

let state = {
  userAccessToken: null,
  userRefreshToken: null,
  tokenExpiresAt: 0,
  appAccessToken: null,
  appTokenExpiresAt: 0,
  tableFields: null,   // 飞书表格字段名缓存
  currentUser: null,   // 当前授权用户信息
};

// 从文件 / 环境变量加载 token
function loadTokens() {
  // 1. 优先从环境变量加载 (Render 持久化)
  if (process.env.FEISHU_REFRESH_TOKEN) {
    state.userRefreshToken = process.env.FEISHU_REFRESH_TOKEN;
    state.userAccessToken = process.env.FEISHU_ACCESS_TOKEN || null;
    state.tokenExpiresAt = parseInt(process.env.FEISHU_TOKEN_EXPIRES || '0', 10);
    console.log('[飞书] 从环境变量加载 token');
    return;
  }

  // 2. 从文件加载 (本地开发)
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf-8'));
      state.userAccessToken = data.userAccessToken || null;
      state.userRefreshToken = data.userRefreshToken || null;
      state.tokenExpiresAt = data.tokenExpiresAt || 0;
      console.log('[飞书] 从文件加载 token, refreshToken存在:', !!state.userRefreshToken);
    }
  } catch (e) {
    console.error('[飞书] 加载token文件失败:', e.message);
  }
}

function saveTokens() {
  // 保存到文件 (本地)
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({
      userAccessToken: state.userAccessToken,
      userRefreshToken: state.userRefreshToken,
      tokenExpiresAt: state.tokenExpiresAt,
    }, null, 2));
  } catch (e) {
    console.error('[飞书] 保存token文件失败:', e.message);
  }
}

loadTokens();

// ---- 获取 app_access_token ----
async function getAppAccessToken() {
  if (state.appAccessToken && Date.now() < state.appTokenExpiresAt - 60000) {
    return state.appAccessToken;
  }
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`获取 app_access_token 失败: ${data.msg}`);
  }
  state.appAccessToken = data.app_access_token;
  state.appTokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
  return state.appAccessToken;
}

// ---- 获取/刷新 user_access_token ----
async function getUserAccessToken() {
  if (state.userAccessToken && Date.now() < state.tokenExpiresAt - 60000) {
    return state.userAccessToken;
  }
  if (!state.userRefreshToken) {
    throw new Error('NOT_AUTHORIZED');
  }

  const appToken = await getAppAccessToken();
  const resp = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/refresh_access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      refresh_token: state.userRefreshToken,
    }),
  });
  const data = await resp.json();

  if (data.code !== 0) {
    state.userRefreshToken = null;
    saveTokens();
    throw new Error('REFRESH_TOKEN_EXPIRED');
  }

  state.userAccessToken = data.data.access_token;
  state.userRefreshToken = data.data.refresh_token;
  state.tokenExpiresAt = Date.now() + (data.data.expires_in || 7200) * 1000;
  saveTokens();
  console.log('[飞书] user_access_token 已刷新');
  return state.userAccessToken;
}

// ---- 更新飞书记录 ----
async function updateFeishuRecord(recordId, fields) {
  const token = await getUserAccessToken();

  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/${recordId}`;

  const resp = await fetch(url, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json();

  if (data.code !== 0) {
    throw new Error(`飞书API错误: ${data.msg} (code=${data.code})`);
  }

  return data;
}

// ---- 读取飞书记录 ----
async function getFeishuRecord(recordId) {
  const token = await getUserAccessToken();

  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/${recordId}`;

  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await resp.json();

  if (data.code !== 0) {
    throw new Error(`读取飞书记录失败: ${data.msg} (code=${data.code})`);
  }

  return data.data.record;
}

// ---- 获取表格字段列表（带缓存），缺失的扩展字段自动创建 ----
const EXTRA_FIELDS = [
  { field_name: '确认人', type: 1 },
  { field_name: '确认人ID', type: 1 },
  { field_name: '已修改', type: 1 },
  { field_name: '修改历史', type: 1 },
];

async function ensureTableFields() {
  if (state.tableFields) return state.tableFields;

  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields?page_size=200`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await resp.json();

  if (data.code !== 0) {
    throw new Error(`获取表格字段失败: ${data.msg}`);
  }

  const fields = data.data.items || [];
  state.tableFields = fields.map(f => f.field_name);

  // 自动创建缺失的扩展字段
  for (const ef of EXTRA_FIELDS) {
    if (!state.tableFields.includes(ef.field_name)) {
      try {
        const createResp = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/fields`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(ef),
        });
        const created = await createResp.json();
        if (created.code === 0) {
          console.log(`[飞书] ✓ 已创建字段: ${ef.field_name}`);
          state.tableFields.push(ef.field_name);
        } else {
          console.warn(`[飞书] 创建字段 ${ef.field_name} 失败: ${created.msg}`);
        }
      } catch (e) {
        console.warn(`[飞书] 创建字段 ${ef.field_name} 异常: ${e.message}`);
      }
    }
  }

  return state.tableFields;
}

// ---- 获取当前授权用户信息 (open_id + 姓名) ----
async function getCurrentUser() {
  if (state.currentUser) return state.currentUser;

  const token = await getUserAccessToken();
  const resp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await resp.json();

  if (data.code !== 0) {
    console.warn('[飞书] 获取用户信息失败:', data.msg);
    return null;
  }

  state.currentUser = {
    openId: data.data.open_id || '',
    name: data.data.name || data.data.en_name || '未知用户',
  };
  console.log(`[飞书] 当前用户: ${state.currentUser.name} (${state.currentUser.openId})`);
  return state.currentUser;
}

// 解析"修改历史"字段（兼容 JSON 数组与多行文本两种格式）
function parseChangeHistory(raw) {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) { /* 不是 JSON，按文本行解析 */ }
    return raw.split('\n').filter(Boolean);
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

// 把修改历史格式化为多行文本
function formatChangeHistory(entries) {
  return entries
    .map(e => {
      if (typeof e === 'string') return e;
      return `[${e.time}] ${e.user || ''} | ${e.fieldLabel || e.field || ''}: ${e.oldValue || '(空)'} → ${e.newValue || '(空)'} | 原因: ${e.reason || '未填写'}`.trim();
    })
    .join('\n');
}

// ---- 中间件 ----
app.use(express.json());

// CORS: 允许来自任何源的请求 (团队共享需要)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- 静态文件 ----
app.use(express.static(__dirname));

// 首页
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'policy-review-workbench.html'));
});

// ---- OAuth2 回调 ----
app.get('/api/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('缺少 code 参数');
  }

  console.log('[OAuth] 收到授权回调，正在换取 token...');

  try {
    const appToken = await getAppAccessToken();

    const resp = await fetch('https://open.feishu.cn/open-apis/authen/v1/oidc/access_token', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${appToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });

    const data = await resp.json();

    if (data.code !== 0) {
      console.error('[OAuth] 换取token失败:', data.msg);
      return res.send(`<script>alert('授权失败: ${data.msg}');window.close();</script>`);
    }

    state.userAccessToken = data.data.access_token;
    state.userRefreshToken = data.data.refresh_token;
    state.tokenExpiresAt = Date.now() + (data.data.expires_in || 7200) * 1000;
    saveTokens();

    // 获取当前用户信息（open_id + 姓名）
    try {
      state.currentUser = null; // 强制刷新
      await getCurrentUser();
    } catch (e) {
      console.warn('[OAuth] 获取用户信息失败(可稍后重试):', e.message);
    }

    console.log('[OAuth] ✓ 授权成功');
    res.send('<script>alert("✅ 授权成功！现在可以确认文件了。");window.close();</script>');
  } catch (err) {
    console.error('[OAuth] 错误:', err.message);
    res.send(`<script>alert('授权错误: ${err.message}');window.close();</script>`);
  }
});

// ---- 授权状态 ----
app.get('/api/auth-status', (req, res) => {
  res.json({
    authorized: !!state.userRefreshToken,
    tokenValid: !!(state.userAccessToken && Date.now() < state.tokenExpiresAt - 60000),
    mode: 'render',
    user: state.currentUser || null,
  });
});

// ---- 当前用户信息 ----
app.get('/api/me', async (req, res) => {
  try {
    if (!state.userRefreshToken) {
      return res.json({ authorized: false, user: null });
    }
    const user = await getCurrentUser();
    res.json({ authorized: true, user });
  } catch (err) {
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.json({ authorized: false, user: null });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ---- 获取授权 URL ----
app.get('/api/auth-url', (req, res) => {
  const redirectUri = `https://${req.get('host')}/api/oauth/callback`;
  const authUrl = `https://open.feishu.cn/open-apis/authen/v1/index?app_id=${APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=policy_review`;
  res.json({ authUrl, redirectUri });
});

// ---- 确认文件 ----
app.post('/api/confirm', async (req, res) => {
  const { recordId, fileName } = req.body;

  if (!recordId) {
    return res.status(400).json({ success: false, error: '缺少 recordId' });
  }

  console.log(`[确认] ${fileName || recordId}`);

  try {
    const now = Date.now();

    // 确保扩展字段存在
    try { await ensureTableFields(); } catch (e) { console.warn('[确认] 检查字段失败:', e.message); }

    // 获取当前授权用户（确认人）
    let confirmedBy = null;
    try {
      confirmedBy = await getCurrentUser();
    } catch (e) {
      console.warn('[确认] 获取用户信息失败，仍执行确认:', e.message);
    }

    const fields = {
      '审核状态': '已确认',
      '确认时间': now,
    };
    if (confirmedBy) {
      fields['确认人'] = confirmedBy.name;
      fields['确认人ID'] = confirmedBy.openId;
    }

    await updateFeishuRecord(recordId, fields);

    console.log(`[确认] ✓ ${fileName || recordId} 确认人: ${confirmedBy ? confirmedBy.name : '未知'}`);
    res.json({
      success: true,
      confirmedAt: now,
      confirmedBy: confirmedBy || null,
    });
  } catch (err) {
    console.error(`[确认] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 保存字段修改（含修改原因 + 修改历史 + 已修改标识） ----
app.post('/api/save-field', async (req, res) => {
  const { recordId, fieldLabel, newValue, reason, changeEntry } = req.body;

  if (!recordId) {
    return res.status(400).json({ success: false, error: '缺少 recordId' });
  }

  try {
    // 确保扩展字段存在
    try { await ensureTableFields(); } catch (e) { console.warn('[保存字段] 检查字段失败:', e.message); }

    // 获取当前用户
    let user = null;
    try { user = await getCurrentUser(); } catch (e) { /* 忽略 */ }

    // 读取现有记录，合并修改历史
    let existingHistory = [];
    try {
      const record = await getFeishuRecord(recordId);
      const rawHistory = (record.fields || {})['修改历史'];
      existingHistory = parseChangeHistory(rawHistory);
    } catch (e) {
      console.warn('[保存字段] 读取现有历史失败，从头开始:', e.message);
    }

    // 构造新变更条目
    const entry = changeEntry || {
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      user: user ? user.name : '',
      fieldLabel: fieldLabel || '',
      field: fieldLabel || '',
      oldValue: '',
      newValue: newValue !== undefined ? String(newValue) : '',
      reason: reason || '',
    };

    existingHistory.push(entry);
    const historyText = formatChangeHistory(existingHistory);

    // 更新飞书字段（仅更新表格中实际存在的字段）
    const fields = {
      '已修改': '是',
      '修改历史': historyText,
    };
    if (fieldLabel && state.tableFields && state.tableFields.includes(fieldLabel)) {
      fields[fieldLabel] = newValue !== undefined ? String(newValue) : '';
    } else if (fieldLabel) {
      console.warn(`[保存字段] 表格中不存在字段「${fieldLabel}」，仅记录修改历史`);
    }

    await updateFeishuRecord(recordId, fields);

    console.log(`[保存字段] ✓ ${fieldLabel || ''} 原因: ${reason || '(无)'} 历史${existingHistory.length}条`);
    res.json({ success: true, historyCount: existingHistory.length });
  } catch (err) {
    console.error(`[保存字段] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 健康检查 ----
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    mode: 'render-oauth2',
    authorized: !!state.userRefreshToken,
  });
});

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`\n🚀 政策审核工作台 (Render) 已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   已授权: ${!!state.userRefreshToken}\n`);
});
