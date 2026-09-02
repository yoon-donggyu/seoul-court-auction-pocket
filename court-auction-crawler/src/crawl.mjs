import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const SOURCE_URL = 'https://www.courtauction.go.kr/pgj/index.on?w2xPath=/pgj/ui/pgj100/PGJ151F00.xml';
const COURTS = [
  '서울중앙지방법원',
  '서울동부지방법원',
  '서울서부지방법원',
  '서울남부지방법원',
  '서울북부지방법원'
];
const DATA_DIR = path.resolve('data');
const OUTPUT = path.join(DATA_DIR, 'court-auctions.json');
const PREVIOUS = path.join(DATA_DIR, 'court-auctions.previous.json');
const DIAGNOSTIC = path.join(DATA_DIR, 'last-failure.html');
const MIN_DELAY_MS = Number(process.env.CRAWL_DELAY_MIN_MS || 2500);
const MAX_DELAY_MS = Number(process.env.CRAWL_DELAY_MAX_MS || 5000);
const MAX_PAGES = Number(process.env.CRAWL_MAX_PAGES || 100);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = () => sleep(MIN_DELAY_MS + Math.floor(Math.random() * Math.max(1, MAX_DELAY_MS - MIN_DELAY_MS)));
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const digits = value => clean(value).replace(/[^0-9]/g, '');

function kstIso() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date()).replace(' ', 'T') + '+09:00';
}

function itemKey(item) {
  return [item.court, item.caseNumber, item.itemNumber || '1'].join('|');
}

function parseMoney(value) {
  const n = digits(value);
  return n && Number(n) >= 10000 ? n : '';
}

function parseRow(court, cells) {
  const text = cells.map(clean);
  const joined = text.join(' | ');
  const caseNumber = joined.match(/\b(\d{4})\s*타경\s*(\d+)\b/);
  if (!caseNumber) return null;

  const dates = joined.match(/20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}/g) || [];
  // 사건번호·주소 숫자를 가격으로 오인하지 않도록 천 단위 쉼표가 있는 금액만 읽는다.
  const moneyMatches = [...joined.matchAll(/\b(\d{1,3}(?:,\d{3})+)\s*원?/g)]
    .map(match => parseMoney(match[1])).filter(Boolean);
  const failCount = joined.match(/유찰\s*[:：()\-]?\s*(\d+)\s*회?/);
  const itemNo = joined.match(/물건번호\s*(\d+)/);
  const itemNumber = itemNo?.[1] || (text[2]?.match(/^\d{1,4}$/)?.[0]) || '1';
  const address = text.find(v => /(서울특별시|서울시)\s/.test(v)) || '';
  const useType = text.find(v => /(아파트|다세대|연립|단독주택|다가구|오피스텔|상가|근린|토지|대지|임야|전|답)/.test(v)) || '';
  const appraisalPrice = moneyMatches[0] || '';
  const minimumPrice = moneyMatches[1] || '';
  const discountRate = joined.match(/\((\d+(?:\.\d+)?)%\)/)?.[1] || '';
  const saleStatus = text.find(v => /유찰|매각|변경|취하|정지|진행/.test(v) && !/경매\d+계/.test(v)) || '';
  const remarks = text.filter(v => v && v !== '지도' && /건축물대장|임대|대항력|지분|특별매각|재매각/.test(v)).join(' · ');
  const fields = [
    ['법원', court], ['사건번호', `${caseNumber[1]}타경${caseNumber[2]}`],
    ['물건번호', itemNumber], ['용도', useType],
    ['소재지 · 면적', address], ['감정평가액', appraisalPrice],
    ['최저매각가격', minimumPrice], ['감정가 대비', discountRate ? `${discountRate}%` : ''],
    ['담당계 · 매각기일', dates[0] || ''], ['진행상태', saleStatus],
    ['유찰 횟수', failCount ? `${failCount[1]}회` : ''], ['비고 · 부가정보', remarks]
  ].filter(([, value]) => value).map(([label, value]) => ({ label, value }));

  return {
    id: `${court}-${caseNumber[1]}타경${caseNumber[2]}-${itemNumber}`,
    court,
    caseNumber: `${caseNumber[1]}타경${caseNumber[2]}`,
    itemNumber,
    address,
    useType,
    appraisalPrice,
    minimumPrice,
    saleDate: dates[0] || '',
    failCount: failCount ? Number(failCount[1]) : null,
    fields,
    raw: text,
    sourceUrl: SOURCE_URL
  };
}

