/**
 * 政策审核工作台 - Node.js 服务器 (Render 部署版)
 * 使用飞书 user_access_token 更新多维表格
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Redis = require('ioredis');
const mammoth = require('mammoth');
const XLSX = require('xlsx');
const WordExtractor = require('word-extractor');
const { PDFParse } = require('pdf-parse');

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
const FEISHU_OAUTH_SCOPES = sanitizeFeishuOAuthScopes(process.env.FEISHU_OAUTH_SCOPES || 'offline_access bitable:app');
const LOCAL_REVIEW_STORE_FILE = process.env.LOCAL_REVIEW_STORE_FILE || path.join(__dirname, '.review_state_store.json');
const LOCAL_REVIEW_MODE = process.env.LOCAL_REVIEW_MODE !== 'false';
const FEISHU_FALLBACK_TO_LOCAL = process.env.FEISHU_FALLBACK_TO_LOCAL === 'true';
const REVIEW_REDIS_URL = process.env.REVIEW_REDIS_URL || process.env.REDIS_URL || '';
const REVIEW_REDIS_KEY = process.env.REVIEW_REDIS_KEY || 'policy-review-workbench:review-state';
const REVIEW_STORAGE_MODE = (process.env.REVIEW_STORAGE_MODE || 'feishu').toLowerCase();
const REVIEW_GITHUB_TOKEN = process.env.REVIEW_GITHUB_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const REVIEW_GITHUB_REPO = process.env.REVIEW_GITHUB_REPO || '';
const REVIEW_GITHUB_BRANCH = process.env.REVIEW_GITHUB_BRANCH || 'main';
const REVIEW_GITHUB_PATH = process.env.REVIEW_GITHUB_PATH || 'data/review-state.json';
const UPLOAD_BASE_TOKEN = process.env.FEISHU_UPLOAD_BASE_TOKEN || 'C6ZcbDr5RaxqOYsT0UAcx7S7nnc';
const UPLOAD_TABLE_ID = process.env.FEISHU_UPLOAD_TABLE_ID || 'tblnpDn9US3ZxcfI';
const UPLOAD_QUEUE_SCAN_ENABLED = process.env.UPLOAD_QUEUE_SCAN_ENABLED !== 'false';
const UPLOAD_QUEUE_SCAN_INTERVAL_MS = parseInt(process.env.UPLOAD_QUEUE_SCAN_INTERVAL_MS || '120000', 10);
const UPLOAD_QUEUE_SCAN_BATCH_LIMIT = parseInt(process.env.UPLOAD_QUEUE_SCAN_BATCH_LIMIT || '3', 10);
const UPLOAD_QUEUE_DOWNLOAD_LIMIT_BYTES = parseInt(process.env.UPLOAD_QUEUE_DOWNLOAD_LIMIT_BYTES || String(45 * 1024 * 1024), 10);
const RULE_CONFIRM_NOTIFY_OPEN_IDS = parseEnvList(process.env.RULE_CONFIRM_NOTIFY_OPEN_IDS || process.env.FEISHU_NOTIFY_OPEN_IDS || '');
const RULE_CONFIRM_NOTIFY_CURRENT_USER = process.env.RULE_CONFIRM_NOTIFY_CURRENT_USER !== 'false';
const GOLDEN_REGRESSION_SAMPLE_LIMIT = parseInt(process.env.GOLDEN_REGRESSION_SAMPLE_LIMIT || '120', 10);
const GOLDEN_UPLOAD_MISMATCH_DISPLAY_LIMIT = parseInt(process.env.GOLDEN_UPLOAD_MISMATCH_DISPLAY_LIMIT || '12', 10);
const GOLDEN_SAMPLE_SOURCES = parseGoldenSampleSources(process.env.POLICY_GOLDEN_SAMPLE_SOURCES || '', defaultGoldenSampleSources());
const WORKBENCH_AUTH_ENABLED = process.env.WORKBENCH_AUTH_ENABLED !== 'false';
const WORKBENCH_SESSION_COOKIE = 'policy_review_session';
const WORKBENCH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKBENCH_AUTH_SECRET = process.env.WORKBENCH_AUTH_SECRET || APP_SECRET || 'policy-review-workbench-dev-secret';
const WORKBENCH_DEFAULT_USER = process.env.WORKBENCH_USERNAME || 'admin';
const WORKBENCH_DEFAULT_PASSWORD = process.env.WORKBENCH_PASSWORD || 'policy2026';
const WORKBENCH_ALLOWED_ORIGINS = parseEnvList(process.env.WORKBENCH_ALLOWED_ORIGINS || [
  'https://nnybk2m78w-ship-it.github.io',
  'https://policy-review-workbench.onrender.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
  'http://localhost:8091',
  'http://127.0.0.1:8091',
].join(','));
let redisClient = null;
const wordExtractor = new WordExtractor();

function parseEnvList(value) {
  return String(value || '')
    .split(/[,\s;；，]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function defaultGoldenSampleSources() {
  return [
    {
      name: '历史黄金样本-自营',
      fileType: '自营',
      url: 'https://hf7l9aiqzx.feishu.cn/wiki/BcBjwXYAiiD0aMkQdPAccUcrnmc?table=tblPq2afhMMohXxY&view=vewVMMNKIO',
    },
    {
      name: '历史黄金样本-旗舰店',
      fileType: '旗舰店',
      url: 'https://hf7l9aiqzx.feishu.cn/wiki/AZq1wRqNmi6NP8kIArjcdv4dnEe?table=tblQFIM4LlaBJhmM&view=vewVMMNKIO',
    },
    {
      name: '历史黄金样本-次卡',
      fileType: '次卡',
      url: 'https://hf7l9aiqzx.feishu.cn/wiki/DNcYwpfI3iPKMQkz3N3c5rvFnwd?base_hp_from=larktab&table=tblHjR3KwC4zyG9E&view=vew4wNFNXG',
    },
    {
      name: '标准测试集',
      fileType: '',
      url: 'https://hf7l9aiqzx.feishu.cn/wiki/MUaJwhgGkiggSHkPFsictDrcn0c?table=tblKOs1WWzUw71mq&view=vew3MZfo68',
    },
  ];
}

function parseGoldenSampleSources(raw, fallback = []) {
  const text = String(raw || '').trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.filter(item => item && (item.url || (item.baseToken && item.tableId)));
  } catch (e) { /* 支持非 JSON 简写 */ }
  const sources = text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line, idx) => {
      const parts = line.split('|').map(part => part.trim());
      if (parts.length >= 3) return { name: parts[0], fileType: parts[1], url: parts.slice(2).join('|') };
      return { name: `黄金样本-${idx + 1}`, fileType: '', url: line };
    })
    .filter(item => item.url);
  return sources.length ? sources : fallback;
}

const KEY_LABELS = {
  scenario: '解析场景',
  business_line: '业务线',
  channel_note: '渠道备注',
  carrier: '航司二字码',
  carrier_name: '航司名称',
  product_name: '产品名称',
  product_family: '产品类型',
  product_type: '产品类型',
  pata_code: 'PAT指令',
  product_code: '产品代码',
  product_code_raw: '原始产品码',
  product_price: '产品价格',
  price_deduction: '营销立减金额',
  price_groups: '价格组',
  price_group: '价格组序号',
  office_id: 'OFFICE号',
  policy_code: '政策编号',
  fare_basis: '运价基础',
  corporate_code: '大客户编码',
  coupon_resource_code: '券/资源编号',
  product_category: '产品类别',
  flight_type: '航程类型',
  trip_type_note: '航程备注',
  od: '航线范围',
  beside_od: '不适用航线',
  od_note: '航线备注',
  booking_cabin: '适用舱位',
  cabin: '舱位代码',
  cabin_count: '舱位数量',
  sale_date: '销售日期',
  sale_constraint: '购票提前限制',
  beside_sale_date: '销售除外日期',
  redeem_date: '兑换日期',
  use_date: '兑换日期(标准)',
  depart_date: '旅行日期',
  depart_week: '班期限制',
  depart_time: '旅行日期',
  beside_date: '除外日期',
  beside_depart_time: '旅行除外日期',
  depart_date_origin: '旅行日期原文',
  depart_date_note: '旅行日期备注',
  flight_number: '适用航班',
  non_flight_number: '不适用航班',
  not_applicable_flight_number: '不适用航班',
  advance_purchase_days: '提前购票',
  ticket_type: '票证类型',
  ticket_stock: '票证代码',
  sub_cabin: '是否适用小舱位',
  associated_cabin: '关联舱位',
  discount_type: '直减类型',
  discount_per: '直减金额/比例',
  sale_type: '实现形式',
  price_code: '优惠码',
  price_discount: '价格立减优惠码',
  price_voucher: '优惠券码',
  restriction_code: '政策限制编码',
  minimum_sales: '最低销售价格',
  whether_member: '是否会员',
  passenger_type: '旅客类型',
  customer_limit_group: '客群分组',
  age_limit: '年龄限制',
  child_applicable: '儿童适用',
  baby_applicable: '婴儿适用',
  realname_required: '实名要求',
  realname_limit: '实名限制',
  id_type_restriction: '证件类型限制',
  document_restrictions: '证件限制',
  usage_threshold: '使用门槛',
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
  beside_time: '旅行除外日期',
  membership_limit: '会员限制',
  payment_limit: '支付限制',
  capacity_limit: '人数限制',
  capacity_limit_supplementary: '人数限制补充',
  family_limit: '家庭/多人限制',
  equity_related: '权益相关',
  passenger_benefit: '旅客权益',
  agent_fee: '代理费',
  remium_products: '溢价产品',
  regional_limit: '区域限制',
  regional_limit_origin: '区域限制原文',
  sale_method: '销售方式',
  display_method: '展示方式',
  splice_limit: '拼接限制',
  gender_restriction: '性别限制',
  cabin_class: '舱等',
  student_verification: '学生认证',
  student_verification_rules: '学生认证规则',
  card_limit: '次卡/权益卡限制',
  card_limit_choice: '次卡/权益卡限制选项',
  customer_limit: '客群限制',
  customer_limit_origin: '客群限制原文',
  product_label: '产品标签',
  display_limit: '展示限制',
  refund_change_together: '同退同改',
  order_times: '订单次数',
  refund_change_type: '退改类型',
  refund_rule: '退票规则(旧字段)',
  change_rule: '变更规则(旧字段)',
  close_time: '关舱/截止时间',
  change_free_times: '免费变更次数',
  free_times: '免费次数',
  refund_free_equity: '免费退票权益',
  refund_change: '退改规则',
  child_refund_change: '儿童退改规则',
  same_cabin: '同舱同价',
  domain: '域名',
  splicing_type: '拼接类型',
  benfit_upgrade: '升舱权益',
  take_pay: '支付/带付限制',
  ticket_hotel: '机+酒店',
  airline_code: '航司简称',
  refund_time: '未兑换退款日期',
  purchase_limit: '购买限制',
  luggage_amount: '行李额',
  benefit_name: '权益名称',
  benefit_usage_rules: '权益使用规则',
  not_applicable_flight_routes: '不适用航班/航线明细',
  price_groups_summary: '价格组汇总',
  use_code: '兑换标识',
  match_rule: 'match_rule',
};
const FIELD_LABEL_TO_KEY = Object.fromEntries(Object.entries(KEY_LABELS).map(([key, label]) => [label, key]));
const JSON_FIELD_CANDIDATES = ['解析JSON', '解析结果', '结构化结果', 'JSON'];
const FIELD_DEFINITIONS_KEY = '_field_definitions';
const SOURCE_BOUND_KEYS = new Set(['benefit_name', 'benefit_usage_rules']);
const DOCUMENT_LEVEL_KEYS = new Set(['benefit_name', 'benefit_usage_rules']);
const SERVER_PROMPT_FIELDS = {
  '自营': new Set(['scenario','business_line','channel_note','carrier','carrier_name','product_name','product_family','product_type','product_code','policy_code','fare_basis','corporate_code','flight_type','trip_type_note','od','od_note','booking_cabin','cabin','sale_date','depart_date','advance_purchase_days','discount_type','discount_per','passenger_type','age_limit','child_applicable','baby_applicable','realname_limit','document_restrictions','sign_and_transfer_rules','refund_rules','change_rules','commission_rate','manual_confirm_fields','luggage_amount','not_applicable_od']),
  '旗舰店code': new Set(['scenario','business_line','carrier','carrier_name','product_name','product_family','product_code','product_code_raw','policy_code','fare_basis','corporate_code','flight_type','od','booking_cabin','cabin','sale_date','depart_date','discount_type','discount_per','passenger_type','age_limit','child_applicable','baby_applicable','realname_limit','document_restrictions','sign_and_transfer_rules','refund_rules','change_rules','manual_confirm_fields','luggage_amount','benefit_name','benefit_usage_rules','not_applicable_flight_routes']),
  '旗舰店券类': new Set(['scenario','business_line','carrier','carrier_name','product_name','product_family','product_code','coupon_resource_code','policy_code','flight_type','od','booking_cabin','cabin','sale_date','redeem_date','use_date','depart_date','discount_type','discount_per','passenger_type','age_limit','child_applicable','baby_applicable','realname_limit','document_restrictions','benefit_name','benefit_usage_rules','not_applicable_flight_routes','manual_confirm_fields']),
  '次卡': new Set(['scenario','business_line','carrier','carrier_name','product_name','product_family','product_code','policy_code','flight_type','od','booking_cabin','cabin','sale_date','redeem_date','use_date','depart_date','usage_times','travel_class','product_show','json_count','use_limit','use_begin','wether_depart_today','refund_time','price_groups_summary','manual_confirm_fields']),
};
const LEGACY_SELF_OPERATED_FIELDS = [
  'business_line','carrier','sale_date','sale_constraint','depart_date','flight_type','flight_number',
  'not_applicable_flight_number','cabin','sub_cabin','associated_cabin','discount_type','discount_per',
  'od','not_applicable_od','passenger_type','child_applicable','baby_applicable','passenger_benefit',
  'agent_fee','luggage_amount','price_discount','price_voucher','restriction_code','pata_code',
  'age_limit','age_limit_supplementary','age_limit_gender','young_old','membership_limit','capacity_limit',
  'capacity_limit_supplementary','family_limit','realname_limit','equity_related','remium_products',
  'payment_limit','regional_limit','regional_limit_origin','splice_limit','sale_method','display_method',
  'product_label','display_limit','sign_and_transfer_rules','refund_rules','change_rules',
  'gender_restriction','document_restrictions','usage_threshold','cabin_class','student_verification',
  'student_verification_rules','customer_limit','card_limit','customer_limit_origin','refund_change_together',
  'beside_time','product_type_origin','depart_date_origin'
];
LEGACY_SELF_OPERATED_FIELDS.forEach(key => SERVER_PROMPT_FIELDS['自营'].add(key));
const FLAGSHIP_CODE_FIELDS = [
  'product_type','business_line','carrier','sale_date','sale_constraint','depart_date','flight_type',
  'flight_number','not_applicable_flight_number','cabin','sub_cabin','associated_cabin','discount_type',
  'discount_per','od','not_applicable_od','passenger_type','child_applicable','baby_applicable',
  'passenger_benefit','agent_fee','luggage_amount','price_discount','price_voucher',
  'age_limit','age_limit_supplementary','age_limit_gender','young_old','membership_limit','capacity_limit',
  'capacity_limit_supplementary','family_limit','realname_limit','equity_related','remium_products',
  'payment_limit','regional_limit','regional_limit_origin','splice_limit','sale_method','display_method',
  'product_label','display_limit','sign_and_transfer_rules','refund_rules','change_rules',
  'gender_restriction','document_restrictions','usage_threshold','cabin_class','student_verification',
  'student_verification_rules','customer_limit','card_limit','restriction_code','customer_limit_origin',
  'refund_change_together'
];
FLAGSHIP_CODE_FIELDS.forEach(key => SERVER_PROMPT_FIELDS['旗舰店code'].add(key));
// 旗舰店券类不再由系统自动区分「老券 / 新券」；这里只保留两组
// prompt 来源字段并合并为统一的「旗舰店券类」字段集。
const FLAGSHIP_COUPON_CORE_FIELDS = [
  '航班-适用','航班-不适用','机场-适用','机场-不适用','舱位','销售日期','旅行日期',
  '活动形式','直减金额/直减比例','购票提前天数限制','实现形式','资源编号',
  '最低销售价格','是否注册','优惠券码','优惠码'
];
const FLAGSHIP_COUPON_EXTENDED_FIELDS = [
  '业务线','销售限制','旅客类型','儿童','婴儿','年龄限制','年龄限制补充','性别年龄限制',
  '青老年','会员限制','人数限制','人数限制补充','家庭限制','实名限制','区域限制',
  '区域限制原文','产品标签','展示方式','展示限制','性别限制','证件限制','使用门槛',
  '舱等','学生认证','学生认证方式','次卡权益卡限制','match_rule','关联营销活动',
  '活动名称','航司','航班-适用','航班-不适用','机场-适用','机场-不适用','舱位',
  '销售日期','旅行日期','旅行日期不适用','活动形式','直减金额/比例','购票提前天数限制',
  '实现形式','优惠码','优惠券码','资源编号','最低销售价格','是否注册'
];
const FLAGSHIP_COUPON_FIELDS = [
  'product_name','product_label','carrier','flight_number','non_flight_number','od','beside_od',
  'cabin','sub_cabin','sale_date','beside_sale_date','depart_week','depart_time','beside_depart_time',
  'discount_type','discount_per','sale_constraint','sale_type','price_code','price_voucher',
  'minimum_sales','whether_member',
  ...FLAGSHIP_COUPON_CORE_FIELDS,
  ...FLAGSHIP_COUPON_EXTENDED_FIELDS,
];
FLAGSHIP_COUPON_FIELDS.forEach(key => SERVER_PROMPT_FIELDS['旗舰店券类'].add(key));
const TRIP_CARD_FIELDS = [
  'carrier','airline_code','od','flight_type','usage_times','product_name','product_show','product_type',
  'product_price','price_deduction','cabin','travel_class','sale_date','depart_date','beside_time',
  'use_limit','use_begin','use_date','refund_time','use_code','passenger_type','age_limit',
  'sign_and_transfer_rules','refund_rules','change_rules','luggage_amount','realname_limit',
  'purchase_limit','wether_depart_today','price_groups','price_group'
];
TRIP_CARD_FIELDS.forEach(key => SERVER_PROMPT_FIELDS['次卡'].add(key));
const SCHEMA_FIELDS_BY_TYPE = {
  '自营': LEGACY_SELF_OPERATED_FIELDS,
  '旗舰店code': FLAGSHIP_CODE_FIELDS,
  '旗舰店券类': FLAGSHIP_COUPON_FIELDS,
  '次卡': TRIP_CARD_FIELDS,
};

function sanitizeFeishuOAuthScopes(rawScopes) {
  const deprecatedScopes = new Set(['base:record:read', 'base:record:write']);
  const scopes = String(rawScopes || '')
    .split(/\s+/)
    .map(scope => scope.trim())
    .filter(Boolean)
    .filter(scope => !deprecatedScopes.has(scope));
  if (!scopes.includes('offline_access')) scopes.unshift('offline_access');
  if (!scopes.includes('bitable:app')) scopes.push('bitable:app');
  return [...new Set(scopes)].join(' ');
}

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
  tenantAccessToken: null,
  tenantTokenExpiresAt: 0,
  tableFields: null,   // 飞书表格字段名缓存
  uploadQueueFields: null, // 上传队列表字段缓存
  currentUser: null,   // 当前授权用户信息
  uploadQueueScan: {
    running: false,
    scheduled: false,
    lastRunAt: null,
    lastResult: null,
  },
  goldenUploadSamples: {
    loadedAt: 0,
    samples: [],
    errors: [],
  },
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

function createEmptyReviewStore() {
  return {
    version: 1,
    updatedAt: null,
    staticHidden: false,
    records: {},
    events: [],
  };
}

function loadReviewStore() {
  try {
    if (fs.existsSync(LOCAL_REVIEW_STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(LOCAL_REVIEW_STORE_FILE, 'utf-8'));
      if (data && typeof data === 'object') {
        data.staticHidden = !!data.staticHidden;
        data.records = data.records && typeof data.records === 'object' ? data.records : {};
        data.events = Array.isArray(data.events) ? data.events : [];
        return data;
      }
    }
  } catch (e) {
    console.warn('[本地审核记录] 读取失败，将使用空记录:', e.message);
  }
  return createEmptyReviewStore();
}

function saveReviewStore(store) {
  if (!LOCAL_REVIEW_MODE) return;
  try {
    store.updatedAt = new Date().toISOString();
    fs.writeFileSync(LOCAL_REVIEW_STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('[本地审核记录] 保存失败:', e.message);
    throw e;
  }
}

function useFeishuStorage() {
  return REVIEW_STORAGE_MODE === 'feishu';
}

function allowFeishuLocalFallback() {
  return useFeishuStorage() && LOCAL_REVIEW_MODE && FEISHU_FALLBACK_TO_LOCAL;
}

function hasValidUserAccessToken() {
  return !!(state.userAccessToken && Date.now() < state.tokenExpiresAt - 60000);
}

function hasFeishuUserAuth() {
  return !!state.userRefreshToken || hasValidUserAccessToken();
}

function useRedisStorage() {
  return REVIEW_STORAGE_MODE === 'redis' && !!REVIEW_REDIS_URL;
}

function useGithubStorage() {
  return REVIEW_STORAGE_MODE === 'github' && !!REVIEW_GITHUB_TOKEN && !!REVIEW_GITHUB_REPO;
}

function activeReviewStorageName() {
  if (useFeishuStorage()) return 'feishu';
  if (useRedisStorage()) return 'redis';
  if (useGithubStorage()) return 'github';
  return 'local';
}

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx <= 0) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value || '');
  });
  return out;
}

function base64UrlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64UrlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function signSessionPayload(payload) {
  return crypto.createHmac('sha256', WORKBENCH_AUTH_SECRET).update(payload).digest('base64url');
}

function createWorkbenchSession(user) {
  const payload = base64UrlEncode(JSON.stringify({
    user,
    exp: Date.now() + WORKBENCH_SESSION_TTL_MS,
  }));
  return `${payload}.${signSessionPayload(payload)}`;
}

function readWorkbenchSession(req) {
  if (!WORKBENCH_AUTH_ENABLED) {
    return { authenticated: true, user: { username: 'auth-disabled', name: '免登录模式' } };
  }
  const authHeader = String(req.get('authorization') || '');
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
  const token = parseCookies(req.headers.cookie)[WORKBENCH_SESSION_COOKIE] || bearerToken;
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = signSessionPayload(payload);
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const parsed = JSON.parse(base64UrlDecode(payload));
    if (!parsed || parsed.exp < Date.now()) return null;
    return { authenticated: true, user: parsed.user || null };
  } catch (e) {
    return null;
  }
}

function isAllowedWorkbenchOrigin(origin) {
  if (!origin) return false;
  if (WORKBENCH_ALLOWED_ORIGINS.includes('*')) return true;
  return WORKBENCH_ALLOWED_ORIGINS.includes(origin);
}

function getWorkbenchSessionCookie(req, token, maxAgeSeconds) {
  const secure = req.secure || req.get('x-forwarded-proto') === 'https';
  const origin = req.get('origin') || '';
  const sameSite = secure && origin && isAllowedWorkbenchOrigin(origin) ? 'None' : 'Lax';
  return [
    `${WORKBENCH_SESSION_COOKIE}=${encodeURIComponent(token || '')}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${sameSite}`,
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function getWorkbenchUsers() {
  if (process.env.WORKBENCH_USERS) {
    try {
      const parsed = JSON.parse(process.env.WORKBENCH_USERS);
      if (Array.isArray(parsed)) {
        return parsed
          .map(item => ({
            username: String(item.username || item.name || '').trim(),
            password: String(item.password || ''),
            passwordHash: String(item.passwordHash || item.password_sha256 || ''),
            name: String(item.displayName || item.name || item.username || '').trim(),
          }))
          .filter(item => item.username && (item.password || item.passwordHash));
      }
    } catch (e) {
      console.warn('[登录] WORKBENCH_USERS 解析失败，使用单账号配置:', e.message);
    }
  }
  return [{
    username: WORKBENCH_DEFAULT_USER,
    password: WORKBENCH_DEFAULT_PASSWORD,
    passwordHash: process.env.WORKBENCH_PASSWORD_SHA256 || '',
    name: process.env.WORKBENCH_DISPLAY_NAME || WORKBENCH_DEFAULT_USER,
  }];
}

function verifyWorkbenchPassword(user, password) {
  if (!user) return false;
  const input = String(password || '');
  if (user.passwordHash) {
    const hash = crypto.createHash('sha256').update(input).digest('hex');
    if (hash.length !== user.passwordHash.length) return false;
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(user.passwordHash));
  }
  if (!user.password || input.length !== user.password.length) return false;
  return crypto.timingSafeEqual(Buffer.from(input), Buffer.from(user.password));
}

function requireWorkbenchAuthForApi(req, res, next) {
  if (req.method === 'OPTIONS') return next();
  const publicPaths = new Set([
    '/api/health', '/health',
    '/api/login-status', '/login-status',
    '/api/login', '/login',
    '/api/logout', '/logout',
    '/api/oauth/callback', '/oauth/callback',
  ]);
  const originalPath = String(req.originalUrl || '').split('?')[0];
  if (publicPaths.has(req.path) || publicPaths.has(originalPath)) return next();
  const session = readWorkbenchSession(req);
  if (!session || !session.authenticated) {
    return res.status(401).json({ success: false, error: '需要登录后操作', needLogin: true });
  }
  req.workbenchUser = session.user || null;
  next();
}

function getRedisClient() {
  if (!redisClient) {
    redisClient = new Redis(REVIEW_REDIS_URL, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });
    redisClient.on('error', err => {
      console.warn('[Redis审核记录] 连接异常:', err.message);
    });
  }
  return redisClient;
}

async function loadRedisReviewStore() {
  try {
    const raw = await getRedisClient().get(REVIEW_REDIS_KEY);
    if (!raw) return createEmptyReviewStore();
    const parsed = JSON.parse(raw);
    parsed.records = parsed.records && typeof parsed.records === 'object' ? parsed.records : {};
    parsed.events = Array.isArray(parsed.events) ? parsed.events : [];
    parsed.staticHidden = !!parsed.staticHidden;
    return parsed;
  } catch (e) {
    console.warn('[Redis审核记录] 读取失败，退回本地缓存:', e.message);
    return loadReviewStore();
  }
}

async function saveRedisReviewStore(store) {
  await getRedisClient().set(REVIEW_REDIS_KEY, JSON.stringify(store));
}

