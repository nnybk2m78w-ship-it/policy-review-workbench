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
const KNOWLEDGE_DOC_ID = process.env.FEISHU_KNOWLEDGE_DOC_ID || 'AyGydegiaoEXU6xFCnAc4gKBnDc';
const VERSION_RECORD_DOC_TOKEN = process.env.FEISHU_VERSION_RECORD_DOC_TOKEN || 'C1d9w9WCIiLjCNkSecrcR7Bsnvh';
const AUTO_CORRECTION_LIMIT = parseInt(process.env.AUTO_CORRECTION_LIMIT || '20', 10);

const KEY_LABELS = {
  scenario: '解析场景',
  business_line: '业务线',
  channel_note: '渠道备注',
  carrier: '航司二字码',
  carrier_name: '航司名称',
  product_name: '产品名称',
  product_family: '产品类型',
  product_type: '出票指令',
  product_code: '产品代码',
  product_code_raw: '原始产品码',
  policy_code: '政策编号',
  fare_basis: '运价基础',
  corporate_code: '大客户编码',
  coupon_resource_code: '券/资源编号',
  product_category: '产品类别',
  flight_type: '航程类型',
  trip_type_note: '航程备注',
  od: '航线范围',
  od_note: '航线备注',
  booking_cabin: '适用舱位',
  cabin: '舱位代码',
  cabin_count: '舱位数量',
  sale_date: '销售日期',
  redeem_date: '兑换日期',
  use_date: '兑换日期(标准)',
  depart_date: '旅行日期',
  depart_date_note: '旅行日期备注',
  advance_purchase_days: '提前购票',
  ticket_type: '票证类型',
  ticket_stock: '票证代码',
  discount_type: '直减类型',
  discount_per: '直减金额/比例',
  passenger_type: '旅客类型',
  customer_limit_group: '客群分组',
  age_limit: '年龄限制',
  child_applicable: '儿童适用',
  baby_applicable: '婴儿适用',
  realname_required: '实名要求',
  realname_limit: '实名限制',
  id_type_restriction: '证件类型限制',
  document_restrictions: '证件限制',
  sign_and_transfer_rules: '签转规则',
  refund_rules: '退票规则',
  refund_change_note: '退改说明',
  change_rules: '变更规则',
  commission_rate: '代理费率',
  rounding_rule: '取整规则',
  fc_fn_fp_note: 'FC/FN/FP备注',
  manual_confirm_fields: '人工确认项',
  office_scope: 'OFFICE范围',
  office_count: 'OFFICE数量',
  route_row_count: '航线行数',
  unique_route_count: '唯一航线数',
  flight_count: '航班数',
  amount_tiers: '金额档位',
  amount_range: '金额范围',
  price_tiers_count: '价格档位数',
  top_5_hubs: 'TOP5枢纽',
  usage_times: '使用次数',
  travel_class: '舱等',
  product_show: '权益卡展示文案',
  json_count: '拆分JSON数',
  use_limit: '兑换限制',
  use_begin: '兑换开启时间',
  wether_depart_today: '是否含起飞当日',
  membership_limit: '会员限制',
  refund_time: '未兑换退款日期',
  luggage_amount: '行李额',
  benefit_name: '权益名称',
  benefit_usage_rules: '权益使用规则',
  not_applicable_flight_routes: '不适用航班/航线明细',
  price_groups_summary: '价格组汇总',
  use_code: '兑换标识',
};
const FIELD_LABEL_TO_KEY = Object.fromEntries(Object.entries(KEY_LABELS).map(([key, label]) => [label, key]));
const JSON_FIELD_CANDIDATES = ['解析JSON', '解析结果', '结构化结果', 'JSON'];
const FIELD_DEFINITIONS_KEY = '_field_definitions';

function canonicalizeFieldName(field) {
  return FIELD_LABEL_TO_KEY[field] || field;
}

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

// ---- 创建飞书记录 ----
async function createFeishuRecord(fields) {
  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields }),
  });

  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`创建飞书记录失败: ${data.msg} (code=${data.code})`);
  }
  return data.data.record;
}

