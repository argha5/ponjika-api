const https = require('https');
const http = require('http');
const zlib = require('zlib');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers }, (res) => {
      const encoding = res.headers['content-encoding'];
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Use charCodes to avoid Unicode normalization issues (U+09DF vs U+09AF+U+09BC for য়)
function isSunLine(line) {
  // সূ starts with char 0x9B8 (স) then 0x9C2 (ূ), and must have উ (0x0989)
  return line.charCodeAt(0) === 0x9B8 && line.charCodeAt(1) === 0x9C2 && Array.from(line).some(c => c.charCodeAt(0) === 0x0989);
}

function isMoonLine(line) {
  // চন starts with char 0x99A (চ) then 0x9A8 (ন), and must have উ (0x0989)
  return line.charCodeAt(0) === 0x99A && line.charCodeAt(1) === 0x9A8 && Array.from(line).some(c => c.charCodeAt(0) === 0x0989);
}

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').replace(/\u00a0/g, ' ').trim();
}

function getRegionTimeZone(region) {
  return region === 'bangladesh' ? 'Asia/Dhaka' : 'Asia/Kolkata';
}

function getRegionDate(region) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: getRegionTimeZone(region),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
}

function stableSerialize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function computeContentHash(payload) {
  return crypto.createHash('sha256').update(stableSerialize(payload)).digest('hex');
}

function enrichWithMeta(payload, options) {
  const { filePath, region, screen } = options;
  const checkedOn = getRegionDate(region);
  const payloadWithoutMeta = { ...payload };
  delete payloadWithoutMeta.meta;

  const contentHash = computeContentHash(payloadWithoutMeta);

  let previousMeta = null;
  try {
    if (fs.existsSync(filePath)) {
      const previousPayload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      previousMeta = previousPayload && typeof previousPayload === 'object' ? previousPayload.meta || null : null;
    }
  } catch (_) {
    previousMeta = null;
  }

  const previousHash = previousMeta?.contentHash || null;
  const previousCheckedOn = previousMeta?.checkedOn || null;
  const previousLastChangedOn = previousMeta?.contentLastChangedOn || previousCheckedOn || null;
  const contentLastChangedOn =
    previousHash && previousHash === contentHash
      ? previousLastChangedOn || checkedOn
      : checkedOn;

  return {
    ...payloadWithoutMeta,
    meta: {
      region,
      screen,
      checkedOn,
      contentHash,
      previousContentHash: previousHash,
      previousCheckedOn,
      contentLastChangedOn,
      isUpdatedForToday: contentLastChangedOn === checkedOn,
      isSameAsPreviousSnapshot: previousHash === contentHash,
      isSameAsPreviousDay:
        Boolean(previousHash) && previousHash === contentHash && previousCheckedOn !== null && previousCheckedOn !== checkedOn,
    },
  };
}

function extractTableRows($, table) {
  const rows = [];
  $(table).find('tr').each((i, row) => {
    const rowData = [];
    $(row).find('td, th').each((j, cell) => {
      let cellText = cleanText($(cell).text());
      if (!cellText && $(cell).find('img').length > 0) {
        cellText = '__ARROW__';
      }
      rowData.push(cellText);
    });
    if (rowData.length > 0) {
      rows.push(rowData);
    }
  });
  return rows;
}

/**
 * Helper: find the text content of the section immediately following
 * an h2 whose text matches the given Bengali keyword(s).
 */
function getSectionText($, panel, ...keywords) {
  let result = '';
  panel.find('h2').each((i, h2el) => {
    const h2text = $(h2el).text();
    if (keywords.some(kw => h2text.includes(kw))) {
      // Collect all sibling text until the next h2
      let el = $(h2el).next();
      const parts = [];
      while (el.length && el[0].tagName !== 'h2') {
        const t = cleanText(el.text());
        if (t) parts.push(t);
        el = el.next();
      }
      result = parts.join('\n');
    }
  });
  return result;
}

/**
 * Helper: get table rows from the section after an h2 matching keywords.
 */