async function githubContentsRequest(method, body) {
  const baseUrl = `https://api.github.com/repos/${REVIEW_GITHUB_REPO}/contents/${encodeURIComponent(REVIEW_GITHUB_PATH).replace(/%2F/g, '/')}`;
  const url = method === 'GET' ? `${baseUrl}?ref=${encodeURIComponent(REVIEW_GITHUB_BRANCH)}` : baseUrl;
  const resp = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${REVIEW_GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.message || `GitHub storage ${method} failed`);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function loadGithubReviewStore() {
  try {
    const data = await githubContentsRequest('GET');
    const raw = Buffer.from(data.content || '', 'base64').toString('utf-8');
    const parsed = raw.trim() ? JSON.parse(raw) : createEmptyReviewStore();
    parsed.records = parsed.records && typeof parsed.records === 'object' ? parsed.records : {};
    parsed.events = Array.isArray(parsed.events) ? parsed.events : [];
    parsed.staticHidden = !!parsed.staticHidden;
    return { store: parsed, sha: data.sha || null };
  } catch (e) {
    if (e.status === 404) {
      return { store: createEmptyReviewStore(), sha: null };
    }
    console.warn('[GitHub审核记录] 读取失败，退回本地缓存:', e.message);
    return { store: loadReviewStore(), sha: null, fallback: true };
  }
}

async function saveGithubReviewStore(store, sha, message) {
  const content = Buffer.from(JSON.stringify(store, null, 2), 'utf-8').toString('base64');
  const body = {
    message: message || 'Update policy review state',
    content,
    branch: REVIEW_GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;
  const data = await githubContentsRequest('PUT', body);
  return data && data.content && data.content.sha;
}

async function loadReviewStoreForRead() {
  if (useRedisStorage()) {
    const store = await loadRedisReviewStore();
    saveReviewStore(store);
    return store;
  }
  if (useGithubStorage()) {
    const result = await loadGithubReviewStore();
    saveReviewStore(result.store);
    return result.store;
  }
  return loadReviewStore();
}

async function withReviewStore(mutator, message) {
  const loaded = useRedisStorage()
    ? { store: await loadRedisReviewStore(), sha: null }
    : useGithubStorage()
    ? await loadGithubReviewStore()
    : { store: loadReviewStore(), sha: null };
  const result = await mutator(loaded.store);
  loaded.store.updatedAt = new Date().toISOString();
  if (useRedisStorage()) {
    try {
      await saveRedisReviewStore(loaded.store);
    } catch (e) {
      console.warn('[Redis审核记录] 保存失败，退回本地文件:', e.message);
      saveReviewStore(loaded.store);
      return result;
    }
  } else if (useGithubStorage() && !loaded.fallback) {
    try {
      await saveGithubReviewStore(loaded.store, loaded.sha, message);
    } catch (e) {
      if (e.status === 409) {
        const reloaded = await loadGithubReviewStore();
        const retryResult = await mutator(reloaded.store);
        reloaded.store.updatedAt = new Date().toISOString();
        await saveGithubReviewStore(reloaded.store, reloaded.sha, message);
        saveReviewStore(reloaded.store);
        return retryResult;
      }
      console.warn('[GitHub审核记录] 保存失败，退回本地文件:', e.message);
      saveReviewStore(loaded.store);
      return result;
    }
  } else {
    saveReviewStore(loaded.store);
  }
  saveReviewStore(loaded.store);
  return result;
}

function getReviewStoreRecord(store, recordId) {
  if (!store.records[recordId]) {
    store.records[recordId] = {
      status: '',
      confirmed_at: null,
      confirmed_by: null,
      dataPatch: {},
      deletedFields: [],
      fieldDefinitions: {},
      changeHistory: [],
      problemLines: [],
      ruleSuggestions: [],
      fields: {},
      updated_at: null,
    };
  }
  return store.records[recordId];
}

function appendReviewEvent(store, type, recordId, payload) {
  store.events.push({
    type,
    recordId,
    time: new Date().toISOString(),
    payload: payload || {},
  });
  if (store.events.length > 3000) store.events = store.events.slice(-3000);
}

function fallbackUser() {
  return { name: '网页审核用户', openId: 'local_review_user' };
}

let staticPoliciesCache = null;
function loadStaticPolicies() {
  if (staticPoliciesCache) return staticPoliciesCache;
  try {
    const html = fs.readFileSync(path.join(__dirname, 'policy-review-workbench.html'), 'utf-8');
    const match = html.match(/const REVIEW_POLICIES = ([\s\S]*?);\n\nconst FEISHU_BASE_URL/);
    if (!match) return [];
    staticPoliciesCache = Function(`return ${match[1]}`)();
    return staticPoliciesCache;
  } catch (e) {
    console.warn('[本地审核记录] 读取静态解析数据失败:', e.message);
    return [];
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value || {}));
}

function applyLocalRecordToPolicy(policy, localRecord) {
  const next = cloneJson(policy);
  next.data = next.data && typeof next.data === 'object' ? next.data : {};
  if (!localRecord) return sanitizePolicyFields(next);
  Object.entries(localRecord.dataPatch || {}).forEach(([key, value]) => {
    next.data[key] = value;
  });
  (localRecord.deletedFields || []).forEach(key => {
    delete next.data[key];
    if (next.data[FIELD_DEFINITIONS_KEY]) delete next.data[FIELD_DEFINITIONS_KEY][key];
  });
  if (Object.keys(localRecord.fieldDefinitions || {}).length) {
    next.data[FIELD_DEFINITIONS_KEY] = {
      ...(next.data[FIELD_DEFINITIONS_KEY] || {}),
      ...localRecord.fieldDefinitions,
    };
  }
  if (localRecord.status) next.status = localRecord.status;
  if (localRecord.confirmed_at !== undefined) next.confirmed_at = localRecord.confirmed_at;
  if (localRecord.confirmed_by !== undefined) next.confirmed_by = localRecord.confirmed_by;
  next._change_history = localRecord.changeHistory || [];
  sanitizePolicyFields(next);
  return next;
}

function getPolicyFileTypeFromPolicy(policy) {
  const data = (policy && policy.data) || {};
  const text = [
    policy && policy.file_name,
    policy && policy.category,
    policy && policy.source_text,
    data.scenario,
    data.business_line,
    data.product_family,
    data.product_category,
    data.product_name,
  ].filter(Boolean).join(' ');
  return inferPolicyTypeFromEvidence(text);
}

function sourceBoundFieldAllowedForPolicy(policy, key) {
  if (!SOURCE_BOUND_KEYS.has(key)) return true;
  const fileType = getPolicyFileTypeFromPolicy(policy);
  if (fileType === '旗舰店code' || fileType === '旗舰店券类') return true;
  const def = policy && policy.data && policy.data[FIELD_DEFINITIONS_KEY] && policy.data[FIELD_DEFINITIONS_KEY][key];
  const defType = def && (def.file_type || def.fileType);
  return !!defType && defType === fileType;
}

function sanitizePolicyFields(policy) {
  if (!policy || !policy.data) return policy;
  Object.keys(policy.data).forEach(key => {
    if (!sourceBoundFieldAllowedForPolicy(policy, key)) {
      delete policy.data[key];
      if (policy.data[FIELD_DEFINITIONS_KEY]) delete policy.data[FIELD_DEFINITIONS_KEY][key];
    }
  });
  if (policy.data[FIELD_DEFINITIONS_KEY] && !Object.keys(policy.data[FIELD_DEFINITIONS_KEY]).length) {
    delete policy.data[FIELD_DEFINITIONS_KEY];
  }
  return policy;
}

function policyToFields(policy, localRecord) {
  sanitizePolicyFields(policy);
  const visibleHistoryText = humanChangeHistoryText((localRecord && localRecord.changeHistory) || []);
  const ruleSuggestionsText = formatRuleSuggestions((localRecord && localRecord.ruleSuggestions) || []);
  const policyProblemLines = Array.isArray(policy.problem_lines)
    ? policy.problem_lines
    : (policy.problem_marks ? splitProblemMarkEntries(policy.problem_marks) : []);
  const problemLines = policyProblemLines.length ? policyProblemLines : ((localRecord && localRecord.problemLines) || []);
  const fields = {
    '文件名称': policy.file_name || '',
    '文件类型': policy.source_type || '',
    '原始文本': policy.source_text || '',
    '解析JSON': stringifyJsonField({
      ...policy,
      data: policy.data || {},
    }),
    '审核状态': policy.status === 'confirmed' ? '已确认' : '待审核',
    '确认时间': policy.confirmed_at || null,
    '确认人': policy.confirmed_by && policy.confirmed_by.name ? policy.confirmed_by.name : '',
    '确认人ID': policy.confirmed_by && policy.confirmed_by.openId ? policy.confirmed_by.openId : '',
    '已修改': visibleHistoryText ? '是' : '',
    '修改历史': visibleHistoryText,
    '问题标记': problemLines.join('\n'),
    '规则待确认': ruleSuggestionsText,
  };
  Object.entries(KEY_LABELS).forEach(([key, label]) => {
    if (policy.data && sourceBoundFieldAllowedForPolicy(policy, key) && Object.prototype.hasOwnProperty.call(policy.data, key)) {
      fields[label] = normalizeFeishuValue(policy.data[key]);
    }
  });
  if (localRecord && localRecord.fields) {
    Object.entries(localRecord.fields).forEach(([label, value]) => {
      const key = FIELD_LABEL_TO_KEY[label];
      if (key && !sourceBoundFieldAllowedForPolicy(policy, key)) return;
      fields[label] = value;
    });
  }
  return fields;
}

async function listLocalRecordStatuses() {
  const store = await loadReviewStoreForRead();
  const statuses = {};
  const staticPolicies = store.staticHidden ? [] : loadStaticPolicies();
  staticPolicies.forEach(policy => {
    const localRecord = store.records[policy.id] || null;
    const merged = applyLocalRecordToPolicy(policy, localRecord);
    const fields = policyToFields(merged, localRecord);
    statuses[policy.id] = {
      status: merged.status === 'confirmed' ? 'confirmed' : 'reviewing',
      confirmed_by: merged.confirmed_by || null,
      confirmed_at: merged.confirmed_at || null,
      edited: fields['已修改'] || null,
      change_history: fields['修改历史'] || null,
      problem_marks: fields['问题标记'] || null,
      rule_suggestions: fields['规则待确认'] || null,
      pending_rule_count: parseRuleSuggestions(fields['规则待确认']).filter(item => item.status === 'pending_confirmation').length,
      fields,
      storage: activeReviewStorageName(),
      updated_at: localRecord && localRecord.updated_at ? localRecord.updated_at : null,
    };
  });
  Object.entries(store.records).forEach(([recordId, localRecord]) => {
    if (statuses[recordId]) return;
    const visibleHistoryText = humanChangeHistoryText(localRecord.changeHistory || []);
    const ruleSuggestionsText = formatRuleSuggestions(localRecord.ruleSuggestions || []);
    const fields = {
      ...(localRecord.fields || {}),
      '审核状态': localRecord.status === 'confirmed' ? '已确认' : '待审核',
      '确认时间': localRecord.confirmed_at || null,
      '确认人': localRecord.confirmed_by && localRecord.confirmed_by.name ? localRecord.confirmed_by.name : '',
      '确认人ID': localRecord.confirmed_by && localRecord.confirmed_by.openId ? localRecord.confirmed_by.openId : '',
      '已修改': visibleHistoryText ? '是' : '',
      '修改历史': visibleHistoryText,
      '问题标记': (localRecord.problemLines || []).join('\n'),
      '规则待确认': ruleSuggestionsText,
    };
    statuses[recordId] = {
      status: localRecord.status === 'confirmed' ? 'confirmed' : 'reviewing',
      confirmed_by: localRecord.confirmed_by || null,
      confirmed_at: localRecord.confirmed_at || null,
      edited: fields['已修改'] || null,
      change_history: fields['修改历史'] || null,
      problem_marks: fields['问题标记'] || null,
      rule_suggestions: fields['规则待确认'] || null,
      pending_rule_count: parseRuleSuggestions(fields['规则待确认']).filter(item => item.status === 'pending_confirmation').length,
      fields,
      storage: activeReviewStorageName(),
      updated_at: localRecord.updated_at || null,
    };
  });
  return statuses;
}

function normalizeReviewStatus(fields) {
  let st = fields && fields['审核状态'];
  if (Array.isArray(st)) st = st[0];
  if (st && typeof st === 'object') st = st.text || st.name || st.value || '';
  return normalizeFeishuValue(st) === '已确认' ? 'confirmed' : 'reviewing';
}

function normalizeConfirmedBy(fields) {
  const name = normalizeFeishuValue(fields && fields['确认人']);
  const openId = normalizeFeishuValue(fields && fields['确认人ID']);
  return name || openId ? { name: name || '网页审核用户', openId: openId || 'local_review_user' } : null;
}

function localRecordIdForFields(fields, fallbackIndex) {
  const seed = normalizeFeishuValue(fields['文件名称'] || fields['文件名']) || `record-${fallbackIndex}`;
  return `local_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 14)}`;
}

function findLocalRecordIdByFileName(store, fileName) {
  const target = normalizeFeishuValue(fileName);
  if (!target) return '';
  for (const [recordId, record] of Object.entries(store.records || {})) {
    const existingName = normalizeFeishuValue(record.fields && (record.fields['文件名称'] || record.fields['文件名']));
    if (existingName === target) return recordId;
  }
  if (!store.staticHidden) {
    const staticPolicy = loadStaticPolicies().find(policy => normalizeFeishuValue(policy.file_name) === target);
    if (staticPolicy) return staticPolicy.id;
  }
  return '';
}

async function saveLocalImportedRecords(records) {
  return withReviewStore(store => {
  store.staticHidden = true;
  const imported = [];
  records.forEach((item, index) => {
    const fields = cloneJson(item.fields || item || {});
    const fileName = normalizeFeishuValue(fields['文件名称'] || fields['文件名']);
    if (!fileName) throw new Error('导入记录缺少 文件名称');
    fields['文件名称'] = fileName;
    const recordId = item.recordId || item.id || findLocalRecordIdByFileName(store, fileName) || localRecordIdForFields(fields, index);
    const previous = store.records[recordId] || {};
    const record = getReviewStoreRecord(store, recordId);
    record.fields = {
      ...(previous.fields || {}),
      ...fields,
    };
    record.status = normalizeReviewStatus(record.fields);
    record.confirmed_at = record.fields['确认时间'] || previous.confirmed_at || null;
    record.confirmed_by = normalizeConfirmedBy(record.fields) || previous.confirmed_by || null;
    record.changeHistory = parseChangeHistory(record.fields['修改历史'] || previous.changeHistory || '');
    record.problemLines = splitProblemMarkEntries(record.fields['问题标记'] || previous.problemLines || '');
    record.ruleSuggestions = parseRuleSuggestions(record.fields['规则待确认'] || previous.ruleSuggestions || '');
    record.updated_at = new Date().toISOString();
    imported.push({ recordId, fields: record.fields, fileName, mode: previous.fields ? 'updated' : 'created' });
  });
  appendReviewEvent(store, 'import-records', '', { count: imported.length });
  return imported;
  }, `Import ${records.length} policy review records`);
}

async function clearLocalReviewRecords() {
  return withReviewStore(store => {
  Object.keys(store.records || {}).forEach(key => delete store.records[key]);
  store.events = [];
  store.staticHidden = true;
  appendReviewEvent(store, 'clear-records', '', { scope: 'local' });
  return true;
  }, 'Clear policy review records');
}

async function saveLocalConfirm(recordId, fileName, confirmedBy) {
  return withReviewStore(store => {
  const record = getReviewStoreRecord(store, recordId);
  const now = Date.now();
  record.status = 'confirmed';
  record.confirmed_at = now;
  record.confirmed_by = confirmedBy || fallbackUser();
  record.fields['文件名称'] = fileName || record.fields['文件名称'] || '';
  record.updated_at = new Date().toISOString();
  appendReviewEvent(store, 'confirm', recordId, { fileName, confirmedBy: record.confirmed_by });
  return { confirmedAt: now, confirmedBy: record.confirmed_by };
  }, `Confirm policy review: ${fileName || recordId}`);
}

async function saveLocalReopen(recordId, fileName) {
  return withReviewStore(store => {
  const record = getReviewStoreRecord(store, recordId);
  record.status = 'reviewing';
  record.confirmed_at = null;
  record.confirmed_by = null;
  record.fields['文件名称'] = fileName || record.fields['文件名称'] || '';
  record.updated_at = new Date().toISOString();
  appendReviewEvent(store, 'reopen', recordId, { fileName });
  return true;
  }, `Reopen policy review: ${fileName || recordId}`);
}

async function saveLocalFieldChange({ recordId, fieldLabel, fieldKey, newValue, reason, changeEntry, deleteField, fieldDefinition }) {
  return withReviewStore(store => {
  const record = getReviewStoreRecord(store, recordId);
  const key = fieldKey || FIELD_LABEL_TO_KEY[fieldLabel] || fieldLabel;
  const entry = normalizeChangeEntry(changeEntry, {
    time: new Date().toLocaleString('zh-CN', { hour12: false }),
    user: fallbackUser().name,
    field: key,
    fieldLabel: fieldLabel || KEY_LABELS[key] || key,
    oldValue: '',
    newValue: newValue !== undefined ? String(newValue) : '',
    reason: reason || '',
    source: 'human',
  });
  record.changeHistory.push(entry);
  if (fieldDefinition) record.fieldDefinitions[key] = fieldDefinition;
  if (deleteField) {
    delete record.dataPatch[key];
    if (!record.deletedFields.includes(key)) record.deletedFields.push(key);
    if (fieldLabel) record.fields[fieldLabel] = '';
  } else {
    record.dataPatch[key] = newValue !== undefined ? String(newValue) : '';
    record.deletedFields = record.deletedFields.filter(x => x !== key);
    if (fieldLabel) record.fields[fieldLabel] = record.dataPatch[key];
  }
  const isEffectiveChange = normalizeFeishuValue(entry.oldValue) !== normalizeFeishuValue(entry.newValue);
  if (isEffectiveChange) {
    const label = entry.fieldLabel || fieldLabel || KEY_LABELS[key] || key;
    const problemLine = `[${entry.time}] ${entry.user || fallbackUser().name} | ${label}: ${deleteField ? '删除字段' : '字段修改'}：${entry.oldValue || '(空)'} → ${deleteField ? '(空)' : (entry.newValue || '(空)')}；原因：${entry.reason || '未填写'}`;
    record.problemLines.push(problemLine);
  }
  record.updated_at = new Date().toISOString();
  appendReviewEvent(store, 'save-field', recordId, { fieldKey: key, fieldLabel, newValue, reason, deleteField: !!deleteField });
  return { historyCount: record.changeHistory.length };
  }, `Update policy field: ${fieldLabel || fieldKey || recordId}`);
}

async function saveLocalRuleSuggestion(recordId, suggestion) {
  return withReviewStore(store => {
    const record = getReviewStoreRecord(store, recordId);
    const result = appendRuleSuggestion(record.ruleSuggestions || [], suggestion);
    record.ruleSuggestions = result.suggestions;
    record.fields['规则待确认'] = formatRuleSuggestions(record.ruleSuggestions);
    record.updated_at = new Date().toISOString();
    if (result.changed) appendReviewEvent(store, 'rule-suggestion', recordId, { suggestion: result.suggestion });
    return { count: record.ruleSuggestions.length, suggestion: result.suggestion, changed: result.changed };
  }, `Add parser rule suggestion: ${recordId}`);
}

async function resolveLocalRuleSuggestion(recordId, suggestionId, decision, note, user, regression = null) {
  return withReviewStore(store => {
    const record = getReviewStoreRecord(store, recordId);
    const result = resolveRuleSuggestions(record.ruleSuggestions || [], suggestionId, decision, note, user || fallbackUser());
    if (!result.found) throw new Error('未找到规则建议');
    if (regression) {
      const attached = attachRuleRegression(result.suggestions, suggestionId, regression);
      record.ruleSuggestions = attached.suggestions;
      result.found = attached.found || result.found;
    } else {
      record.ruleSuggestions = result.suggestions;
    }
    record.fields['规则待确认'] = formatRuleSuggestions(record.ruleSuggestions);
    record.updated_at = new Date().toISOString();
    appendReviewEvent(store, 'resolve-rule-suggestion', recordId, { suggestionId, decision, note });
    return result.found;
  }, `Resolve parser rule suggestion: ${recordId}`);
}

async function saveLocalProblem(recordId, entry) {
  return withReviewStore(store => {
  const record = getReviewStoreRecord(store, recordId);
  const line = `[${entry.created_at || new Date().toLocaleString('zh-CN', { hour12: false })}] ${entry.created_by || fallbackUser().name} | ${entry.field_label || '文件整体'}: ${entry.desc || ''}`;
  record.problemLines.push(line);
  record.updated_at = new Date().toISOString();
  appendReviewEvent(store, 'mark-problem', recordId, { entry });
  return { count: record.problemLines.length };
  }, `Mark policy problem: ${recordId}`);
}

async function saveLocalFieldDefinition(fieldKey, fieldDefinition) {
  return withReviewStore(store => {
  const targetType = fieldDefinition.file_type || fieldDefinition.fileType || '';
  let updated = 0;
  loadStaticPolicies().forEach(policy => {
    if (targetType && getPolicyFileType(policy) !== targetType) return;
    const record = getReviewStoreRecord(store, policy.id);
    record.fieldDefinitions[fieldKey] = fieldDefinition;
    record.updated_at = new Date().toISOString();
    updated++;
  });
  appendReviewEvent(store, 'field-definition', '', { fieldKey, fieldDefinition, updated });
  return updated;
  }, `Update policy field definition: ${fieldKey}`);
}

function isAuthOrPermissionError(err) {
  const msg = String((err && err.message) || err || '');
  return msg.includes('NOT_AUTHORIZED') ||
    msg.includes('REFRESH_TOKEN_EXPIRED') ||
    msg.includes('Unauthorized') ||
    msg.includes('permission') ||
    msg.includes('999916');
}

function sendFeishuAuthRequired(res, err) {
  return res.status(401).json({
    success: false,
    error: '需要飞书授权',
    needAuth: true,
    detail: err && err.message ? err.message : String(err || ''),
  });
}

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

// ---- 获取 tenant_access_token：Render 无用户 OAuth 时使用应用身份读写多维表格 ----
async function getTenantAccessToken() {
  if (state.tenantAccessToken && Date.now() < state.tenantTokenExpiresAt - 60000) {
    return state.tenantAccessToken;
  }
  if (!APP_SECRET) throw new Error('NOT_AUTHORIZED');
  const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = await resp.json();
  if (data.code !== 0 || !data.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: ${data.msg || data.message || 'unknown'}`);
  }
  state.tenantAccessToken = data.tenant_access_token;
  state.tenantTokenExpiresAt = Date.now() + (data.expire || 7200) * 1000;
  return state.tenantAccessToken;
}

function normalizeOAuthTokenResponse(data) {
  const payload = data && (data.data || data);
  if (!payload) return null;
  return {
    accessToken: payload.access_token || payload.user_access_token || '',
    refreshToken: payload.refresh_token || payload.user_refresh_token || '',
    expiresIn: payload.expires_in || payload.expires_in_sec || payload.expire || 7200,
  };
}

function getFeishuErrorMessage(data, fallback) {
  return (data && (data.msg || data.message || data.error_description || data.error)) || fallback;
}

function isFeishuErrorResponse(data) {
  return typeof (data && data.code) === 'number' && data.code !== 0;
}

// ---- 获取/刷新 user_access_token ----
async function getUserAccessToken() {
  if (state.userAccessToken && Date.now() < state.tokenExpiresAt - 60000) {
    return state.userAccessToken;
  }
  if (!state.userRefreshToken) {
    return getTenantAccessToken();
  }

  const resp = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: APP_ID,
      client_secret: APP_SECRET,
      refresh_token: state.userRefreshToken,
    }),
  });
  const data = await resp.json();

  const tokenData = normalizeOAuthTokenResponse(data);
  if (isFeishuErrorResponse(data) || !tokenData || !tokenData.accessToken) {
    state.userRefreshToken = null;
    saveTokens();
    return getTenantAccessToken();
  }

  state.userAccessToken = tokenData.accessToken;
  state.userRefreshToken = tokenData.refreshToken || state.userRefreshToken;
  state.tokenExpiresAt = Date.now() + (tokenData.expiresIn || 7200) * 1000;
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
  { field_name: '规则待确认', type: 1 },
];

const UPLOAD_QUEUE_FIELDS = [
  { field_name: '文件名称', type: 1 },
  { field_name: '原始文件', type: 17 },
  { field_name: '文件类型', type: 1 },
  { field_name: '文件大小', type: 1 },
  { field_name: '文件Hash', type: 1 },
  { field_name: '上传人', type: 1 },
  { field_name: '上传人ID', type: 1 },
  { field_name: '上传时间', type: 1 },
  { field_name: '解析状态', type: 1 },
  { field_name: '解析方式', type: 1 },
  { field_name: '批次ID', type: 1 },
  { field_name: '解析结果记录ID', type: 1 },
  { field_name: '审核页记录ID', type: 1 },
  { field_name: '附件缺失说明', type: 1 },
  { field_name: '失败原因', type: 1 },
  { field_name: '解析日志', type: 1 },
  { field_name: '解析开始时间', type: 1 },
  { field_name: '解析完成时间', type: 1 },
  { field_name: '备注', type: 1 },
];

async function listBaseTableFields(baseToken, tableId) {
  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields?page_size=200`;
  const resp = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`获取表格字段失败: ${data.msg} (code=${data.code})`);
  }
  return data.data.items || [];
}

async function createBaseTableField(baseToken, tableId, field) {
  const token = await getUserAccessToken();
  const resp = await fetch(`https://open.feishu.cn/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/fields`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(field),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`创建字段「${field.field_name}」失败: ${data.msg} (code=${data.code})`);
  }
  return data.data && data.data.field;
}

async function ensureUploadQueueFields() {
  if (state.uploadQueueFields) return state.uploadQueueFields;
  let fields = await listBaseTableFields(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID);
  const byName = new Map(fields.map(field => [field.field_name, field]));
  for (const field of UPLOAD_QUEUE_FIELDS) {
    if (byName.has(field.field_name)) continue;
    try {
      const created = await createBaseTableField(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, field);
      console.log(`[上传队列] ✓ 已创建字段: ${field.field_name}`);
      if (created) byName.set(created.field_name || field.field_name, created);
    } catch (e) {
      console.warn(`[上传队列] 创建字段 ${field.field_name} 失败: ${e.message}`);
    }
  }
  fields = await listBaseTableFields(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID);
  state.uploadQueueFields = {
    names: fields.map(field => field.field_name),
    byName: Object.fromEntries(fields.map(field => [field.field_name, field])),
  };
  return state.uploadQueueFields;
}

async function createBaseRecord(baseToken, tableId, fields) {
  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records`;
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
    throw new Error(`创建记录失败: ${data.msg} (code=${data.code})`);
  }
  return data.data.record;
}

async function updateBaseRecord(baseToken, tableId, recordId, fields) {
  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${baseToken}/tables/${tableId}/records/${recordId}`;
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
    throw new Error(`更新记录失败: ${data.msg} (code=${data.code})`);
  }
  return data;
}

async function readFeishuJsonResponse(resp, action) {
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (e) {
    const snippet = text ? text.slice(0, 220).replace(/\s+/g, ' ') : '(empty body)';
    throw new Error(`${action}失败: 飞书返回非JSON响应，HTTP ${resp.status}，内容: ${snippet}`);
  }
  if (!resp.ok) {
    throw new Error(`${action}失败: HTTP ${resp.status} ${data.msg || data.error || ''}`.trim());
  }
  if (data.code !== 0) {
    throw new Error(`${action}失败: ${data.msg || data.error || '未知错误'} (code=${data.code})`);
  }
  return data;
}

async function listBaseRecords(baseToken, tableId) {
  const token = await getUserAccessToken();
  const records = [];
  let offset = 0;
  const pageSize = 200;
  let guard = 0;
  let hasMore = false;
  do {
    const url = `https://open.feishu.cn/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/records?limit=${pageSize}&offset=${offset}`;
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
  } while (hasMore && guard < 50);
  return records;
}