// ---- 删除飞书记录 ----
async function deleteFeishuRecord(recordId) {
  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BASE_TOKEN}/tables/${TABLE_ID}/records/${recordId}`;

  const resp = await fetch(url, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`删除飞书记录失败: ${data.msg} (code=${data.code})`);
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
  { field_name: '问题标记', type: 1 },
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

function appendProblemLine(rawProblemMarks, line) {
  const lines = normalizeFeishuValue(rawProblemMarks).split('\n').filter(Boolean);
  if (line && !lines.includes(line)) lines.push(line);
  return lines.join('\n');
}

function formatProblemMarks(entries) {
  if (!Array.isArray(entries)) return normalizeFeishuValue(entries);
  return entries
    .map(e => {
      if (typeof e === 'string') return e;
      const time = e.created_at || e.time || '';
      const user = e.created_by || e.user || '';
      const label = e.field_label || e.fieldLabel || e.field || '文件整体';
      const desc = e.desc || e.reason || '';
      return `[${time}] ${user} | ${label}: ${desc}`.trim();
    })
    .filter(Boolean)
    .join('\n');
}

function normalizeChangeEntry(entry, fallback) {
  const src = entry && typeof entry === 'object' ? entry : {};
  return {
    time: src.time || fallback.time || new Date().toLocaleString('zh-CN', { hour12: false }),
    user: src.user || fallback.user || '',
    fieldLabel: src.fieldLabel || src.field || fallback.fieldLabel || fallback.field || '',
    field: src.field || fallback.field || src.fieldLabel || fallback.fieldLabel || '',
    oldValue: src.oldValue !== undefined ? src.oldValue : (fallback.oldValue || ''),
    newValue: src.newValue !== undefined ? src.newValue : (fallback.newValue || ''),
    reason: src.reason || fallback.reason || '',
  };
}

function normalizeFeishuValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value.map(normalizeFeishuValue).filter(Boolean).join('、');
  }
  if (typeof value === 'object') {
    if (value.text !== undefined) return normalizeFeishuValue(value.text);
    if (value.name !== undefined) return normalizeFeishuValue(value.name);
    if (value.value !== undefined) return normalizeFeishuValue(value.value);
    if (value.link !== undefined) return normalizeFeishuValue(value.link);
    return JSON.stringify(value);
  }
  return String(value);
}

function cleanManualConfirmText(raw) {
  const text = normalizeFeishuValue(raw).trim();
  if (!text) return '';
  return text
    .split(/[；;\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !/^依据原文出现/.test(part))
    .filter(part => !/按旗舰店(?:code)?政策审核/.test(part))
    .filter(part => !/旗舰店不解析PAT[:：]?A|旗舰店不解析出票指令|旗舰店不看出票指令/.test(part))
    .filter(part => !/^分类依据[:：]/.test(part))
    .join('；');
}

function getJsonFieldName(fields) {
  if (!fields) return '';
  return JSON_FIELD_CANDIDATES.find(name => Object.prototype.hasOwnProperty.call(fields, name)) || '';
}

function parseJsonField(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const text = normalizeFeishuValue(raw).trim();
  if (!text) return null;
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) {
      try { return JSON.parse(match[1]); } catch (_) { /* ignore */ }
    }
  }
  return null;
}

function stringifyJsonField(value) {
  return JSON.stringify(value, null, 2);
}

function setParsedFieldDefinition(obj, key, fieldDefinition) {
  if (!obj || typeof obj !== 'object' || !key || !fieldDefinition) return false;
  const next = {
    label: fieldDefinition.label || KEY_LABELS[key] || key,
    json_key: key,
    value_type: fieldDefinition.value_type || fieldDefinition.format || 'string',
    file_type: fieldDefinition.file_type || fieldDefinition.fileType || '',
    description: fieldDefinition.description || fieldDefinition.summary || '',
    logic: fieldDefinition.logic || '',
  };
  if (!obj[FIELD_DEFINITIONS_KEY] || typeof obj[FIELD_DEFINITIONS_KEY] !== 'object' || Array.isArray(obj[FIELD_DEFINITIONS_KEY])) {
    obj[FIELD_DEFINITIONS_KEY] = {};
  }
  const old = obj[FIELD_DEFINITIONS_KEY][key];
  if (JSON.stringify(old || {}) !== JSON.stringify(next)) {
    obj[FIELD_DEFINITIONS_KEY][key] = next;
    return true;
  }
  return false;
}

function setParsedField(parsed, key, value, fieldDefinition) {
  if (!parsed || !key) return false;
  let changed = false;
  const applyOne = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (normalizeFeishuValue(obj[key]) !== normalizeFeishuValue(value)) {
      obj[key] = value;
      changed = true;
    }
    if (obj.data && typeof obj.data === 'object' && normalizeFeishuValue(obj.data[key]) !== normalizeFeishuValue(value)) {
      obj.data[key] = value;
      changed = true;
    }
    if (fieldDefinition) {
      changed = setParsedFieldDefinition(obj, key, fieldDefinition) || changed;
      if (obj.data && typeof obj.data === 'object') {
        changed = setParsedFieldDefinition(obj.data, key, fieldDefinition) || changed;
      }
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(applyOne);
  else applyOne(parsed);
  return changed;
}

function deleteParsedField(parsed, key) {
  if (!parsed || !key) return false;
  let changed = false;
  const applyOne = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      delete obj[key];
      changed = true;
    }
    if (obj.data && typeof obj.data === 'object' && Object.prototype.hasOwnProperty.call(obj.data, key)) {
      delete obj.data[key];
      changed = true;
    }
    if (obj[FIELD_DEFINITIONS_KEY] && typeof obj[FIELD_DEFINITIONS_KEY] === 'object' && Object.prototype.hasOwnProperty.call(obj[FIELD_DEFINITIONS_KEY], key)) {
      delete obj[FIELD_DEFINITIONS_KEY][key];
      changed = true;
    }
    if (obj.data && obj.data[FIELD_DEFINITIONS_KEY] && typeof obj.data[FIELD_DEFINITIONS_KEY] === 'object' && Object.prototype.hasOwnProperty.call(obj.data[FIELD_DEFINITIONS_KEY], key)) {
      delete obj.data[FIELD_DEFINITIONS_KEY][key];
      changed = true;
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(applyOne);
  else applyOne(parsed);
  return changed;
}

function setParsedFieldDefinitionOnly(parsed, key, fieldDefinition) {
  if (!parsed || !key || !fieldDefinition) return false;
  let changed = false;
  const applyOne = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    changed = setParsedFieldDefinition(obj, key, fieldDefinition) || changed;
    if (obj.data && typeof obj.data === 'object') {
      changed = setParsedFieldDefinition(obj.data, key, fieldDefinition) || changed;
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(applyOne);
  else applyOne(parsed);
  return changed;
}

function getParsedValue(parsed, key) {
  if (!parsed || !key) return '';
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || typeof first !== 'object') return '';
  if (first[key] !== undefined) return normalizeFeishuValue(first[key]);
  if (first.data && first.data[key] !== undefined) return normalizeFeishuValue(first.data[key]);
  return '';
}

function manualConfirmPatternForField(fieldKey, fieldLabel) {
  const label = normalizeFeishuValue(fieldLabel || KEY_LABELS[fieldKey] || fieldKey);
  const patterns = {
    sale_date: /销售|售卖|出票日期|出票时间/,
    depart_date: /航班日期|旅行|出行|乘机|航班时间|适用日期/,
    use_date: /兑换|使用日期|使用时间/,
    redeem_date: /兑换|使用日期|使用时间/,
    booking_cabin: /适用舱位|订座舱位|舱位/,
    cabin: /适用舱位|订座舱位|舱位/,
    od: /航线范围|具体航线|航线金额|航线表|航线/,
    flight_type: /航程/,
    discount_per: /直减|优惠|金额|价格|比例/,
    age_limit: /年龄|周岁/,
    document_restrictions: /证件|身份证/,
  };
  if (patterns[fieldKey]) return patterns[fieldKey];
  if (label && label !== fieldKey) {
    return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  return null;
}

function stripManualConfirmForField(raw, fieldKey, fieldLabel) {
  const text = cleanManualConfirmText(raw);
  if (!text) return text;
  const pattern = manualConfirmPatternForField(fieldKey, fieldLabel);
  if (!pattern) return text;
  return text
    .split(/[；;\n]+/)
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => !pattern.test(part))
    .join('；');
}

function clearParsedManualConfirmForField(parsed, fieldKey, fieldLabel) {
  if (!parsed || !fieldKey) return false;
  let changed = false;
  const applyOne = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const next = stripManualConfirmForField(obj.manual_confirm_fields, fieldKey, fieldLabel);
    if (normalizeFeishuValue(obj.manual_confirm_fields) !== next) {
      obj.manual_confirm_fields = next;
      changed = true;
    }
    if (obj.data && typeof obj.data === 'object') {
      const dataNext = stripManualConfirmForField(obj.data.manual_confirm_fields, fieldKey, fieldLabel);
      if (normalizeFeishuValue(obj.data.manual_confirm_fields) !== dataNext) {
        obj.data.manual_confirm_fields = dataNext;
        changed = true;
      }
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(applyOne);
  else applyOne(parsed);
  return changed;
}

function cleanParsedManualConfirm(parsed) {
  if (!parsed) return false;
  let changed = false;
  const applyOne = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    const next = cleanManualConfirmText(obj.manual_confirm_fields);
    if (normalizeFeishuValue(obj.manual_confirm_fields) !== next) {
      obj.manual_confirm_fields = next;
      changed = true;
    }
    if (obj.data && typeof obj.data === 'object') {
      const dataNext = cleanManualConfirmText(obj.data.manual_confirm_fields);
      if (normalizeFeishuValue(obj.data.manual_confirm_fields) !== dataNext) {
        obj.data.manual_confirm_fields = dataNext;
        changed = true;
      }
    }
  };
  if (Array.isArray(parsed)) parsed.forEach(applyOne);
  else applyOne(parsed);
  return changed;
}

function appendManualNote(parsed, note) {
  if (!parsed || !note) return false;
  const appendOne = (obj) => {
    if (!obj || typeof obj !== 'object') return false;
    const prev = cleanManualConfirmText(obj.manual_confirm_fields);
    if (prev.includes(note)) return false;
    obj.manual_confirm_fields = prev ? `${prev}；${note}` : note;
    return true;
  };
  if (Array.isArray(parsed)) return parsed.map(appendOne).some(Boolean);
  return appendOne(parsed);
}

function isPendingReview(fields) {
  const st = normalizeFeishuValue(fields && fields['审核状态']);
  return st !== '已确认';
}

function getFileName(fields, parsed) {
  return normalizeFeishuValue((fields && (fields['文件名称'] || fields['文件名'])) || getParsedValue(parsed, 'file_name'));
}

function getPolicyText(fields, parsed) {
  return [
    getFileName(fields, parsed),
    normalizeFeishuValue(fields && (fields['原始文本'] || fields['源文本'] || fields['文件内容'] || fields['解析文本'])),
    normalizeFeishuValue(getParsedValue(parsed, 'product_name')),
    normalizeFeishuValue(getParsedValue(parsed, 'scenario')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_family')),
  ].filter(Boolean).join('\n');
}

function getPolicyFileType(fields, parsed) {
  const text = [
    getFileName(fields, parsed),
    normalizeFeishuValue(fields && fields['解析场景']),
    normalizeFeishuValue(fields && fields['产品名称']),
    normalizeFeishuValue(getParsedValue(parsed, 'scenario')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_family')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_category')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_name')),
  ].filter(Boolean).join(' ');
  if (/次卡|权益卡|共享卡|畅游卡|无限飞|往返卡/.test(text)) return '次卡';
  if (/旗舰店/.test(text)) return /券类|优惠券|券码|资源券|coupon/i.test(text) ? '旗舰店券类' : '旗舰店code';
  return '自营';
}

function isBlankish(value) {
  const text = normalizeFeishuValue(value).trim();
  return !text ||
    ['null', 'undefined', '待确认', '需人工确认', '人工确认', '未提取', '未识别', '无法确认', '未获取', '(空)', '空', '暂无'].includes(text) ||
    /^(待确认|需人工确认|人工确认|未提取|未识别|无法确认|未获取)/.test(text);
}

function sameScope(sourceParsed, targetParsed) {
  const sourceScenario = getParsedValue(sourceParsed, 'scenario');
  const targetScenario = getParsedValue(targetParsed, 'scenario');
  if (sourceScenario && targetScenario && sourceScenario !== targetScenario) return false;

  const sourceCarrier = getParsedValue(sourceParsed, 'carrier') || getParsedValue(sourceParsed, 'carrier_name');
  const targetCarrier = getParsedValue(targetParsed, 'carrier') || getParsedValue(targetParsed, 'carrier_name');
  if (sourceCarrier && targetCarrier && sourceCarrier !== targetCarrier) return false;

  return true;
}

function inferDateRangeFromTitle(text, fieldKey) {
  if (!text) return '';
  const yearMatch = text.match(/(20\d{2})/);
  if (!yearMatch) return '';
  const year = Number(yearMatch[1]);
  const rangeMatch = text.match(/[（(]\s*(\d{1,2})[.\-/月](\d{1,2})日?\s*[-~至—]\s*(\d{1,2})[.\-/月](\d{1,2})日?\s*[）)]/);
  if (!rangeMatch) return '';
  const [, sm, sd, em, ed] = rangeMatch.map(String);
  const start = `${year}-${sm.padStart(2, '0')}-${sd.padStart(2, '0')}`;
  const endYear = Number(em) < Number(sm) ? year + 1 : year;
  const end = `${endYear}-${em.padStart(2, '0')}-${ed.padStart(2, '0')}`;
  return `${start}至${end}`;
}

function parseRecordDate(fields) {
  const raw = normalizeFeishuValue(fields && (fields['解析时间'] || fields['创建时间'] || fields['更新时间']));
  const m = raw.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function extractDocumentDate(text) {
  const patterns = [
    /(?:发布日期|发布日|发文日期|签发日期|下发日期|通知日期|日期)[:：\s]*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/,
    /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日.{0,30}(?:发布|下发|签发|生效)/,
    /(?:发布日期|发布日|发文日期|签发日期|下发日期|通知日期|日期)[:：\s]*(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }
  return '';
}

function compareDate(a, b) {
  if (!a || !b) return 0;
  return a.localeCompare(b);
}

function inferRelativeStartDateRange(fields, parsed, fieldKey) {
  const text = getPolicyText(fields, parsed);
  if (!/(即日起|上线之日起|产品生效之日起|自下发之日起|自发布之日起|本通告自下发之日起生效)/.test(text)) return '';
  const parseDate = parseRecordDate(fields);
  const docDate = extractDocumentDate(text);
  const endMatch = text.match(/(?:至|到|截止至|截至|有效期至)\s*(20\d{2})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})日?/);
  const end = endMatch ? `${endMatch[1]}-${endMatch[2].padStart(2, '0')}-${endMatch[3].padStart(2, '0')}` : '';
  const start = (end && compareDate(parseDate, end) > 0) ? docDate : (docDate || parseDate);
  if (!start) return '';
  if (end && compareDate(start, end) > 0) return '';
  if (end) return `${start}至${end}`;
  if (['sale_date', 'depart_date', 'use_date', 'redeem_date'].includes(fieldKey)) return `${start}起`;
  return '';
}

function classifyCorrection(fieldKey, fieldLabel, reason, newValue) {
  const text = `${fieldKey} ${fieldLabel || ''} ${reason || ''} ${newValue || ''}`;
  if (fieldKey === 'product_type' && /成人|儿童|CH|PAT[:：]?A/i.test(text) && /PAT[:：]?A/i.test(text)) {
    return {
      type: '自营PAT指令完整性规则',
      rule: '自营场景 product_type 必须完整保留成人和儿童 PAT 指令；原文同时出现成人 PAT:A、儿童 PAT:A*CH 等指令时，应同时输出成人与儿童指令，不得只保留其中一项。',
    };
  }
  if (/证件|身份证|年龄|青年|长者|银发|学生/.test(text) && fieldKey === 'document_restrictions') {
    return {
      type: '年龄限制产品证件默认规则',
      rule: '存在年龄限制的供应平台产品，证件限制默认补为居民身份证，除非原文明确允许其他证件。',
    };
  }
  if (/旗舰店|出票指令|PAT[:：]?A|pata/i.test(text) && ['product_type', 'product_code', 'manual_confirm_fields'].includes(fieldKey)) {
    return {
      type: '旗舰店忽略出票指令规则',
      rule: '旗舰店 code 场景不把 PAT:A/出票指令作为录入字段，也不因为缺少出票指令标记待确认。',
    };
  }
  if (/次卡|销售日期|售卖日期|购卡日期|航班日期|旅行日期|出行日期|结束时间|结束日期/.test(text) && ['sale_date', 'depart_date', 'use_date', 'redeem_date'].includes(fieldKey)) {
    return {
      type: '次卡日期完整性规则',
      rule: '次卡必须分别输出销售/兑换/航班日期；只识别到截止日时不得留空，标题期间可用于补齐旅行日期并保留人工复核说明。',
    };
  }
  if (['sign_and_transfer_rules', 'refund_rules', 'change_rules'].includes(fieldKey)) {
    return {
      type: '退改签原文拆分规则',
      rule: '退票、变更、签转必须从当前文件原文逐条拆分：改期/变更/升舱进入变更规则，签转/外航/EI不签转进入签转规则，退票/退款/权益取消进入退票规则；合并标题不得作为字段值，也不得跨文件自动套用。',
    };
  }
  return {
    type: '字段修改原因沉淀规则',
    rule: `当同场景、同航司待审文件命中相同字段问题，且当前值为空或等于旧值时，按人工修改原因修正「${fieldLabel || fieldKey}」。`,
  };
}

function reasonLooksGeneral(reason) {
  return /默认|统一|所有|只要|一律|应该|必须|不应该|不能|缺少|漏|补齐|字段|规则|旗舰店|次卡/.test(reason || '');
}

function isSystemGeneratedChange(reqBody = {}, reason = '') {
  const source = String(reqBody.source || reqBody.changeSource || '').toLowerCase();
  const user = normalizeFeishuValue(reqBody.user || (reqBody.changeEntry && reqBody.changeEntry.user));
  return !!(
    reqBody.autoGenerated ||
    reqBody.systemGenerated ||
    reqBody.autoCorrection ||
    /AUTO_RULE|^系统$|^auto/i.test(user) ||
    ['system', 'auto', 'ai', 'batch', 'auto_rule'].includes(source) ||
    /^自动/.test(reason || '') ||
    /^系统回滚/.test(reason || '')
  );
}

function splitProblemMarkEntries(raw) {
  const lines = String(raw || '').split('\n').filter(line => line.trim());
  const entries = [];
  let current = '';
  const entryStart = /^\[\d{4}[-/]\d{1,2}[-/]\d{1,2}[^\]]*\]/;
  for (const line of lines) {
    const trimmed = line.trim();
    if (entryStart.test(trimmed)) {
      if (current) entries.push(current);
      current = trimmed;
    } else if (current) {
      current += `\n${trimmed}`;
    } else {
      current = trimmed;
    }
  }
  if (current) entries.push(current);
  return entries;
}

function isSystemProblemEntry(entry) {
  const text = String(entry || '');
  return /AUTO_RULE|自动矫正|按当前原文复核拆分/.test(text);
}

function filterManualProblemMarks(raw) {
  return splitProblemMarkEntries(raw).filter(entry => !isSystemProblemEntry(entry)).join('\n');
}

function deriveAutoValue({ ruleType, fieldKey, newValue, targetFields, targetParsed }) {
  const targetText = getPolicyText(targetFields, targetParsed);
  if (ruleType === '年龄限制产品证件默认规则') {
    const age = getParsedValue(targetParsed, 'age_limit');
    if (!age && !/青年|长者|银发|学生|年龄|周岁|身份证第7-14位/.test(targetText)) return null;
    return '居民身份证';
  }
  if (ruleType === '旗舰店忽略出票指令规则') {
    const scenario = getParsedValue(targetParsed, 'scenario');
    const current = getParsedValue(targetParsed, fieldKey);
    if (!/旗舰店/.test(scenario || targetText)) return null;
    if (!/PAT[:：]?A|成人[:：]?PAT|出票指令|运价计算/i.test(current)) return null;
    return newValue;
  }
  if (ruleType === '自营PAT指令完整性规则') {
    const scenario = getParsedValue(targetParsed, 'scenario');
    if (/旗舰店/.test(scenario || targetText)) return null;
    if (!/PAT[:：]?A|出票指令|运价计算|成人|儿童|CH/i.test(targetText)) return null;
    return newValue;
  }
  if (ruleType === '次卡日期完整性规则') {
    if (!/次卡|权益卡|共享卡|畅游卡|往返卡|无限飞/.test(targetText)) return null;
    const relative = inferRelativeStartDateRange(targetFields, targetParsed, fieldKey);
    if (relative) return relative;
    const inferred = inferDateRangeFromTitle(targetText, fieldKey);
    return inferred || null;
  }
  return newValue;
}

async function listAllFeishuRecords() {
  const token = await getUserAccessToken();
  const records = [];
  let offset = 0;
  const pageSize = 200;
  let guard = 0;
  let hasMore = false;
  do {
    const url = `https://open.feishu.cn/open-apis/base/v3/bases/${BASE_TOKEN}/tables/${TABLE_ID}/records?limit=${pageSize}&offset=${offset}`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
    const body = await resp.json();
    if (body.code !== 0) {
      throw new Error(`读取记录失败: ${body.msg} (code=${body.code})`);
    }
    const inner = body.data || {};
    const fieldNames = inner.fields || [];
    const ids = inner.record_id_list || [];
    const rows = inner.data || [];
    rows.forEach((row, i) => {
      const recordId = ids[i];
      if (!recordId) return;
      const fields = {};
      fieldNames.forEach((name, j) => { fields[name] = row[j]; });
      records.push({ recordId, fields });
    });
    hasMore = !!inner.has_more && rows.length > 0;
    offset += rows.length;
    guard++;
  } while (hasMore && guard < 20);
  return records;
}