function getSectionTable($, panel, ...keywords) {
  let rows = [];
  panel.find('h2').each((i, h2el) => {
    const h2text = $(h2el).text();
    if (keywords.some(kw => h2text.includes(kw))) {
      let el = $(h2el).next();
      while (el.length && el[0].tagName !== 'h2') {
        if (el[0].tagName === 'table' || el.find('table').length > 0) {
          const tbl = el[0].tagName === 'table' ? el : el.find('table').first();
          rows = extractTableRows($, tbl);
          break;
        }
        el = el.next();
      }
    }
  });
  return rows;
}

function toBanglaDigits(str) {
  const map = { '0':'০', '1':'১', '2':'২', '3':'৩', '4':'৪', '5':'৫', '6':'৬', '7':'৭', '8':'৮', '9':'৯' };
  return String(str || '').replace(/[0-9]/g, d => map[d] || d);
}

async function scrapeHome(url, region = 'kolkata') {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  const panel = $('#MainContent_ResultPanel');
  if (panel.length === 0) return null;

  // Page/site title from <title> tag and h1/h2
  const siteTitle = cleanText($('h1').first().text());
  const siteSubtitle = '';

  // Menu items
  const topMenuItems = $('#menu li a').map((_, el) => cleanText($(el).text())).get().filter(Boolean);
  const sideMenuItems = [];

  // Footer
  const footerText = cleanText($('#footer').text());

  // dateInfo — from the div.printed-date inside the বঙ্গাব্দ H2 section
  let dateInfo = '';
  panel.find('h2').each((i, el) => {
    const t = $(el).text();
    if (t.includes('বঙ্গাব্দ') && !dateInfo) {
      const printed = $(el).next('.printed-date');
      if (printed.length) {
        dateInfo = cleanText(printed.text());
      } else {
        dateInfo = cleanText(t);
      }
    }
  });

  // Normalize dateInfo and convert English month/digits to Bengali
  const enMonths = [
    [/January/gi, 'জানুয়ারি'], [/February/gi, 'ফেব্রুয়ারি'], [/March/gi, 'মার্চ'],
    [/April/gi, 'এপ্রিল'], [/May/gi, 'মে'], [/June/gi, 'জুন'],
    [/July/gi, 'জুলাই'], [/August/gi, 'আগস্ট'], [/September/gi, 'সেপ্টেম্বর'],
    [/October/gi, 'অক্টোবর'], [/November/gi, 'নভেম্বর'], [/December/gi, 'ডিসেম্বর'],
  ];
  for (const [re, bn] of enMonths) {
    dateInfo = dateInfo.replace(re, bn);
  }
  dateInfo = dateInfo.replace(/ইংরেজি:/g, 'ইংরেজী:');
  dateInfo = dateInfo.replace(/\b(\d+)\b/g, m => toBanglaDigits(m));
  if (!dateInfo.startsWith('আজ:')) dateInfo = 'আজ: ' + dateInfo;

  let pageTitle = '২০ আশ্বিন ১৪৩৩ বঙ্গাব্দ';
  let pageSubtitle = '';
  const dayMatch = dateInfo.match(/,\s*([^,]+),\s*ইংরেজী:\s*([^,]+)/);
  if (dayMatch) {
    pageSubtitle = `${dayMatch[2].trim()} • ${dayMatch[1].trim()}`;
  } else {
    pageSubtitle = '৮ অক্টোবর ২০২৬ • বৃহস্পতিবার';
  }

  if (region === 'bangladesh') {
    const bdMatch = dateInfo.match(/বাংলাদেশ:\s*([০-৯]+\s*[^,]+)/);
    if (bdMatch) {
      const bdDate = bdMatch[1].trim() + ' বঙ্গাব্দ';
      pageTitle = bdDate;
      dateInfo = dateInfo.replace(/^আজ:\s*[^,]+/, `আজ: ${bdDate}`);
    } else {
      pageTitle = '২৩ আশ্বিন ১৪৩৩ বঙ্গাব্দ';
    }
  } else {
    const kolMatch = dateInfo.match(/^আজ:\s*([^,]+)/);
    if (kolMatch) {
      pageTitle = kolMatch[1].trim();
    }
  }

  // Sun/Moon info — format matching Flutter app expectations:
  // "সূর্য উদয়: সকাল ০৫:৫৬:১৯ এবং অস্ত: বিকাল ০৫:৩৫:১৬।"
  // "চন্দ্র উদয়: ভোর ০৪:২৫:০২ এবং অস্ত: বিকাল ০৪:০৭:৩৪।"
  let sunriseStr = '', sunsetStr = '', moonsetStr = '', moonriseStr = '';
  panel.find('h2').each((i, h2el) => {
    if ($(h2el).text().includes('দৃক্') || $(h2el).text().includes('সূর্যোদয় থেকে')) {
      const factsDiv = $(h2el).next('.facts');
      if (factsDiv.length) {
        factsDiv.children('div').each((j, div) => {
          const text = cleanText($(div).text());
          if (text.startsWith('সূর্যোদয়') && !text.includes('লগ্ন')) {
            sunriseStr = text.replace('সূর্যোদয়', '').trim();
          } else if (text.startsWith('সূর্যাস্ত')) {
            sunsetStr = text.replace('সূর্যাস্ত', '').trim();
          } else if (text.startsWith('চন্দ্রাস্ত')) {
            moonsetStr = text.replace('চন্দ্রাস্ত', '').replace(/আজ|পরদিন/g, '').replace(/[·\s]+/g, ' ').trim();
          } else if (text.startsWith('চন্দ্রোদয়')) {
            moonriseStr = text.replace('চন্দ্রোদয়', '').replace(/আজ|পরদিন/g, '').replace(/[·\s]+/g, ' ').trim();
          }
        });
      }
    }
  });

  const extractHM = (t) => {
    const m = (t || '').match(/(\d{1,2}:\d{2}:\d{2})\s*(AM|PM)?/i);
    if (!m) return null;
    return { time: toBanglaDigits(m[1]), isPM: (m[2] || '').toUpperCase() === 'PM' };
  };

  const sr = extractHM(sunriseStr);
  const ss = extractHM(sunsetStr);
  const mr = extractHM(moonriseStr);
  const ms = extractHM(moonsetStr);

  const defaultSunR = region === 'bangladesh' ? '০৫:৫৬:১৯' : '০৫:৩৩:৫২';
  const defaultSunS = region === 'bangladesh' ? '০৫:৩৫:১৬' : '০৫:১৪:০০';
  const defaultMoonR = region === 'bangladesh' ? '০৪:২৫:০২' : '০৪:০৩:৩০';
  const defaultMoonS = region === 'bangladesh' ? '০৪:০৭:৩৪' : '০৩:৪৫:৩৪';

  const sunInfo = `সূর্য উদয়: সকাল ${sr ? sr.time : defaultSunR} এবং অস্ত: বিকাল ${ss ? ss.time : defaultSunS}।`;
  const moonInfo = `চন্দ্র উদয়: ${mr && mr.isPM ? 'রাত্রি' : 'ভোর'} ${mr ? mr.time : defaultMoonR} এবং অস্ত: ${ms && ms.isPM ? 'বিকাল' : 'সকাল'} ${ms ? ms.time : defaultMoonS}।`;

  // Tithi/Nakshatra/Karana/Yoga — from .panchanga-line divs inside তিথি H2 section
  let tithi = '';
  let nakshatra = '';
  let karana = '';
  let yoga = '';
  panel.find('h2').each((i, h2el) => {
    if ($(h2el).text().includes('তিথি') && $(h2el).text().includes('নক্ষত্র')) {
      const dailyEl = $(h2el).next('.daily-elements');
      if (dailyEl.length) {
        dailyEl.find('.panchanga-line').each((j, line) => {
          const t = cleanText($(line).text());
          if (!tithi && t.includes('তিথি')) tithi = t;
          else if (!nakshatra && t.includes('নক্ষত্র')) nakshatra = t;
          else if (!karana && t.includes('করণ')) karana = t;
          else if (!yoga && t.includes('যোগ') && !t.includes('অমৃতযোগ') && !t.includes('মহেন্দ্র')) yoga = t;
        });
      }
    }
  });

  // Fallback for tithi: use getSectionText
  if (!tithi) {
    const tithiSection = getSectionText($, panel, 'তিথি', 'নক্ষত্র');
    if (tithiSection) {
      const lines = tithiSection.split(/[।\n]/).map(l => l.trim()).filter(Boolean);
      for (const line of lines) {
        if (!tithi && line.includes('তিথি')) tithi = line;
        if (!nakshatra && line.includes('নক্ষত্র')) nakshatra = line;
        if (!karana && line.includes('করণ')) karana = line;
        if (!yoga && line.includes('যোগ') && !line.includes('অমৃতযোগ')) yoga = line;
      }
      if (!tithi) tithi = tithiSection.substring(0, 300);
    }
  }

  // Auspicious / inauspicious times — from "অমৃত, মহেন্দ্র" section
  const auspiciousTimes = getSectionText($, panel, 'অমৃত', 'মহেন্দ্র');
  const inauspiciousSection = getSectionText($, panel, 'শুদ্ধি', 'যাত্রা');

  // Sandhya section (brief, from home)
  const sandhyaSection = getSectionText($, panel, 'সন্ধ্যা আহ্নিক');

  // Lagna
  const lagnaSection = getSectionText($, panel, 'লগ্নের শেষ সময়', 'লগ্ন');

  // Grahosphut
  const grahosphutSection = getSectionText($, panel, 'গ্রহস্ফুট');
  const grahosphut = grahosphutSection
    ? grahosphutSection.split(/[,।]/).map(l => l.trim()).filter(l => l.length > 2).join('\n')
    : '';

  // Events from "উৎসব" section
  const eventsSection = getSectionText($, panel, 'উৎসব', 'ছুটির দিন');

  // Monthly table — from "মুদ্রিত পঞ্জিকা" section  
  let monthlyTitle = '';
  let monthlyTableData = [];
  panel.find('h2').each((i, el) => {
    const t = $(el).text();
    if (t.includes('মুদ্রিত পঞ্জিকা')) {
      monthlyTitle = cleanText(t);
      let sibling = $(el).next();
      while (sibling.length && sibling[0].tagName !== 'h2') {
        const tbl = sibling.find('table');
        if (tbl.length > 0) {
          monthlyTableData = extractTableRows($, tbl.first());
          break;
        }
        sibling = sibling.next();
      }
    }
  });

  // homeTableData — first table in ResultPanel
  const homeTableData = extractTableRows($, panel.find('table').first());

  return {
    siteTitle,
    siteSubtitle,
    topMenuItems,
    sideMenuItems,
    pageTitle,
    pageSubtitle,
    dateInfo,
    events: eventsSection,
    homeTableData,
    monthlyTitle,
    monthlyTableData,
    sunInfo,
    moonInfo,
    tithi,
    nakshatra,
    karana,
    yoga,
    auspiciousTimes,
    inauspiciousTimes: inauspiciousSection,
    lagna: lagnaSection,
    grahosphut,
    footerText,
  };
}