function parseFeishuBaseSource(source) {
  if (!source) return null;
  if (source.baseToken && source.tableId) {
    return { ...source, baseToken: source.baseToken, tableId: source.tableId };
  }
  const rawUrl = normalizeFeishuValue(source.url);
  if (!rawUrl) return null;
  try {
    const normalized = rawUrl.replace(/\\&/g, '&').replace(/，$/g, '');
    const url = new URL(normalized);
    const tableId = url.searchParams.get('table') || source.tableId || '';
    const wikiMatch = url.pathname.match(/\/wiki\/([^/?#]+)/);
    const baseMatch = url.pathname.match(/\/base\/([^/?#]+)/);
    if (baseMatch && tableId) return { ...source, baseToken: baseMatch[1], tableId };
    if (wikiMatch && tableId) return { ...source, wikiToken: wikiMatch[1], tableId };
  } catch (e) {
    console.warn('[黄金样本] URL 解析失败:', rawUrl, e.message);
  }
  return null;
}

async function resolveBitableAppToken(source) {
  if (source.baseToken) return source.baseToken;
  if (!source.wikiToken) throw new Error('缺少 baseToken/wikiToken');
  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(source.wikiToken)}`;
  const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  const data = await resp.json();
  const node = data.data && data.data.node;
  if (data.code !== 0 || !node || !node.obj_token) {
    throw new Error(`解析 wiki 多维表 token 失败: ${data.msg || 'unknown'} (code=${data.code})`);
  }
  return node.obj_token;
}

function fileTypeMatchesGoldenSource(targetType, sourceType, sampleType) {
  const target = normalizePolicyDisplayType(targetType) || normalizeFeishuValue(targetType);
  const source = normalizePolicyDisplayType(sourceType) || normalizeFeishuValue(sourceType);
  const sample = normalizePolicyDisplayType(sampleType) || normalizeFeishuValue(sampleType);
  if (!target) return true;
  const candidates = [source, sample].filter(Boolean);
  if (!candidates.length) return true;
  if (target === '旗舰店') return candidates.some(item => /旗舰店/.test(item));
  if (/旗舰店/.test(target)) return candidates.some(item => /旗舰店/.test(item));
  return candidates.some(item => item === target);
}

function hasParsedKey(parsed, key) {
  if (!parsed || !key) return false;
  return parsedObjects(parsed).some(obj =>
    Object.prototype.hasOwnProperty.call(obj, key) ||
    (obj.data && typeof obj.data === 'object' && Object.prototype.hasOwnProperty.call(obj.data, key)));
}

function parseGoldenExpectedJson(fields) {
  const candidates = [
    '原始政策文件信息',
    '解析JSON',
    '解析结果',
    '结构化结果',
    'JSON',
    '标准答案',
    '期望结果',
    '最终结果',
  ];
  for (const name of candidates) {
    if (!Object.prototype.hasOwnProperty.call(fields || {}, name)) continue;
    const parsed = parseJsonField(fields[name]);
    if (parsed) return parsed;
  }
  const compact = {};
  Object.entries(fields || {}).forEach(([label, value]) => {
    const key = canonicalizeFieldName(label);
    if (key && key !== label && normalizeFeishuValue(value).trim()) compact[key] = value;
  });
  return Object.keys(compact).length ? compact : null;
}

function extractSourceTextFromParsed(parsed) {
  for (const obj of parsedObjects(parsed)) {
    const candidates = [
      obj.source_text,
      obj.original_text,
      obj.raw_text,
      obj.policy_text,
      obj.text,
      obj.data && obj.data.source_text,
      obj.data && obj.data.original_text,
    ];
    const found = candidates.map(normalizeFeishuValue).find(text => text && text.length > 80);
    if (found) return { text: found, kind: 'json_source_text' };
  }
  return { text: '', kind: '' };
}

function extractGoldenSourceText(fields, expectedJson) {
  const fromJson = extractSourceTextFromParsed(expectedJson);
  if (fromJson.text) return fromJson;
  const directFields = ['原始文本', '源文本', '文件内容', '解析文本', '正文', '原文', 'source_text'];
  for (const name of directFields) {
    const text = normalizeFeishuValue(fields && fields[name]);
    if (text && text.length > 80) return { text, kind: name };
  }
  const info = normalizeFeishuValue(fields && fields['原始政策文件信息']);
  if (info && info.length > 200 && !/^\s*[\[{]/.test(info)) return { text: info, kind: '原始政策文件信息' };
  const evidence = normalizeFeishuValue(fields && (fields['解析依据'] || fields['依据'] || fields['提取依据']));
  if (evidence && evidence.length > 120) return { text: evidence, kind: '解析依据' };
  return { text: '', kind: '' };
}

function canonicalComparableValue(value) {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) {
    return value.map(canonicalComparableValue).filter(Boolean).sort().join('、');
  }
  if (typeof value === 'object') {
    const sorted = {};
    Object.keys(value).sort().forEach(key => { sorted[key] = canonicalComparableValue(value[key]); });
    return JSON.stringify(sorted);
  }
  const text = normalizeFeishuValue(value)
    .replace(/\s+/g, '')
    .replace(/需人工确认|待人工确认|未提取|未识别|无法确认/g, '人工确认')
    .replace(/[；;]/g, '；')
    .replace(/至/g, '-');
  return text;
}

function valuesEquivalent(actual, expected) {
  return canonicalComparableValue(actual) === canonicalComparableValue(expected);
}

function sourceTypeForRegression(fileType) {
  if (fileType === '次卡') return 'Excel/Word/PDF';
  if (fileType === '旗舰店券类') return '旗舰店券类';
  if (fileType === '旗舰店code') return '旗舰店Code';
  return fileType || '政策文件';
}

function predictFieldWithCurrentParser(sample, fieldKey) {
  if (!sample.sourceText) return { value: '', parsed: null, fileType: sample.fileType || '', skipped: '缺少可重跑源文' };
  try {
    const result = buildPolicyDataFromSource({
      fileName: sample.fileName,
      source: {
        text: sample.sourceText,
        sourceType: sourceTypeForRegression(sample.fileType),
        tableSummaries: [],
        warnings: [],
      },
      queueFields: {},
    });
    return {
      value: getParsedValue(result.data, fieldKey),
      parsed: result.data,
      fileType: result.fileType,
      skipped: '',
    };
  } catch (e) {
    return { value: '', parsed: null, fileType: sample.fileType || '', skipped: `重跑失败：${e.message}` };
  }
}

function predictFieldWithCandidateRule(sample, fieldKey, baseline, suggestion) {
  if (!baseline || !baseline.parsed) return baseline ? baseline.value : '';
  const ruleType = suggestion.ruleType || (classifyCorrection(fieldKey, suggestion.fieldLabel, suggestion.reason, suggestion.newValue).type);
  if (ruleType === '字段修改原因沉淀规则' || ruleType === '新增字段定义沉淀规则') {
    return baseline.value;
  }
  const fields = {
    '文件名称': sample.fileName,
    '原始文本': sample.sourceText,
    '解析场景': sample.fileType || baseline.fileType || '',
    '业务线': sample.fileType || baseline.fileType || '',
  };
  const derived = deriveAutoValue({
    ruleType,
    fieldKey,
    newValue: suggestion.newValue,
    targetFields: fields,
    targetParsed: baseline.parsed,
  });
  if (derived === null || derived === undefined) return baseline.value;
  return derived;
}

function buildGoldenSampleFromRecord(item, source) {
  const fields = item.fields || {};
  const expectedJson = parseGoldenExpectedJson(fields);
  if (!expectedJson) return null;
  const inferredType = getPolicyFileType(fields, expectedJson);
  const sourceText = extractGoldenSourceText(fields, expectedJson);
  return {
    recordId: item.recordId,
    sourceName: source.name || '',
    fileName: getFileName(fields, expectedJson) || normalizeFeishuValue(fields['文件名称'] || fields['文件名']) || item.recordId,
    fileType: inferredType || source.fileType || '',
    expectedJson,
    sourceText: sourceText.text,
    sourceKind: sourceText.kind,
  };
}

async function loadGoldenSamplesForField(fieldKey, targetFileType) {
  const samples = [];
  const errors = [];
  for (const rawSource of GOLDEN_SAMPLE_SOURCES) {
    if (samples.length >= GOLDEN_REGRESSION_SAMPLE_LIMIT) break;
    const source = parseFeishuBaseSource(rawSource);
    if (!source) {
      errors.push({ source: rawSource.name || rawSource.url || '', error: '样本源配置不可解析' });
      continue;
    }
    if (!fileTypeMatchesGoldenSource(targetFileType, source.fileType, source.fileType)) continue;
    try {
      const baseToken = await resolveBitableAppToken(source);
      const records = await listBaseRecords(baseToken, source.tableId);
      for (const item of records) {
        if (samples.length >= GOLDEN_REGRESSION_SAMPLE_LIMIT) break;
        const sample = buildGoldenSampleFromRecord(item, source);
        if (!sample) continue;
        if (!fileTypeMatchesGoldenSource(targetFileType, source.fileType, sample.fileType)) continue;
        if (!hasParsedKey(sample.expectedJson, fieldKey)) continue;
        samples.push(sample);
      }
    } catch (e) {
      errors.push({ source: source.name || source.url || source.tableId, error: e.message });
    }
  }
  return { samples, errors };
}

async function loadCurrentConfirmedSamplesForField(fieldKey, targetFileType, excludeRecordId) {
  const samples = [];
  try {
    const records = await listAllFeishuRecords();
    for (const item of records) {
      if (samples.length >= 40) break;
      if (item.recordId === excludeRecordId) continue;
      if (normalizeFeishuValue(item.fields && item.fields['审核状态']) !== '已确认') continue;
      const jsonField = getJsonFieldName(item.fields);
      const expectedJson = parseJsonField(jsonField ? item.fields[jsonField] : null);
      if (!expectedJson || !hasParsedKey(expectedJson, fieldKey)) continue;
      const type = getPolicyFileType(item.fields, expectedJson);
      if (!fileTypeMatchesGoldenSource(targetFileType, '', type)) continue;
      const sourceText = extractGoldenSourceText(item.fields, expectedJson);
      samples.push({
        recordId: item.recordId,
        sourceName: '当前审核表已确认样本',
        fileName: getFileName(item.fields, expectedJson) || item.recordId,
        fileType: type,
        expectedJson,
        sourceText: sourceText.text,
        sourceKind: sourceText.kind,
      });
    }
  } catch (e) {
    return { samples, errors: [{ source: '当前审核表已确认样本', error: e.message }] };
  }
  return { samples, errors: [] };
}

function summarizeRegressionRows(rows) {
  return rows.slice(0, 8).map(row => ({
    fileName: row.fileName,
    sourceName: row.sourceName,
    expected: normalizeFeishuValue(row.expected).slice(0, 160),
    before: normalizeFeishuValue(row.before).slice(0, 160),
    after: normalizeFeishuValue(row.after).slice(0, 160),
    status: row.status,
  }));
}

async function runRuleFieldRegression({ suggestion, sourceRecordId, sourceFields, sourceParsed }) {
  const fieldKey = canonicalizeFieldName(suggestion.fieldKey || suggestion.fieldLabel || '');
  const fieldLabel = suggestion.fieldLabel || KEY_LABELS[fieldKey] || fieldKey;
  const sourceFileType = getPolicyFileType(sourceFields || {}, sourceParsed || null);
  const golden = await loadGoldenSamplesForField(fieldKey, sourceFileType);
  const current = await loadCurrentConfirmedSamplesForField(fieldKey, sourceFileType, sourceRecordId);
  const allSamples = [...golden.samples, ...current.samples];
  const seen = new Set();
  const samples = allSamples.filter(sample => {
    const key = `${sample.sourceName}|${sample.fileName}|${sample.recordId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, GOLDEN_REGRESSION_SAMPLE_LIMIT);

  const rows = [];
  const skipped = [];
  for (const sample of samples) {
    const expected = getParsedValue(sample.expectedJson, fieldKey);
    if (!normalizeFeishuValue(expected).trim()) {
      skipped.push({ fileName: sample.fileName, reason: '黄金样本该字段为空' });
      continue;
    }
    if (!sample.sourceText) {
      skipped.push({ fileName: sample.fileName, reason: '缺少可重跑源文' });
      continue;
    }
    const baseline = predictFieldWithCurrentParser(sample, fieldKey);
    if (baseline.skipped) {
      skipped.push({ fileName: sample.fileName, reason: baseline.skipped });
      continue;
    }
    const candidate = predictFieldWithCandidateRule(sample, fieldKey, baseline, suggestion);
    const oldCorrect = valuesEquivalent(baseline.value, expected);
    const newCorrect = valuesEquivalent(candidate, expected);
    let status = 'unchanged';
    if (oldCorrect && !newCorrect) status = 'regression';
    else if (!oldCorrect && newCorrect) status = 'improved';
    else if (!oldCorrect && !newCorrect) status = 'still_wrong';
    else status = 'kept_correct';
    rows.push({
      fileName: sample.fileName,
      sourceName: sample.sourceName,
      expected,
      before: baseline.value,
      after: candidate,
      oldCorrect,
      newCorrect,
      status,
    });
  }

  const checked = rows.length;
  const oldCorrectCount = rows.filter(row => row.oldCorrect).length;
  const newCorrectCount = rows.filter(row => row.newCorrect).length;
  const regressions = rows.filter(row => row.status === 'regression');
  const improvements = rows.filter(row => row.status === 'improved');
  const oldAccuracy = checked ? oldCorrectCount / checked : null;
  const newAccuracy = checked ? newCorrectCount / checked : null;
  const status = regressions.length || (checked && newAccuracy < oldAccuracy)
    ? 'failed'
    : (checked ? 'passed' : 'insufficient');
  const sampleSources = [...new Set(samples.map(sample => sample.sourceName).filter(Boolean))];
  return {
    status,
    fieldKey,
    fieldLabel,
    fileType: sourceFileType,
    checked,
    runnableSamples: checked,
    totalSamples: samples.length,
    skippedCount: skipped.length,
    oldAccuracy,
    newAccuracy,
    oldAccuracyText: checked ? `${oldCorrectCount}/${checked}` : '0/0',
    newAccuracyText: checked ? `${newCorrectCount}/${checked}` : '0/0',
    regressions: regressions.length,
    improvements: improvements.length,
    stillWrong: rows.filter(row => row.status === 'still_wrong').length,
    keptCorrect: rows.filter(row => row.status === 'kept_correct').length,
    regressionRows: summarizeRegressionRows(regressions),
    improvementRows: summarizeRegressionRows(improvements),
    sampleSources,
    skipped: skipped.slice(0, 8),
    sourceErrors: [...golden.errors, ...current.errors].slice(0, 8),
    checkedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

const GOLDEN_COMPARE_SKIP_KEYS = new Set([
  'data',
  'configs',
  'evidence',
  'audit',
  'problems',
  'rule_suggestions',
  FIELD_DEFINITIONS_KEY,
  'source_text',
  'original_text',
  'raw_text',
  'policy_text',
  'text',
  'source_type',
  'source_files',
  'file_name',
  'fileName',
  'parsed_at',
  'status',
  'category',
  'subcategory',
  'confirmed_at',
  'confirmed_by',
  '_change_history',
  'tableSummaries',
  'warnings',
]);

function normalizePolicyFileNameForMatch(name) {
  return path.basename(normalizeFeishuValue(name))
    .replace(/^原始文件\s*[—\-:：]\s*/g, '')
    .replace(/\.(docx?|pdf|xlsx?|xlsm|csv|7z|zip|rar)$/i, '')
    .replace(/\s*[-－—]\s*副本\s*$/g, '')
    .replace(/(?:\(|（)\s*(?:副本|copy|最终|最新版|\d+)\s*(?:\)|）)$/ig, '')
    .replace(/\s+/g, '')
    .replace(/[【】\[\]（）()《》<>“”"'\-－—_·.,，。:：;；]/g, '')
    .toLowerCase();
}

function policyFileNameMatchScore(uploadName, sampleName) {
  const uploadRaw = normalizeFeishuValue(uploadName);
  const sampleRaw = normalizeFeishuValue(sampleName);
  if (!uploadRaw || !sampleRaw) return 0;
  if (uploadRaw === sampleRaw) return 4;
  const upload = normalizePolicyFileNameForMatch(uploadRaw);
  const sample = normalizePolicyFileNameForMatch(sampleRaw);
  if (!upload || !sample) return 0;
  if (upload === sample) return 3;
  if (Math.min(upload.length, sample.length) >= 14 && (upload.includes(sample) || sample.includes(upload))) return 1;
  return 0;
}

function unwrapComparableUnit(obj) {
  if (!obj || typeof obj !== 'object') return {};
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) return obj.data;
  return obj;
}

function comparableUnitsFromParsed(parsed, preferConfigs = false) {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.map(unwrapComparableUnit).filter(obj => obj && typeof obj === 'object');
  const obj = unwrapComparableUnit(parsed);
  const configs = Array.isArray(obj.configs) ? obj.configs : (obj.data && Array.isArray(obj.data.configs) ? obj.data.configs : null);
  if (preferConfigs && configs && configs.length) return configs.map(unwrapComparableUnit).filter(x => x && typeof x === 'object');
  return [obj].filter(x => x && typeof x === 'object');
}

function comparableValueFromUnit(unit, root, key) {
  if (unit && Object.prototype.hasOwnProperty.call(unit, key)) return unit[key];
  if (unit && unit.data && Object.prototype.hasOwnProperty.call(unit.data, key)) return unit.data[key];
  if (root && Object.prototype.hasOwnProperty.call(root, key)) return root[key];
  if (root && root.data && Object.prototype.hasOwnProperty.call(root.data, key)) return root.data[key];
  return '';
}

function comparableKeysFromExpectedUnit(unit) {
  return Object.keys(unit || {})
    .map(canonicalizeFieldName)
    .filter(key => key && !GOLDEN_COMPARE_SKIP_KEYS.has(key));
}

function shortComparableValue(value, limit = 90) {
  const text = normalizeFeishuValue(value);
  if (!text) return '(空)';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

async function loadGoldenSamplesForUpload(force = false) {
  const cacheTtlMs = 10 * 60 * 1000;
  if (!force && state.goldenUploadSamples.loadedAt && Date.now() - state.goldenUploadSamples.loadedAt < cacheTtlMs) {
    return state.goldenUploadSamples;
  }
  const samples = [];
  const errors = [];
  for (const rawSource of GOLDEN_SAMPLE_SOURCES) {
    const source = parseFeishuBaseSource(rawSource);
    if (!source) {
      errors.push({ source: rawSource.name || rawSource.url || '', error: '样本源配置不可解析' });
      continue;
    }
    try {
      const baseToken = await resolveBitableAppToken(source);
      const records = await listBaseRecords(baseToken, source.tableId);
      records.forEach(item => {
        const sample = buildGoldenSampleFromRecord(item, source);
        if (sample) samples.push(sample);
      });
    } catch (e) {
      errors.push({ source: source.name || source.url || source.tableId, error: e.message });
    }
  }
  state.goldenUploadSamples = { loadedAt: Date.now(), samples, errors };
  return state.goldenUploadSamples;
}

async function findGoldenSampleForUpload(fileName, fileType) {
  const { samples, errors } = await loadGoldenSamplesForUpload();
  const matches = samples
    .map(sample => ({
      sample,
      score: policyFileNameMatchScore(fileName, sample.fileName),
      typeMatched: fileTypeMatchesGoldenSource(fileType, sample.sourceName, sample.fileType),
    }))
    .filter(item => item.score >= 3 && item.typeMatched)
    .sort((a, b) => b.score - a.score);
  return {
    sample: matches[0] ? matches[0].sample : null,
    errors,
    candidates: matches.slice(0, 3).map(item => ({
      fileName: item.sample.fileName,
      sourceName: item.sample.sourceName,
      fileType: item.sample.fileType,
      score: item.score,
    })),
  };
}

function compareParsedPolicyWithGoldenSample(policy, sample) {
  const expectedUnits = comparableUnitsFromParsed(sample.expectedJson, true);
  const expectedHasMultipleUnits = Array.isArray(sample.expectedJson) ||
    (sample.expectedJson && typeof sample.expectedJson === 'object' && Array.isArray(unwrapComparableUnit(sample.expectedJson).configs));
  const actualRoot = (policy && policy.data) || {};
  const actualUnits = comparableUnitsFromParsed(actualRoot, expectedHasMultipleUnits);
  const mismatches = [];
  let checked = 0;

  if (expectedHasMultipleUnits && expectedUnits.length !== actualUnits.length) {
    mismatches.push({
      fieldKey: '_config_count',
      fieldLabel: '拆分配置数量',
      expected: expectedUnits.length,
      actual: actualUnits.length,
      unitIndex: 0,
    });
  }

  expectedUnits.forEach((expectedUnit, index) => {
    const actualUnit = actualUnits[index] || actualUnits[0] || {};
    comparableKeysFromExpectedUnit(expectedUnit).forEach(fieldKey => {
      const expected = comparableValueFromUnit(expectedUnit, sample.expectedJson, fieldKey);
      const actual = comparableValueFromUnit(actualUnit, actualRoot, fieldKey);
      checked++;
      if (!valuesEquivalent(actual, expected)) {
        mismatches.push({
          fieldKey,
          fieldLabel: KEY_LABELS[fieldKey] || fieldKey,
          expected,
          actual,
          unitIndex: index + 1,
        });
      }
    });
  });

  return {
    matched: true,
    passed: mismatches.length === 0,
    checked,
    mismatches,
    sampleFileName: sample.fileName,
    sampleSourceName: sample.sourceName,
    sampleFileType: sample.fileType,
    expectedUnitCount: expectedUnits.length,
    actualUnitCount: actualUnits.length,
    checkedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
  };
}

function formatGoldenValidationProblem(report) {
  if (!report || !report.mismatches || !report.mismatches.length) return '';
  const shown = report.mismatches.slice(0, GOLDEN_UPLOAD_MISMATCH_DISPLAY_LIMIT).map(item => {
    const prefix = item.unitIndex > 1 ? `第${item.unitIndex}组 ` : '';
    return `${prefix}${item.fieldLabel}(${item.fieldKey}) 标准=${shortComparableValue(item.expected)}，本次=${shortComparableValue(item.actual)}`;
  });
  const more = report.mismatches.length > shown.length ? `；另有 ${report.mismatches.length - shown.length} 个差异` : '';
  return `[${report.checkedAt}] 黄金样本校验 | 文件整体: 命中黄金样本「${report.sampleFileName}」但本次解析未通过；共校验 ${report.checked} 个字段，发现 ${report.mismatches.length} 个差异：${shown.join('；')}${more}。请进入抽检验证复核，必要时优化解析规则。`;
}

async function applyGoldenSampleUploadValidation(policy, fileType) {
  const match = await findGoldenSampleForUpload(policy.file_name, fileType);
  if (!match.sample) {
    if (match.errors && match.errors.length) {
      policy.evidence = {
        ...(policy.evidence || {}),
        goldenSampleCheck: {
          matched: false,
          sourceErrors: match.errors.slice(0, 5),
          checkedAt: new Date().toLocaleString('zh-CN', { hour12: false }),
        },
      };
    }
    return { matched: false, errors: match.errors || [] };
  }

  const report = compareParsedPolicyWithGoldenSample(policy, match.sample);
  policy.evidence = {
    ...(policy.evidence || {}),
    goldenSampleCheck: {
      ...report,
      mismatches: report.mismatches.slice(0, GOLDEN_UPLOAD_MISMATCH_DISPLAY_LIMIT),
      mismatchCount: report.mismatches.length,
      sourceErrors: match.errors.slice(0, 5),
    },
  };

  if (report.passed) {
    policy.status = 'confirmed';
    policy.confirmed_at = report.checkedAt;
    policy.confirmed_by = {
      name: '黄金样本自动校验',
      openId: 'golden_sample_auto_check',
    };
  } else {
    const line = formatGoldenValidationProblem(report);
    if (line) policy.problem_lines = [...new Set([...(policy.problem_lines || []), line])];
  }
  return report;
}

async function uploadBitableMedia({ baseToken, fileName, buffer }) {
  if (buffer.length > 20 * 1024 * 1024) {
    throw new Error('当前飞书素材直传接口单文件上限为20MB，请先上传小于20MB的文件，或后续补充分片上传能力');
  }
  const token = await getUserAccessToken();
  const url = 'https://open.feishu.cn/open-apis/drive/v1/medias/upload_all';
  const form = new FormData();
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', baseToken);
  form.append('size', String(buffer.length));
  form.append('file', blob, fileName);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  });
  const data = await readFeishuJsonResponse(resp, '上传附件素材');
  const media = data.data || {};
  const fileToken = media.file_token || media.fileToken || media.token;
  if (!fileToken) {
    throw new Error('上传附件素材失败: 飞书未返回 file_token');
  }
  return { ...media, file_token: fileToken };
}

async function uploadBaseAttachment({ baseToken, tableId, recordId, fieldName, fileName, buffer }) {
  const media = await uploadBitableMedia({ baseToken, fileName, buffer });
  await updateBaseRecord(baseToken, tableId, recordId, {
    [fieldName || '原始文件']: [{ file_token: media.file_token }],
  });
  return media;
}

function collectAttachmentMetas(value, out = [], seen = new Set()) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach(item => collectAttachmentMetas(item, out, seen));
    return out;
  }
  if (typeof value !== 'object') return out;
  const token = value.file_token || value.fileToken || value.token || value.file_id || value.fileId;
  if (token && !seen.has(token)) {
    seen.add(token);
    out.push({
      fileToken: token,
      fileName: value.name || value.file_name || value.fileName || value.title || '',
      size: value.size || value.file_size || value.fileSize || 0,
      extra: value.extra || value.extra_info || value.extraInfo || '',
    });
  }
  Object.values(value).forEach(item => {
    if (item && typeof item === 'object') collectAttachmentMetas(item, out, seen);
  });
  return out;
}

async function listBaseRecordAttachments(baseToken, tableId, recordId) {
  const token = await getUserAccessToken();
  const url = `https://open.feishu.cn/open-apis/base/v3/bases/${baseToken}/tables/${tableId}/get_attachments`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ record_id_list: [recordId] }),
  });
  const data = await resp.json();
  if (data.code !== 0) {
    throw new Error(`读取附件元数据失败: ${data.msg || data.message || 'unknown'} (code=${data.code})`);
  }
  return collectAttachmentMetas(data.data || data);
}

async function downloadBaseAttachmentFile(meta) {
  if (!meta || !meta.fileToken) throw new Error('附件缺少 file_token');
  const token = await getUserAccessToken();
  const params = new URLSearchParams();
  if (meta.extra) {
    params.set('extra', typeof meta.extra === 'string' ? meta.extra : JSON.stringify(meta.extra));
  }
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const url = `https://open.feishu.cn/open-apis/drive/v1/medias/${encodeURIComponent(meta.fileToken)}/download${suffix}`;
  const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!resp.ok) {
    let message = `下载附件失败: HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      message = `下载附件失败: ${data.msg || data.message || message}`;
    } catch (_) {
      // ignore non-json body
    }
    throw new Error(message);
  }
  const buffer = Buffer.from(await resp.arrayBuffer());
  if (buffer.length > UPLOAD_QUEUE_DOWNLOAD_LIMIT_BYTES) {
    throw new Error(`附件超过自动解析下载上限 ${formatByteSize(UPLOAD_QUEUE_DOWNLOAD_LIMIT_BYTES)}`);
  }
  return buffer;
}

function getFileExt(fileName) {
  return path.extname(String(fileName || '')).toLowerCase();
}

function normalizeWhitespaceText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sheetRowsToText(rows, sheetName) {
  const lines = [];
  if (sheetName) lines.push(`【Sheet】${sheetName}`);
  rows.forEach(row => {
    const cells = (row || []).map(cell => normalizeFeishuValue(cell).trim());
    if (cells.some(Boolean)) lines.push(cells.join('\t'));
  });
  return lines.join('\n');
}

async function extractPolicySourceFromBuffer(fileName, buffer) {
  const ext = getFileExt(fileName);
  const source = {
    fileName,
    sourceType: getUploadFileType(fileName),
    text: '',
    hasEmbeddedTables: false,
    tableSummaries: [],
    warnings: [],
  };

  if (ext === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    source.text = normalizeWhitespaceText(result.value || '');
    if (result.messages && result.messages.length) {
      source.warnings.push(...result.messages.map(m => m.message || String(m)).filter(Boolean).slice(0, 5));
    }
    source.hasEmbeddedTables = /\t|表格|航线表|价格表|明细表/.test(source.text);
    return source;
  }

  if (ext === '.doc') {
    const doc = await wordExtractor.extract(buffer);
    source.text = normalizeWhitespaceText([
      doc.getBody && doc.getBody(),
      doc.getHeaders && doc.getHeaders(),
      doc.getFooters && doc.getFooters(),
      doc.getFootnotes && doc.getFootnotes(),
      doc.getEndnotes && doc.getEndnotes(),
      doc.getAnnotations && doc.getAnnotations(),
      doc.getTextboxes && doc.getTextboxes(),
    ].filter(Boolean).join('\n'));
    source.hasEmbeddedTables = /\t|表格|航线表|价格表|明细表/.test(source.text);
    return source;
  }

  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv') {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false, dense: true });
    const parts = [];
    workbook.SheetNames.forEach(name => {
      const sheet = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });
      const text = sheetRowsToText(rows, name);
      if (text) {
        parts.push(text);
        source.tableSummaries.push(`${name}: ${rows.filter(row => (row || []).some(Boolean)).length} 行`);
      }
    });
    source.text = normalizeWhitespaceText(parts.join('\n\n'));
    source.hasEmbeddedTables = true;
    return source;
  }

  if (ext === '.pdf') {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      source.text = normalizeWhitespaceText(result.text || '');
      source.hasEmbeddedTables = /表格|航线表|价格表|明细表|\t/.test(source.text);
      return source;
    } finally {
      await parser.destroy().catch(() => {});
    }
  }

  if (ext === '.zip' || ext === '.7z' || ext === '.rar') {
    throw new Error('压缩包暂不在 Render 端自动解压解析，请先解压后上传其中的 Word/PDF/Excel 文件');
  }

  throw new Error(`暂不支持该文件格式: ${ext || '未知'}`);
}

function todayInShanghai() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function parseDateToYmd(value) {
  const text = normalizeFeishuValue(value);
  const m = text.match(/(20\d{2})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})日?/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function addDaysYmd(ymd, days) {
  if (!ymd) return '';
  const date = new Date(`${ymd}T00:00:00+08:00`);
  if (Number.isNaN(date.getTime())) return '';
  date.setDate(date.getDate() + Number(days || 0));
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function normalizeDateRangeParts(match) {
  if (!match) return '';
  const sy = match[1];
  const sm = match[2];
  const sd = match[3];
  const ey = match[4] || sy;
  const em = match[5];
  const ed = match[6];
  if (!sy || !sm || !sd || !em || !ed) return '';
  return `${sy}-${sm.padStart(2, '0')}-${sd.padStart(2, '0')}至${ey}-${em.padStart(2, '0')}-${ed.padStart(2, '0')}`;
}

function extractDateRangeNear(text, labelRegex) {
  const source = normalizeFeishuValue(text);
  const lines = source.split(/\n+/).filter(line => labelRegex.test(line));
  const candidates = lines.length ? lines : [source.slice(0, 1600)];
  const patterns = [
    /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:至|到|-|—|~)\s*(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/,
    /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\s*(?:至|到|-|—|~)\s*(?:(20\d{2})[-/.])?(\d{1,2})[-/.](\d{1,2})/,
  ];
  for (const chunk of candidates) {
    for (const pattern of patterns) {
      const m = chunk.match(pattern);
      const value = normalizeDateRangeParts(m);
      if (value) return value;
    }
  }
  return '';
}

function getRangeStart(value) {
  const m = normalizeFeishuValue(value).match(/^(20\d{2}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function getRangeEnd(value) {
  const m = normalizeFeishuValue(value).match(/至(20\d{2}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function replaceRangeStart(value, start) {
  const end = getRangeEnd(value);
  if (!start || !end) return value;
  return `${start}至${end}`;
}

function extractPatInstruction(text) {
  const source = normalizeFeishuValue(text);
  const compound = [...source.matchAll(/PAT\s*[:：]?\s*A[#*]?\s*C?([A-Z0-9]{2,12})\s*或\s*([A-Z0-9]{2,12})/ig)]
    .map(m => `PAT:A#C${m[1].replace(/^C/, '')}或${m[2].replace(/^C/, '')}`)
    .filter(Boolean);
  if (compound.length) return [...new Set(compound)].join('；');
  const matches = [...source.matchAll(/PAT\s*[:：]?\s*A[#*]?[A-Z0-9@#*_.-]*/ig)]
    .map(m => m[0].replace(/\s+/g, '').replace(/^PAT[:：]?/i, 'PAT:'))
    .filter(Boolean);
  return [...new Set(matches)].join('；');
}

function inferMarketingProductType(text, fileType) {
  const source = normalizeFeishuValue(text);
  if (fileType === '次卡' || /次卡|权益卡|往返卡|共享卡|畅游卡|无限飞/.test(source)) return '权益卡/次卡';
  const types = [];
  const add = value => { if (value && !types.includes(value)) types.push(value); };
  if (/会员|金鹏|明珠|凤凰知音|常旅客/.test(source)) add('会员产品');
  if (/年龄|周岁|银发|长者|青年|少年/.test(source)) add('年龄限制产品');
  if (/学生|开学季|校园/.test(source)) add('学生产品');
  if (/多人|同行|家庭|亲子/.test(source)) add(/家庭|亲子/.test(source) ? '家庭产品' : '多人产品');
  if (/身份证.{0,12}(开头|地区)|区域限制|户籍|属地/.test(source)) add('区域限制/身份证xx开头产品');
  if (/客群|新客|首乘|拉新|定向|专享/.test(source)) add('客群限制产品');
  if (/返现|现金券|现金补贴/.test(source)) add('返现产品');
  if (/特殊退改|优享退票|退改权益/.test(source)) add('特殊退改产品');
  if (/行李|里程|积分/.test(source)) add('赠送行李额/里程/积分');
  if (/直减|立减|优惠金额/.test(source)) add('直减产品');
  if (/男士|女士|性别/.test(source)) add('性别限制类产品');
  if (!types.length && /权益|礼包|酒店|安检|选座|升舱|休息室|餐食|接送机/.test(source)) add('其他优享权益类产品');
  return types.join('；') || '直减产品';
}

function hasSelfTicketingEvidence(text) {
  return /客运销售运价政策|内部运价政策|私有运价|投放单|运价政策|PAT\s*[:：]?\s*A|出票指令|运价基础|FARE\s*BASIS|票价级别|票价计算栏|EI项|BSP方向|OFFICE号|航协号|自营渠道|自有票台|自营配置|国内自营航班|运价引擎|不得手工改价/i.test(text || '');
}

function hasCoreFlagshipEvidence(text) {
  return /旗舰店票台|官网旗舰店|指定官网旗舰店|官网或旗舰店|旗舰店客票|直连合作方|授权销售渠道|授权销售代理|直连客票|BSP客票|TC项|券码|资源编号|消费券|优惠券|coupon/i.test(text || '');
}

function inferPolicyTypeFromEvidence(rawText) {
  const source = normalizeFeishuValue(rawText);
  if (/次卡|权益卡|共享卡|畅游卡|往返卡|无限飞|兑换卡|卡包/.test(source)) return '次卡';
  const selfEvidence = hasSelfTicketingEvidence(source);
  const flagshipEvidence = hasCoreFlagshipEvidence(source);
  const plainFlagshipMention = /旗舰店/.test(source);

  // Plain "OTA旗舰店" in a sales-channel table is only a channel mention.
  // When the file also has PAT/运价基础/自营渠道/运价引擎 evidence, route it to self-operated.
  if (selfEvidence && !flagshipEvidence) return '自营';
  if (flagshipEvidence) {
    return /券类|优惠券|券码|消费券|资源券|coupon|用券|领券/i.test(source) ? '旗舰店券类' : '旗舰店code';
  }
  if (selfEvidence) return '自营';
  if (plainFlagshipMention) return /券类|优惠券|券码|消费券|资源券|coupon|用券|领券/i.test(source) ? '旗舰店券类' : '旗舰店code';
  return '自营';
}

function classifyUploadedPolicy(fileName, text) {
  return inferPolicyTypeFromEvidence(`${fileName || ''}\n${text || ''}`);
}

function extractCarrierNameFromText(fileName, text) {
  const source = `${fileName || ''}\n${text || ''}`;
  const aliases = [
    ['深圳航空', /深圳航空|深航/],
    ['长龙航空', /长龙航空|浙江长龙/],
    ['华夏航空', /华夏航空/],
    ['成都航空', /成都航空|成都航/],
    ['西藏航空', /西藏航空/],
    ['北部湾航空', /北部湾航空/],
    ['天骄航空', /天骄航空/],
    ['奥凯航空', /奥凯航空/],
    ['瑞丽航空', /瑞丽航空|苏南瑞丽/],
    ['首都航空', /首都航空/],
    ['祥鹏航空', /祥鹏航空/],
    ['长安航空', /长安航空|长安航/],
    ['海南航空', /海南航空|海航/],
    ['中国联合航空', /中国联合航空|中联航/],
    ['中国国际航空', /中国国际航空|国航/],
    ['乌鲁木齐航空', /乌鲁木齐航空/],
    ['南方航空', /南方航空|南航/],
    ['东方航空', /东方航空|东航/],
  ];
  for (const [name, re] of aliases) {
    if (re.test(source)) return name;
  }
  const m = source.match(/([\u4e00-\u9fa5]{2,10}航空)/);
  return m ? m[1] : '';
}

function carrierCodeForName(name) {
  const map = {
    深圳航空: 'ZH',
    长龙航空: 'GJ',
    华夏航空: 'G5',
    成都航空: 'EU',
    西藏航空: 'TV',
    北部湾航空: 'GX',
    天骄航空: '9D',
    奥凯航空: 'BK',
    瑞丽航空: 'DR',
    首都航空: 'JD',
    祥鹏航空: '8L',
    长安航空: '9H',
    海南航空: 'HU',
    中国联合航空: 'KN',
    中国国际航空: 'CA',
    乌鲁木齐航空: 'UQ',
    南方航空: 'CZ',
    东方航空: 'MU',
  };
  return map[name] || '';
}

function extractTitleFromSource(fileName, text) {
  const lines = normalizeFeishuValue(text).split(/\n+/).map(line => line.trim()).filter(Boolean);
  const aboutTitle = lines.find(line => /关于.*(政策|规定|规则|产品|通告|通知)/.test(line) && line.length <= 90);
  if (aboutTitle) return aboutTitle.replace(/^关于(?:修订|重新)?(?:制定并)?下发/, '').replace(/[《》]/g, '').replace(/的(?:业务)?(?:通告|通知)$/, '').trim() || aboutTitle;
  const productTitle = lines.find(line => /(产品|政策|规则|规定)$/.test(line) && !/公司|委员会|市场营销|业务通知|业务通告/.test(line) && line.length >= 6 && line.length <= 60);
  if (productTitle) return productTitle;
  const title = lines.find(line => line.length >= 8 && line.length <= 80 && !/^[\d\s\t|:：.-]+$/.test(line));
  return title || String(fileName || '').replace(/\.[^.]+$/, '');
}

function extractPolicyCode(text) {
  const source = normalizeFeishuValue(text);
  const patterns = [
    /([A-Z]{2,6}[-_]?[A-Z0-9]{2,}[-_]?\d{2,}(?:[-_]\d+)?)/,
    /([A-Z]{2,6}\d{6,}[-_]?\d*)/,
    /([\u4e00-\u9fa5]{1,8}(?:市业|客运市场部业|营销部业)?〔20\d{2}〕\d+号)/,
    /(20\d{2}\d{2,4}号)/,
  ];
  for (const pattern of patterns) {
    const m = source.match(pattern);
    if (m) return m[1];
  }
  return '';
}

function extractProductCode(text, carrier) {
  const source = normalizeFeishuValue(text);
  const patterns = [
    /(?:产品代码|产品码|活动代码|活动码|TC项)[:：\s]*([A-Z0-9_-]{2,})/i,
    /\b(TC[A-Z0-9_-]{2,}|[A-Z]{2,5}\d{3,}[A-Z0-9_-]*)\b/,
  ];
  for (const pattern of patterns) {
    const m = source.match(pattern);
    if (m && m[1] && !/^PAT$/i.test(m[1])) {
      const raw = m[1];
      if (carrier === 'HU' && !/^TOURISMROVER_/i.test(raw)) return `TOURISMROVER_${raw}`;
      return raw;
    }
  }
  return '';
}

function inferDiscountPerFromText(text) {
  const source = normalizeFeishuValue(text);
  if (/示例|例：|仅供参考|以实际|以系统|以呈报|不固定|X\s*元/.test(source) && /(直减|优惠|折扣|金额|比例)/.test(source)) return '不固定';
  const variableYuan = source.match(/(?:不超过|最高|上限|封顶|不高于)\s*(\d+(?:\.\d+)?)\s*元/);
  if (variableYuan && /直减|优惠|减免/.test(source)) return `0-${variableYuan[1]}元`;
  const variablePercent = source.match(/(?:不超过|最高|上限|封顶|不高于)\s*(\d+(?:\.\d+)?)\s*%/);
  if (variablePercent) return `≤${variablePercent[1]}%`;
  const yuan = [...source.matchAll(/(?:直减|立减|优惠|减免|下浮|上浮|直加|加价|加收|差价)[^\n]{0,16}?(\d+(?:\.\d+)?)\s*元/g)]
    .map(m => `${m[1]}元`);
  if (yuan.length) return [...new Set(yuan)].slice(0, 8).join('/');
  const percent = [...source.matchAll(/(\d+(?:\.\d+)?)\s*%[^\n]{0,12}(?:直减|折扣|优惠|下浮)|(?:直减|折扣|优惠|下浮)[^\n]{0,12}?(\d+(?:\.\d+)?)\s*%/g)]
    .map(m => `${m[1] || m[2]}%`);
  if (percent.length) return [...new Set(percent)].slice(0, 8).join('/');
  const fixed = source.match(/(?:票面价|票面金额|指定价格|一口价|票价为)[^\n]{0,12}?(\d+(?:\.\d+)?)\s*元/);
  if (fixed) return `${fixed[1]}元`;
  return '';
}

function extractCabin(text) {
  const source = normalizeFeishuValue(text);
  const line = source.split(/\n+/).find(item => /适用舱位|订座舱位|舱位代码|预订舱位|舱位/.test(item));
  if (!line) return '';
  const m = line.match(/(?:适用舱位|订座舱位|舱位代码|预订舱位|舱位)[：:\s]*([A-Z0-9/M、,，\s]+)(?:。|；|;|$)/i);
  if (m && /[A-Z]/i.test(m[1])) return m[1].replace(/[，、\s]+/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  return '';
}

function extractFlightType(text) {
  const source = normalizeFeishuValue(text);
  if (/往返拼接|单次往返|去回程拼接|往返次卡|往返/.test(source)) return '往返';
  if (/单程|单段/.test(source)) return '单程';
  return '单程';
}

function extractOdText(text) {
  const source = normalizeFeishuValue(text);
  const line = source.split(/\n+/).find(item => /航线|航段|OD|始发|到达|适用城市/.test(item) && /[A-Z]{3}[-_=][A-Z]{3}/i.test(item));
  if (!line) return '';
  const routes = [...line.matchAll(/\b([A-Z]{3})\s*[-_=]\s*([A-Z]{3})\b/g)].map(m => `${m[1]}_${m[2]}`);
  if (routes.length) {
    if (/单程/.test(source) && /=/.test(line)) {
      const both = [];
      routes.forEach(route => {
        const [a, b] = route.split('_');
        both.push(`${a}_${b}`, `${b}_${a}`);
      });
      return [...new Set(both)].join(', ');
    }
    return [...new Set(routes)].join(', ');
  }
  return '';
}

function extractRefundChangeSignRules(text) {
  const source = normalizeFeishuValue(text);
  const lines = source.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const out = { refund_rules: '', change_rules: '', sign_and_transfer_rules: '' };
  const push = (key, line) => {
    if (!line || out[key].includes(line)) return;
    out[key] = out[key] ? `${out[key]}；${line}` : line;
  };
  lines.forEach(line => {
    if (line.length > 260) return;
    const hasRefund = /退票|退款|仅退税费|不予退还|退还|自愿退/.test(line);
    const hasChange = /变更|改期|改签|升舱|降舱|改舱/.test(line);
    const hasSign = /签转|外航|EI项|EI\s*[:：]|不得签/.test(line);
    if (hasRefund) push('refund_rules', line);
    if (hasChange) push('change_rules', line);
    if (hasSign) push('sign_and_transfer_rules', line);
    if (hasChange && /按.{0,8}退票/.test(line)) push('refund_rules', line);
    if (hasSign && /按.{0,8}退票/.test(line)) push('refund_rules', line);
  });
  return out;
}

function hasExternalAttachmentReference(source) {
  const text = normalizeFeishuValue(source.text);
  if (!/见附件|详见附件|详见航线表|以附件为准|附件航线|附件表/.test(text)) return false;
  if (source.hasEmbeddedTables || (source.tableSummaries && source.tableSummaries.length)) return false;
  return /(航线|价格|金额|舱位|销售单位|出票单位|日期|航班|范围).{0,20}(见附件|详见附件|详见航线表|以附件为准)|(见附件|详见附件|详见航线表|以附件为准).{0,20}(航线|价格|金额|舱位|销售单位|出票单位|日期|航班|范围)/.test(text);
}

function defaultSchemaValueForField(key) {
  const booleanFalseFields = new Set([
    'sub_cabin','capacity_limit_supplementary','family_limit','realname_limit','equity_related',
    'remium_products','premium_products','display_method','student_verification','student_verification_rules',
    'refund_change_together','same_cabin','benfit_upgrade','take_pay','ticket_hotel','child_applicable',
    'baby_applicable','wether_depart_today'
  ]);
  if (booleanFalseFields.has(key)) return false;
  if (['sale_date','depart_date','flight_type','cabin','discount_type','discount_per','passenger_type','price_voucher','flight_number','not_applicable_flight_number','non_flight_number','beside_od','depart_time','price_groups'].includes(key)) return null;
  return null;
}

function applyScenarioSchemaDefaults(fileType, data) {
  const fields = SCHEMA_FIELDS_BY_TYPE[fileType] || [];
  fields.forEach(key => {
    if (!Object.prototype.hasOwnProperty.call(data, key)) {
      data[key] = defaultSchemaValueForField(key);
    }
  });
  return data;
}

function asArrayValue(value) {
  if (Array.isArray(value)) return value;
  const text = normalizeFeishuValue(value);
  if (!text) return null;
  return text.split(/[、,，/]/).map(item => item.trim()).filter(Boolean);
}

function extractEffectiveDateRange(text) {
  const source = normalizeFeishuValue(text);
  const patterns = [
    /本产品文件自\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:至|到|-|—|~)\s*(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*有效/,
    /自\s*(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*(?:至|到|-|—|~)\s*(?:(20\d{2})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?\s*有效/
  ];
  for (const pattern of patterns) {
    const value = normalizeDateRangeParts(source.match(pattern));
    if (value) return value;
  }
  return '';
}

function extractDepartDateOrigin(text) {
  const source = normalizeFeishuValue(text);
  const lines = source.split(/\n+/).map(line => line.trim()).filter(Boolean);
  const idx = lines.findIndex(line => /适用销售、航班日期|适用销售.*航班日期|销售.*航班日期/.test(line));
  if (idx >= 0) {
    return lines.slice(idx, idx + 2).join('').replace(/^（[一二三四五六七八九十]+）/, '').replace(/适用销售、航班日期[:：]?/, '').trim();
  }
  return '';
}

function extractSaleConstraint(text) {
  const source = normalizeFeishuValue(text);
  const m = source.match(/(?:购买|购票|兑换)(\d+)天后航班（?不含起飞当天）?/);
  if (m) return `D${Number(m[1]) + (/不含起飞当天/.test(m[0]) ? 1 : 0)}`;
  const m2 = source.match(/提前\s*(\d+)\s*天(?:购票|购买|兑换)/);
  if (m2) return `D${Number(m2[1])}`;
  return null;
}

function extractSelfProductCodes(text) {
  const source = normalizeFeishuValue(text);
  const codes = [];
  const add = value => {
    const code = normalizeFeishuValue(value).replace(/^C/, '');
    if (/^[A-Z0-9]{2,12}$/.test(code) && !codes.includes(code)) codes.push(code);
  };
  [...source.matchAll(/\|\s*\d+\s*\|\s*([A-Z0-9]{2,12})\s*\|/g)].forEach(m => add(m[1]));
  [...source.matchAll(/PAT\s*[:：]?\s*A[#*]?\s*C?([A-Z0-9]{2,12})/ig)].forEach(m => add(m[1]));
  const orMatch = source.match(/PAT\s*[:：]?\s*A[#*]?\s*C?([A-Z0-9]{2,12})\s*或\s*([A-Z0-9]{2,12})/i);
  if (orMatch) {
    add(orMatch[1]);
    add(orMatch[2]);
  }
  return codes;
}

function inferBusinessLineForSelfCode(code, text) {
  const source = normalizeFeishuValue(text);
  const row = source.split(/\n+/).find(line => line.includes(code) && /渠道|平台|旗舰店|自营/.test(line)) || '';
  if (/旗舰店/.test(row)) return ['自有票台', '旗舰店票台'];
  return null;
}

function inferSelfDiscountType(text) {
  const source = normalizeFeishuValue(text);
  if (/折扣下浮|下浮比例|下浮优惠|折上折/.test(source)) return '下浮比例';
  if (/直减|立减|减免/.test(source)) return '直减金额';
  if (/指定票面价|票面价|一口价/.test(source)) return '指定票面价';
  if (/直加|上浮|加价|差价/.test(source)) return '溢价产品';
  return inferDiscountType(null, { product_name: source });
}

function inferSelfDiscountPer(text) {
  const source = normalizeFeishuValue(text);
  const maxPercent = source.match(/(?:不超过|最高|上限|封顶|不高于)\s*(\d+(?:\.\d+)?)\s*%/);
  if (maxPercent && /折扣|下浮|优惠/.test(source)) return [`${maxPercent[1]}%`];
  const rate = [...source.matchAll(/(?:下浮|直减|优惠|折扣)[^\n。；]{0,40}?(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%[^\n。；]{0,40}(?:下浮|直减|优惠|折扣)/g)]
    .map(m => `${m[1] || m[2]}%`);
  if (rate.length) return [...new Set(rate)].slice(0, 8);
  const fallback = inferDiscountPerFromText(source);
  return fallback ? asArrayValue(fallback) : null;
}

function buildSelfOperatedConfigs({ text, carrier, saleRange, departRange, cabin, rules }) {
  const effectiveRange = extractEffectiveDateRange(text);
  const productCodes = extractSelfProductCodes(text);
  const codes = productCodes.length ? productCodes : [extractProductCode(text, carrier)].filter(Boolean);
  const departOrigin = extractDepartDateOrigin(text);
  const cabinArr = asArrayValue(cabin);
  const configs = (codes.length ? codes : ['']).map(code => {
    const obj = {};
    applyScenarioSchemaDefaults('自营', obj);
    obj.business_line = code ? inferBusinessLineForSelfCode(code, text) : '自营';
    obj.carrier = carrier || null;
    obj.pata_code = code || null;
    obj.sale_date = effectiveRange || saleRange ? [effectiveRange || saleRange] : null;
    obj.sale_constraint = extractSaleConstraint(text);
    obj.depart_date_origin = departOrigin || null;
    obj.depart_date = /以运价引擎呈报为准|以价引擎呈报为准|呈报为准/.test(departOrigin || text) ? ['需人工确认'] : (departRange ? [departRange] : null);
    obj.flight_type = extractFlightType(text) ? [extractFlightType(text)] : null;
    obj.cabin = cabinArr;
    obj.sub_cabin = /不含子舱/.test(text) ? false : defaultSchemaValueForField('sub_cabin');
    const selfDiscountType = inferSelfDiscountType(text);
    obj.discount_type = selfDiscountType ? [selfDiscountType] : null;
    obj.discount_per = inferSelfDiscountPer(text);
    obj.od = /国内自营航班|国内航线/.test(text) && !extractOdText(text) ? 'ALL-ALL' : (extractOdText(text) || null);
    obj.passenger_type = /儿童/.test(text) ? ['成人', '儿童'] : ['成人'];
    obj.child_applicable = /儿童/.test(text) ? true : null;
    obj.baby_applicable = /婴儿/.test(text) ? true : null;
    obj.luggage_amount = /行李/.test(text) ? '人工确认' : null;
    const cap = text.match(/(\d+)\s*(?:至|-|到)\s*(\d+)\s*人/);
    obj.capacity_limit = cap ? `${cap[1]}-${cap[2]}` : null;
    obj.family_limit = /多人|同行|家庭/.test(text);
    obj.realname_limit = false;
    obj.equity_related = false;
    obj.remium_products = false;
    obj.display_method = false;
    obj.document_restrictions = /身份证/.test(text) ? '1' : null;
    obj.cabin_class = /经济舱|V\/N\/A\/U\/T|V、N、A、U、T/.test(text) ? '经济舱' : null;
    obj.student_verification = false;
    obj.student_verification_rules = false;
    obj.product_label = /多人|同行/.test(text) ? '多人同行' : null;
    obj.display_limit = obj.capacity_limit ? `${obj.capacity_limit.replace('-', '至')}人同行享折扣，限单程国内自营航班` : null;
    obj.refund_change_together = /同时办理变更|同时办理退票|不允许部分人员/.test(text);
    obj.sign_and_transfer_rules = rules && rules.sign_and_transfer_rules ? rules.sign_and_transfer_rules : null;
    obj.refund_rules = rules && rules.refund_rules ? rules.refund_rules : '需人工确认';
    obj.change_rules = rules && rules.change_rules ? rules.change_rules : '需人工确认';
    return obj;
  });
  return configs;
}

function buildPolicyDataFromSource({ fileName, source, queueFields }) {
  const text = `${fileName || ''}\n${source.text || ''}`;
  const fileType = classifyUploadedPolicy(fileName, source.text);
  const displayType = displayTypeForFileType(fileType) || fileType;
  const carrierName = extractCarrierNameFromText(fileName, source.text);
  const carrier = carrierCodeForName(carrierName);
  const policyCode = extractPolicyCode(text);
  const uploadDate = parseDateToYmd(queueFields && queueFields['上传时间']) || todayInShanghai();
  const docDate = extractDocumentDate(text);
  const titleRange = inferDateRangeFromTitle(text, 'depart_date');
  const saleRange = extractDateRangeNear(text, /销售|售卖|出票|购卡|购买|发售|上线/);
  const departRange = extractDateRangeNear(text, /航班|旅行|出行|乘机|适用日期|适用时间|使用日期/) || titleRange;
  const redeemRange = extractDateRangeNear(text, /兑换|使用|预约|核销/);
  const pat = extractPatInstruction(text);
  const cabin = extractCabin(text);
  const rules = extractRefundChangeSignRules(text);
  if (fileType === '自营') {
    const configs = buildSelfOperatedConfigs({ text, carrier, saleRange, departRange, cabin, rules });
    const primary = configs[0] || {};
    const data = {
      scenario: displayType,
      carrier_name: carrierName,
      product_name: extractTitleFromSource(fileName, source.text),
      product_family: inferMarketingProductType(text, fileType),
      policy_code: policyCode,
      corporate_code: inferCorporateCode({ '文件名称': fileName, '原始文本': source.text }, {}),
      product_code: configs.map(item => item.pata_code).filter(Boolean).join('/') || extractProductCode(text, carrier) || null,
      ...primary,
      configs,
    };
    if (!data.corporate_code) data.corporate_code = null;
    applyScenarioSchemaDefaults(fileType, data);
    return { data, fileType };
  }
  const data = {
    scenario: displayType,
    business_line: displayType,
    carrier,
    carrier_name: carrierName,
    product_name: extractTitleFromSource(fileName, source.text),
    product_family: inferMarketingProductType(text, fileType),
    policy_code: policyCode,
    corporate_code: inferCorporateCode({ '文件名称': fileName, '原始文本': source.text }, {}),
    flight_type: extractFlightType(text),
    od: extractOdText(text),
    booking_cabin: cabin,
    cabin,
    sale_date: saleRange,
    depart_date: departRange,
    discount_type: inferDiscountType(null, { product_name: text }),
    discount_per: inferDiscountPerFromText(text),
    age_limit: normalizeAgeRangeText('', text),
    child_applicable: inferChildApplicable(null, { product_name: text }),
    document_restrictions: /年龄|周岁|青年|长者|银发|学生/.test(text) ? '居民身份证' : '',
    ...rules,
  };

  const productCode = extractProductCode(text, carrier);
  if (productCode) data.product_code = productCode;

  if (fileType === '自营') {
    if (pat) data.product_type = pat;
  } else if (fileType === '次卡') {
    data.product_type = pat || '';
  } else {
    delete data.product_type;
  }

  const manual = [];
  const markManual = key => {
    const label = KEY_LABELS[key] || key;
    if (!manual.includes(label)) manual.push(label);
    data[key] = '人工确认';
  };

  if (!data.booking_cabin && SERVER_PROMPT_FIELDS[fileType] && SERVER_PROMPT_FIELDS[fileType].has('booking_cabin')) {
    markManual('booking_cabin');
    data.cabin = '人工确认';
  }

  if (fileType === '次卡') {
    if (data.sale_date) {
      const start = getRangeStart(data.sale_date);
      const end = getRangeEnd(data.sale_date);
      if (start && uploadDate && start < uploadDate && (!end || uploadDate <= end)) {
        data.sale_date = replaceRangeStart(data.sale_date, uploadDate);
      }
    } else {
      markManual('sale_date');
    }
    if (!data.depart_date) markManual('depart_date');
    if (!data.redeem_date && !data.use_date) {
      const departEnd = getRangeEnd(data.depart_date);
      const inferredEnd = departEnd ? addDaysYmd(departEnd, -3) : '';
      if (inferredEnd) {
        data.redeem_date = `人工确认（按旅行最晚日期-3天推算为${inferredEnd}，需确认含/不含当天）`;
        data.use_date = data.redeem_date;
        if (!manual.includes('兑换日期')) manual.push('兑换日期');
      } else {
        markManual('redeem_date');
        data.use_date = '人工确认';
      }
    }
    data.product_family = '权益卡/次卡';
    data.json_count = '按航程类型、舱等、使用次数拆分；价格进入价格组';
    if (!data.product_code) markManual('product_code');
  }

  if (!data.discount_type && /优惠|直减|折扣|票面价|一口价|溢价|上浮|下浮/.test(text)) markManual('discount_type');
  if (!data.discount_per && /优惠|直减|折扣|金额|票面价|一口价|溢价|上浮|下浮/.test(text)) markManual('discount_per');

  Object.keys(data).forEach(key => {
    if (data[key] === '' || data[key] === undefined || data[key] === null) delete data[key];
  });

  if (manual.length) data.manual_confirm_fields = [...new Set(manual)].join('；');

  const benefits = inferBenefitFields({
    '文件名称': fileName,
    '原始文本': source.text,
  }, data);
  if (benefits) {
    if (benefits.benefit_name) data.benefit_name = benefits.benefit_name;
    if (benefits.benefit_usage_rules) data.benefit_usage_rules = benefits.benefit_usage_rules;
  }

  applyScenarioSchemaDefaults(fileType, data);
  removeUnsupportedScenarioFields(null, data);
  return { data, fileType };
}

async function upsertPolicyReviewRecord(policy) {
  const tableFields = await ensureTableFields();
  const incoming = filterKnownFields(policyToFields(policy, null), tableFields);
  const records = await listAllFeishuRecords();
  const fileName = normalizeFeishuValue(incoming['文件名称']);
  const existing = records.find(record => normalizeFeishuValue(record.fields && record.fields['文件名称']) === fileName);
  if (!existing) {
    const created = await createFeishuRecord(incoming);
    return { recordId: created.record_id, mode: 'created' };
  }

  const reviewed = normalizeFeishuValue(existing.fields && existing.fields['审核状态']) === '已确认' ||
    normalizeFeishuValue(existing.fields && existing.fields['已修改']) === '是' ||
    !!normalizeFeishuValue(existing.fields && existing.fields['修改历史']) ||
    !!normalizeFeishuValue(existing.fields && existing.fields['问题标记']);
  if (reviewed) {
    return { recordId: existing.recordId, mode: 'kept-reviewed' };
  }

  const preserve = ['审核状态', '确认人', '确认人ID', '确认时间', '已修改', '修改历史', '问题标记'];
  const updates = { ...incoming };
  const incomingConfirmed = normalizeFeishuValue(incoming['审核状态']) === '已确认';
  preserve.forEach(name => {
    if (incomingConfirmed && ['审核状态', '确认人', '确认人ID', '确认时间'].includes(name)) return;
    if (normalizeFeishuValue(existing.fields && existing.fields[name])) delete updates[name];
  });
  await updateFeishuRecord(existing.recordId, filterKnownFields(updates, tableFields));
  return { recordId: existing.recordId, mode: 'updated' };
}

function uploadQueueRecordNeedsParse(item) {
  const f = item.fields || {};
  const status = normalizeFeishuValue(f['解析状态']);
  const fileName = normalizeFeishuValue(f['文件名称']);
  const reviewRecordId = normalizeFeishuValue(f['审核页记录ID']);
  if (!fileName || reviewRecordId) return false;
  return !status || /待解析|待重试|上传完成|重新解析/.test(status);
}

async function processUploadQueueRecord(item) {
  const recordId = item.recordId;
  const fields = item.fields || {};
  const fileName = normalizeFeishuValue(fields['文件名称']);
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId, {
    '解析状态': '解析中',
    '解析开始时间': now,
    '解析日志': '后台 worker 已领取任务，正在下载源文件',
    '失败原因': '',
  });

  const attachments = await listBaseRecordAttachments(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId);
  if (!attachments.length) {
    const message = '队列记录没有可下载的原始文件附件';
    await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId, {
      '解析状态': '缺附件',
      '附件缺失说明': message,
      '失败原因': message,
      '解析完成时间': new Date().toLocaleString('zh-CN', { hour12: false }),
    });
    return { success: false, recordId, fileName, status: '缺附件', error: message };
  }

  const meta = attachments.find(a => normalizeFeishuValue(a.fileName) === fileName) || attachments[0];
  const buffer = await downloadBaseAttachmentFile(meta);
  const source = await extractPolicySourceFromBuffer(fileName || meta.fileName, buffer);
  if (!source.text) throw new Error('源文件未抽取到可解析文本');
  if (hasExternalAttachmentReference(source)) {
    const message = '正文核心字段指向附件/航线表，但当前上传文件未包含可读表格或附件内容，请补传附件后再解析';
    await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId, {
      '解析状态': '缺附件',
      '附件缺失说明': message,
      '失败原因': message,
      '解析完成时间': new Date().toLocaleString('zh-CN', { hour12: false }),
      '解析日志': `已抽取文本 ${source.text.length} 字，但缺少附件内容`,
    });
    return { success: false, recordId, fileName, status: '缺附件', error: message };
  }

  const { data, fileType } = buildPolicyDataFromSource({ fileName, source, queueFields: fields });
  const policy = {
    id: `upload_${recordId}`,
    file_name: fileName,
    source_type: source.sourceType,
    source_text: source.text,
    source_files: [fileName],
    category: fileType === '次卡' ? '01_次卡' : (fileType === '自营' ? '03_自营' : (fileType === '旗舰店券类' ? '02_旗舰店券类' : '02_旗舰店code')),
    subcategory: data.carrier_name || displayTypeForFileType(fileType) || fileType,
    parsed_at: new Date().toLocaleString('zh-CN', { hour12: false }),
    status: 'reviewing',
    data,
    evidence: {
      uploadQueueRecordId: recordId,
      tableSummaries: source.tableSummaries,
      warnings: source.warnings,
      parser: 'upload_queue_worker_rule_based_v1',
    },
  };
  const goldenReport = await applyGoldenSampleUploadValidation(policy, fileType);
  const review = await upsertPolicyReviewRecord(policy);
  let parseStatus = review.mode === 'kept-reviewed' ? '已存在已审核' : '待审核';
  let parseLogSuffix = '';
  if (goldenReport && goldenReport.matched) {
    if (review.mode === 'kept-reviewed') {
      parseLogSuffix = `；命中黄金样本「${goldenReport.sampleFileName}」，但审核记录已有人工/确认状态，保持原记录不覆盖`;
    } else if (goldenReport.passed) {
      parseStatus = '已确认';
      parseLogSuffix = `；命中黄金样本「${goldenReport.sampleFileName}」，${goldenReport.checked} 个字段校验通过，已自动确认`;
    } else {
      parseStatus = '待抽检';
      parseLogSuffix = `；命中黄金样本「${goldenReport.sampleFileName}」，发现 ${goldenReport.mismatches.length} 个差异，已进入抽检验证`;
    }
  }
  await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId, {
    '解析状态': parseStatus,
    '审核页记录ID': review.recordId,
    '解析结果记录ID': review.recordId,
    '解析完成时间': new Date().toLocaleString('zh-CN', { hour12: false }),
    '解析日志': `已解析并${review.mode === 'created' ? '创建' : (review.mode === 'kept-reviewed' ? '复用已审核' : '更新')}审核记录；文本 ${source.text.length} 字；类型=${displayTypeForFileType(fileType) || fileType}${parseLogSuffix}`,
    '失败原因': '',
  });
  return { success: true, recordId, fileName, reviewRecordId: review.recordId, mode: review.mode, fileType, goldenSample: goldenReport };
}

async function scanUploadQueue(reason = 'manual') {
  if (!UPLOAD_QUEUE_SCAN_ENABLED) {
    return { success: false, skipped: true, reason: 'UPLOAD_QUEUE_SCAN_ENABLED=false' };
  }
  if (state.uploadQueueScan.running) {
    return { success: true, skipped: true, reason: 'scan already running', lastResult: state.uploadQueueScan.lastResult };
  }
  state.uploadQueueScan.running = true;
  state.uploadQueueScan.lastRunAt = new Date().toISOString();
  const result = { success: true, reason, processed: 0, succeeded: 0, failed: 0, items: [] };
  try {
    await ensureUploadQueueFields();
    const records = await listBaseRecords(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID);
    const targets = records.filter(uploadQueueRecordNeedsParse).slice(0, Math.max(1, UPLOAD_QUEUE_SCAN_BATCH_LIMIT));
    const outcomes = await runLimited(targets, 1, async item => {
      try {
        return await processUploadQueueRecord(item);
      } catch (e) {
        const fileName = normalizeFeishuValue(item.fields && item.fields['文件名称']);
        await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, item.recordId, {
          '解析状态': '解析失败',
          '失败原因': e.message,
          '解析完成时间': new Date().toLocaleString('zh-CN', { hour12: false }),
          '解析日志': `后台解析失败：${e.message}`,
        }).catch(updateErr => console.warn('[上传队列] 失败状态回写失败:', updateErr.message));
        return { success: false, recordId: item.recordId, fileName, status: '解析失败', error: e.message };
      }
    });
    result.processed = targets.length;
    result.items = outcomes;
    result.succeeded = outcomes.filter(x => x && x.success).length;
    result.failed = outcomes.filter(x => x && !x.success).length;
    state.uploadQueueScan.lastResult = result;
    return result;
  } finally {
    state.uploadQueueScan.running = false;
  }
}

function scheduleUploadQueueScan(reason = 'scheduled') {
  if (!UPLOAD_QUEUE_SCAN_ENABLED || state.uploadQueueScan.scheduled) return;
  state.uploadQueueScan.scheduled = true;
  setImmediate(() => {
    state.uploadQueueScan.scheduled = false;
    scanUploadQueue(reason).catch(e => {
      state.uploadQueueScan.lastResult = { success: false, reason, error: e.message };
      console.warn('[上传队列] 后台扫描失败:', e.message);
    });
  });
}

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
    return splitChangeHistoryEntries(raw);
  }
  if (Array.isArray(raw)) return raw;
  return [];
}

// 把修改历史格式化为多行文本
function formatChangeHistory(entries) {
  return entries
    .map(e => {
      if (typeof e === 'string') {
        const normalized = normalizeHistoryEntry(e);
        if (!normalized) return e;
        e = normalized;
      }
      const source = normalizeChangeSource(e);
      return `[${e.time}] ${e.user || ''} | ${e.fieldLabel || e.field || ''}: ${e.oldValue || '(空)'} → ${e.newValue || '(空)'} | 原因: ${e.reason || '未填写'} | 来源: ${source === 'auto' ? '系统修正' : '人工修改'}`.trim();
    })
    .join('\n');
}

function humanEditedFieldLabelsFromHistory(rawHistory) {
  const labels = new Set();
  parseChangeHistory(rawHistory)
    .map(normalizeHistoryEntry)
    .filter(Boolean)
    .forEach(entry => {
      if (normalizeChangeSource(entry) !== 'human') return;
      const key = canonicalizeFieldName(entry.field || entry.fieldLabel || '');
      const label = entry.fieldLabel || (key && KEY_LABELS[key]) || '';
      if (label) labels.add(label);
      if (key && KEY_LABELS[key]) labels.add(KEY_LABELS[key]);
    });
  return labels;
}

function humanChangeHistoryEntries(rawHistory) {
  return parseChangeHistory(rawHistory)
    .map(normalizeHistoryEntry)
    .filter(Boolean)
    .filter(entry => normalizeChangeSource(entry) === 'human')
    .filter(entry => normalizeFeishuValue(entry.oldValue) !== normalizeFeishuValue(entry.newValue));
}

function humanChangeHistoryText(rawHistory) {
  return formatChangeHistory(humanChangeHistoryEntries(rawHistory));
}

function normalizeChangeSource(entry = {}) {
  const raw = normalizeFeishuValue(entry.source || entry.changeSource || entry.origin || entry.type).toLowerCase();
  const user = normalizeFeishuValue(entry.user);
  const reason = normalizeFeishuValue(entry.reason);
  if (['auto', 'system', 'ai', 'batch', 'auto_rule'].includes(raw)) return 'auto';
  if (/AUTO_RULE|^系统$|^auto/i.test(user)) return 'auto';
  if (/^自动|自动矫正|系统自动|系统回滚|按当前文件.+修复|按当前原文复核拆分/.test(reason)) return 'auto';
  return 'human';
}

function normalizeHistoryEntry(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    const text = entry.trim();
    if (!text) return null;
    const match = text.match(/^\[([^\]]*)\]\s*([^|]*)\|\s*([^:：]+)[:：]\s*([\s\S]*?)\s*→\s*([\s\S]*?)(?:\s*\|\s*原因[:：]\s*([\s\S]*))?$/);
    if (!match) return null;
    const fieldLabel = match[3].trim();
    const field = canonicalizeFieldName(fieldLabel);
    let reason = (match[6] || '').trim();
    let source = '';
    const sourceMatch = reason.match(/([\s\S]*?)\s*\|\s*来源[:：]\s*(人工修改|系统修正|auto|human|system)\s*$/i);
    if (sourceMatch) {
      reason = sourceMatch[1].trim();
      source = /系统|auto|system/i.test(sourceMatch[2]) ? 'auto' : 'human';
    }
    const normalized = {
      time: match[1].trim(),
      user: match[2].trim(),
      fieldLabel,
      field,
      oldValue: (match[4] || '').trim(),
      newValue: (match[5] || '').trim(),
      reason,
      source,
    };
    normalized.source = normalizeChangeSource(normalized);
    return normalized;
  }
  if (typeof entry === 'object') {
    const fieldLabel = entry.fieldLabel || entry.field_label || entry.label || entry.field || '';
    const field = canonicalizeFieldName(entry.field || fieldLabel);
    const normalized = {
      time: entry.time || entry.created_at || entry.updated_at || '',
      user: entry.user || entry.created_by || entry.operator || '',
      fieldLabel: fieldLabel || KEY_LABELS[field] || field,
      field,
      oldValue: entry.oldValue !== undefined ? entry.oldValue : (entry.old_value !== undefined ? entry.old_value : ''),
      newValue: entry.newValue !== undefined ? entry.newValue : (entry.new_value !== undefined ? entry.new_value : ''),
      reason: entry.reason || entry.desc || '',
      source: entry.source || entry.changeSource || entry.origin || '',
    };
    normalized.source = normalizeChangeSource(normalized);
    return normalized;
  }
  return null;
}

function appendProblemLine(rawProblemMarks, line) {
  const lines = normalizeFeishuValue(rawProblemMarks).split('\n').filter(Boolean);
  if (line && !lines.includes(line)) lines.push(line);
  return lines.join('\n');
}

function splitChangeHistoryEntries(raw) {
  const lines = normalizeFeishuValue(raw).split('\n');
  const entries = [];
  let current = '';
  const entryStart = /^\[\d{4}[-/]\d{1,2}[-/]\d{1,2}[^\]]*\]/;
  lines.forEach(line => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (entryStart.test(trimmed)) {
      if (current) entries.push(current);
      current = trimmed;
    } else if (current) {
      current += `\n${trimmed}`;
    } else {
      current = trimmed;
    }
  });
  if (current) entries.push(current);
  return entries;
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
  const normalized = {
    time: src.time || fallback.time || new Date().toLocaleString('zh-CN', { hour12: false }),
    user: src.user || fallback.user || '',
    fieldLabel: src.fieldLabel || src.field || fallback.fieldLabel || fallback.field || '',
    field: src.field || fallback.field || src.fieldLabel || fallback.fieldLabel || '',
    oldValue: src.oldValue !== undefined ? src.oldValue : (fallback.oldValue || ''),
    newValue: src.newValue !== undefined ? src.newValue : (fallback.newValue || ''),
    reason: src.reason || fallback.reason || '',
    source: src.source || src.changeSource || fallback.source || fallback.changeSource || '',
  };
  normalized.source = normalizeChangeSource(normalized);
  return normalized;
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
    .filter(part => !/^字段「.+」仍为人工确认/.test(part))
    .filter(part => !/^[\w\u4e00-\u9fa5（）()\/\-]+需人工确认$/.test(part))
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
  const targets = Array.isArray(parsed) && DOCUMENT_LEVEL_KEYS.has(key)
    ? parsed.slice(0, 1)
    : (Array.isArray(parsed) ? parsed : [parsed]);
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
  targets.forEach(applyOne);
  if (Array.isArray(parsed) && DOCUMENT_LEVEL_KEYS.has(key)) {
    parsed.slice(1).forEach(obj => {
      if (!obj || typeof obj !== 'object') return;
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        delete obj[key];
        changed = true;
      }
      if (obj.data && typeof obj.data === 'object' && Object.prototype.hasOwnProperty.call(obj.data, key)) {
        delete obj.data[key];
        changed = true;
      }
    });
  }
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
  const targets = Array.isArray(parsed) && DOCUMENT_LEVEL_KEYS.has(key)
    ? parsed.slice(0, 1)
    : (Array.isArray(parsed) ? parsed : [parsed]);
  const applyOne = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    changed = setParsedFieldDefinition(obj, key, fieldDefinition) || changed;
    if (obj.data && typeof obj.data === 'object') {
      changed = setParsedFieldDefinition(obj.data, key, fieldDefinition) || changed;
    }
  };
  targets.forEach(applyOne);
  if (Array.isArray(parsed) && DOCUMENT_LEVEL_KEYS.has(key)) {
    parsed.slice(1).forEach(obj => {
      if (!obj || typeof obj !== 'object') return;
      if (obj[FIELD_DEFINITIONS_KEY] && typeof obj[FIELD_DEFINITIONS_KEY] === 'object' && Object.prototype.hasOwnProperty.call(obj[FIELD_DEFINITIONS_KEY], key)) {
        delete obj[FIELD_DEFINITIONS_KEY][key];
        changed = true;
      }
      if (obj.data && obj.data[FIELD_DEFINITIONS_KEY] && typeof obj.data[FIELD_DEFINITIONS_KEY] === 'object' && Object.prototype.hasOwnProperty.call(obj.data[FIELD_DEFINITIONS_KEY], key)) {
        delete obj.data[FIELD_DEFINITIONS_KEY][key];
        changed = true;
      }
    });
  }
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

function displayTypeForFileType(fileType) {
  if (fileType === '次卡') return '次卡';
  if (fileType === '自营') return '自营';
  if (fileType === '旗舰店code' || fileType === '旗舰店券类') return '旗舰店';
  return '';
}

function normalizePolicyDisplayType(value) {
  const text = normalizeFeishuValue(value);
  if (!text) return '';
  if (/次卡/.test(text)) return '次卡';
  if (/自营|自有票台/.test(text)) return '自营';
  if (/旗舰店|旗舰店票台|旗舰店code|旗舰店券类/.test(text)) return '旗舰店';
  return text;
}

function inferFlagshipSubtypeFromText(text) {
  return /券类|优惠券|券码|消费券|资源券|coupon/i.test(text || '') ? '旗舰店券类' : '旗舰店code';
}

function getPolicyFileType(fields, parsed) {
  const explicitBusinessLine = normalizeFeishuValue(getParsedValue(parsed, 'business_line') || (fields && fields['业务线']));
  const explicitScenario = normalizeFeishuValue(getParsedValue(parsed, 'scenario') || (fields && fields['解析场景']));
  const text = [
    getFileName(fields, parsed),
    normalizeFeishuValue(fields && fields['解析场景']),
    normalizeFeishuValue(fields && fields['业务线']),
    normalizeFeishuValue(fields && fields['产品名称']),
    normalizeFeishuValue(fields && (fields['原始文本'] || fields['源文本'] || fields['文件内容'] || fields['解析文本'])),
    normalizeFeishuValue(getParsedValue(parsed, 'scenario')),
    normalizeFeishuValue(getParsedValue(parsed, 'business_line')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_family')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_category')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_name')),
    normalizeFeishuValue(getParsedValue(parsed, 'coupon_resource_code')),
    normalizeFeishuValue(getParsedValue(parsed, 'product_code')),
    normalizeFeishuValue(getParsedValue(parsed, 'coupon_name')),
  ].filter(Boolean).join(' ');
  const evidenceType = inferPolicyTypeFromEvidence(text);
  if (evidenceType === '自营' && hasSelfTicketingEvidence(text)) return '自营';
  if (/次卡/.test(explicitBusinessLine) || /次卡/.test(explicitScenario)) return '次卡';
  if (/自营|自有票台/.test(explicitBusinessLine) || explicitScenario === '自营') return '自营';
  if (/旗舰店券/.test(explicitBusinessLine) || /旗舰店券类/.test(explicitScenario)) return '旗舰店券类';
  if (/旗舰店|旗舰店票台/.test(explicitBusinessLine) || /旗舰店|旗舰店票台|旗舰店code/.test(explicitScenario)) {
    return inferFlagshipSubtypeFromText(text);
  }
  return evidenceType;
}

function normalizeScenarioBusinessLineDisplay(fields, parsed) {
  if (!parsed) return [];
  const fileType = getPolicyFileType(fields, parsed);
  const displayType = displayTypeForFileType(fileType);
  if (!displayType) return [];
  const changes = [];
  ['scenario', 'business_line'].forEach(key => {
    const before = getParsedValue(parsed, key) || normalizeFeishuValue(fields && fields[KEY_LABELS[key]]);
    const after = normalizePolicyDisplayType(displayType);
    if (!after || normalizePolicyDisplayType(before) === after) return;
    if (setParsedField(parsed, key, after)) {
      changes.push({
        key,
        label: KEY_LABELS[key],
        before,
        after,
        reason: '统一展示口径：自有票台展示为自营，旗舰店票台展示为旗舰店；内部字段集路由保持不变',
      });
    }
  });
  return changes;
}

function repairScenarioFromBusinessLine(fields, parsed) {
  return normalizeScenarioBusinessLineDisplay(fields, parsed);
}

function removeUnsupportedScenarioFields(fields, parsed) {
  if (!parsed) return [];
  const fileType = getPolicyFileType(fields, parsed);
  const allowed = SERVER_PROMPT_FIELDS[fileType] || new Set();
  const removable = ['redeem_date', 'use_date'];
  const changes = [];
  removable.forEach(key => {
    if (allowed.has(key)) return;
    const before = getParsedValue(parsed, key);
    if (!before) return;
    if (deleteParsedField(parsed, key)) {
      changes.push({
        key,
        label: KEY_LABELS[key] || key,
        before,
        after: '',
        reason: `当前文件类型为${fileType}，该字段不属于对应提示词字段集，移除跨场景残留字段`,
      });
    }
  });
  return changes;
}

function isBlankish(value) {
  const text = normalizeFeishuValue(value).trim();
  return !text ||
    ['null', 'undefined', '待确认', '需人工确认', '人工确认', '未提取', '未识别', '无法确认', '未获取', '(空)', '空', '暂无'].includes(text) ||
    /^(待确认|需人工确认|人工确认|未提取|未识别|无法确认|未获取)/.test(text);
}

function hasConcreteFieldValue(value) {
  return !isBlankish(value);
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
  const docDate = extractDocumentDate(text);
  const endMatch = text.match(/(?:至|到|截止至|截至|有效期至)\s*(20\d{2})[年\-/\.](\d{1,2})[月\-/\.](\d{1,2})日?/);
  const end = endMatch ? `${endMatch[1]}-${endMatch[2].padStart(2, '0')}-${endMatch[3].padStart(2, '0')}` : '';
  if (!docDate) return end ? `需人工确认至${end}` : '人工确认';
  const start = docDate;
  if (end && compareDate(start, end) > 0) return '';
  if (end) return `${start}至${end}`;
  if (['sale_date', 'depart_date', 'use_date', 'redeem_date'].includes(fieldKey)) return `${start}起`;
  return '';
}

function lastDayOfMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

function inferMonthEndDateRange(fields, parsed, fieldKey) {
  if (!['sale_date', 'depart_date', 'use_date', 'redeem_date'].includes(fieldKey)) return '';
  const current = getParsedValue(parsed, fieldKey);
  if (!/人工确认|需人工确认/.test(current)) return '';
  const text = getSourceTextForLearning(fields, parsed);
  const labelPattern = fieldKey === 'sale_date'
    ? '(?:销售|售卖|出票)(?:日期|时间)'
    : fieldKey === 'depart_date'
      ? '(?:航班|旅行|出行|乘机)(?:日期|时间)'
      : '(?:兑换|使用)(?:日期|时间)';
  const pattern = new RegExp(`${labelPattern}[^\\n]{0,20}?(20\\d{2})年\\s*(\\d{1,2})月\\s*(\\d{1,2})日?\\s*(?:至|到|-|—|~)\\s*(?:(20\\d{2})年)?\\s*(\\d{1,2})月(?!\\s*\\d{1,2}日)`);
  const match = text.match(pattern);
  if (!match) return '';
  const year = match[1];
  const startMonth = match[2].padStart(2, '0');
  const startDay = match[3].padStart(2, '0');
  const endYear = match[4] || year;
  const endMonth = match[5].padStart(2, '0');
  const endDay = String(lastDayOfMonth(endYear, endMonth)).padStart(2, '0');
  return `${year}-${startMonth}-${startDay}至${endYear}-${endMonth}-${endDay}`;
}

function inferSamePeriodDate(fields, parsed, fieldKey) {
  if (!['sale_date', 'depart_date', 'use_date', 'redeem_date'].includes(fieldKey)) return '';
  const candidates = fieldKey === 'sale_date'
    ? ['depart_date', 'travel_date', 'use_date', 'redeem_date']
    : ['sale_date', 'depart_date', 'use_date', 'redeem_date'];
  for (const key of candidates) {
    if (key === fieldKey) continue;
    const value = getParsedValue(parsed, key);
    if (value && !isBlankish(value)) return value;
  }
  return '';
}

function inferCorporateCode(fields, parsed) {
  const text = getPolicyText(fields, parsed);
  const patterns = [
    /大客户编码[:：\s]*([A-Z0-9_-]{2,})/i,
    /(?:PAT[:：]?A)?#C\s*([A-Z0-9_-]{2,})/i,
    /特殊指令[:：\s]*(?:PAT[:：]?A)?#?C?([A-Z0-9_-]{2,})/i,
    /TC项[:：\s]*([A-Z0-9_-]{2,})/i,
  ];
  for (const pattern of patterns) {
    const m = text.match(pattern);
    if (m && m[1] && !/PAT|GP|CGP/i.test(m[1])) return m[1];
  }
  return '';
}

function inferDiscountType(fields, parsed) {
  const text = getPolicyText(fields, parsed);
  if (/一口价/.test(text)) return '一口价';
  if (/指定票面价|票面价|指定价格|票价为|票面金额/.test(text)) return '指定票面价';
  if (/溢价产品|溢价/.test(text)) return '溢价产品';
  if (/上浮/.test(text)) return '上浮金额';
  if (/下浮.{0,12}(不固定|浮动|以.*为准)/.test(text)) return '下浮金额不固定';
  if (/直加|加价|加收|加享|升舱差价|额外支付/.test(text)) return '溢价产品';
  if (/\d+(?:\.\d+)?\s*%|折扣|直减比例|折扣促销/.test(text)) return /折扣促销/.test(text) ? '折扣促销' : '直减比例';
  if (/直减|立减|优惠金额|减免|减\d+元/.test(text)) return '直减金额';
  return '';
}

function inferChildApplicable(fields, parsed) {
  const text = getPolicyText(fields, parsed);
  if (/儿童.{0,12}(不适用|不得|不可|不能|不享受|不支持|不允许)|不适用.{0,12}儿童/.test(text)) return '否';
  if (/儿童.{0,12}(适用|可购买|可享受|允许)|适用.{0,12}儿童/.test(text)) return '是';
  return '';
}

function normalizeAgeRangeText(value, text = '') {
  const source = `${normalizeFeishuValue(value)}\n${normalizeFeishuValue(text)}`;
  if (!source) return '';
  const results = [];
  const add = (item) => {
    if (item && !results.includes(item)) results.push(item);
  };
  const hasAgeContext = (nearby) => /年龄|周岁|岁|青年|少年|学生|长者|银发|老人|老年|适老/.test(nearby);
  const looksLikePolicyCode = (nearby) => /号|编号|政策|通告|文件|DRGN|XLS|XS-CP|SC-CP/i.test(nearby);
  const rangeRe = /(\d{1,3})\s*(?:周岁|岁)?\s*(?:[-~至到]|—|－|--|—)\s*(\d{1,3})\s*(?:周岁|岁)?/g;
  for (const match of source.matchAll(rangeRe)) {
    const start = match.index || 0;
    const nearby = source.slice(Math.max(0, start - 18), start + match[0].length + 18);
    const after = source.slice(start + match[0].length, start + match[0].length + 4);
    if (hasAgeContext(nearby) && !looksLikePolicyCode(nearby) && !/人|名|位/.test(after)) {
      const end = /不含/.test(after) && /儿童|少儿|儿童票/.test(nearby)
        ? String(Math.max(Number(match[2]) - 1, Number(match[1])))
        : match[2];
      add(`${match[1]}-${end}`);
    }
  }
  const aboveRe = /(\d{1,3})\s*(?:周岁|岁)?\s*(?:以上|及以上|含以上|（含）以上|\(含\)以上)/g;
  for (const match of source.matchAll(aboveRe)) {
    const start = match.index || 0;
    const nearby = source.slice(Math.max(0, start - 18), start + match[0].length + 18);
    const after = source.slice(start + match[0].length, start + match[0].length + 4);
    if (hasAgeContext(nearby) && !looksLikePolicyCode(nearby) && !/人|名|位/.test(after)) {
      const from = Number(match[1]);
      const end = from >= 50 || /老年|长者|银发|老人|适老|青老年/.test(nearby) ? 110 : 200;
      add(`${from}-${end}`);
    }
  }
  const underRe = /(\d{1,3})\s*(?:周岁|岁)?\s*(?:以下|及以下|含以下|（含）以下|\(含\)以下)/g;
  for (const match of source.matchAll(underRe)) {
    const start = match.index || 0;
    const nearby = source.slice(Math.max(0, start - 18), start + match[0].length + 18);
    const after = source.slice(start + match[0].length, start + match[0].length + 4);
    if (hasAgeContext(nearby) && !looksLikePolicyCode(nearby) && !/人|名|位/.test(after)) add(`0-${match[1]}`);
  }
  if (results.length) {
    const normalized = results.filter(item => {
      const match = item.match(/^(\d{1,3})-200$/);
      return !match || !results.includes(`${match[1]}-110`);
    });
    return normalized.join('；');
  }
  if (/青年|少年|学生/.test(source)) {
    const young = source.match(/(\d{1,3})\s*(?:周岁|岁)?[^\n]{0,12}?(\d{1,3})\s*(?:周岁|岁)?/);
    if (young) return `${young[1]}-${young[2]}`;
  }
  return '';
}

function inferPassengerCountLimit(text) {
  const source = normalizeFeishuValue(text);
  const range = source.match(/(?:[（(]\s*)?(\d{1,2})\s*(?:[-~至到]|—|－|--)\s*(\d{1,2})\s*(?:[）)]\s*)?(?:人|名|位).{0,10}(?:同行|成团|同订|同时购买|一同出行|同一订单|购买|出行)/);
  if (range) return `${range[1]}-${range[2]}人`;
  const min = source.match(/(?:至少|不少于|不低于|≥|>=|满|购买人数|同行人数|出行人数|成团人数|同一订单.{0,8}?)(\d{1,2})\s*(?:人|名|位)/);
  if (min) return `${min[1]}人及以上`;
  const group = source.match(/(\d{1,2})\s*(?:人|名|位)(?:及以上|以上|起|同行|成团|同订|同时购买)/);
  if (group) return `${group[1]}人及以上`;
  if (/多人|拼团|同行|小团/.test(source)) return '2人及以上';
  return '';
}

function inferFlagshipPassengerType(fields, parsed) {
  const fileType = getPolicyFileType(fields, parsed);
  if (fileType !== '旗舰店code' && fileType !== '旗舰店券类') return '';
  const text = getSourceTextForLearning(fields, parsed) || getPolicyText(fields, parsed);
  const productType = normalizeFeishuValue(getParsedValue(parsed, 'product_type'));
  const productFamily = normalizeFeishuValue(getParsedValue(parsed, 'product_family'));
  const ageLimit = normalizeFeishuValue(getParsedValue(parsed, 'age_limit'));
  const current = normalizeFeishuValue(getParsedValue(parsed, 'passenger_type'));
  const source = `${text}\n${productType}\n${productFamily}\n${ageLimit}`;

  const parts = [];
  const ageRange = normalizeAgeRangeText(ageLimit, source);
  if (ageRange && !/^0-200$/.test(ageRange)) parts.push(ageRange);
  const countLimit = inferPassengerCountLimit(source);
  if (countLimit) parts.push(countLimit);
  if (parts.length) return [...new Set(parts)].join('；');

  if (/溢价产品|直加|加价|上浮|额外支付|付费.{0,8}(?:权益|行李|选座|升舱|积分|里程)|加享/.test(source)) {
    return '成人适用';
  }
  if (/(?:仅限|只限|限).{0,8}(?:成人|正常散客)|成人(?:适用|可购买|旅客)|正常散客\s*[（(]\s*不含儿童/.test(source)) {
    return '成人适用';
  }
  if (/儿童.{0,12}(不适用|不得|不可|不能|不享受|不支持|不允许)|不含儿童|婴儿.{0,12}(不适用|不得|不可|不能)|团队.{0,12}(不适用|不得|不可|不能)|特殊旅客.{0,12}(不适用|不得|不可|不能)/.test(source)) {
    return '成人适用';
  }
  if (/全人群|不限旅客|所有旅客|成人儿童婴儿均适用/.test(source)) return '全人群适用';
  if (
    !/(成人|儿童|婴儿|团队|散客|特殊旅客|年龄|周岁|岁|学生|青年|长者|银发|老人|多人|拼团|同行|家庭|会员|人数)/.test(source) &&
    (isBlankish(current) || /成人|人工确认|需人工确认/.test(current))
  ) {
    return '全人群适用';
  }
  return '';
}

function classifyCorrection(fieldKey, fieldLabel, reason, newValue) {
  const text = `${fieldKey} ${fieldLabel || ''} ${reason || ''} ${newValue || ''}`;
  if (['sale_date', 'depart_date'].includes(fieldKey) && /删除字段|不看此字段|不开此字段|配置不看|配置不开/.test(text)) {
    return {
      type: '场景字段不适用删除规则',
      rule: '当人工确认某文件类型/产品系列的字段不属于配置字段时，后续同场景同航司待审文件将该字段置空，不再以人工确认阻塞审核。',
    };
  }
  if (fieldKey === 'sale_date' && /没有销售时间|无销售时间|同乘机|同航班|同适用日期|适用日期|文件下发日期|下发日期就是售卖日期/.test(text)) {
    return {
      type: '销售日期同周期或发文日规则',
      rule: '销售日期缺失时，仅按当前文件自身证据处理：若说明与乘机/航班/适用日期同周期，则取该文件自己的旅行/适用日期；若说明下发日即售卖日期，则取该文件下发/发文日期。',
    };
  }
  if (fieldKey === 'corporate_code' && /大客户编码|特殊指令|#C|TC项/.test(text)) {
    return {
      type: '大客户编码特殊指令规则',
      rule: '大客户编码优先从大客户编码标签、#C 后缀、TC 项或特殊指令中提取，不作为优惠码、资源编号或渠道。',
    };
  }
  if (fieldKey === 'discount_type' && /指定票面价|票面价|一口价|直加|加价|直减|比例|优惠/.test(text)) {
    return {
      type: '优惠类型语义识别规则',
      rule: '优惠类型按原文语义识别：指定票价/票面价/一口价为指定票面价；直加/加价为直加金额；百分比为直减比例；固定减免为直减金额。',
    };
  }
  if (fieldKey === 'child_applicable' && /儿童|婴儿|特殊票|不适用|适用/.test(text)) {
    return {
      type: '儿童适用显式语义规则',
      rule: '儿童适用只按当前文件明确儿童适用/不适用判断；仅排除婴儿或特殊票时不得等同于儿童不适用。',
    };
  }
  if (fieldKey === 'passenger_type' && /旅客类型|适用旅客|成人|儿童|婴儿|团队|散客|年龄|人数|全人群|溢价/.test(text)) {
    return {
      type: '旗舰店旅客类型语义规则',
      rule: '旗舰店 passenger_type 只表达适用旅客范围：溢价产品输出成人适用；有年龄/人数限制时输出对应年龄段和人数限制；没有成人/儿童/婴儿/团队等限制时输出全人群适用；无法判断才人工确认。',
    };
  }
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

function parsedObjects(parsed) {
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed.filter(x => x && typeof x === 'object') : [parsed].filter(x => x && typeof x === 'object');
}

function getSourceTextForLearning(fields, parsed) {
  return [
    getFileName(fields, parsed),
    normalizeFeishuValue(fields && (fields['原始文本'] || fields['源文本'] || fields['文件内容'] || fields['解析文本'])),
    normalizeFeishuValue(getParsedValue(parsed, 'source_text')),
  ].filter(Boolean).join('\n');
}

function cleanGenericManualConfirm(value) {
  const text = cleanManualConfirmText(value);
  return /^(人工确认|需人工确认|待确认|未识别|无法确认|暂无|\(空\)|空)$/.test(text) ? '' : text;
}

function clearManualConfirmByConcreteValues(parsed) {
  let changed = false;
  parsedObjects(parsed).forEach(obj => {
    Object.entries(obj).forEach(([key, value]) => {
      if (key === 'manual_confirm_fields' || key === FIELD_DEFINITIONS_KEY || !hasConcreteFieldValue(value)) return;
      const next = stripManualConfirmForField(obj.manual_confirm_fields, key, KEY_LABELS[key] || key);
      if (normalizeFeishuValue(obj.manual_confirm_fields) !== next) {
        obj.manual_confirm_fields = next;
        changed = true;
      }
    });
    if (obj.data && typeof obj.data === 'object') {
      Object.entries(obj.data).forEach(([key, value]) => {
        if (key === 'manual_confirm_fields' || key === FIELD_DEFINITIONS_KEY || !hasConcreteFieldValue(value)) return;
        const next = stripManualConfirmForField(obj.data.manual_confirm_fields, key, KEY_LABELS[key] || key);
        if (normalizeFeishuValue(obj.data.manual_confirm_fields) !== next) {
          obj.data.manual_confirm_fields = next;
          changed = true;
        }
      });
    }
  });
  return changed;
}

function applyChangeHistoryToParsed(parsed, rawHistory) {
  if (!parsed) return [];
  const changes = [];
  parseChangeHistory(rawHistory)
    .map(normalizeHistoryEntry)
    .filter(Boolean)
    .forEach(entry => {
      const fieldKey = canonicalizeFieldName(entry.field || entry.fieldLabel || '');
      if (!fieldKey || fieldKey === 'manual_confirm_fields' || fieldKey === FIELD_DEFINITIONS_KEY) return;
      const fieldLabel = entry.fieldLabel || KEY_LABELS[fieldKey] || fieldKey;
      const before = getParsedValue(parsed, fieldKey);
      if (/^删除字段[:：]/.test(entry.reason || '')) {
        if (deleteParsedField(parsed, fieldKey)) {
          changes.push({
            key: fieldKey,
            label: fieldLabel,
            before,
            after: '',
            reason: '按人工删除记录回放到解析JSON',
          });
        }
        return;
      }
      if (!hasConcreteFieldValue(entry.newValue)) return;
      if (setParsedField(parsed, fieldKey, entry.newValue)) {
        changes.push({
          key: fieldKey,
          label: fieldLabel,
          before,
          after: entry.newValue,
          reason: '按人工修改历史回放到解析JSON',
        });
      }
      clearParsedManualConfirmForField(parsed, fieldKey, fieldLabel);
    });
  if (cleanParsedManualConfirm(parsed)) {
    changes.push({
      key: 'manual_confirm_fields',
      label: KEY_LABELS.manual_confirm_fields,
      before: '',
      after: getParsedValue(parsed, 'manual_confirm_fields'),
      reason: '清理人工确认项中的无效占位',
    });
  }
  return changes;
}

function repairConfirmedManualResidues(fields, parsed) {
  if (!parsed || normalizeFeishuValue(fields && fields['审核状态']) !== '已确认') return [];
  const changes = [];
  const text = getSourceTextForLearning(fields, parsed);
  const replaceManualValue = (key, after, reason) => {
    const before = getParsedValue(parsed, key);
    if (!isBlankish(before) && !/人工确认|需人工确认|未提取|未识别|无法确认/.test(before)) return;
    if (setParsedField(parsed, key, after)) {
      changes.push({ key, label: KEY_LABELS[key] || key, before, after, reason });
      clearParsedManualConfirmForField(parsed, key, KEY_LABELS[key] || key);
    }
  };

  const docRestriction = getParsedValue(parsed, 'document_restrictions');
  if (/证件类型需人工确认|需人工确认/.test(docRestriction) && /学生|青年|长者|银发|年龄|周岁/.test(text)) {
    const base = normalizeFeishuValue(docRestriction)
      .split(/[；;\n]+/)
      .map(x => x.trim())
      .filter(Boolean)
      .filter(x => !/证件类型需人工确认|需人工确认/.test(x));
    if (!base.some(x => /身份证|居民身份证/.test(x))) base.push('居民身份证');
    const after = base.join('；') || '居民身份证';
    const before = docRestriction;
    if (setParsedField(parsed, 'document_restrictions', after)) {
      changes.push({
        key: 'document_restrictions',
        label: KEY_LABELS.document_restrictions,
        before,
        after,
        reason: '已确认年龄/学生类产品按规则补齐证件限制为居民身份证',
      });
      clearParsedManualConfirmForField(parsed, 'document_restrictions', KEY_LABELS.document_restrictions);
    }
  }

  ['booking_cabin', 'od', 'discount_per'].forEach(key => {
    const before = getParsedValue(parsed, key);
    if (/需人工确认|人工确认/.test(before) && /详见附件|见附件|以附件为准/.test(before + '\n' + text)) {
      replaceManualValue(key, '详见附件', '已确认记录中该字段原文指向附件，归一为“详见附件”而非人工确认占位');
    }
  });

  return changes;
}

function repairDateRangeOrder(value) {
  const text = normalizeFeishuValue(value);
  const m = text.match(/^(20\d{2})-(\d{2})-(\d{2})至(20\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const start = `${m[1]}-${m[2]}-${m[3]}`;
  const end = `${m[4]}-${m[5]}-${m[6]}`;
  if (start <= end) return '';
  return `${end}至${start}`;
}

function repairInvalidDateFromTitle(fields, parsed, fieldKey) {
  const current = getParsedValue(parsed, fieldKey);
  if (!/20\d{2}-\d{2}-00/.test(current)) return '';
  const inferred = inferDateRangeFromTitle(getSourceTextForLearning(fields, parsed), fieldKey);
  return inferred || '';
}

function extractYearMonthDay(text, suffixPattern) {
  const m = text.match(suffixPattern);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

function inferMissingDateStart(fields, parsed, fieldKey) {
  const current = getParsedValue(parsed, fieldKey);
  const endMatch = normalizeFeishuValue(current).match(/^(?:需)?人工确认至(20\d{2}-\d{2}-\d{2})$/);
  if (!endMatch) return '';
  const text = getSourceTextForLearning(fields, parsed);
  let start = '';
  if (/文件下发之日起|政策下发之日起|自政策下发之日起|自下发之日起/.test(text)) {
    start = extractDocumentDate(text);
  }
  if (!start && /即日起|上线之日起|产品生效之日起|运价生效日起/.test(text)) {
    start = extractDocumentDate(text);
  }
  if (!start) {
    start = extractYearMonthDay(text, /(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  }
  if (!start || start > endMatch[1]) return '';
  return `${start}至${endMatch[1]}`;
}

function fieldHasPresentedPolicyPlaceholder(text, fieldKey) {
  const source = normalizeFeishuValue(text);
  if (!/呈报政策|政策呈报|以接口报出为准|销售后台|销售后台.*为准/.test(source)) return false;
  const fieldPatterns = {
    sale_date: /(?:适用)?(?:出票|销售)(?:日期|时间)[：:\s]*以具体呈报(?:的)?政策为准|(?:出票|销售)(?:日期|时间).{0,20}以(?:具体)?呈报(?:的)?政策为准/,
    depart_date: /(?:适用)?(?:航班|旅行|乘机)(?:日期|时间)[：:\s]*以具体呈报(?:的)?政策为准|(?:航班|旅行|乘机)(?:日期|时间).{0,20}以(?:具体)?呈报(?:的)?政策为准/,
    booking_cabin: /(?:适用)?(?:订座舱位|舱位)[：:\s]*以具体呈报(?:的)?政策为准|(?:订座舱位|舱位).{0,20}以(?:具体)?呈报(?:的)?政策为准/,
    discount_per: /(?:直加金额|加价金额|产品定价|产品价格|定价模式|X\s*具体金额).{0,30}以(?:具体)?(?:政策)?呈报(?:的)?政策?为准|(?:定价模式|产品定价)[：:\s]*以政策呈报为准/,
  };
  return !!(fieldPatterns[fieldKey] && fieldPatterns[fieldKey].test(source));
}

function repairOpenEndedManualDate(fields, parsed, fieldKey) {
  const current = getParsedValue(parsed, fieldKey);
  const match = normalizeFeishuValue(current).match(/^(20\d{2}-\d{2}-\d{2})起[，,、；;\s]*(?:结束日|截止日)?(?:需)?人工确认$/);
  if (!match) return '';
  const text = getSourceTextForLearning(fields, parsed);
  if (!/(起生效|自.{0,12}起|生效之日起|下发之日起|发布之日起)/.test(text)) return '';
  return `${match[1]}起`;
}

function repairPresentedPolicyPlaceholders(fields, parsed) {
  const text = getSourceTextForLearning(fields, parsed);
  const fileType = getPolicyFileType(fields, parsed);
  if (!/旗舰店/.test(fileType) && !/长龙|浙江长龙/.test(text)) return [];
  const changes = [];
  ['sale_date', 'depart_date', 'booking_cabin', 'discount_per'].forEach(key => {
    const before = getParsedValue(parsed, key);
    if (!isBlankish(before)) return;
    if (!fieldHasPresentedPolicyPlaceholder(text, key)) return;
    if (setParsedField(parsed, key, '以具体呈报政策为准')) {
      changes.push({
        key,
        label: KEY_LABELS[key] || key,
        before: normalizeFeishuValue(before),
        after: '以具体呈报政策为准',
        reason: '原文明确该字段以具体呈报政策为准，非当前通告可直接解析字段，去除人工确认占位',
      });
    }
  });
  return changes;
}

function repairDanglingManualValue(parsed) {
  const changes = [];
  parsedObjects(parsed).forEach(obj => {
    const target = obj.data && typeof obj.data === 'object' ? obj.data : obj;
    Object.entries(target).forEach(([key, value]) => {
      if (key === 'manual_confirm_fields' || key === FIELD_DEFINITIONS_KEY) return;
      if (!isBlankish(value)) return;
      const label = KEY_LABELS[key] || key;
      const note = `${label}需人工确认`;
      const before = normalizeFeishuValue(target.manual_confirm_fields || obj.manual_confirm_fields);
      appendManualNote(obj, note);
      const after = normalizeFeishuValue(target.manual_confirm_fields || obj.manual_confirm_fields);
      if (before !== after) {
        changes.push({
          key: 'manual_confirm_fields',
          label: KEY_LABELS.manual_confirm_fields,
          before,
          after,
          reason: `字段「${label}」仍为人工确认，占位值同步进入人工确认项，避免审核状态误判`,
        });
      }
    });
  });
  return changes;
}

function summarizeBenefitRules(text, names) {
  const lines = normalizeFeishuValue(text)
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean);
  const keys = ['领取', '兑换', '激活', '有效期', '使用', '核销', '适用', '不适用', '退款', '退票', '变更', '签转', '会员', '短信', '订单', '行李', '选座', '积分', '里程', '酒店', '礼包', '安检', '升舱'];
  const picked = [];
  lines.forEach(line => {
    if (picked.length >= 8) return;
    if (!keys.some(k => line.includes(k))) return;
    if (names && !names.some(name => line.includes(name.replace(/\d+\s*/g, '').slice(0, 2))) && !/(权益|礼包|酒店|行李|选座|积分|里程|安检|升舱)/.test(line)) return;
    const compact = line.length > 180 ? `${line.slice(0, 180)}...` : line;
    if (!picked.includes(compact)) picked.push(compact);
  });
  return picked.join('；');
}

function inferBenefitFields(fields, parsed) {
  const text = getSourceTextForLearning(fields, parsed);
  if (!/(酒店券|客房券|酒店房券|机\+酒店|云饮礼包|饮品礼包|行李加享|优享行李|乐享行李|机票\+行李|优先选座|优享选座|免费提前选座|快速安检|速选升舱|特惠超经舱|特惠公务舱|积分优享|机\+PLUS|PLUS\s*月卡|额外.{0,8}里程|赠送里程|休息室|餐食|接送机|兑换券|优享退票|退票权益|超值权益|权益包)/i.test(text)) return null;
  const names = [];
  const add = name => { if (name && !names.includes(name)) names.push(name); };
  if (/酒店券|客房券|酒店房券|机\+酒店/.test(text)) add('酒店券');
  const luggage = text.match(/(\d+\s*(?:KG|kg|公斤).{0,8}(?:托运行李额|行李额))/);
  if (/行李加享|优享行李|乐享行李|机票\+行李|产品权益.{0,30}行李额|享.{0,8}(?:托运行李额|行李额)/.test(text)) add(luggage ? luggage[1].replace(/\s+/g, '') : '行李权益');
  if (/优先选座|优享选座|免费提前选座/.test(text)) add(/优享选座|免费提前选座/.test(text) ? '优享选座权益' : '优先选座');
  if (/PLUS\s*月卡|Plus\s*月卡|plus\s*月卡|机\+PLUS/i.test(text)) add('PLUS月卡');
  if (/积分优享|消费积分|赠送积分/.test(text) && !/不累积任何.{0,6}积分/.test(text)) add(/优享积分/.test(text) ? '优享积分' : '会员消费积分');
  if (/额外.{0,8}里程|非定级里程|赠送里程/.test(text)) add('额外非定级里程');
  if (/云饮礼包|饮品礼包|饮品券|云饮/.test(text)) add('云饮礼包');
  if (/快速安检/.test(text)) add('快速安检服务');
  if (/速选升舱|特惠超经舱/.test(text)) add('升舱权益');
  if (/特惠公务舱/.test(text)) add('公务舱权益');
  if (/优享退票|退票权益/.test(text)) add('优享退票权益');
  if (/超值权益|权益包/.test(text)) add('超值权益包');
  if (/休息室/.test(text)) add('休息室权益');
  if (/餐食/.test(text)) add('餐食权益');
  if (/接送机/.test(text)) add('接送机权益');
  const rules = summarizeBenefitRules(text, names);
  if (!names.length) return null;
  if (!rules && names.length === 1 && names[0] === '接送机权益') return null;
  return {
    benefit_name: names.join('；'),
    benefit_usage_rules: rules,
  };
}

function shouldRemoveUnsupportedBenefit(currentValue, fields, parsed) {
  const text = getSourceTextForLearning(fields, parsed);
  const value = normalizeFeishuValue(currentValue);
  if (!value) return false;
  if (!inferBenefitFields(fields, parsed)) {
    return /公务舱权益|升舱权益|会员消费积分|接送机权益/.test(value);
  }
  if (/会员消费积分/.test(value) && /不累积任何.{0,6}积分/.test(text)) return true;
  if (/公务舱权益/.test(value) && !/特惠公务舱/.test(text)) return true;
  if (/升舱权益/.test(value) && !/速选升舱|特惠超经舱/.test(text)) return true;
  if (/接送机权益/.test(value) && !/接送机/.test(text)) return true;
  return false;
}

function normalizeDocumentLevelField(parsed, key) {
  if (!Array.isArray(parsed) || !DOCUMENT_LEVEL_KEYS.has(key)) return false;
  let changed = false;
  let firstValue = '';
  for (const obj of parsed) {
    const value = getParsedValue(obj, key);
    if (hasConcreteFieldValue(value)) {
      firstValue = value;
      break;
    }
  }
  parsed.forEach((obj, idx) => {
    if (!obj || typeof obj !== 'object') return;
    if (idx === 0 && firstValue && normalizeFeishuValue(getParsedValue(obj, key)) !== normalizeFeishuValue(firstValue)) {
      obj[key] = firstValue;
      if (obj.data && typeof obj.data === 'object') obj.data[key] = firstValue;
      changed = true;
    }
    if (idx > 0) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        delete obj[key];
        changed = true;
      }
      if (obj.data && typeof obj.data === 'object' && Object.prototype.hasOwnProperty.call(obj.data, key)) {
        delete obj.data[key];
        changed = true;
      }
    }
  });
  return changed;
}

function applyCurrentLearningToParsed(fields, parsed) {
  if (!parsed) return { changed: false, changes: [] };
  const changes = [];
  const recordChange = (key, before, after, reason) => {
    if (normalizeFeishuValue(before) === normalizeFeishuValue(after)) return;
    changes.push({ key, label: KEY_LABELS[key] || key, before: normalizeFeishuValue(before), after: normalizeFeishuValue(after), reason });
  };

  applyChangeHistoryToParsed(parsed, fields && fields['修改历史']).forEach(change => recordChange(change.key, change.before, change.after, change.reason));
  repairScenarioFromBusinessLine(fields, parsed).forEach(change => recordChange(change.key, change.before, change.after, change.reason));
  removeUnsupportedScenarioFields(fields, parsed).forEach(change => recordChange(change.key, change.before, change.after, change.reason));
  repairConfirmedManualResidues(fields, parsed).forEach(change => recordChange(change.key, change.before, change.after, change.reason));

  parsedObjects(parsed).forEach(obj => {
    const rawManual = obj.manual_confirm_fields;
    const cleanManual = cleanGenericManualConfirm(rawManual);
    if (normalizeFeishuValue(rawManual) !== cleanManual) {
      obj.manual_confirm_fields = cleanManual;
      recordChange('manual_confirm_fields', rawManual, cleanManual, '清理无具体字段的人工确认占位');
    }
    if (obj.data && typeof obj.data === 'object') {
      const dataManual = obj.data.manual_confirm_fields;
      const cleanDataManual = cleanGenericManualConfirm(dataManual);
      if (normalizeFeishuValue(dataManual) !== cleanDataManual) {
        obj.data.manual_confirm_fields = cleanDataManual;
        recordChange('manual_confirm_fields', dataManual, cleanDataManual, '清理无具体字段的人工确认占位');
      }
    }
  });

  const fileType = getPolicyFileType(fields, parsed);
  const allowedFields = SERVER_PROMPT_FIELDS[fileType] || new Set();
  ['sale_date', 'depart_date', 'use_date', 'redeem_date'].forEach(key => {
    if (!allowedFields.has(key) && !getParsedValue(parsed, key)) return;
    const before = getParsedValue(parsed, key);
    const swapped = repairDateRangeOrder(before);
    const invalidFixed = repairInvalidDateFromTitle(fields, parsed, key);
    const missingStartFixed = inferMissingDateStart(fields, parsed, key);
    const relativeStartFixed = isBlankish(before) ? inferRelativeStartDateRange(fields, parsed, key) : '';
    const monthEndFixed = inferMonthEndDateRange(fields, parsed, key);
    const openEndedFixed = repairOpenEndedManualDate(fields, parsed, key);
    const after = swapped || invalidFixed || missingStartFixed || monthEndFixed || openEndedFixed || relativeStartFixed;
    if (after && setParsedField(parsed, key, after)) {
      recordChange(key, before, after, '按当前文件日期证据修复日期范围');
    }
  });

  repairPresentedPolicyPlaceholders(fields, parsed).forEach(change => recordChange(change.key, change.before, change.after, change.reason));

  if (allowedFields.has('passenger_type')) {
    const before = getParsedValue(parsed, 'passenger_type');
    const inferredPassengerType = inferFlagshipPassengerType(fields, parsed);
    if (inferredPassengerType && normalizeFeishuValue(before) !== inferredPassengerType && setParsedField(parsed, 'passenger_type', inferredPassengerType)) {
      recordChange('passenger_type', before, inferredPassengerType, '按旗舰店知识库旅客类型规则修正：溢价=成人适用，年龄/人数限制输出限制，无限制输出全人群适用');
    }
  }

  clearManualConfirmByConcreteValues(parsed);
  cleanParsedManualConfirm(parsed);

  const benefits = inferBenefitFields(fields, parsed);
  const benefitDefinitions = {
    benefit_name: {
      label: '权益名称',
      json_key: 'benefit_name',
      value_type: 'string',
      file_type: fileType,
      description: '当前政策文件明确售卖或赠送的附加权益名称',
      logic: '只提取当前文件原文出现的具体权益本体，如酒店券、行李额、优先选座、月卡、积分、里程、快速安检、升舱等；不是产品名或活动名。',
    },
    benefit_usage_rules: {
      label: '权益使用规则',
      json_key: 'benefit_usage_rules',
      value_type: 'string',
      file_type: fileType,
      description: '当前政策文件中该附加权益的领取、激活、兑换、有效期、适用限制和退改影响',
      logic: '仅概括当前文件中与权益使用直接相关的规则，不写整篇产品介绍、票价规则、航线规则或退改签章节。',
    },
  };
  ['benefit_name', 'benefit_usage_rules'].forEach(key => {
    const before = getParsedValue(parsed, key);
    if (benefits && hasConcreteFieldValue(benefits[key])) {
      if (setParsedField(parsed, key, benefits[key], benefitDefinitions[key])) {
        recordChange(key, before, benefits[key], '按当前文件权益证据补齐文档级权益字段');
      }
    } else if (
      before &&
      (!hasConcreteFieldValue(before) ||
        shouldRemoveUnsupportedBenefit(before, fields, parsed) ||
        (key === 'benefit_usage_rules' && !benefits))
    ) {
      if (deleteParsedField(parsed, key)) {
        recordChange(key, before, '', '权益字段无当前文件强证据或属于旧规则误补，移除');
      }
    }
    normalizeDocumentLevelField(parsed, key);
  });

  return { changed: changes.length > 0, changes };
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

function buildRuleChangeSuggestion({ fieldKey, fieldLabel, oldValue, newValue, reason, isFieldAddition, isFieldDeletion, fileName }) {
  if (normalizeFeishuValue(oldValue) === normalizeFeishuValue(newValue)) return null;
  const baseType = isFieldAddition
    ? '新增逻辑待确认'
    : (isFieldDeletion ? '字段适用性待确认' : '原逻辑优化待确认');
  const rule = classifyCorrection(fieldKey, fieldLabel, reason, newValue);
  const seed = [
    fieldKey,
    fieldLabel,
    oldValue,
    newValue,
    reason,
    fileName,
    Date.now(),
    crypto.randomBytes(4).toString('hex'),
  ].join('|');
  return {
    id: `rule_${crypto.createHash('sha1').update(seed).digest('hex').slice(0, 16)}`,
    status: 'pending_confirmation',
    type: baseType,
    fieldKey,
    fieldLabel: fieldLabel || fieldKey || '',
    fileName: fileName || '',
    oldValue: normalizeFeishuValue(oldValue) || '(空)',
    newValue: normalizeFeishuValue(newValue) || '(空)',
    reason: normalizeFeishuValue(reason),
    ruleType: rule.type,
    proposedRule: rule.rule,
    message: '字段值已保存。解析规则不会自动扩散；需要先确认这是在原有 prompt 逻辑上新增逻辑，还是优化原逻辑，再固化到解析能力。',
  };
}

function normalizeRuleSuggestion(item, fallback = {}) {
  if (!item || typeof item !== 'object') return null;
  const status = normalizeFeishuValue(item.status || fallback.status || 'pending_confirmation') || 'pending_confirmation';
  const id = normalizeFeishuValue(item.id) ||
    `rule_${crypto.createHash('sha1').update(JSON.stringify({ ...item, fallback })).digest('hex').slice(0, 16)}`;
  return {
    id,
    status,
    type: normalizeFeishuValue(item.type || fallback.type || '原逻辑优化待确认'),
    recordId: normalizeFeishuValue(item.recordId || fallback.recordId),
    fileName: normalizeFeishuValue(item.fileName || fallback.fileName),
    fieldKey: normalizeFeishuValue(item.fieldKey || fallback.fieldKey),
    fieldLabel: normalizeFeishuValue(item.fieldLabel || fallback.fieldLabel),
    oldValue: normalizeFeishuValue(item.oldValue),
    newValue: normalizeFeishuValue(item.newValue),
    reason: normalizeFeishuValue(item.reason),
    ruleType: normalizeFeishuValue(item.ruleType),
    proposedRule: normalizeFeishuValue(item.proposedRule),
    message: normalizeFeishuValue(item.message),
    createdAt: normalizeFeishuValue(item.createdAt || fallback.createdAt),
    createdBy: item.createdBy || fallback.createdBy || null,
    decision: normalizeFeishuValue(item.decision),
    decisionNote: normalizeFeishuValue(item.decisionNote),
    confirmedAt: normalizeFeishuValue(item.confirmedAt),
    confirmedBy: item.confirmedBy || null,
    lastRegression: item.lastRegression || item.regression || null,
  };
}

function parseRuleSuggestions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(item => normalizeRuleSuggestion(item)).filter(Boolean);
  if (typeof raw === 'object') {
    const one = normalizeRuleSuggestion(raw);
    return one ? [one] : [];
  }
  const text = String(raw || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return parseRuleSuggestions(parsed);
  } catch (e) {
    return text
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => normalizeRuleSuggestion({
        status: 'pending_confirmation',
        type: '原逻辑优化待确认',
        message: line,
        proposedRule: line,
      }))
      .filter(Boolean);
  }
}

function formatRuleSuggestions(suggestions) {
  const normalized = (suggestions || []).map(item => normalizeRuleSuggestion(item)).filter(Boolean);
  return normalized.length ? JSON.stringify(normalized, null, 2) : '';
}

function enrichRuleSuggestion(suggestion, { recordId, sourceFields, sourceParsed, user }) {
  const enriched = normalizeRuleSuggestion({
    ...suggestion,
    recordId,
    fileName: suggestion.fileName || getFileName(sourceFields, sourceParsed),
    createdAt: suggestion.createdAt || new Date().toLocaleString('zh-CN', { hour12: false }),
    createdBy: suggestion.createdBy || (user ? { name: user.name || '', openId: user.openId || '' } : null),
  });
  return enriched;
}

function appendRuleSuggestion(existingRaw, suggestion) {
  const existing = parseRuleSuggestions(existingRaw);
  const next = normalizeRuleSuggestion(suggestion);
  if (!next) return { suggestions: existing, changed: false, suggestion: null };
  const samePending = existing.find(item =>
    item.status === 'pending_confirmation' &&
    item.fieldKey === next.fieldKey &&
    normalizeFeishuValue(item.oldValue) === normalizeFeishuValue(next.oldValue) &&
    normalizeFeishuValue(item.newValue) === normalizeFeishuValue(next.newValue) &&
    normalizeFeishuValue(item.reason) === normalizeFeishuValue(next.reason));
  if (samePending) return { suggestions: existing, changed: false, suggestion: samePending };
  return { suggestions: [...existing, next], changed: true, suggestion: next };
}

function decisionLabel(decision) {
  if (decision === 'add_logic') return '新增逻辑';
  if (decision === 'optimize_logic') return '优化原逻辑';
  if (decision === 'skip') return '暂不处理';
  return normalizeFeishuValue(decision) || '已处理';
}

function resolveRuleSuggestions(raw, suggestionId, decision, note, user) {
  const suggestions = parseRuleSuggestions(raw);
  let found = null;
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const next = suggestions.map(item => {
    if (item.id !== suggestionId) return item;
    found = {
      ...item,
      status: decision === 'skip' ? 'skipped' : 'confirmed',
      decision: decisionLabel(decision),
      decisionNote: normalizeFeishuValue(note),
      confirmedAt: now,
      confirmedBy: user ? { name: user.name || '', openId: user.openId || '' } : null,
    };
    return found;
  });
  return { suggestions: next, found };
}

function findRuleSuggestion(raw, suggestionId) {
  return parseRuleSuggestions(raw).find(item => item.id === suggestionId) || null;
}

function attachRuleRegression(raw, suggestionId, regression) {
  let found = null;
  const suggestions = parseRuleSuggestions(raw).map(item => {
    if (item.id !== suggestionId) return item;
    found = {
      ...item,
      lastRegression: regression,
    };
    return found;
  });
  return { suggestions, found };
}

async function notifyRuleSuggestion(suggestion, user) {
  const recipients = [...RULE_CONFIRM_NOTIFY_OPEN_IDS];
  if (!recipients.length && RULE_CONFIRM_NOTIFY_CURRENT_USER && user && user.openId) {
    recipients.push(user.openId);
  }
  const uniqueRecipients = [...new Set(recipients.filter(Boolean))];
  if (!uniqueRecipients.length) {
    return { sent: 0, skipped: true, reason: '未配置 RULE_CONFIRM_NOTIFY_OPEN_IDS，且当前用户 open_id 不可用' };
  }

  const token = await getTenantAccessToken();
  const text = [
    '【政策解析规则待确认】',
    `文件：${suggestion.fileName || ''}`,
    `字段：${suggestion.fieldLabel || suggestion.fieldKey || ''}`,
    `变化：${suggestion.oldValue || '(空)'} -> ${suggestion.newValue || '(空)'}`,
    `原因：${suggestion.reason || '未填写'}`,
    `建议：${suggestion.type || ''} / ${suggestion.ruleType || ''}`,
    '请到政策审核工作台「规则待确认」页面确认是新增逻辑、优化原逻辑，还是暂不处理。',
  ].join('\n');

  const results = [];
  for (const openId of uniqueRecipients) {
    try {
      const resp = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      });
      const data = await resp.json();
      if (data.code !== 0) throw new Error(`${data.msg || 'unknown'} (code=${data.code})`);
      results.push({ openId, ok: true });
    } catch (e) {
      results.push({ openId, ok: false, error: e.message });
      console.warn('[规则待确认通知] 发送失败:', openId, e.message);
    }
  }
  return {
    sent: results.filter(x => x.ok).length,
    failed: results.filter(x => !x.ok).length,
    results,
  };
}

function deriveAutoValue({ ruleType, fieldKey, newValue, targetFields, targetParsed }) {
  const targetText = getPolicyText(targetFields, targetParsed);
  if (ruleType === '场景字段不适用删除规则') {
    const type = getPolicyFileType(targetFields, targetParsed);
    if (type !== '旗舰店code') return null;
    if (!/长龙|浙江长龙|GJ|升舱|超值权益|特惠|快速安检|行李加享|积分优享|授权销售渠道|TC项|产品代码/.test(targetText)) return null;
    return '';
  }
  if (ruleType === '销售日期同周期或发文日规则') {
    if (/按呈报政策|以接口报出为准|详见附件|见附件/.test(targetText)) return null;
    if (/下发日期就是售卖日期|文件下发日期/.test(`${newValue || ''} ${targetText}`)) {
      const docDate = extractDocumentDate(targetText);
      if (docDate) return docDate;
    }
    const samePeriod = inferSamePeriodDate(targetFields, targetParsed, fieldKey);
    if (samePeriod && !isBlankish(samePeriod)) return samePeriod;
    return inferRelativeStartDateRange(targetFields, targetParsed, fieldKey) || null;
  }
  if (ruleType === '大客户编码特殊指令规则') {
    return inferCorporateCode(targetFields, targetParsed) || null;
  }
  if (ruleType === '优惠类型语义识别规则') {
    return inferDiscountType(targetFields, targetParsed) || null;
  }
  if (ruleType === '儿童适用显式语义规则') {
    return inferChildApplicable(targetFields, targetParsed) || null;
  }
  if (ruleType === '旗舰店旅客类型语义规则') {
    return inferFlagshipPassengerType(targetFields, targetParsed) || null;
  }
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
  const sourceTextBoundFields = new Set([
    'sign_and_transfer_rules',
    'refund_rules',
    'change_rules',
    'benefit_name',
    'benefit_usage_rules',
    'not_applicable_flight_routes',
    'not_applicable_od',
  ]);
  if (sourceTextBoundFields.has(fieldKey)) {
    return {
      applied: 0,
      files: [],
      skipped: true,
      reason: '源文绑定字段必须按当前原文逐条提取，不做跨文件自动矫正或复制',
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
      source: 'auto',
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
app.use(express.json({ limit: process.env.JSON_BODY_LIMIT || '80mb' }));

// CORS: GitHub Pages 前端会跨域调用 Render API，需要允许凭证请求。
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (isAllowedWorkbenchOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Vary', 'Origin');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- 静态文件 ----
app.use(express.static(__dirname, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, max-age=0');
    }
  },
}));

// 首页
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.sendFile(path.join(__dirname, 'policy-review-workbench.html'));
});

app.get('/api/login-status', (req, res) => {
  const session = readWorkbenchSession(req);
  res.json({
    success: true,
    authEnabled: WORKBENCH_AUTH_ENABLED,
    authenticated: !!(session && session.authenticated),
    user: session && session.user ? session.user : null,
    usingDefaultCredential: WORKBENCH_DEFAULT_USER === 'admin' && WORKBENCH_DEFAULT_PASSWORD === 'policy2026' && !process.env.WORKBENCH_USERS && !process.env.WORKBENCH_PASSWORD,
  });
});

app.post('/api/login', (req, res) => {
  if (!WORKBENCH_AUTH_ENABLED) {
    return res.json({ success: true, authenticated: true, user: { username: 'auth-disabled', name: '免登录模式' } });
  }
  const { username, password } = req.body || {};
  const user = getWorkbenchUsers().find(item => item.username === String(username || '').trim());
  if (!verifyWorkbenchPassword(user, password)) {
    return res.status(401).json({ success: false, error: '账号或密码错误' });
  }
  const safeUser = { username: user.username, name: user.name || user.username };
  const token = createWorkbenchSession(safeUser);
  res.setHeader('Set-Cookie', getWorkbenchSessionCookie(req, token, Math.floor(WORKBENCH_SESSION_TTL_MS / 1000)));
  res.json({ success: true, authenticated: true, user: safeUser, sessionToken: token });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', getWorkbenchSessionCookie(req, '', 0));
  res.json({ success: true });
});

// ---- OAuth2 回调 ----
app.get('/api/oauth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.status(400).send('缺少 code 参数');
  }

  console.log('[OAuth] 收到授权回调，正在换取 token...');

  try {
    const redirectUri = `https://${req.get('host')}/api/oauth/callback`;

    const resp = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: APP_ID,
        client_secret: APP_SECRET,
        code,
        redirect_uri: redirectUri,
      }),
    });

    const data = await resp.json();
    const tokenData = normalizeOAuthTokenResponse(data);

    if (isFeishuErrorResponse(data) || !tokenData || !tokenData.accessToken) {
      const message = getFeishuErrorMessage(data, '换取 token 失败');
      console.error('[OAuth] 换取token失败:', message);
      return res.send(`<script>alert('授权失败: ${message}');window.close();</script>`);
    }

    state.userAccessToken = tokenData.accessToken;
    state.userRefreshToken = tokenData.refreshToken || state.userRefreshToken;
    state.tokenExpiresAt = Date.now() + (tokenData.expiresIn || 7200) * 1000;
    saveTokens();
    // 授权成功后打印 refresh_token，供配置 FEISHU_REFRESH_TOKEN 环境变量使用（Render 日志可见，私密勿外泄）
    console.log('[OAuth] refresh_token:', tokenData.refreshToken || '(未返回新的 refresh_token)');

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

