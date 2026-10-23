const platformOrder = ['去哪儿', '携程', '同程', '飞猪'];

const platformFlows = {
  '去哪儿': {
    entry: '首页 -> 机票 -> 航司活动 -> 国内次卡放心囤 / 航司卡券联名专区',
    signals: '航司活动 / 国内次卡放心囤 / 权益卡',
    risk: '基准平台，按次卡和权益卡分别核对。',
  },
  '携程': {
    entry: '首页 -> 机票 / 特价机票 -> 权益中心 -> 飞行次卡 / 权益卡',
    signals: '权益中心 / 飞行次卡 / 权益卡',
    risk: '已剔除机场燃油卡、学生权益卡、银行信用卡等非航司活动。',
  },
  '同程': {
    entry: '首页 -> 机票 -> 错峰捡漏209元机票次卡 -> 出行权益中心 -> 查看更多 -> 机票提前囤 -> 国内',
    signals: '出行权益中心 / 机票提前囤 / 国内',
    risk: '已剔除测试卡，合并同一产品的价格区间。',
  },
  '飞猪': {
    entry: '首页 -> 机票 -> 展开全部 -> 飞猪旅行卡 -> 机票专区',
    signals: '机票次卡 / 飞猪旅行卡 / 机票专区',
    risk: '已剔除国际/外航卡，尾部卡片已补采。',
  },
};

const reviewRows = [
  {
    topic: '藏航冬日暖阳单程 / 往返',
    qunar: '藏航冬日暖阳单程次卡、藏航冬日暖阳往返次卡',
    competitors: '携程国内单程/往返经济舱次卡，同程西藏航空冬日暖阳，飞猪西藏航空冬日暖阳往返机票卡',
    verdict: '价格和产品主题高度接近，需进详情页比对航线、使用期、退改规则后合并。',
  },
  {
    topic: '山东航空中转次卡',
    qunar: '山东航空中转次卡',
    competitors: '携程国内中转机票次卡，同程山航中转次卡 / 山航中转3次卡',
    verdict: '450 元单次卡大概率同品；3 次卡属于规格差异，需单独记录。',
  },
  {
    topic: '成都航空往返次卡',
    qunar: '成都航空往返次卡',
    competitors: '携程成都航空经济舱往返次卡',
    verdict: '价格一致，优先核验详情后可视为同一产品。',
  },
  {
    topic: '国航系青年 / 银发 / 雪域权益',
    qunar: '国航系青年权益卡、国航系银发悠享权益卡、国航雪域高原权益卡',
    competitors: '携程国航系青年卡 / 银发悠享 / 西藏雪域专享卡，同程国航系青春联名卡 / 雪域专享权益卡',
    verdict: '名称和价格存在小幅差异，必须用详情页判断是否同品。',
  },
  {
    topic: '川航老友 / 青年 / 家庭权益',
    qunar: '川航老友同行权益卡、四川航空青年权益卡、川航家庭权益卡',
    competitors: '携程四川航空老友同行权益卡，同程川航成都老友 / 青年 / 家庭多人单次卡，飞猪川航双人/三人单次卡',
    verdict: '权益卡和多人次卡混在同一航司主题下，需按产品类型和使用规则拆分。',
  },
  {
    topic: '华夏自由飞权益卡',
    qunar: '未在去哪儿本轮列表出现',
    competitors: '携程华夏航空自由飞权益卡，飞猪华夏自由飞特惠权益卡',
    verdict: '两个竞品均出现，且价格接近，应作为去哪儿优先缺失候选。',
  },
];

const els = {
  metrics: document.querySelector('#metrics'),
  flows: document.querySelector('#flows'),
  reviewRows: document.querySelector('#reviewRows'),
  productRows: document.querySelector('#productRows'),
  productCount: document.querySelector('#productCount'),
  platformFilter: document.querySelector('#platformFilter'),
  typeFilter: document.querySelector('#typeFilter'),
  keywordFilter: document.querySelector('#keywordFilter'),
};

let products = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function countByPlatform(items) {
  const counts = new Map();
  for (const platform of platformOrder) {
    counts.set(platform, { platform, total: 0, tripCards: 0, benefitCards: 0 });
  }
  for (const product of items) {
    const item = counts.get(product.platform) || { platform: product.platform, total: 0, tripCards: 0, benefitCards: 0 };
    item.total += 1;
    if (product.product_type === '次卡') item.tripCards += 1;
    if (product.product_type === '权益卡') item.benefitCards += 1;
    counts.set(product.platform, item);
  }
  return platformOrder.map((platform) => counts.get(platform)).filter(Boolean);
}