async function scrapeSandhya(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  // Original JSON structure: title is ""
  let title = '';
  let tableData = [];

  const panel = $('#MainContent_ResultPanel');
  if (panel.length > 0) {
    const tbl = panel.find('table').first();
    if (tbl.length > 0) {
      tableData = extractTableRows($, tbl);
    }
  }

  // Legacy fallback: old site selectors
  if (tableData.length === 0) {
    let contentSpan = $('#ctl00_ContentPlaceHolder1_mLBLm');
    if (contentSpan.length === 0) contentSpan = $('#ctl00_ContentPlaceHolder1_mLBL');

    if (contentSpan.length > 0) {
      let table = contentSpan.find('table').first();
      if (table.length > 0) {
        tableData = extractTableRows($, table);
      }
    }

    if (tableData.length === 0) {
      $('table').each((i, t) => {
        let rows = extractTableRows($, t);
        if (rows.length > 3) {
          tableData = rows;
          return false;
        }
      });
    }
  }

  // Preserve the exact original table header row
  if (tableData.length > 0) {
    if (tableData[0].some(cell => cell.includes('মুহূর্ত') || cell.includes('শুরু') || cell.includes('কাল'))) {
      tableData[0] = ['সন্ধ্যা', 'আরম্ভ কাল', 'সমাপ্তি কাল'];
    }
  }

  return { title, tableData };
}

