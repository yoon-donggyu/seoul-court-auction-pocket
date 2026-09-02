import fs from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = path.resolve('data');
const OUTPUT = path.join(DATA_DIR, 'court-auctions.json');

const digits = value => String(value ?? '').replace(/[^0-9]/g, '');

function exactFromRaw(item) {
  for (const value of item.raw || []) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    const match = text.match(/(\d{1,3}(?:,\d{3})+)\s*\((\d+(?:\.\d+)?)%\)/);
    if (match) {
      return {
        minimumPrice: match[1].replace(/,/g, ''),
        discountRate: match[2]
      };
    }
  }
  return null;
}

function stripAppendedDiscount(item) {
  const minimum = digits(item.minimumPrice);
  const discountDigits = digits(item.discountRate);
  if (!minimum || !discountDigits || !minimum.endsWith(discountDigits)) return null;

  const candidate = minimum.slice(0, -discountDigits.length);
  const appraisal = Number(digits(item.appraisalPrice));
  const price = Number(candidate);
  if (!candidate || price < 10000) return null;
  if (appraisal > 0 && price > appraisal) return null;

  return { minimumPrice: candidate, discountRate: String(item.discountRate ?? '') };
}

function repair(item) {
  const exact = exactFromRaw(item);
  const fallback = exact || stripAppendedDiscount(item);
  if (!fallback) return { item, changed: false };

  const before = String(item.minimumPrice ?? '');
  const next = {
    ...item,
    minimumPrice: fallback.minimumPrice,
    discountRate: fallback.discountRate || item.discountRate
  };
  next.fields = (item.fields || []).map(field => {
    if (field.label === '최저매각가격') return { ...field, value: next.minimumPrice };
    if (field.label === '감정가 대비') return { ...field, value: next.discountRate ? `${next.discountRate}%` : field.value };
    return field;
  });

  return { item: next, changed: before !== String(next.minimumPrice ?? '') };
}

const payload = JSON.parse(await fs.readFile(OUTPUT, 'utf8'));
let changedCount = 0;
payload.items = (payload.items || []).map(item => {
  const repaired = repair(item);
  if (repaired.changed) changedCount += 1;
  return repaired.item;
});

await fs.writeFile(OUTPUT, JSON.stringify(payload, null, 2) + '\n', 'utf8');
console.log(JSON.stringify({ ok: true, normalizedMinimumPrices: changedCount }));