async function extractVisibleItems(page, court) {
  const physicalRows = await page.locator('tr').evaluateAll(rows => rows.map(row =>
    Array.from(row.children)
      .filter(cell => cell.tagName === 'TD')
      .map(cell => (cell.innerText || '').replace(/\s+/g, ' ').trim())
  ).filter(cells => cells.length));
  const logicalRows = [];
  let current = null;
  for (const cells of physicalRows) {
    const hasCase = cells.some(value => /\d{4}\s*타경\s*\d+/.test(value));
    if (hasCase) {
      if (current) logicalRows.push(current);
      current = [...cells];
    } else if (current && cells.some(Boolean)) {
      current.push(...cells);
    }
  }
  if (current) logicalRows.push(current);
  return logicalRows.map(cells => parseRow(court, cells)).filter(Boolean);
}

async function findNextButton(page) {
  const candidates = [
    page.getByRole('link', { name: /다음/ }),
    page.getByRole('button', { name: /다음/ }),
    page.locator('[title*="다음"]')
  ];
  for (const candidate of candidates) {
    if (await candidate.count()) {
      const first = candidate.first();
      if (await first.isVisible() && await first.isEnabled()) return first;
    }
  }
  return null;
}

async function crawlCourt(page, court) {
  await page.goto(SOURCE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.getByLabel('법원 선택').selectOption({ label: court });
  await randomDelay();
  await page.locator('input[title="부동산 물건상세 검색 버튼"]').click({ timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await randomDelay();

  const items = [];
  const seenPageSignatures = new Set();
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const current = await extractVisibleItems(page, court);
    const signature = current.map(itemKey).join(',');
    if (!signature || seenPageSignatures.has(signature)) break;
    seenPageSignatures.add(signature);
    items.push(...current);

    const next = await findNextButton(page);
    if (!next) break;
    await next.click({ timeout: 30000 });
    await randomDelay();
  }
  return items;
}

function mergeHistory(currentItems, previousPayload) {
  const previous = new Map((previousPayload?.items || []).map(item => [itemKey(item), item]));
  const now = kstIso();
  const currentKeys = new Set();
  const items = currentItems.map(item => {
    const key = itemKey(item);
    currentKeys.add(key);
    const old = previous.get(key);
    const changed = !!old && ['address', 'appraisalPrice', 'minimumPrice', 'saleDate', 'failCount']
      .some(field => String(old[field] ?? '') !== String(item[field] ?? ''));
    return {
      ...item,
      firstSeenAt: old?.firstSeenAt || now,
      lastSeenAt: now,
      status: old ? (changed ? '변경' : '유효') : '신규'
    };
  });

  for (const [key, old] of previous) {
    if (!currentKeys.has(key)) items.push({ ...old, status: '종료', endedAt: old.endedAt || now });
  }
  return items;
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

async function atomicWrite(file, data) {
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  await fs.rename(temp, file);
}

async function main() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const previous = await readJson(OUTPUT);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    viewport: { width: 1440, height: 1200 }
  });
  const page = await context.newPage();
  const all = [];
  const courtStats = [];

  try {
    for (const court of COURTS) {
      const items = await crawlCourt(page, court);
      all.push(...items);
      courtStats.push({ court, count: items.length });
      await randomDelay();
    }
    if (!all.length) throw new Error('서울 법원 검색 결과가 0건입니다. 사이트 구조 또는 접근 상태를 확인하세요.');

    const deduped = [...new Map(all.map(item => [itemKey(item), item])).values()];
    const items = mergeHistory(deduped, previous);
    const payload = {
      ok: true,
      source: '대한민국 법원 경매정보',
      scope: '서울 5개 지방법원, 조회일 기준 향후 2주 매각기일',
      generatedAt: kstIso(),
      activeCount: items.filter(item => item.status !== '종료').length,
      totalCount: items.length,
      courtStats,
      items
    };
    if (previous) await atomicWrite(PREVIOUS, previous);
    await atomicWrite(OUTPUT, payload);
    await fs.rm(DIAGNOSTIC, { force: true });
    console.log(JSON.stringify({ ok: true, activeCount: payload.activeCount, courtStats }, null, 2));
  } catch (error) {
    // 이동 중인 페이지에서는 page.content() 자체가 실패할 수 있다.
    // 진단 파일 저장 실패가 실제 수집 오류를 가리지 않도록 별도로 보호한다.
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
      const html = await page.content();
      await fs.writeFile(DIAGNOSTIC, html, 'utf8');
    } catch (diagnosticError) {
      console.warn(`진단 화면 저장 실패: ${diagnosticError?.message || diagnosticError}`);
    }
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