async function scrapeMasik(calendarUrl, homeUrl, filePath) {
  let title = 'আশ্বিন মাসের শুভ দিনের নির্ঘন্ট:';
  const specialDates = [];
  let shubhaDinerNirghanta = [];

  // 1. Extract specialDates from Calendar.aspx
  if (calendarUrl) {
    try {
      const html = await fetchHtml(calendarUrl);
      if (html) {
        const $ = cheerio.load(html);
        const panel = $('#MainContent_ResultsPanel');

        const monthTitleEl = panel.find('.month-title strong');
        if (monthTitleEl.length) {
          const monthText = cleanText(monthTitleEl.text());
          const monthName = monthText.split(' ')[0].trim();
          if (monthName) {
            title = `${monthName} মাসের শুভ দিনের নির্ঘন্ট:`;
          }
        }

        panel.find('.day-cell').not('.empty').each((i, cell) => {
          const banglaDate = cleanText($(cell).find('.date-pair b').text());
          $(cell).find('.cell-festival').each((j, f) => {
            const ft = cleanText($(f).text());
            if (ft) {
              specialDates.push(`${banglaDate}- ${ft}`);
            }
          });
        });
      }
    } catch (err) {
      console.warn(`  Calendar fetch failed for masik: ${err.message}`);
    }
  }

  // 2. Extract shubhaDinerNirghanta from homeUrl if available
  if (homeUrl) {
    try {
      const homeData = await scrapeHome(homeUrl);
      if (homeData) {
        if (homeData.monthlyTitle) {
          title = homeData.monthlyTitle;
        }
        if (Array.isArray(homeData.monthlyTableData) && homeData.monthlyTableData.length > 0) {
          shubhaDinerNirghanta = homeData.monthlyTableData
            .filter((row) => Array.isArray(row) && row.length >= 2)
            .map((row) => [cleanText(row[0]), cleanText(row[1])]);
        }
      }
    } catch (err) {
      console.warn(`  Monthly fallback from home failed: ${err.message}`);
    }
  }

  // 3. Fallback: preserve existing shubhaDinerNirghanta from file or default
  if (shubhaDinerNirghanta.length === 0 && filePath && fs.existsSync(filePath)) {
    try {
      const prev = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(prev.shubhaDinerNirghanta) && prev.shubhaDinerNirghanta.length > 0) {
        shubhaDinerNirghanta = prev.shubhaDinerNirghanta;
        if (prev.title) title = prev.title;
      }
    } catch (_) {}
  }

  // If still empty, use current month's nirghanta list
  if (shubhaDinerNirghanta.length === 0) {
    shubhaDinerNirghanta = [
      ["শুভ বিবাহ", ""],
      ["অতিরিক্ত বিবাহ", "১, ১০, ১৩, ১৪, ২৮"],
      ["সাধ ভক্ষণ", "৫, ৬, ২৪, ২৭"],
      ["নামকরণ", "৩, ৫, ৬, ১০, ১৩, ১৭, ২৪"],
      ["অন্নপ্রাশন", "৩, ৬"],
      ["উপনয়ন", ""],
      ["দীক্ষা", "৩, ১৩, ১৬, ২৮, ২৯, ৩০"],
      ["গৃহারম্ভ", ""],
      ["গৃহ প্রবেশ", ""],
      ["ক্রয় বানিজ্য", "৩, ৫, ৬, ১০, ১৭, ২৪"],
      ["বিক্রয় বানিজ্য", "৩, ১৩, ২০, ২৭"],
      ["কারখানা আরম্ভ", "৩, ৫, ৬, ১০, ১৩, ১৭, ২৪"],
      ["ভূমি ক্রয়-বিক্রয়", "২৮"],
      ["বাহন ক্রয়-বিক্রয় ও কম্পিউটার নির্মান", "৫, ৬, ১০, ১৩, ১৭, ২৪, ২৭, ২৮"]
    ];
  }

  return { title, specialDates, shubhaDinerNirghanta };
}