function renderMetrics(items) {
  const counts = countByPlatform(items);
  const total = items.length;
  const tripCards = items.filter((item) => item.product_type === '次卡').length;
  const benefitCards = items.filter((item) => item.product_type === '权益卡').length;
  const qunar = counts.find((item) => item.platform === '去哪儿') || { total: 0, tripCards: 0, benefitCards: 0 };
  const competitorUnique = new Set(items.filter((item) => item.platform !== '去哪儿').map((item) => item.product_name)).size;

  const metrics = [
    { label: '已入库产品', value: total, note: `次卡 ${tripCards} / 权益卡 ${benefitCards}` },
    { label: '去哪儿基准', value: qunar.total, note: `次卡 ${qunar.tripCards} / 权益卡 ${qunar.benefitCards}`, baseline: true },
    { label: '竞品唯一产品', value: competitorUnique, note: '按名称粗去重，详情页核验后再合并' },
    { label: '待核验主题', value: reviewRows.length, note: '名称差异但可能同品' },
  ];

  els.metrics.innerHTML = metrics.map((item) => `
    <article class="metric${item.baseline ? ' baseline' : ''}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <em>${escapeHtml(item.note)}</em>
    </article>
  `).join('');
}

function renderFlows() {
  els.flows.innerHTML = platformOrder.map((platform) => {
    const flow = platformFlows[platform];
    return `
      <article class="flow-card">
        <strong>${escapeHtml(platform)}</strong>
        <span>${escapeHtml(flow.entry)}</span>
        <p>${escapeHtml(flow.signals)}</p>
        <p>${escapeHtml(flow.risk)}</p>
      </article>
    `;
  }).join('');
}

function renderReviews() {
  els.reviewRows.innerHTML = reviewRows.map((row) => `
    <tr>
      <td><strong>${escapeHtml(row.topic)}</strong></td>
      <td>${escapeHtml(row.qunar)}</td>
      <td>${escapeHtml(row.competitors)}</td>
      <td>${escapeHtml(row.verdict)}</td>
    </tr>
  `).join('');
}

function renderPlatformOptions() {
  const platforms = Array.from(new Set(products.map((product) => product.platform)));
  for (const platform of platformOrder.filter((item) => platforms.includes(item))) {
    const option = document.createElement('option');
    option.value = platform;
    option.textContent = platform;
    els.platformFilter.appendChild(option);
  }
}

function productMatches(product) {
  const platform = els.platformFilter.value;
  const type = els.typeFilter.value;
  const keyword = els.keywordFilter.value.trim().toLowerCase();
  if (platform && product.platform !== platform) return false;
  if (type && product.product_type !== type) return false;
  if (!keyword) return true;
  const haystack = [
    product.product_name,
    product.price,
    product.product_info,
    product.source_page,
    product.platform,
    product.product_type,
  ].join(' ').toLowerCase();
  return haystack.includes(keyword);
}

function renderProducts() {
  const filtered = products.filter(productMatches);
  els.productCount.textContent = `${filtered.length} / ${products.length} 条`;
  els.productRows.innerHTML = filtered.length ? filtered.map((product) => `
    <tr>
      <td>${escapeHtml(product.platform)}</td>
      <td><strong>${escapeHtml(product.product_name)}</strong></td>
      <td><span class="pill">${escapeHtml(product.product_type || '未分类')}</span></td>
      <td>${escapeHtml(product.price || '-')}</td>
      <td>${escapeHtml(product.product_info || '-')}</td>
      <td>${escapeHtml(product.source_page || '-')}</td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="empty">没有匹配的产品</td></tr>';
}

async function init() {
  const response = await fetch('./data/products.json');
  products = await response.json();
  renderMetrics(products);
  renderFlows();
  renderReviews();
  renderPlatformOptions();
  renderProducts();
  els.platformFilter.addEventListener('change', renderProducts);
  els.typeFilter.addEventListener('change', renderProducts);
  els.keywordFilter.addEventListener('input', renderProducts);
}

init().catch((error) => {
  els.productRows.innerHTML = `<tr><td colspan="6" class="empty">数据加载失败：${escapeHtml(error.message)}</td></tr>`;
});