function textDocBlock(content, blockType = 2) {
  return {
    block_type: blockType,
    text: {
      elements: [
        { text_run: { content: String(content || ''), text_element_style: {} } },
      ],
      style: {},
    },
  };
}

async function resolveDocxToken(token, accessToken) {
  if (!token) return '';
  try {
    const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(token)}`;
    const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
    const data = await resp.json();
    const node = data.data && data.data.node;
    if (data.code === 0 && node && node.obj_token && (!node.obj_type || node.obj_type === 'docx')) {
      return node.obj_token;
    }
  } catch (e) {
    console.warn('[版本记录] wiki token 解析失败，尝试直接作为 docx token:', e.message);
  }
  return token;
}

async function appendVersionUpdateRecord(record) {
  const targetToken = VERSION_RECORD_DOC_TOKEN || KNOWLEDGE_DOC_ID;
  if (!targetToken) return { ok: false, skipped: true };
  try {
    const token = await getUserAccessToken();
    const documentId = await resolveDocxToken(targetToken, token);
    const updatedFiles = [
      record.fileName ? `${record.fileName}（主文件解析结果）` : '',
      ...(record.autoFiles || []).map(name => `${name}（待审文件自动矫正）`),
    ].filter(Boolean);
    const lines = [
      `版本更新记录｜${record.time || new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `更新时间：${record.time || new Date().toLocaleString('zh-CN', { hour12: false })}`,
      `操作人：${record.userName || ''}`,
      `触发文件：${record.fileName || ''}`,
      `字段：${record.fieldLabel || ''}`,
      `更新内容：${record.oldValue || '(空)'} -> ${record.newValue || '(空)'}`,
      `修改原因：${record.reason || ''}`,
      `学习结论：${record.rule || ''}`,
      `规则类型：${record.ruleType || ''}`,
      `更新文件解析结果：${updatedFiles.length ? updatedFiles.join('；') : '无'}`,
      `相关待审文件自动矫正：${record.autoApplied || 0} 份`,
      record.autoFiles && record.autoFiles.length ? `待审文件清单：${record.autoFiles.join('；')}` : '待审文件清单：无',
    ].filter(Boolean);
    const body = {
      index: -1,
      children: [
        textDocBlock(lines[0], 4),
        ...lines.slice(1).map(line => textDocBlock(line, 2)),
      ],
    };
    const url = `https://open.feishu.cn/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (data.code !== 0) {
      throw new Error(`${data.msg || 'unknown'} (code=${data.code})`);
    }
    return { ok: true };
  } catch (e) {
    console.warn('[版本记录] 写入失败:', e.message);
    return { ok: false, error: e.message };
  }
}

async function autoCorrectPendingRecords({ sourceRecordId, sourceFields, sourceParsed, fieldKey, fieldLabel, oldValue, newValue, reason, userName }) {
  if (/^新增字段[:：]/.test(reason || '')) {
    return {
      applied: 0,
      files: [],
      skipped: true,
      ruleType: '新增字段定义沉淀规则',
      rule: '新增字段仅沉淀中文名、JSON key、字段值和判断逻辑；其它文件必须按各自原文重新解析，不跨文件复制当前字段值。',
      reason: '新增字段不做跨文件自动改值',
    };
  }
  if (!fieldKey || !reasonLooksGeneral(reason)) {
    return { applied: 0, files: [], skipped: true, reason: '修改原因不是可泛化规则' };
  }
  const sourceTextBoundFields = new Set(['sign_and_transfer_rules', 'refund_rules', 'change_rules']);
  if (sourceTextBoundFields.has(fieldKey)) {
    return {
      applied: 0,
      files: [],
      skipped: true,
      reason: '退票/变更/签转字段必须按当前原文逐条拆分，不做跨文件自动矫正',
    };
  }

  const rule = classifyCorrection(fieldKey, fieldLabel, reason, newValue);
  if (rule.type === '字段修改原因沉淀规则') {
    return {
      applied: 0,
      files: [],
      skipped: true,
      ruleType: rule.type,
      rule: rule.rule,
      reason: '默认沉淀规则只写入知识图谱，不直接跨文件改值',
    };
  }

  const all = await listAllFeishuRecords();
  const applied = [];

  for (const item of all) {
    if (applied.length >= AUTO_CORRECTION_LIMIT) break;
    if (item.recordId === sourceRecordId) continue;
    if (!isPendingReview(item.fields)) continue;

    const jsonFieldName = getJsonFieldName(item.fields);
    const targetParsed = parseJsonField(jsonFieldName ? item.fields[jsonFieldName] : null);
    if (!targetParsed || !sameScope(sourceParsed, targetParsed)) continue;

    const current = getParsedValue(targetParsed, fieldKey) || normalizeFeishuValue(item.fields[fieldLabel]);
    const canOverwrite = isBlankish(current) || normalizeFeishuValue(current) === normalizeFeishuValue(oldValue) || rule.type !== '字段修改原因沉淀规则';
    if (!canOverwrite) continue;

    const autoValue = deriveAutoValue({ ruleType: rule.type, fieldKey, newValue, targetFields: item.fields, targetParsed });
    if (autoValue === null || autoValue === undefined || normalizeFeishuValue(autoValue) === normalizeFeishuValue(current)) continue;

    const changedJson = setParsedField(targetParsed, fieldKey, autoValue);
    if (!changedJson) continue;
    if (rule.type === '次卡日期完整性规则') {
      appendManualNote(targetParsed, `${fieldLabel}由标题/文件名期间自动补齐，需人工复核`);
    }

    const rawHistory = item.fields['修改历史'];
    const history = parseChangeHistory(rawHistory);
    const entry = {
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      user: 'AUTO_RULE',
      fieldLabel,
      oldValue: current,
      newValue: autoValue,
      reason: `自动矫正：基于「${getFileName(sourceFields, sourceParsed) || sourceRecordId}」的修改原因「${reason}」；规则=${rule.type}`,
    };
    history.push(entry);

    const fieldsToUpdate = {
      '已修改': '是',
      '修改历史': formatChangeHistory(history),
    };
    if (jsonFieldName && state.tableFields && state.tableFields.includes(jsonFieldName)) {
      fieldsToUpdate[jsonFieldName] = stringifyJsonField(targetParsed);
    }
    if (fieldLabel && state.tableFields && state.tableFields.includes(fieldLabel)) {
      fieldsToUpdate[fieldLabel] = normalizeFeishuValue(autoValue);
    }
    if (rule.type === '次卡日期完整性规则' && state.tableFields && state.tableFields.includes('人工确认项')) {
      fieldsToUpdate['人工确认项'] = getParsedValue(targetParsed, 'manual_confirm_fields');
    }

    await updateFeishuRecord(item.recordId, fieldsToUpdate);
    applied.push({
      recordId: item.recordId,
      fileName: getFileName(item.fields, targetParsed),
      newValue: normalizeFeishuValue(autoValue),
    });
  }

  return {
    applied: applied.length,
    files: applied.map(x => x.fileName || x.recordId),
    ruleType: rule.type,
    rule: rule.rule,
  };
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
    // 授权成功后打印 refresh_token，供配置 FEISHU_REFRESH_TOKEN 环境变量使用（Render 日志可见，私密勿外泄）
    console.log('[OAuth] refresh_token:', data.data.refresh_token);

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

// ---- 恢复为待确认 ----
app.post('/api/reopen', async (req, res) => {
  const { recordId, fileName } = req.body;

  if (!recordId) {
    return res.status(400).json({ success: false, error: '缺少 recordId' });
  }

  console.log(`[恢复待确认] ${fileName || recordId}`);

  try {
    // 确保扩展字段存在，便于清空确认人信息
    try { await ensureTableFields(); } catch (e) { console.warn('[恢复待确认] 检查字段失败:', e.message); }

    const fields = {
      '审核状态': '待审核',
      '确认时间': null,
      '确认人': '',
      '确认人ID': '',
    };

    await updateFeishuRecord(recordId, fields);

    console.log(`[恢复待确认] ✓ ${fileName || recordId}`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[恢复待确认] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 保存字段修改（含修改原因 + 修改历史 + 已修改标识） ----
app.post('/api/save-field', async (req, res) => {
  const { recordId, fieldLabel, fieldKey: requestedFieldKey, newValue, reason, changeEntry, deleteField, fieldDefinition } = req.body;
  const systemGenerated = isSystemGeneratedChange(req.body, reason || (changeEntry && changeEntry.reason) || '');

  if (!recordId) {
    return res.status(400).json({ success: false, error: '缺少 recordId' });
  }

  try {
    // 确保扩展字段存在
    try { await ensureTableFields(); } catch (e) { console.warn('[保存字段] 检查字段失败:', e.message); }

    // 获取当前用户
    let user = null;
    try { user = await getCurrentUser(); } catch (e) { /* 忽略 */ }

    // 读取现有记录，合并修改历史，并同步修正解析JSON
    let existingHistory = [];
    let record = null;
    let sourceFields = {};
    let sourceParsed = null;
    let jsonFieldName = '';
    const fieldKey = requestedFieldKey || FIELD_LABEL_TO_KEY[fieldLabel] || fieldLabel;
    try {
      record = await getFeishuRecord(recordId);
      sourceFields = record.fields || {};
      const rawHistory = sourceFields['修改历史'];
      existingHistory = parseChangeHistory(rawHistory);
      jsonFieldName = getJsonFieldName(sourceFields);
      sourceParsed = parseJsonField(jsonFieldName ? sourceFields[jsonFieldName] : null);
    } catch (e) {
      console.warn('[保存字段] 读取现有历史失败，从头开始:', e.message);
    }

    // 构造新变更条目。前端历史可能漏传 user，后端必须用当前飞书授权用户兜底，
    // 否则页面/表格里会出现有修改但无法追溯修改人的空记录。
    const entry = normalizeChangeEntry(changeEntry, {
      time: new Date().toLocaleString('zh-CN', { hour12: false }),
      user: user ? user.name : '',
      fieldLabel: fieldLabel || '',
      field: fieldLabel || '',
      oldValue: '',
      newValue: newValue !== undefined ? String(newValue) : '',
      reason: reason || '',
    });

    existingHistory.push(entry);
    const historyText = formatChangeHistory(existingHistory);
    const oldText = normalizeFeishuValue(entry.oldValue);
    const isFieldAddition = /^新增字段[:：]/.test(entry.reason || '') || oldText === '' || oldText === '(空)' || oldText === '空';
    const isFieldDeletion = !!deleteField || /^删除字段[:：]/.test(entry.reason || '');
    const isEffectiveChange = normalizeFeishuValue(entry.oldValue) !== normalizeFeishuValue(entry.newValue);
    const autoProblemLine = isEffectiveChange
      ? `[${entry.time}] ${entry.user || (user ? user.name : '')} | ${entry.fieldLabel || fieldLabel || fieldKey}: ${isFieldDeletion ? '删除字段' : (isFieldAddition ? '新增字段' : '字段修改')}：${entry.oldValue || '(空)'} → ${entry.newValue || '(空)'}；原因：${entry.reason || '未填写'}`
      : '';

    // 更新飞书字段（仅更新表格中实际存在的字段）
    const fields = {
      '已修改': '是',
      '修改历史': historyText,
    };
    if (autoProblemLine && !systemGenerated) {
      fields['问题标记'] = appendProblemLine(sourceFields['问题标记'], autoProblemLine);
    }
    if (fieldLabel && state.tableFields && state.tableFields.includes(fieldLabel)) {
      fields[fieldLabel] = newValue !== undefined ? String(newValue) : '';
    } else if (fieldLabel) {
      console.warn(`[保存字段] 表格中不存在字段「${fieldLabel}」，仅记录修改历史`);
    }

    let changedJson = false;
    if (sourceParsed && fieldKey) {
      changedJson = deleteField
        ? deleteParsedField(sourceParsed, fieldKey)
        : setParsedField(sourceParsed, fieldKey, newValue !== undefined ? String(newValue) : '', fieldDefinition);
    }
    if (!deleteField && fieldKey && !isBlankish(newValue)) {
      const cleanedManual = stripManualConfirmForField(sourceFields['人工确认项'], fieldKey, fieldLabel);
      if (normalizeFeishuValue(sourceFields['人工确认项']) !== cleanedManual && state.tableFields && state.tableFields.includes('人工确认项')) {
        fields['人工确认项'] = cleanedManual;
      }
      if (sourceParsed) {
        changedJson = clearParsedManualConfirmForField(sourceParsed, fieldKey, fieldLabel) || changedJson;
      }
    }
    if (changedJson && jsonFieldName && state.tableFields && state.tableFields.includes(jsonFieldName)) {
      fields[jsonFieldName] = stringifyJsonField(sourceParsed);
    }

    await updateFeishuRecord(recordId, fields);

    console.log(`[保存字段] ✓ 主记录已保存 ${fieldLabel || ''} 原因: ${reason || '(无)'} 历史${existingHistory.length}条，后台继续自动矫正/知识沉淀`);
    res.json({
      success: true,
      historyCount: existingHistory.length,
      savedToFeishu: true,
      background: {
        autoCorrection: !!sourceParsed,
        knowledge: true,
      },
    });

    setImmediate(() => {
      (async () => {
        let autoCorrection = { applied: 0, files: [] };
        const knowledge = {
          ok: false,
          skipped: true,
        };
        try {
          if (sourceParsed && !systemGenerated) {
            autoCorrection = await autoCorrectPendingRecords({
              sourceRecordId: recordId,
              sourceFields,
              sourceParsed,
              fieldKey,
              fieldLabel,
              oldValue: entry.oldValue || '',
              newValue: newValue !== undefined ? String(newValue) : '',
              reason: reason || '',
              userName: user ? user.name : '',
            });
          }
        } catch (e) {
          autoCorrection = { applied: 0, files: [], error: e.message };
          console.warn('[自动矫正] 失败:', e.message);
        }

        try {
          if (!systemGenerated) {
            const rule = classifyCorrection(fieldKey, fieldLabel, reason, newValue);
            Object.assign(knowledge, await appendVersionUpdateRecord({
              time: new Date().toLocaleString('zh-CN', { hour12: false }),
              fileName: getFileName(sourceFields, sourceParsed),
              userName: user ? user.name : '',
              fieldLabel,
              oldValue: entry.oldValue || '',
              newValue: newValue !== undefined ? String(newValue) : '',
              reason: reason || '',
              ruleType: autoCorrection.ruleType || rule.type,
              rule: autoCorrection.rule || rule.rule,
              autoApplied: autoCorrection.applied || 0,
              autoFiles: autoCorrection.files || [],
            }));
          } else {
            knowledge.skipped = true;
            knowledge.reason = '系统自动矫正不沉淀为人工学习记录';
          }
        } catch (e) {
          knowledge.ok = false;
          knowledge.error = e.message;
          console.warn('[版本记录] 记录生成失败:', e.message);
        }

        console.log(`[保存字段后台] ✓ ${fieldLabel || ''} 自动矫正${autoCorrection.applied || 0}条 版本记录${knowledge.ok ? '已写入' : '未写入'}`);
      })().catch(e => {
        console.warn('[保存字段后台] 异常:', e.message);
      });
    });
  } catch (err) {
    console.error(`[保存字段] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 按文件类型同步字段定义：只同步 schema，不同步当前文件字段值 ----
app.post('/api/apply-field-definition', async (req, res) => {
  const { sourceRecordId, fieldKey, fieldDefinition } = req.body || {};
  if (!fieldKey || !fieldDefinition || !fieldDefinition.file_type) {
    return res.status(400).json({ success: false, error: '缺少 fieldKey 或 fieldDefinition.file_type' });
  }

  try {
    try { await ensureTableFields(); } catch (e) { console.warn('[字段定义] 检查字段失败:', e.message); }
    const records = await listAllFeishuRecords();
    let updated = 0;
    const targetType = fieldDefinition.file_type;
    for (const item of records) {
      const fields = item.fields || {};
      const jsonFieldName = getJsonFieldName(fields);
      const parsed = parseJsonField(jsonFieldName ? fields[jsonFieldName] : null);
      if (!parsed) continue;
      if (getPolicyFileType(fields, parsed) !== targetType) continue;
      const changed = setParsedFieldDefinitionOnly(parsed, fieldKey, fieldDefinition);
      if (!changed) continue;
      const updateFields = {};
      if (jsonFieldName && state.tableFields && state.tableFields.includes(jsonFieldName)) {
        updateFields[jsonFieldName] = stringifyJsonField(parsed);
      }
      if (!Object.keys(updateFields).length) continue;
      await updateFeishuRecord(item.recordId, updateFields);
      updated++;
    }
    console.log(`[字段定义] ✓ ${fieldKey} 已应用到 ${targetType} ${updated} 条记录`);
    res.json({ success: true, updated, fileType: targetType, sourceRecordId: sourceRecordId || '' });
  } catch (err) {
    console.error(`[字段定义] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 标记解析问题（含同步到飞书「问题标记」字段） ----
app.post('/api/mark-problem', async (req, res) => {
  const { recordId, entry } = req.body;

  if (!recordId || !entry) {
    return res.status(400).json({ success: false, error: '缺少 recordId 或 entry' });
  }

  try {
    // 确保扩展字段存在
    try { await ensureTableFields(); } catch (e) { console.warn('[标记问题] 检查字段失败:', e.message); }

    // 读取现有问题标记，追加一行
    let existingLines = [];
    let sourceFields = {};
    let sourceParsed = null;
    let user = null;
    try { user = await getCurrentUser(); } catch (e) { /* 忽略 */ }
    try {
      const record = await getFeishuRecord(recordId);
      sourceFields = record.fields || {};
      sourceParsed = parseJsonField(sourceFields[getJsonFieldName(sourceFields)]);
      const raw = sourceFields['问题标记'];
      if (typeof raw === 'string' && raw.trim()) {
        existingLines = raw.split('\n').filter(Boolean);
      }
    } catch (e) {
      console.warn('[标记问题] 读取现有问题失败:', e.message);
    }

    const line = `[${entry.created_at || ''}] ${entry.created_by || ''} | ${entry.field_label || '文件整体'}: ${entry.desc || ''}`;
    existingLines.push(line);
    const problemText = existingLines.join('\n');

    await updateFeishuRecord(recordId, { '问题标记': problemText });

    console.log(`[标记问题] ✓ ${recordId} 问题 ${existingLines.length} 条`);
    res.json({ success: true, count: existingLines.length });

    setImmediate(() => {
      appendVersionUpdateRecord({
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        userName: user ? user.name : (entry.created_by || ''),
        fileName: getFileName(sourceFields, sourceParsed) || recordId,
        fieldLabel: entry.field_label || '文件整体',
        oldValue: '(标记前)',
        newValue: entry.desc || '',
        reason: entry.desc || '人工标记解析问题',
        ruleType: '人工问题标记',
        rule: '人工仅标记问题时，记录为待学习事项；完成字段修正后再沉淀具体解析规则并按安全规则矫正待审文件。',
        autoApplied: 0,
        autoFiles: [],
      }).catch(e => console.warn('[版本记录] 标记问题记录生成失败:', e.message));
    });
  } catch (err) {
    console.error(`[标记问题] ✗ ${err.message}`);
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

// ---- 拉取全部记录的最新状态（供前端多人同步确认状态/确认人）----
// 说明：bitable/v1 列表接口需要 bitable:app 权限（OAuth 授权 scope 常缺失），
// 改用 base/v3 列表接口（只需 base:record:read），返回列为 record_id_list + fields + data 行数组。
async function listAllRecordStatuses() {
  const statuses = {};
  const records = await listAllFeishuRecords();
  records.forEach(({ recordId, fields: f }) => {
    if (Object.prototype.hasOwnProperty.call(f, '人工确认项')) {
      f['人工确认项'] = cleanManualConfirmText(f['人工确认项']);
    }
    let st = f['审核状态'];
    if (Array.isArray(st)) st = st[0];
    if (st && typeof st === 'object') st = st.text || st.name || '';
    const manualProblemMarks = filterManualProblemMarks(f['问题标记']);
    statuses[recordId] = {
      status: st === '已确认' ? 'confirmed' : 'reviewing',
      confirmed_by: f['确认人'] || null,
      confirmed_at: f['确认时间'] || null,
      edited: f['已修改'] || null,
      change_history: f['修改历史'] || null,
      problem_marks: manualProblemMarks || null,
      fields: {
        ...f,
        '问题标记': manualProblemMarks,
      },
    };
  });
  return statuses;
}

app.get('/api/statuses', async (req, res) => {
  try {
    const statuses = await listAllRecordStatuses();
    res.json({ success: true, count: Object.keys(statuses).length, statuses });
  } catch (err) {
    console.error(`[状态同步] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 恢复同名旧缓存里的审核痕迹（recordId 变化后的兜底迁移）----
app.post('/api/restore-review-state', async (req, res) => {
  const { recordId, data, changeHistory, problems, editedFields } = req.body || {};
  if (!recordId) {
    return res.status(400).json({ success: false, error: '缺少 recordId' });
  }

  try {
    const tableFields = await ensureTableFields();
    const record = await getFeishuRecord(recordId);
    const currentFields = record.fields || {};
    const updates = {};
    const hasValue = v => normalizeFeishuValue(v).trim() !== '';

    const history = Array.isArray(changeHistory)
      ? changeHistory.map(e => normalizeChangeEntry(e, {})).filter(e => e.field || e.fieldLabel || e.reason)
      : [];
    const historyText = formatChangeHistory(history);
    const problemText = formatProblemMarks(problems || []);

    if (historyText && !hasValue(currentFields['修改历史'])) updates['修改历史'] = historyText;
    if (problemText && !hasValue(currentFields['问题标记'])) updates['问题标记'] = problemText;
    if ((historyText || problemText) && !hasValue(currentFields['已修改'])) updates['已修改'] = '是';

    const changedKeys = new Set((editedFields || []).map(canonicalizeFieldName).filter(Boolean));
    history.forEach(h => changedKeys.add(canonicalizeFieldName(h.field || h.fieldLabel)));
    const payloadData = data && typeof data === 'object' ? data : {};
    changedKeys.forEach(key => {
      const label = KEY_LABELS[key];
      if (!label || !tableFields.includes(label)) return;
      if (!Object.prototype.hasOwnProperty.call(payloadData, key)) return;
      const value = normalizeFeishuValue(payloadData[key]);
      if (!value) return;
      updates[label] = value;
    });

    const jsonFieldName = getJsonFieldName(currentFields);
    const parsed = parseJsonField(jsonFieldName ? currentFields[jsonFieldName] : null);
    if (parsed && jsonFieldName && tableFields.includes(jsonFieldName)) {
      let changedJson = false;
      changedKeys.forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(payloadData, key)) return;
        changedJson = setParsedField(parsed, key, normalizeFeishuValue(payloadData[key])) || changedJson;
      });
      if (payloadData[FIELD_DEFINITIONS_KEY] && typeof payloadData[FIELD_DEFINITIONS_KEY] === 'object') {
        Object.entries(payloadData[FIELD_DEFINITIONS_KEY]).forEach(([key, def]) => {
          changedJson = setParsedFieldDefinition(parsed, key, def) || changedJson;
        });
      }
      if (changedJson) updates[jsonFieldName] = stringifyJsonField(parsed);
    }

    if (!Object.keys(updates).length) {
      return res.json({ success: true, restored: false, reason: '当前飞书记录已有审核痕迹或无可恢复内容' });
    }

    await updateFeishuRecord(recordId, updates);
    console.log(`[恢复审核状态] ✓ ${recordId} 更新字段: ${Object.keys(updates).join(', ')}`);
    res.json({ success: true, restored: true, fields: Object.keys(updates) });
  } catch (err) {
    console.error(`[恢复审核状态] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

function requireAdminConfirm(req, res, expected) {
  const confirm = (req.body && req.body.confirm) || req.query.confirm || '';
  if (confirm !== expected) {
    res.status(400).json({ success: false, error: '缺少或错误的确认短语' });
    return false;
  }
  return true;
}

function filterKnownFields(fields, knownFields) {
  const filtered = {};
  Object.entries(fields || {}).forEach(([key, value]) => {
    if (knownFields.includes(key)) filtered[key] = value;
  });
  return filtered;
}

async function runLimited(items, limit, worker) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const currentIndex = index++;
      try {
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      } catch (e) {
        results[currentIndex] = { success: false, error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
  return results;
}

// ---- 管理接口：分批清空飞书记录 ----
// 用于重新解析上传前清理旧审核任务。必须传确认短语，避免误触。
app.post('/api/admin/clear-records', async (req, res) => {
  if (!requireAdminConfirm(req, res, 'DELETE_ALL_POLICY_RECORDS')) return;

  try {
    const limit = Math.max(1, Math.min(parseInt(req.body.limit || '80', 10) || 80, 120));
    const records = await listAllFeishuRecords();
    const target = records.slice(0, limit);
    const results = await runLimited(target, 8, async item => {
      await deleteFeishuRecord(item.recordId);
      return { success: true, recordId: item.recordId };
    });
    const deleted = results.filter(x => x && x.success).length;
    const errors = results.filter(x => x && !x.success);
    res.json({
      success: errors.length === 0,
      deleted,
      errors,
      before: records.length,
      remaining_estimate: Math.max(records.length - deleted, 0),
    });
  } catch (err) {
    console.error(`[清空记录] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 管理接口：清理系统自动矫正生成的问题标记 ----
// 保留修改历史，仅从「问题标记」里移除 AUTO_RULE/自动矫正/按当前原文复核拆分 等系统行。
app.post('/api/admin/cleanup-auto-problems', async (req, res) => {
  if (!requireAdminConfirm(req, res, 'CLEANUP_AUTO_PROBLEMS')) return;

  try {
    const records = await listAllFeishuRecords();
    const changed = [];
    const results = await runLimited(records, 8, async item => {
      const before = item.fields['问题标记'] || '';
      const after = filterManualProblemMarks(before);
      if (normalizeFeishuValue(before) === normalizeFeishuValue(after)) {
        return { success: true, skipped: true, recordId: item.recordId };
      }
      await updateFeishuRecord(item.recordId, { '问题标记': after });
      changed.push({
        recordId: item.recordId,
        fileName: getFileName(item.fields, parseJsonField(item.fields[getJsonFieldName(item.fields)])),
        removed: splitProblemMarkEntries(before).length - splitProblemMarkEntries(after).length,
      });
      return { success: true, recordId: item.recordId };
    });
    const errors = results.filter(x => x && !x.success);
    res.json({
      success: errors.length === 0,
      changed: changed.length,
      changed_records: changed,
      errors,
    });
  } catch (err) {
    console.error(`[清理自动问题标记] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 管理接口：清理人工确认项中的解析说明/分类证据 ----
app.post('/api/admin/cleanup-manual-confirm', async (req, res) => {
  if (!requireAdminConfirm(req, res, 'CLEANUP_MANUAL_CONFIRM')) return;

  try {
    const tableFields = await ensureTableFields();
    const records = await listAllFeishuRecords();
    const changed = [];
    const results = await runLimited(records, 6, async item => {
      const before = normalizeFeishuValue(item.fields['人工确认项']);
      const after = cleanManualConfirmText(before);
      const updates = {};
      if (before !== after && tableFields.includes('人工确认项')) {
        updates['人工确认项'] = after;
      }

      const jsonFieldName = getJsonFieldName(item.fields);
      const parsed = parseJsonField(jsonFieldName ? item.fields[jsonFieldName] : null);
      if (parsed && jsonFieldName && tableFields.includes(jsonFieldName) && cleanParsedManualConfirm(parsed)) {
        updates[jsonFieldName] = stringifyJsonField(parsed);
      }

      if (!Object.keys(updates).length) {
        return { success: true, skipped: true, recordId: item.recordId };
      }

      await updateFeishuRecord(item.recordId, updates);
      changed.push({
        recordId: item.recordId,
        fileName: getFileName(item.fields, parsed),
        before,
        after,
      });
      return { success: true, recordId: item.recordId };
    });
    const errors = results.filter(x => x && !x.success);
    res.json({
      success: errors.length === 0,
      changed: changed.length,
      changed_records: changed,
      errors,
    });
  } catch (err) {
    console.error(`[清理人工确认项] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 管理接口：批量导入新解析任务 ----
app.post('/api/admin/import-records', async (req, res) => {
  if (!requireAdminConfirm(req, res, 'IMPORT_POLICY_RECORDS')) return;

  try {
    const records = Array.isArray(req.body.records) ? req.body.records : [];
    if (!records.length) {
      return res.status(400).json({ success: false, error: 'records 为空' });
    }
    const tableFields = await ensureTableFields();
    const existingRecords = await listAllFeishuRecords();
    const existingByName = new Map();
    existingRecords.forEach(record => {
      const name = normalizeFeishuValue(record.fields && (record.fields['文件名称'] || record.fields['文件名']));
      if (name && !existingByName.has(name)) existingByName.set(name, record);
    });
    const REVIEW_PRESERVE_FIELDS = new Set([
      '审核状态', '确认人', '确认人ID', '确认时间',
      '已修改', '修改历史', '问题标记',
      '错误字段', '错误字段明细',
    ]);
    const MERGEABLE_RESULT_FIELDS = Object.values(KEY_LABELS).filter(name => !REVIEW_PRESERVE_FIELDS.has(name));
    const hasValue = v => normalizeFeishuValue(v).trim() !== '';
    const mergePreservingReview = (incoming, existing) => {
      if (!existing || !existing.fields) return incoming;
      const merged = { ...incoming };

      // 审核资产一律以飞书现有记录为准，防止重导入/补导入冲掉人工痕迹。
      REVIEW_PRESERVE_FIELDS.forEach(name => {
        if (Object.prototype.hasOwnProperty.call(existing.fields, name) && hasValue(existing.fields[name])) {
          merged[name] = existing.fields[name];
        }
      });

      // 对已经被人工改过的文件，字段列也优先保留飞书当前值；新解析只补空字段。
      const reviewed = hasValue(existing.fields['修改历史']) ||
        hasValue(existing.fields['问题标记']) ||
        normalizeFeishuValue(existing.fields['已修改']) === '是' ||
        normalizeFeishuValue(existing.fields['审核状态']) === '已确认';
      if (reviewed) {
        MERGEABLE_RESULT_FIELDS.forEach(name => {
          if (hasValue(existing.fields[name])) merged[name] = existing.fields[name];
        });
      }

      return merged;
    };
    const created = [];
    for (const item of records) {
      let fields = filterKnownFields(item.fields || item, tableFields);
      if (!fields['文件名称']) {
        throw new Error('导入记录缺少 文件名称');
      }
      const existing = existingByName.get(normalizeFeishuValue(fields['文件名称']));
      if (existing) {
        fields = filterKnownFields(mergePreservingReview(fields, existing), tableFields);
        await updateFeishuRecord(existing.recordId, fields);
        created.push({
          recordId: existing.recordId,
          fields: { ...(existing.fields || {}), ...fields },
          fileName: fields['文件名称'],
          mode: 'updated',
        });
        continue;
      }
      const record = await createFeishuRecord(fields);
      created.push({
        recordId: record.record_id,
        fields: record.fields || fields,
        fileName: fields['文件名称'],
        mode: 'created',
      });
    }
    res.json({ success: true, count: created.length, records: created });
  } catch (err) {
    console.error(`[导入记录] ✗ ${err.message}`);
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      res.status(401).json({ success: false, error: '需要飞书授权', needAuth: true });
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 启动 ----
app.listen(PORT, () => {
  console.log(`\n🚀 政策审核工作台 (Render) 已启动`);
  console.log(`   端口: ${PORT}`);
  console.log(`   已授权: ${!!state.userRefreshToken}\n`);
});
