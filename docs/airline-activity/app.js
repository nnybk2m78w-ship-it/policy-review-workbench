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

const gapCandidates = [
  {
    topic: '华夏自由飞权益卡',
    priority: 'P0',
    platforms: ['携程', '飞猪'],
    qunarStatus: '去哪儿本轮未见同名或近似权益卡',
    reason: '携程和飞猪均出现华夏自由飞权益产品，价格均在 520 元附近，疑似同一底层产品或强相似产品。',
    next: '进入携程、飞猪详情页，比对价格、航线范围、权益券和使用有效期；若详情一致，应列为去哪儿明确缺失。',
    keywords: ['华夏航空自由飞权益卡', '华夏自由飞特惠权益卡'],
    filterKeyword: '华夏|自由飞',
  },
  {
    topic: '飞猪全国通用国内机票卡系列',
    priority: 'P1',
    platforms: ['飞猪'],
    qunarStatus: '去哪儿本轮未见等价全国通用机票卡入口',
    reason: '飞猪出现 299 / 388 / 499 / 888 / 999 元多档位全国通用国内机票卡，属于平台自营通用次卡系列。',
    next: '确认去哪儿是否有等价通用机票卡入口；若没有，按价格档位拆为系列缺失。',
    keywords: ['全国通用国内机票卡'],
    filterKeyword: '全国通用国内机票卡',
  },
  {
    topic: '同程出去玩1次卡 299 / 399 元版',
    priority: 'P1',
    platforms: ['同程'],
    qunarStatus: '去哪儿本轮未见同名次卡',
    reason: '同程出现出去玩1次卡 299 元和 399 元两个清晰价档，名称级缺失明显。',
    next: '详情页确认航线、可用日期、退改和兑换规则；若不是测试卡，应列入去哪儿补充跟进。',
    keywords: ['出去玩1次卡'],
    filterKeyword: '出去玩1次卡',
  },
  {
    topic: '东海 / 南航 / 长安航 / 桂林航空权益卡',
    priority: 'P1',
    platforms: ['同程'],
    qunarStatus: '去哪儿本轮未见对应航司权益卡',
    reason: '同程集中出现东海、南航、长安航、桂林航空权益卡；去哪儿本轮权益卡列表未见对应航司主题。',
    next: '按航司逐项进入详情页核对权益内容和适用范围；若为真实航司权益而非平台通用券，应拆分为多条缺失。',
    keywords: ['东海往返权益卡', '南航秋季旅游节特惠权益卡', '长安航航旅优享权益卡', '桂林航空1元权益'],
    filterKeyword: '东海|南航|长安|桂林',
  },
  {
    topic: '候鸟南飞 / 冰雪之约国内机票次卡',
    priority: 'P2',
    platforms: ['同程'],
    qunarStatus: '去哪儿本轮未见季节主题同名次卡',
    reason: '同程出现候鸟南飞、冰雪之约两个季节主题国内机票次卡，去哪儿列表无同名主题。',
    next: '判断是否与去哪儿国航/藏航冬季产品重合；若航线、价格和使用期不重合，再保留为缺失。',
    keywords: ['候鸟南飞', '冰雪之约'],
    filterKeyword: '候鸟南飞|冰雪之约',
  },
];

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
  gapSummary: document.querySelector('#gapSummary'),
  gapOverview: document.querySelector('#gapOverview'),
  gapList: document.querySelector('#gapList'),
  flows: document.querySelector('#flows'),
  reviewRows: document.querySelector('#reviewRows'),
  productPanel: document.querySelector('#productPanel'),
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
  const p0Gaps = gapCandidates.filter((item) => item.priority === 'P0').length;
  const p1Gaps = gapCandidates.filter((item) => item.priority === 'P1').length;

  const metrics = [
    { label: '已入库产品', value: total, note: `次卡 ${tripCards} / 权益卡 ${benefitCards}` },
    { label: '去哪儿基准', value: qunar.total, note: `次卡 ${qunar.tripCards} / 权益卡 ${qunar.benefitCards}`, baseline: true },
    { label: '竞品唯一产品', value: competitorUnique, note: '按名称粗去重，详情页核验后再合并' },
    { label: '去哪儿缺失候选', value: gapCandidates.length, note: `P0 ${p0Gaps} / P1 ${p1Gaps} / P2 ${gapCandidates.length - p0Gaps - p1Gaps}`, alert: true },
  ];

  els.metrics.innerHTML = metrics.map((item) => `
    <article class="metric${item.baseline ? ' baseline' : ''}${item.alert ? ' alert' : ''}">
      <span>${escapeHtml(item.label)}</span>
      <strong>${escapeHtml(item.value)}</strong>
      <em>${escapeHtml(item.note)}</em>
    </article>
  `).join('');
}