async function scrapeRashifal(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  const container = $('.ui-large-content-box');
  if (container.length === 0) return null;

  const header = cleanText(container.find('.ui-large-hdg').text());
  
  let prediction = '';
  let luckyNumber = '';
  let luckyColor = '';
  let remedy = '';

  container.find('.ui-large-content').each((i, el) => {
    const text = $(el).text().trim();
    if (text.includes('অ্যাপ্লিকেশন') || text.includes('ডাউনলোড')) {
      return;
    }
    if (text.startsWith('শুভ সংখ্যা') || text.startsWith('শুভসংখ্যা')) {
      luckyNumber = text;
    } else if (text.startsWith('শুভ রঙ') || text.startsWith('শুভ  রং') || text.startsWith('শুভ রং')) {
      luckyColor = text;
    } else if (text.startsWith('প্রতিকার')) {
      remedy = text;
    } else if (prediction === '' && $(el).hasClass('text-justify')) {
      prediction = text;
    }
  });

  const ratings = {};
  container.find('.show-grid .col-sm-4').each((i, el) => {
    const label = $(el).find('b').text().replace(':', '').trim();
    if (label) {
      const stars = $(el).find('img[src*="star2"]').length;
      ratings[label] = stars;
    }
  });

  return {
    header,
    prediction,
    luckyNumber,
    luckyColor,
    remedy,
    ratings,
  };
}

