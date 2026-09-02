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

function fieldValue(fields, patterns) {
  const hit = fields.find(field => patterns.some(pattern => pattern.test(field.label)));
  return hit?.value || '';
}

function parseRow(court, cells, headers = []) {
  const text = cells.map(clean);
  const joined = text.join(' | ');
  const caseNumber = joined.match(/\b(\d{4})\s*타경\s*(\d+)\b/);
  if (!caseNumber) return null;

  const dates = joined.match(/20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}/g) || [];
  const fields = text.map((value, index) => ({
    label: clean(headers[index]) || `항목 ${index + 1}`,
    value
  })).filter(field => field.value);
  const appraisalText = fieldValue(fields, [/감정/, /평가/]);
  const minimumText = fieldValue(fields, [/최저/, /매각가격/, /입찰가격/]);
  const moneyMatches = [...joined.matchAll(/(?:금\s*)?([0-9][0-9,]{3,})\s*원?/g)]
    .map(match => parseMoney(match[1])).filter(Boolean);
  const failCount = joined.match(/유찰\s*[:：()\-]?\s*(\d+)\s*회?/);
  const itemNo = joined.match(/물건번호\s*(\d+)/);
  const address = text.find(v => /(서울특별시|서울시)\s/.test(v)) || '';
  const useType = text.find(v => /(아파트|다세대|연립|단독주택|다가구|오피스텔|상가|근린|토지|대지|임야|전|답)/.test(v)) || '';

  return {
    id: `${court}-${caseNumber[1]}타경${caseNumber[2]}-${itemNo?.[1] || '1'}`,
    court,
    caseNumber: `${caseNumber[1]}타경${caseNumber[2]}`,
    itemNumber: itemNo?.[1] || '1',
    address,
    useType,
    appraisalPrice: parseMoney(appraisalText) || '',
    minimumPrice: parseMoney(minimumText) || moneyMatches.at(-1) || '',
    saleDate: dates[0] || '',
    failCount: failCount ? Number(failCount[1]) : null,
    fields,
    raw: text,
    sourceUrl: SOURCE_URL
  };
}

async function extractVisibleItems(page, court) {
  const tables = await page.locator('table').evaluateAll(elements => elements.flatMap(table => {
    const headerRows = Array.from(table.querySelectorAll('tr')).filter(row => row.querySelector('th'));
    const headers = headerRows.length
      ? Array.from(headerRows.at(-1).querySelectorAll('th,td')).map(cell => (cell.innerText || '').replace(/\s+/g, ' ').trim())
      : [];
    return Array.from(table.querySelectorAll('tr')).map(row => ({
      headers,
      cells: Array.from(row.querySelectorAll('td')).map(cell => (cell.innerText || '').replace(/\s+/g, ' ').trim())
    }));
  }));
  return tables.map(row => parseRow(court, row.cells, row.headers)).filter(Boolean);
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
    await fs.writeFile(DIAGNOSTIC, await page.content(), 'utf8').catch(() => {});
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

await main();