function findGapEvidence(candidate) {
  const keywords = candidate.keywords.map((keyword) => keyword.toLowerCase());
  return products.filter((product) => {
    if (product.platform === '去哪儿') return false;
    const haystack = [
      product.product_name,
      product.product_info,
      product.source_page,
    ].join(' ').toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

function renderGapCandidates() {
  const evidenceByTopic = new Map(gapCandidates.map((candidate) => [candidate.topic, findGapEvidence(candidate)]));
  const evidenceCount = Array.from(evidenceByTopic.values()).reduce((sum, items) => sum + items.length, 0);
  const priorityCounts = gapCandidates.reduce((acc, item) => {
    acc[item.priority] = (acc[item.priority] || 0) + 1;
    return acc;
  }, {});

  els.gapSummary.textContent = `${gapCandidates.length} 个候选 / ${evidenceCount} 条竞品证据`;
  els.gapOverview.innerHTML = `
    <div class="gap-stat">
      <span>最高优先级</span>
      <strong>P0 × ${escapeHtml(priorityCounts.P0 || 0)}</strong>
    </div>
    <div class="gap-stat">
      <span>需要重点核验</span>
      <strong>P1 × ${escapeHtml(priorityCounts.P1 || 0)}</strong>
    </div>
    <div class="gap-stat">
      <span>候选证据产品</span>
      <strong>${escapeHtml(evidenceCount)}</strong>
    </div>
    <p>判定口径：先看竞品是否出现，再看去哪儿是否有同名或近似产品；名称不同但价格、航线、使用规则一致时，进入详情页后再合并为同品。</p>
  `;

  els.gapList.innerHTML = gapCandidates.map((candidate) => {
    const evidence = evidenceByTopic.get(candidate.topic) || [];
    return `
      <article class="gap-card priority-${escapeHtml(candidate.priority.toLowerCase())}">
        <div class="gap-card-head">
          <div>
            <span class="priority-badge">${escapeHtml(candidate.priority)}</span>
            <h3>${escapeHtml(candidate.topic)}</h3>
          </div>
          <button type="button" class="gap-filter-btn" data-gap-keyword="${escapeHtml(candidate.filterKeyword)}">查看证据</button>
        </div>
        <div class="gap-meta">
          <span>竞品出现：${escapeHtml(candidate.platforms.join(' / '))}</span>
          <span class="qunar-missing">去哪儿：${escapeHtml(candidate.qunarStatus)}</span>
        </div>
        <p>${escapeHtml(candidate.reason)}</p>
        <div class="evidence-list">
          ${evidence.length ? evidence.map((product) => `
            <span>${escapeHtml(product.platform)}｜${escapeHtml(product.product_name)}｜${escapeHtml(product.price || '-')}</span>
          `).join('') : '<span>明细表暂无可自动匹配的证据产品，需人工核验</span>'}
        </div>
        <div class="next-step">${escapeHtml(candidate.next)}</div>
      </article>
    `;
  }).join('');

  document.querySelectorAll('.gap-filter-btn').forEach((button) => {
    button.addEventListener('click', () => {
      els.platformFilter.value = '';
      els.typeFilter.value = '';
      els.keywordFilter.value = button.dataset.gapKeyword || '';
      renderProducts();
      els.productPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
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
  const haystack = [
    product.product_name,
    product.price,
    product.product_info,
    product.source_page,
    product.platform,
    product.product_type,
  ].join(' ').toLowerCase();
  if (!keyword) return true;
  if (keyword.includes('|')) {
    return keyword.split('|').map((item) => item.trim()).filter(Boolean).some((item) => haystack.includes(item));
  }
  const terms = keyword.split(/\s+/).filter(Boolean);
  return terms.every((term) => haystack.includes(term));
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
  renderGapCandidates();
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