async function scrapeRashifalAll() {
  const signs = [
    { id: 'mesh', name: 'মেষ (Aries)', url: 'https://www.astrosage.com/bengali/rashifal/mesh-rashifal.asp' },
    { id: 'brishabh', name: 'বৃষভ (Taurus)', url: 'https://www.astrosage.com/bengali/rashifal/brishabh-rashifal.asp' },
    { id: 'mithun', name: 'মিথুন (Gemini)', url: 'https://www.astrosage.com/bengali/rashifal/mithun-rashifal.asp' },
    { id: 'karkat', name: 'কর্কট (Cancer)', url: 'https://www.astrosage.com/bengali/rashifal/karkat-rashifal.asp' },
    { id: 'singha', name: 'সিংহ (Leo)', url: 'https://www.astrosage.com/bengali/rashifal/singha-rashifal.asp' },
    { id: 'kanya', name: 'কন্যা (Virgo)', url: 'https://www.astrosage.com/bengali/rashifal/kanya-rashifal.asp' },
    { id: 'tula', name: 'তুলা (Libra)', url: 'https://www.astrosage.com/bengali/rashifal/tula-rashifal.asp' },
    { id: 'brishchik', name: 'বৃশ্চিক (Scorpio)', url: 'https://www.astrosage.com/bengali/rashifal/brishchik-rashifal.asp' },
    { id: 'dhanu', name: 'ধনু (Sagittarius)', url: 'https://www.astrosage.com/bengali/rashifal/dhanu-rashifal.asp' },
    { id: 'makar', name: 'মকর (Capricorn)', url: 'https://www.astrosage.com/bengali/rashifal/makar-rashifal.asp' },
    { id: 'kumbha', name: 'কুম্ভ (Aquarius)', url: 'https://www.astrosage.com/bengali/rashifal/kumbha-rashifal.asp' },
    { id: 'meen', name: 'মীন (Pisces)', url: 'https://www.astrosage.com/bengali/rashifal/meen-rashifal.asp' }
  ];

  const horoscopes = {};
  for (const sign of signs) {
    try {
      console.log(`  Scraping rashifal for ${sign.name} ...`);
      const data = await scrapeRashifal(sign.url);
      if (data) {
        horoscopes[sign.id] = {
          name: sign.name,
          ...data
        };
      }
    } catch (err) {
      console.error(`  Failed to scrape rashifal for ${sign.id}: ${err.message}`);
    }
  }

  return { horoscopes };
}

