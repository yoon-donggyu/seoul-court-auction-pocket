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

function columnNumber(cell) {
  return Number(cell.className.match(/columnstyle_(\d+)_/)?.[1] ?? -1);
}

function columnValues(rows, number) {
  return rows.flatMap(row => row.cells)
    .filter(cell => columnNumber(cell) === number)
    .map(cell => clean(cell.text))
    .filter(Boolean);
}

function parseRows(court, rows) {
  const caseText = columnValues(rows, 1)[0] || '';
  const caseNumbers = [...caseText.matchAll(/(\d{4})\s*타경\s*(\d+)/g)]
    .map(match => `${match[1]}타경${match[2]}`)
    .filter((value, index, values) => values.indexOf(value) === index);
  if (!caseNumbers.length) return null;

  const isDuplicate = /중복/.test(caseText);
  const caseNumber = caseNumbers.join(' / ') + (isDuplicate ? ' (중복)' : '');
  const itemNumber = columnValues(rows, 2)[0]?.match(/^\d{1,4}$/)?.[0] || '1';
  const addressParts = columnValues(rows, 3);
  const address = addressParts.join(' · ');
  const remarks = columnValues(rows, 5).join(' · ');
  const appraisalPrice = parseMoney(columnValues(rows, 6)[0] || '');
  const scheduleText = columnValues(rows, 7)[0] || '';
  const saleDate = scheduleText.match(/20\d{2}[.\-/]\d{1,2}[.\-/]\d{1,2}/)?.[0] || '';
  const department = clean(scheduleText.replace(saleDate, ''));
  const useType = columnValues(rows, 8).join(' · ');
  const minimumText = columnValues(rows, 9)[0] || '';
  const minimumPrice = parseMoney(minimumText);
  const discountRate = minimumText.match(/\((\d+(?:\.\d+)?)%\)/)?.[1] || '';
  const saleStatus = columnValues(rows, 10)[0] || '';
  const failed = saleStatus.match(/유찰\s*[:：()\-]?\s*(\d+)\s*회?/);
  const failCount = failed ? Number(failed[1]) : (/신건/.test(saleStatus) ? 0 : null);
  const raw = rows.flatMap(row => row.cells.map(cell => clean(cell.text))).filter(Boolean);
  const fields = [
    ['법원', court], ['사건번호', caseNumber],
    ['물건번호', itemNumber], ['용도', useType],
    ['소재지 · 물건내역', address], ['비고', remarks], ['감정평가액', appraisalPrice],
    ['최저매각가격', minimumPrice], ['감정가 대비', discountRate ? `${discountRate}%` : ''],
    ['담당계', department], ['매각기일', saleDate], ['진행상태', saleStatus],
    ['유찰 횟수', failCount == null ? '' : `${failCount}회`]
  ].filter(([, value]) => value).map(([label, value]) => ({ label, value }));

  return {
    id: `${court}-${caseNumbers.join('-')}-${itemNumber}`,
    court,
    caseNumber,
    caseNumbers,
    itemNumber,
    address,
    useType,
    appraisalPrice,
    minimumPrice,
    discountRate,
    department,
    saleStatus,
    saleDate,
    failCount,
    remarks,
    fields,
    raw,
    sourceUrl: SOURCE_URL
  };
}

async function extractVisibleItems(page, court) {
  const physicalRows = await page.locator('tr').evaluateAll(rows => rows.map(row => ({
    cells: Array.from(row.children)
      .filter(cell => cell.tagName === 'TD')
      .map(cell => ({
        className: cell.className || '',
        text: (cell.innerText || '').replace(/\s+/g, ' ').trim()
      }))
  })).filter(row => row.cells.length));
  const logicalRows = [];
  let current = null;
  for (const row of physicalRows) {
    const caseCell = row.cells.find(cell => columnNumber(cell) === 1);
    const hasCase = /\d{4}\s*타경\s*\d+/.test(caseCell?.text || '');
    if (hasCase) {
      if (current) logicalRows.push(current);
      current = [row];
    } else if (current && row.cells.some(cell => cell.text)) {
      current.push(row);
    }
  }
  if (current) logicalRows.push(current);
  return logicalRows.map(rows => parseRows(court, rows)).filter(Boolean);
}

async function goToNextResultPage(page, currentPage) {
  const nextNumber = page.getByRole('button', { name: String(currentPage + 1), exact: true });
  if (await nextNumber.count() && await nextNumber.first().isVisible() && await nextNumber.first().isEnabled()) {
    await nextNumber.first().click({ timeout: 30000 });
    await randomDelay();
    return true;
  }

  const nextGroup = page.getByRole('button', { name: '다음 목록', exact: true });
  if (await nextGroup.count() && await nextGroup.first().isVisible() && await nextGroup.first().isEnabled()) {
    await nextGroup.first().click({ timeout: 30000 });
    await randomDelay();
    return true;
  }
  return false;
}

async function openSourcePage(page) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (page.isClosed()) throw new Error('브라우저 페이지가 닫혔습니다.');
      // WebSquare가 내부 이동을 반복해 goto가 시간 초과되어도 실제 검색 화면은
      // 이미 열린 경우가 있다. goto 오류보다 검색 입력 화면 표시 여부를 우선한다.
      let navigationError;
      await page.goto(SOURCE_URL, { waitUntil: 'commit', timeout: 45000 })
        .catch(error => { navigationError = error; });
      await page.getByLabel('법원 선택').waitFor({ state: 'visible', timeout: 60000 });
      if (navigationError) console.warn('페이지 이동 완료 응답은 지연됐지만 검색 화면을 확인해 계속 진행합니다.');
      return;
    } catch (error) {
      lastError = error;
      console.warn(`법원 사이트 접속 ${attempt}/3 실패: ${error?.message || error}`);
      await page.waitForTimeout(10000 * attempt);
      await page.evaluate(() => window.stop()).catch(() => {});
    }
  }
  throw new Error(`법원 사이트 접속에 3회 실패했습니다: ${lastError?.message || lastError}`);
}

async function crawlCourt(page, court) {
  await openSourcePage(page);
  await page.getByLabel('법원 선택').selectOption({ label: court });
  await randomDelay();
  await page.locator('input[title="부동산 물건상세 검색 버튼"]').click({ timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await randomDelay();

  // 페이지당 40건으로 늘리고 1, 2, 3… 순서대로 이동해 중간 페이지가 빠지지 않게 한다.
  const pageSize = page.locator('select[title="페이지당 수 선택"]');
  if (await pageSize.count()) {
    await pageSize.selectOption({ label: '40' });
    await randomDelay();
  }

  const items = [];
  const seenPageSignatures = new Set();
  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo += 1) {
    const current = await extractVisibleItems(page, court);
    const signature = current.map(itemKey).join(',');
    if (!signature || seenPageSignatures.has(signature)) break;
    seenPageSignatures.add(signature);
    items.push(...current);

    if (!await goToNextResultPage(page, pageNo)) break;
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