app.use('/api', requireWorkbenchAuthForApi);

// ---- 授权状态 ----
app.get('/api/auth-status', (req, res) => {
  if (!useFeishuStorage()) {
    return res.json({
      authorized: true,
      tokenValid: true,
      mode: 'review-store',
      storage: activeReviewStorageName(),
      feishuAuthorized: false,
      user: fallbackUser(),
    });
  }
  res.json({
    authorized: hasFeishuUserAuth(),
    tokenValid: hasValidUserAccessToken(),
    hasRefreshToken: !!state.userRefreshToken,
    mode: 'render',
    user: state.currentUser || null,
  });
});

// ---- 当前用户信息 ----
app.get('/api/me', async (req, res) => {
  try {
    if (!useFeishuStorage()) {
      return res.json({ authorized: true, storage: activeReviewStorageName(), feishuAuthorized: false, user: fallbackUser() });
    }
    if (!state.userRefreshToken) {
      if (allowFeishuLocalFallback()) {
        return res.json({ authorized: true, storage: activeReviewStorageName(), feishuAuthorized: false, user: fallbackUser() });
      }
      return res.json({ authorized: false, user: null });
    }
    const user = await getCurrentUser();
    res.json({ authorized: true, user });
  } catch (err) {
    if (err.message === 'NOT_AUTHORIZED' || err.message === 'REFRESH_TOKEN_EXPIRED') {
      if (allowFeishuLocalFallback()) {
        return res.json({ authorized: true, storage: activeReviewStorageName(), feishuAuthorized: false, user: fallbackUser() });
      }
      res.json({ authorized: false, user: null });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ---- 获取授权 URL ----
app.get('/api/auth-url', (req, res) => {
  const redirectUri = `https://${req.get('host')}/api/oauth/callback`;
  const authUrl = `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${APP_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(FEISHU_OAUTH_SCOPES)}&state=policy_review`;
  res.json({ authUrl, redirectUri });
});

// ---- 确认文件 ----
app.post('/api/confirm', async (req, res) => {
  const { recordId, fileName } = req.body;

  if (!recordId) {
    return res.status(400).json({ success: false, error: '缺少 recordId' });
  }

  console.log(`[确认] ${fileName || recordId}`);

  if (!useFeishuStorage()) {
    const saved = await saveLocalConfirm(recordId, fileName, fallbackUser());
    console.log(`[确认] ✓ 已写入${activeReviewStorageName()}审核记录 ${fileName || recordId}`);
    return res.json({
      success: true,
      confirmedAt: saved.confirmedAt,
      confirmedBy: saved.confirmedBy,
      savedToFeishu: false,
      storage: activeReviewStorageName(),
    });
  }

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
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      const saved = await saveLocalConfirm(recordId, fileName, fallbackUser());
      console.log(`[确认] ✓ 已写入本地审核记录 ${fileName || recordId}`);
      res.json({
        success: true,
        confirmedAt: saved.confirmedAt,
        confirmedBy: saved.confirmedBy,
        savedToFeishu: false,
        storage: activeReviewStorageName(),
      });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
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

  if (!useFeishuStorage()) {
    await saveLocalReopen(recordId, fileName);
    console.log(`[恢复待确认] ✓ 已写入${activeReviewStorageName()}审核记录 ${fileName || recordId}`);
    return res.json({ success: true, savedToFeishu: false, storage: activeReviewStorageName() });
  }

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
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      await saveLocalReopen(recordId, fileName);
      console.log(`[恢复待确认] ✓ 已写入本地审核记录 ${fileName || recordId}`);
      res.json({ success: true, savedToFeishu: false, storage: activeReviewStorageName() });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
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

  if (!useFeishuStorage()) {
    const fieldKey = requestedFieldKey || FIELD_LABEL_TO_KEY[fieldLabel] || fieldLabel;
    const saved = await saveLocalFieldChange({
      recordId,
      fieldLabel,
      fieldKey,
      newValue,
      reason,
      changeEntry,
      deleteField,
      fieldDefinition,
    });
    const localEntry = normalizeChangeEntry(changeEntry, {
      oldValue: '',
      newValue: newValue !== undefined ? String(newValue) : '',
      reason: reason || '',
      fieldLabel: fieldLabel || fieldKey || '',
    });
    const localRuleSuggestion = !systemGenerated
      ? buildRuleChangeSuggestion({
          fieldKey,
          fieldLabel: fieldLabel || fieldKey || '',
          oldValue: localEntry.oldValue || '',
          newValue: deleteField ? '' : (newValue !== undefined ? String(newValue) : ''),
          reason: reason || '',
          isFieldAddition: /^新增字段[:：]/.test(reason || '') || isBlankish(localEntry.oldValue),
          isFieldDeletion: !!deleteField || /^删除字段[:：]/.test(reason || ''),
          fileName: '',
        })
      : null;
    let savedLocalRuleSuggestion = null;
    if (localRuleSuggestion) {
      const enriched = enrichRuleSuggestion(localRuleSuggestion, {
        recordId,
        sourceFields: {},
        sourceParsed: null,
        user: fallbackUser(),
      });
      const ruleSaved = await saveLocalRuleSuggestion(recordId, enriched);
      savedLocalRuleSuggestion = ruleSaved.suggestion || enriched;
    }
    console.log(`[保存字段] ✓ 已写入${activeReviewStorageName()}审核记录 ${fieldLabel || fieldKey || ''}`);
    return res.json({
      success: true,
      historyCount: saved.historyCount,
      savedToFeishu: false,
      storage: activeReviewStorageName(),
      background: { autoCorrection: false, knowledge: false, ruleConfirmationRequired: !!savedLocalRuleSuggestion },
      ruleSuggestion: savedLocalRuleSuggestion,
    });
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
      source: systemGenerated ? 'auto' : 'human',
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
    const ruleSuggestion = (!systemGenerated && isEffectiveChange)
      ? buildRuleChangeSuggestion({
          fieldKey,
          fieldLabel: entry.fieldLabel || fieldLabel || fieldKey,
          oldValue: entry.oldValue || '',
          newValue: newValue !== undefined ? String(newValue) : '',
          reason: reason || '',
          isFieldAddition,
          isFieldDeletion,
          fileName: getFileName(sourceFields, sourceParsed),
        })
      : null;

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
    let savedRuleSuggestion = null;
    let notification = null;
    if (ruleSuggestion && state.tableFields && state.tableFields.includes('规则待确认')) {
      const enriched = enrichRuleSuggestion(ruleSuggestion, {
        recordId,
        sourceFields,
        sourceParsed,
        user,
      });
      const appended = appendRuleSuggestion(sourceFields['规则待确认'], enriched);
      savedRuleSuggestion = appended.suggestion || enriched;
      if (appended.changed) {
        fields['规则待确认'] = formatRuleSuggestions(appended.suggestions);
      }
    }

    await updateFeishuRecord(recordId, fields);
    if (savedRuleSuggestion && fields['规则待确认']) {
      try {
        notification = await notifyRuleSuggestion(savedRuleSuggestion, user);
      } catch (e) {
        notification = { sent: 0, failed: 1, error: e.message };
        console.warn('[规则待确认通知] 异常:', e.message);
      }
    }

    console.log(`[保存字段] ✓ 主记录已保存 ${fieldLabel || ''} 原因: ${reason || '(无)'} 历史${existingHistory.length}条，规则变更待确认=${savedRuleSuggestion ? '是' : '否'}`);
    res.json({
      success: true,
      historyCount: existingHistory.length,
      savedToFeishu: true,
      background: {
        autoCorrection: false,
        knowledge: false,
        ruleConfirmationRequired: !!savedRuleSuggestion,
      },
      ruleSuggestion: savedRuleSuggestion,
      notification,
    });
  } catch (err) {
    console.error(`[保存字段] ✗ ${err.message}`);
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      const fieldKey = requestedFieldKey || FIELD_LABEL_TO_KEY[fieldLabel] || fieldLabel;
      const saved = await saveLocalFieldChange({
        recordId,
        fieldLabel,
        fieldKey,
        newValue,
        reason,
        changeEntry,
        deleteField,
        fieldDefinition,
      });
      const fallbackEntry = normalizeChangeEntry(changeEntry, {
        oldValue: '',
        newValue: newValue !== undefined ? String(newValue) : '',
        reason: reason || '',
        fieldLabel: fieldLabel || fieldKey || '',
      });
      const fallbackRuleSuggestion = !systemGenerated
        ? buildRuleChangeSuggestion({
            fieldKey,
            fieldLabel: fieldLabel || fieldKey || '',
            oldValue: fallbackEntry.oldValue || '',
            newValue: deleteField ? '' : (newValue !== undefined ? String(newValue) : ''),
            reason: reason || '',
            isFieldAddition: /^新增字段[:：]/.test(reason || '') || isBlankish(fallbackEntry.oldValue),
            isFieldDeletion: !!deleteField || /^删除字段[:：]/.test(reason || ''),
            fileName: '',
          })
        : null;
      let savedFallbackRuleSuggestion = null;
      if (fallbackRuleSuggestion) {
        const enriched = enrichRuleSuggestion(fallbackRuleSuggestion, {
          recordId,
          sourceFields: {},
          sourceParsed: null,
          user: fallbackUser(),
        });
        const ruleSaved = await saveLocalRuleSuggestion(recordId, enriched);
        savedFallbackRuleSuggestion = ruleSaved.suggestion || enriched;
      }
      console.log(`[保存字段] ✓ 已写入本地审核记录 ${fieldLabel || fieldKey || ''}`);
      return res.json({
        success: true,
        historyCount: saved.historyCount,
        savedToFeishu: false,
        storage: activeReviewStorageName(),
        background: { autoCorrection: false, knowledge: false, ruleConfirmationRequired: !!savedFallbackRuleSuggestion },
        ruleSuggestion: savedFallbackRuleSuggestion,
      });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 处理规则待确认建议 ----
app.post('/api/rule-suggestions/resolve', async (req, res) => {
  const { recordId, suggestionId, decision, note } = req.body || {};
  if (!recordId || !suggestionId) {
    return res.status(400).json({ success: false, error: '缺少 recordId 或 suggestionId' });
  }
  if (!['add_logic', 'optimize_logic', 'skip'].includes(decision)) {
    return res.status(400).json({ success: false, error: 'decision 必须是 add_logic / optimize_logic / skip' });
  }

  if (!useFeishuStorage()) {
    try {
      const resolved = await resolveLocalRuleSuggestion(recordId, suggestionId, decision, note, fallbackUser());
      console.log(`[规则待确认] ✓ 已处理 ${suggestionId} ${resolved.decision}`);
      return res.json({
        success: true,
        savedToFeishu: false,
        storage: activeReviewStorageName(),
        suggestion: resolved,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  try {
    try { await ensureTableFields(); } catch (e) { console.warn('[规则待确认] 检查字段失败:', e.message); }
    let user = null;
    try { user = await getCurrentUser(); } catch (e) { /* 忽略 */ }
    const record = await getFeishuRecord(recordId);
    const fields = record.fields || {};
    const jsonFieldName = getJsonFieldName(fields);
    const sourceParsed = parseJsonField(jsonFieldName ? fields[jsonFieldName] : null);
    const pendingSuggestion = findRuleSuggestion(fields['规则待确认'], suggestionId);
    if (!pendingSuggestion) {
      return res.status(404).json({ success: false, error: '未找到规则建议' });
    }
    let regression = null;
    if (decision !== 'skip') {
      regression = await runRuleFieldRegression({
        suggestion: pendingSuggestion,
        sourceRecordId: recordId,
        sourceFields: fields,
        sourceParsed,
      });
      if (regression.status === 'failed') {
        const attached = attachRuleRegression(fields['规则待确认'], suggestionId, regression);
        await updateFeishuRecord(recordId, {
          '规则待确认': formatRuleSuggestions(attached.suggestions),
        });
        console.warn(`[规则待确认] 回归失败，已阻止规则确认 ${suggestionId}`);
        return res.status(409).json({
          success: false,
          regressionFailed: true,
          error: `字段回归失败：${regression.regressions} 个黄金样本出现回退，规则未确认。`,
          regression,
          suggestion: attached.found || pendingSuggestion,
        });
      }
    }
    const result = resolveRuleSuggestions(fields['规则待确认'], suggestionId, decision, note, user || fallbackUser());
    if (!result.found) {
      return res.status(404).json({ success: false, error: '未找到规则建议' });
    }
    let suggestionsToSave = result.suggestions;
    let resolvedSuggestion = result.found;
    if (regression) {
      const attached = attachRuleRegression(suggestionsToSave, suggestionId, regression);
      suggestionsToSave = attached.suggestions;
      resolvedSuggestion = attached.found || resolvedSuggestion;
    }
    await updateFeishuRecord(recordId, {
      '规则待确认': formatRuleSuggestions(suggestionsToSave),
    });
    console.log(`[规则待确认] ✓ 已处理 ${suggestionId} ${resolvedSuggestion.decision}，回归=${regression ? regression.status : 'skip'}`);
    res.json({
      success: true,
      savedToFeishu: true,
      suggestion: resolvedSuggestion,
      regression,
    });
  } catch (err) {
    console.error(`[规则待确认] ✗ ${err.message}`);
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      try {
        const resolved = await resolveLocalRuleSuggestion(recordId, suggestionId, decision, note, fallbackUser());
        return res.json({
          success: true,
          savedToFeishu: false,
          storage: activeReviewStorageName(),
          suggestion: resolved,
        });
      } catch (localErr) {
        return res.status(500).json({ success: false, error: localErr.message });
      }
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
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

  if (!useFeishuStorage()) {
    const updated = await saveLocalFieldDefinition(fieldKey, fieldDefinition);
    console.log(`[字段定义] ✓ 已写入${activeReviewStorageName()}审核记录 ${fieldKey} ${updated} 条`);
    return res.json({ success: true, updated, fileType: fieldDefinition.file_type, sourceRecordId: sourceRecordId || '', savedToFeishu: false, storage: activeReviewStorageName() });
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
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      const updated = await saveLocalFieldDefinition(fieldKey, fieldDefinition);
      console.log(`[字段定义] ✓ 已写入本地审核记录 ${fieldKey} ${updated} 条`);
      return res.json({ success: true, updated, fileType: fieldDefinition.file_type, sourceRecordId: sourceRecordId || '', savedToFeishu: false, storage: activeReviewStorageName() });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
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

  if (!useFeishuStorage()) {
    const saved = await saveLocalProblem(recordId, entry);
    console.log(`[标记问题] ✓ 已写入${activeReviewStorageName()}审核记录 ${recordId} 问题 ${saved.count} 条`);
    return res.json({ success: true, count: saved.count, savedToFeishu: false, storage: activeReviewStorageName() });
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
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      const saved = await saveLocalProblem(recordId, entry);
      console.log(`[标记问题] ✓ 已写入本地审核记录 ${recordId} 问题 ${saved.count} 条`);
      res.json({ success: true, count: saved.count, savedToFeishu: false, storage: activeReviewStorageName() });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

function getUploadFileType(fileName) {
  const lower = String(fileName || '').toLowerCase();
  if (/\.(doc|docx)$/.test(lower)) return 'Word';
  if (/\.pdf$/.test(lower)) return 'PDF';
  if (/\.(xls|xlsx|csv)$/.test(lower)) return 'Excel';
  if (/\.(zip|7z|rar)$/.test(lower)) return '压缩包';
  return '其他';
}

function formatByteSize(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function normalizeUploadQueueRecord(record) {
  const f = record.fields || {};
  return {
    recordId: record.recordId,
    fileName: normalizeFeishuValue(f['文件名称']),
    fileType: normalizeFeishuValue(f['文件类型']),
    fileSize: normalizeFeishuValue(f['文件大小']),
    fileHash: normalizeFeishuValue(f['文件Hash']),
    uploader: normalizeFeishuValue(f['上传人']),
    uploaderId: normalizeFeishuValue(f['上传人ID']),
    uploadedAt: normalizeFeishuValue(f['上传时间']),
    parseStatus: normalizeFeishuValue(f['解析状态']),
    parseMode: normalizeFeishuValue(f['解析方式']),
    batchId: normalizeFeishuValue(f['批次ID']),
    reviewRecordId: normalizeFeishuValue(f['审核页记录ID']),
    resultRecordId: normalizeFeishuValue(f['解析结果记录ID']),
    missingAttachmentNote: normalizeFeishuValue(f['附件缺失说明']),
    errorReason: normalizeFeishuValue(f['失败原因']),
    parseLog: normalizeFeishuValue(f['解析日志']),
    remark: normalizeFeishuValue(f['备注']),
  };
}

app.get('/api/upload-queue', async (req, res) => {
  try {
    await ensureUploadQueueFields();
    const records = await listBaseRecords(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID);
    const items = records.map(normalizeUploadQueueRecord)
      .filter(item => item.fileName || item.fileHash || item.uploadedAt || item.parseStatus || item.errorReason)
      .sort((a, b) => String(b.uploadedAt || '').localeCompare(String(a.uploadedAt || '')));
    res.json({
      success: true,
      count: items.length,
      items,
      baseToken: UPLOAD_BASE_TOKEN,
      tableId: UPLOAD_TABLE_ID,
    });
  } catch (err) {
    console.error(`[上传队列] 读取失败: ${err.message}`);
    if (isAuthOrPermissionError(err)) return sendFeishuAuthRequired(res, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload-policy-files', async (req, res) => {
  const files = Array.isArray(req.body && req.body.files) ? req.body.files : [];
  if (!files.length) {
    return res.status(400).json({ success: false, error: '未选择文件' });
  }
  if (files.length > 20) {
    return res.status(400).json({ success: false, error: '单次最多上传 20 个文件' });
  }

  try {
    const queueFields = await ensureUploadQueueFields();
    const attachmentField = queueFields.byName && queueFields.byName['原始文件'];
    const maxBytes = parseInt(process.env.UPLOAD_MAX_FILE_BYTES || String(20 * 1024 * 1024), 10);
    const now = new Date().toLocaleString('zh-CN', { hour12: false });
    const batchId = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const user = req.workbenchUser || {};
    const created = [];

    for (const file of files) {
      const fileName = String(file.name || '').trim();
      const rawBase64 = String(file.contentBase64 || '').replace(/^data:[^;]+;base64,/, '');
      if (!fileName || !rawBase64) {
        created.push({ fileName: fileName || '(未命名)', success: false, error: '缺少文件名或文件内容' });
        continue;
      }
      const buffer = Buffer.from(rawBase64, 'base64');
      if (!buffer.length) {
        created.push({ fileName, success: false, error: '文件内容为空' });
        continue;
      }
      if (buffer.length > maxBytes) {
        created.push({ fileName, success: false, error: `文件超过上限 ${formatByteSize(maxBytes)}` });
        continue;
      }

      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      const recordFields = {
        '文件名称': fileName,
        '文件类型': getUploadFileType(fileName),
        '文件大小': formatByteSize(buffer.length),
        '文件Hash': hash,
        '上传人': user.name || user.username || '未知用户',
        '上传人ID': user.username || '',
        '上传时间': now,
        '解析状态': '待解析',
        '解析方式': '上传后队列扫描',
        '批次ID': batchId,
      };

      const record = await createBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordFields);
      const recordId = record && record.record_id;
      const item = { fileName, recordId, hash, success: true, attachmentUploaded: false };

      if (recordId && attachmentField) {
        try {
          const attachment = await uploadBaseAttachment({
            baseToken: UPLOAD_BASE_TOKEN,
            tableId: UPLOAD_TABLE_ID,
            recordId,
            fieldName: attachmentField.field_name || '原始文件',
            fileName,
            buffer,
          });
          item.attachmentUploaded = true;
          item.attachment = attachment;
          await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId, {
            '解析日志': `已上传源文件，等待解析。hash=${hash}`,
          });
        } catch (uploadErr) {
          item.attachmentError = uploadErr.message;
          await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId, {
            '解析状态': '上传失败',
            '失败原因': uploadErr.message,
            '解析日志': `队列记录已创建，但附件上传失败。hash=${hash}`,
          });
        }
      } else if (recordId) {
        item.attachmentError = '缺少原始文件附件字段';
        await updateBaseRecord(UPLOAD_BASE_TOKEN, UPLOAD_TABLE_ID, recordId, {
          '解析状态': '上传失败',
          '失败原因': '缺少原始文件附件字段',
          '解析日志': `队列记录已创建，但未找到原始文件附件字段。hash=${hash}`,
        });
      }

      created.push(item);
    }

    res.json({
      success: created.some(item => item.success),
      batchId,
      uploaded: created.filter(item => item.success && item.attachmentUploaded).length,
      queued: created.filter(item => item.success).length,
      items: created,
    });
    if (created.some(item => item.success && item.attachmentUploaded)) {
      scheduleUploadQueueScan('upload');
    }
  } catch (err) {
    console.error(`[上传队列] 上传失败: ${err.message}`);
    if (isAuthOrPermissionError(err)) return sendFeishuAuthRequired(res, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/upload-queue/scan', async (req, res) => {
  try {
    const result = await scanUploadQueue('manual');
    res.json({
      ...result,
      lastRunAt: state.uploadQueueScan.lastRunAt,
    });
  } catch (err) {
    console.error(`[上传队列] 手动扫描失败: ${err.message}`);
    if (isAuthOrPermissionError(err)) return sendFeishuAuthRequired(res, err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---- 健康检查 ----
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    mode: useFeishuStorage() ? 'render-oauth2' : 'review-store',
    authorized: useFeishuStorage() ? (hasFeishuUserAuth() || !!APP_SECRET) : true,
    tokenValid: useFeishuStorage() ? (hasValidUserAccessToken() || !!state.tenantAccessToken || !!APP_SECRET) : true,
    hasRefreshToken: useFeishuStorage() ? !!state.userRefreshToken : false,
    hasAppSecret: !!APP_SECRET,
    hasTenantToken: !!state.tenantAccessToken,
    localReviewMode: LOCAL_REVIEW_MODE,
    storage: activeReviewStorageName(),
    redisStorageConfigured: useRedisStorage(),
    githubStorageConfigured: useGithubStorage(),
    ruleNotifyConfigured: RULE_CONFIRM_NOTIFY_OPEN_IDS.length > 0,
    ruleNotifyCurrentUser: RULE_CONFIRM_NOTIFY_CURRENT_USER,
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
    const visibleHistoryText = humanChangeHistoryText(f['修改历史']);
    const ruleSuggestionsText = formatRuleSuggestions(parseRuleSuggestions(f['规则待确认']));
    const pendingRuleCount = parseRuleSuggestions(ruleSuggestionsText).filter(item => item.status === 'pending_confirmation').length;
    statuses[recordId] = {
      status: st === '已确认' ? 'confirmed' : 'reviewing',
      confirmed_by: f['确认人'] || null,
      confirmed_at: f['确认时间'] || null,
      edited: visibleHistoryText ? '是' : null,
      change_history: visibleHistoryText || null,
      problem_marks: manualProblemMarks || null,
      rule_suggestions: ruleSuggestionsText || null,
      pending_rule_count: pendingRuleCount,
      fields: {
        ...f,
        '已修改': visibleHistoryText ? '是' : '',
        '修改历史': visibleHistoryText,
        '问题标记': manualProblemMarks,
        '规则待确认': ruleSuggestionsText,
      },
    };
  });
  return statuses;
}

app.get('/api/statuses', async (req, res) => {
  if (!useFeishuStorage()) {
    const statuses = await listLocalRecordStatuses();
    return res.json({
      success: true,
      count: Object.keys(statuses).length,
      statuses,
      storage: activeReviewStorageName(),
    });
  }

  try {
    const statuses = await listAllRecordStatuses();
    res.json({ success: true, count: Object.keys(statuses).length, statuses, storage: 'feishu' });
  } catch (err) {
    console.error(`[状态同步] ✗ ${err.message}`);
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      const statuses = await listLocalRecordStatuses();
      res.json({
        success: true,
        count: Object.keys(statuses).length,
        statuses,
        storage: activeReviewStorageName(),
        warning: '飞书不可用，当前使用站点本地审核记录',
      });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

app.get('/api/local-review-store', async (req, res) => {
  const store = await loadReviewStoreForRead();
  res.json({
    success: true,
    storage: activeReviewStorageName(),
    updatedAt: store.updatedAt,
    recordCount: Object.keys(store.records || {}).length,
    eventCount: (store.events || []).length,
    store,
  });
});

// ---- 恢复同名旧缓存里的审核痕迹（recordId 变化后的兜底迁移）----
app.post('/api/restore-review-state', async (req, res) => {
  const { recordId, data, changeHistory, problems, ruleSuggestions, editedFields } = req.body || {};
  if (!recordId) {
    return res.status(400).json({ success: false, error: '缺少 recordId' });
  }

  if (!useFeishuStorage()) {
    const fields = [];
    await withReviewStore(store => {
      const record = getReviewStoreRecord(store, recordId);
      const history = Array.isArray(changeHistory)
        ? changeHistory.map(e => normalizeChangeEntry(e, {})).filter(e => e.field || e.fieldLabel || e.reason)
        : [];
      const problemLines = splitProblemMarkEntries(formatProblemMarks(problems || []));
      const ruleList = parseRuleSuggestions(ruleSuggestions || []);
      const payloadData = data && typeof data === 'object' ? data : {};
      const changedKeys = new Set((editedFields || []).map(canonicalizeFieldName).filter(Boolean));
      history.forEach(h => changedKeys.add(canonicalizeFieldName(h.field || h.fieldLabel)));

      history.forEach(entry => record.changeHistory.push(entry));
      problemLines.forEach(line => record.problemLines.push(line));
      ruleList.forEach(item => record.ruleSuggestions.push(item));
      if (history.length) fields.push('修改历史');
      if (problemLines.length) fields.push('问题标记');
      if (ruleList.length) fields.push('规则待确认');
      if (history.length || problemLines.length) {
        record.fields['已修改'] = '是';
        fields.push('已修改');
      }
      changedKeys.forEach(key => {
        if (!Object.prototype.hasOwnProperty.call(payloadData, key)) return;
        const value = normalizeFeishuValue(payloadData[key]);
        if (!value) return;
        record.dataPatch[key] = value;
        const label = KEY_LABELS[key];
        if (label) {
          record.fields[label] = value;
          fields.push(label);
        }
      });
      if (payloadData[FIELD_DEFINITIONS_KEY] && typeof payloadData[FIELD_DEFINITIONS_KEY] === 'object') {
        Object.assign(record.fieldDefinitions, payloadData[FIELD_DEFINITIONS_KEY]);
      }
      record.updated_at = new Date().toISOString();
      appendReviewEvent(store, 'restore-review-state', recordId, { fields: [...new Set(fields)] });
      return true;
    }, `Restore policy review state: ${recordId}`);
    return res.json({ success: true, restored: true, fields: [...new Set(fields)], storage: activeReviewStorageName(), savedToFeishu: false });
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
    const ruleSuggestionsText = formatRuleSuggestions(ruleSuggestions || []);

    if (historyText && !hasValue(currentFields['修改历史'])) updates['修改历史'] = historyText;
    if (problemText && !hasValue(currentFields['问题标记'])) updates['问题标记'] = problemText;
    if (ruleSuggestionsText && !hasValue(currentFields['规则待确认'])) updates['规则待确认'] = ruleSuggestionsText;
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
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
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

// ---- 管理接口：按最新人工学习规则修复当前待审记录 ----
// 只修复可由当前文件原文确定的问题；不改已确认记录，不新增人工问题标记。
app.post('/api/admin/relearn-pending-records', async (req, res) => {
  if (!requireAdminConfirm(req, res, 'RELEARN_PENDING_RECORDS')) return;

  if (!useFeishuStorage()) {
    return res.status(400).json({
      success: false,
      error: '当前不是飞书存储模式，无法批量修复线上待审记录',
      storage: activeReviewStorageName(),
    });
  }

  try {
    const tableFields = await ensureTableFields();
    const records = await listAllFeishuRecords();
    const changedRecords = [];
    const skipped = [];

    const results = await runLimited(records, 4, async item => {
      const fields = item.fields || {};
      if (!isPendingReview(fields)) return { success: true, skipped: true, reason: '已确认' };

      const jsonFieldName = getJsonFieldName(fields);
      const parsed = parseJsonField(jsonFieldName ? fields[jsonFieldName] : null);
      if (!parsed) {
        skipped.push({ recordId: item.recordId, fileName: getFileName(fields, parsed), reason: '解析JSON为空或不可解析' });
        return { success: true, skipped: true };
      }

      const beforeJson = stringifyJsonField(parsed);
      const learned = applyCurrentLearningToParsed(fields, parsed);
      const afterJson = stringifyJsonField(parsed);
      const manualAfter = normalizeFeishuValue(getParsedValue(parsed, 'manual_confirm_fields'));
      const updates = {};

      if (beforeJson !== afterJson && jsonFieldName && tableFields.includes(jsonFieldName)) {
        updates[jsonFieldName] = afterJson;
      }
      if (tableFields.includes('人工确认项') && normalizeFeishuValue(fields['人工确认项']) !== manualAfter) {
        updates['人工确认项'] = manualAfter;
      }

      (learned.changes || []).forEach(change => {
        const label = KEY_LABELS[change.key];
        if (!label || !tableFields.includes(label)) return;
        updates[label] = normalizeFeishuValue(getParsedValue(parsed, change.key));
      });

      if (!Object.keys(updates).length) return { success: true, skipped: true, reason: '无可安全修复项' };
      await updateFeishuRecord(item.recordId, updates);
      changedRecords.push({
        recordId: item.recordId,
        fileName: getFileName(fields, parsed),
        fields: [...new Set((learned.changes || []).map(x => x.label || x.key))],
        reasons: [...new Set((learned.changes || []).map(x => x.reason).filter(Boolean))],
      });
      return { success: true, recordId: item.recordId };
    });

    const errors = results.filter(x => x && !x.success);
    let versionRecord = { ok: false, skipped: true };
    if (changedRecords.length) {
      versionRecord = await appendVersionUpdateRecord({
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        fileName: '当前待审文件批量学习修复',
        userName: 'AUTO_RULE',
        fieldLabel: '多字段',
        oldValue: '旧解析结果',
        newValue: '按最新人工学习规则修正',
        reason: '根据已确认历史样本与当前人工反馈，修正权益字段、人工确认残留、日期范围等确定性问题',
        ruleType: '当前待审文件学习修复',
        rule: '权益名称/权益使用规则仅按当前文件证据、文档级最多一次；人工确认被具体值替换后必须清理；日期范围按当前文件发文日/标题/原文日期修复。',
        autoApplied: changedRecords.length,
        autoFiles: changedRecords.map(x => x.fileName || x.recordId),
      });
    }

    res.json({
      success: errors.length === 0,
      changed: changedRecords.length,
      changed_records: changedRecords,
      skipped,
      errors,
      versionRecord,
      storage: 'feishu',
    });
  } catch (err) {
    console.error(`[待审学习修复] ✗ ${err.message}`);
    if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

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

  if (!useFeishuStorage()) {
    await clearLocalReviewRecords();
    return res.json({
      success: true,
      deleted: 0,
      storage: activeReviewStorageName(),
      savedToFeishu: false,
      remaining_estimate: 0,
      note: '已清空审核账本并隐藏静态批次',
    });
  }

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
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      await clearLocalReviewRecords();
      return res.json({
        success: true,
        deleted: 0,
        storage: activeReviewStorageName(),
        savedToFeishu: false,
        remaining_estimate: 0,
        note: '飞书不可用，已清空站点本地审核记录并隐藏静态批次',
      });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
    } else {
      res.status(500).json({ success: false, error: err.message });
    }
  }
});

// ---- 管理接口：清理系统自动矫正生成的问题标记 ----
// 保留修改历史，仅从「问题标记」里移除 AUTO_RULE/自动矫正/按当前原文复核拆分 等系统行。
app.post('/api/admin/cleanup-auto-problems', async (req, res) => {
  if (!requireAdminConfirm(req, res, 'CLEANUP_AUTO_PROBLEMS')) return;

  if (!useFeishuStorage()) {
    let changed = 0;
    await withReviewStore(store => {
      Object.values(store.records || {}).forEach(record => {
        const before = (record.problemLines || []).join('\n');
        const after = filterManualProblemMarks(before);
        if (before !== after) {
          record.problemLines = splitProblemMarkEntries(after);
          record.fields = record.fields || {};
          record.fields['问题标记'] = after;
          record.updated_at = new Date().toISOString();
          changed++;
        }
      });
      appendReviewEvent(store, 'cleanup-auto-problems', '', { changed });
      return true;
    }, 'Cleanup auto problem marks');
    return res.json({ success: true, changed, changed_records: [], errors: [], storage: activeReviewStorageName(), savedToFeishu: false });
  }

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

  if (!useFeishuStorage()) {
    const changedRecords = [];
    await withReviewStore(store => {
      Object.entries(store.records || {}).forEach(([recordId, record]) => {
        const before = normalizeFeishuValue(record.fields && record.fields['人工确认项']);
        const after = cleanManualConfirmText(before);
        const parsed = record.dataPatch || null;
        const jsonChanges = [
          ...applyChangeHistoryToParsed(parsed, record.fields && record.fields['修改历史']),
          ...repairScenarioFromBusinessLine(record.fields, parsed),
          ...removeUnsupportedScenarioFields(record.fields, parsed),
          ...repairConfirmedManualResidues(record.fields, parsed),
        ];
        if (before !== after) {
          record.fields = record.fields || {};
          record.fields['人工确认项'] = after;
          if (record.dataPatch) record.dataPatch.manual_confirm_fields = after;
          record.updated_at = new Date().toISOString();
        }
        if (parsed) {
          const displayScenario = getParsedValue(parsed, 'scenario');
          const displayBusinessLine = getParsedValue(parsed, 'business_line');
          if (displayScenario) record.fields['解析场景'] = displayScenario;
          if (displayBusinessLine) record.fields['业务线'] = displayBusinessLine;
        }
        if (jsonChanges.length && parsed) record.dataPatch = parsed;
        if (before !== after || jsonChanges.length) {
          record.updated_at = new Date().toISOString();
          changedRecords.push({ recordId, fileName: normalizeFeishuValue(record.fields && record.fields['文件名称']), before, after, jsonChanges: jsonChanges.length });
        }
      });
      appendReviewEvent(store, 'cleanup-manual-confirm', '', { changed: changedRecords.length });
      return true;
    }, 'Cleanup manual confirm fields');
    return res.json({ success: true, changed: changedRecords.length, changed_records: changedRecords, errors: [], storage: activeReviewStorageName(), savedToFeishu: false });
  }

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
      const jsonChanges = parsed ? [
        ...applyChangeHistoryToParsed(parsed, item.fields['修改历史']),
        ...repairScenarioFromBusinessLine(item.fields, parsed),
        ...removeUnsupportedScenarioFields(item.fields, parsed),
        ...repairConfirmedManualResidues(item.fields, parsed),
      ] : [];
      const cleanedJson = parsed ? cleanParsedManualConfirm(parsed) : false;
      if (parsed && jsonFieldName && tableFields.includes(jsonFieldName) && (jsonChanges.length || cleanedJson)) {
        updates[jsonFieldName] = stringifyJsonField(parsed);
      }
      if (parsed && tableFields.includes('解析场景')) {
        const nextScenario = normalizeFeishuValue(getParsedValue(parsed, 'scenario'));
        if (nextScenario && normalizeFeishuValue(item.fields['解析场景']) !== nextScenario) updates['解析场景'] = nextScenario;
      }
      if (parsed && tableFields.includes('业务线')) {
        const nextBusinessLine = normalizeFeishuValue(getParsedValue(parsed, 'business_line'));
        if (nextBusinessLine && normalizeFeishuValue(item.fields['业务线']) !== nextBusinessLine) updates['业务线'] = nextBusinessLine;
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
        jsonChanges: jsonChanges.length,
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

  if (!useFeishuStorage()) {
    const records = Array.isArray(req.body.records) ? req.body.records : [];
    if (!records.length) {
      return res.status(400).json({ success: false, error: 'records 为空' });
    }
    const imported = await saveLocalImportedRecords(records);
    return res.json({
      success: true,
      count: imported.length,
      records: imported,
      storage: activeReviewStorageName(),
      savedToFeishu: false,
    });
  }

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

      // Only human-edited result fields are locked. System corrections and old
      // parser output must not freeze stale display columns during a re-import.
      const humanLockedLabels = humanEditedFieldLabelsFromHistory(existing.fields['修改历史']);
      MERGEABLE_RESULT_FIELDS.forEach(name => {
        if (humanLockedLabels.has(name) && Object.prototype.hasOwnProperty.call(existing.fields, name)) {
          merged[name] = existing.fields[name];
        }
      });

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
        const mergedFields = filterKnownFields(mergePreservingReview(fields, existing), tableFields);
        const updateFields = { ...mergedFields };
        // Existing records may contain Feishu select/user/date objects. Updating those
        // objects back through the API can trigger conversion failures, so keep review
        // state in place by omitting preserved fields from update payloads.
        REVIEW_PRESERVE_FIELDS.forEach(name => delete updateFields[name]);
        await updateFeishuRecord(existing.recordId, updateFields);
        created.push({
          recordId: existing.recordId,
          fields: { ...(existing.fields || {}), ...updateFields },
          fileName: mergedFields['文件名称'],
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
    if (allowFeishuLocalFallback() && isAuthOrPermissionError(err)) {
      const records = Array.isArray(req.body.records) ? req.body.records : [];
      if (!records.length) {
        return res.status(400).json({ success: false, error: 'records 为空' });
      }
      const imported = await saveLocalImportedRecords(records);
      return res.json({
        success: true,
        count: imported.length,
        records: imported,
        storage: activeReviewStorageName(),
        savedToFeishu: false,
      });
    } else if (isAuthOrPermissionError(err)) {
      return sendFeishuAuthRequired(res, err);
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
  if (UPLOAD_QUEUE_SCAN_ENABLED && UPLOAD_QUEUE_SCAN_INTERVAL_MS > 0) {
    setInterval(() => scheduleUploadQueueScan('interval'), UPLOAD_QUEUE_SCAN_INTERVAL_MS).unref();
    scheduleUploadQueueScan('startup');
    console.log(`   上传队列扫描: 启用，每 ${UPLOAD_QUEUE_SCAN_INTERVAL_MS}ms，单批 ${UPLOAD_QUEUE_SCAN_BATCH_LIMIT} 个\n`);
  }
});