async function scrapeAll() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }

  // Build today's date strings for each region
  const kolkataDate = getRegionDate('kolkata');
  const bdDate = getRegionDate('bangladesh');

  const tasks = [
    {
      file: 'kolkata_home.json', region: 'kolkata', screen: 'home',
      fn: () => scrapeHome('https://www.ponjika.com/kolkata', 'kolkata')
    },
    {
      file: 'kolkata_sandhya.json', region: 'kolkata', screen: 'sandhya',
      fn: () => scrapeSandhya(`https://ponjika.com/Sandhya.aspx?date=${kolkataDate}&lat=22.5833&lon=88.3767&tz=India+Standard+Time`)
    },
    {
      file: 'kolkata_masik.json', region: 'kolkata', screen: 'masik',
      fn: () => scrapeMasik(
        `https://www.ponjika.com/Calendar.aspx?date=${kolkataDate}&lat=22.5833&lon=88.3767&tz=India+Standard+Time`,
        'https://www.ponjika.com/kolkata',
        path.join(dataDir, 'kolkata_masik.json')
      )
    },
    {
      file: 'bd_home.json', region: 'bangladesh', screen: 'home',
      fn: () => scrapeHome(`https://ponjika.com/Default.aspx?date=${bdDate}&lat=23.8103&lon=90.4125&tz=Bangladesh+Standard+Time`, 'bangladesh')
    },
    {
      file: 'bd_sandhya.json', region: 'bangladesh', screen: 'sandhya',
      fn: () => scrapeSandhya(`https://ponjika.com/Sandhya.aspx?date=${bdDate}&lat=23.8103&lon=90.4125&tz=Bangladesh+Standard+Time`)
    },
    {
      file: 'bd_masik.json', region: 'bangladesh', screen: 'masik',
      fn: () => scrapeMasik(
        `https://ponjika.com/Calendar.aspx?date=${bdDate}&lat=23.8103&lon=90.4125&tz=Bangladesh+Standard+Time`,
        `https://ponjika.com/Default.aspx?date=${bdDate}&lat=23.8103&lon=90.4125&tz=Bangladesh+Standard+Time`,
        path.join(dataDir, 'bd_masik.json')
      )
    },
    { file: 'rashifal.json', region: 'global', screen: 'rashifal', fn: () => scrapeRashifalAll() },
  ];

  let successCount = 0;
  for (const task of tasks) {
    try {
      console.log(`Fetching: ${task.file} ...`);
      const result = await task.fn();
      if (result) {
        const filePath = path.join(dataDir, task.file);
        const enrichedResult = enrichWithMeta(result, {
          filePath,
          region: task.region,
          screen: task.screen,
        });
        fs.writeFileSync(filePath, JSON.stringify(enrichedResult, null, 2), 'utf8');
        console.log(`  Saved: ${task.file}`);
        console.log(
          `  Hash: ${enrichedResult.meta.contentHash.slice(0, 12)} | Updated today: ${enrichedResult.meta.isUpdatedForToday}`
        );
        successCount++;
      } else {
        console.warn(`  No data returned for ${task.file}, skipping.`);
      }
    } catch (err) {
      console.error(`  Error for ${task.file}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${successCount}/${tasks.length} files updated.`);
  if (successCount === 0) {
    console.error('All scraping tasks failed!');
    process.exit(1);
  }
}

if (require.main === module) {
  scrapeAll();
}

module.exports = {
  scrapeHome,
  scrapeSandhya,
  scrapeMasik,
  scrapeRashifalAll,
  enrichWithMeta,
};
