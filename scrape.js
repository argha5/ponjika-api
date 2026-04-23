const https = require('https');
const http = require('http');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
  'Connection': 'keep-alive',
};

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        resolve(buffer.toString('utf-8'));
      });
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

async function scrapeHome(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  
  let contentSpan = $('#ctl00_ContentPlaceHolder1_mLBL');
  if (contentSpan.length === 0) return null;
  const pageTitle = cleanText($('#latest-post h1').first().text());
  const pageSubtitle = cleanText($('#latest-post h2').first().text());
  const siteTitle = cleanText($('#logo h1').first().text());
  const siteSubtitle = cleanText($('#logo p').first().text());
  const topMenuItems = $('#menu li a').map((_, el) => cleanText($(el).text())).get().filter(Boolean);
  const sideMenuItems = $('#rightmenue li a').map((_, el) => cleanText($(el).text())).get().filter(Boolean);
  const footerText = cleanText($('#footer #legal').text());
  const monthlyLabel = cleanText($('#ctl00_ContentPlaceHolder1_LblShubha').text());
  const monthlyTitle = monthlyLabel
    ? `${monthlyLabel} মাসের শুভ দিনের নির্ঘন্ট:`
    : cleanText($('#latest-post strong').last().text());
  const monthlyTableData = extractTableRows($, $('#ctl00_ContentPlaceHolder1_GridView1').first());

  // 1. Extract the bottom home table before removing tables.
  const homeTableData = extractTableRows($, contentSpan.find('table').first());

  // 2. Extract grahosphut table data before removing tables
  let grahosphutLines = [];
  contentSpan.find('table').each((i, table) => {
    $(table).find('tr').each((j, row) => {
      const cells = [];
      $(row).find('td').each((k, cell) => {
        cells.push($(cell).text().replace(/\s+/g, ' ').trim());
      });
      if (cells.length >= 2) {
        const planet = cells[0];
        if (/\u09b0\u09ac\u09bf|\u099a\u09a8\u09cd\u09a6\u09cd\u09b0|\u09ae\u0999\u09cd\u0997\u09b2|\u09ac\u09c1\u09a7|\u09ac\u09c3\u09b9\u09b8\u09cd\u09aa\u09a4\u09bf|\u09b6\u09c1\u0995\u09cd\u09b0|\u09b6\u09a8\u09bf|\u09b0\u09be\u09b9\u09c1|\u0995\u09c7\u09a4\u09c1/.test(planet)) {
          grahosphutLines.push(cells.join(': '));
        }
      }
    });
  });

  // 3. Remove tables and parse text
  contentSpan.find('table').remove();
  
  let innerHtml = contentSpan.html() || '';
  innerHtml = innerHtml.replace(/<br\s*\/?>/gi, '\n');
  innerHtml = innerHtml.replace(/<\/p>/gi, '\n');
  innerHtml = innerHtml.replace(/<p[^>]*>/gi, '\n');
  const temp$ = cheerio.load(innerHtml);
  
  let lines = temp$.text().split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line.length > 2);

  // 4. Parse fields
  let dateInfo = '';
  let sunInfo = '';
  let moonInfo = '';
  let tithi = '';
  let nakshatra = '';
  let karana = '';
  let yoga = '';
  let auspiciousTimes = '';
  let inauspiciousTimes = '';
  let lagna = '';
  let eventLines = [];
  let inGrahosphutSection = false;
  let grahosphutFromText = [];
  let sunMoonFound = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Date
    if (line.includes('\u0986\u099c:') || (dateInfo === '' && line.includes('\u09ac\u0999\u09cd\u0997\u09be\u09ac\u09cd\u09a6') && line.includes('\u0987\u0982\u09b0\u09c7\u099c\u09c0'))) {
      dateInfo = line; continue;
    }
    // Sun
    if (isSunLine(line)) { sunInfo = line; sunMoonFound = true; continue; }
    // Moon
    if (isMoonLine(line)) { moonInfo = line; sunMoonFound = true; continue; }

    if (line.includes('\u09a4\u09bf\u09a5\u09bf:')) { tithi = line; continue; }
    if (line.includes('\u09a8\u0995\u09cd\u09b7\u09a4\u09cd\u09b0:')) { nakshatra = line; continue; }
    if (line.includes('\u0995\u09b0\u09a3:')) { karana = line; continue; }
    if (line.includes('\u09af\u09cb\u0997:') && !line.includes('\u0985\u09ae\u09c3\u09a4\u09af\u09cb\u0997') && !line.includes('\u09ae\u09b9\u09c7\u09a8\u09cd\u09a6\u09cd\u09b0\u09af\u09cb\u0997')) {
      yoga = line; continue;
    }
    if (line.includes('\u0985\u09ae\u09c3\u09a4\u09af\u09cb\u0997:') || line.includes('\u09ae\u09b9\u09c7\u09a8\u09cd\u09a6\u09cd\u09b0\u09af\u09cb\u0997:')) {
      auspiciousTimes += (auspiciousTimes ? '\n' : '') + line; continue;
    }
    if (line.includes('\u0995\u09c1\u09b2\u09bf\u0995\u09ac\u09c7\u09b2\u09be:') || line.includes('\u0995\u09c1\u09b2\u09bf\u0995\u09b0\u09be\u09a4\u09cd\u09b0\u09bf:') || line.includes('\u0995\u09be\u09b2\u09ac\u09c7\u09b2\u09be') || line.includes('\u09ac\u09be\u09b0\u09ac\u09c7\u09b2\u09be') || line.includes('\u0995\u09be\u09b2\u09b0\u09be\u09a4\u09cd\u09b0\u09bf')) {
      inauspiciousTimes += (inauspiciousTimes ? '\n' : '') + line; continue;
    }
    if (line.startsWith('\u09b2\u0997\u09cd\u09a8:') || (lagna === '' && line.includes('\u09b0\u09be\u09b6\u09bf') && line.includes('\u09aa\u09b0\u09cd\u09af\u09a8\u09cd\u09a4') && line.includes('\u09ae\u09c7\u09b7'))) {
      lagna = line; continue;
    }
    if (line.includes('\u0997\u09cd\u09b0\u09b9\u09b8\u09cd\u09ab\u09c1\u099f')) { inGrahosphutSection = true; continue; }
    if (inGrahosphutSection && /^(\u09b0\u09ac\u09bf|\u099a\u09a8\u09cd\u09a6\u09cd\u09b0|\u09ae\u0999\u09cd\u0997\u09b2|\u09ac\u09c1\u09a7|\u09ac\u09c3\u09b9\u09b8\u09cd\u09aa\u09a4\u09bf|\u09b6\u09c1\u0995\u09cd\u09b0|\u09b6\u09a8\u09bf|\u09b0\u09be\u09b9\u09c1|\u0995\u09c7\u09a4\u09c1):/.test(line)) {
      grahosphutFromText.push(line); continue;
    }

    // Special events appear before sun/moon info is found
    if (
      !sunMoonFound && dateInfo !== '' && line !== dateInfo &&
      line.length > 3 && !line.includes('\u00a9') &&
      !line.includes('\u0997\u09cd\u09b0\u09b9\u09b8\u09cd\u09ab\u09c1\u099f') &&
      !line.includes('\u09a8\u09bf\u09b0\u09cd\u0998\u09a8\u09cd\u099f') &&
      !line.includes('\u09ae\u09be\u09b8\u09c7\u09b0 \u09b6\u09c1\u09ad') &&
      !/^(\u09b0\u09ac\u09bf|\u099a\u09a8\u09cd\u09a6\u09cd\u09b0|\u09ae\u0999\u09cd\u0997\u09b2|\u09ac\u09c1\u09a7|\u09ac\u09c3\u09b9\u09b8\u09cd\u09aa\u09a4\u09bf|\u09b6\u09c1\u0995\u09cd\u09b0|\u09b6\u09a8\u09bf|\u09b0\u09be\u09b9\u09c1|\u0995\u09c7\u09a4\u09c1):/.test(line)
    ) {
      eventLines.push(line);
    }
  }

  // 5. Fallback: if sunInfo/moonInfo still not found, scan all lines with a relaxed match
  if (!sunInfo) {
    for (const line of lines) {
      if (isSunLine(line)) { sunInfo = line; break; }
    }
  }
  if (!moonInfo) {
    for (const line of lines) {
      if (isMoonLine(line)) { moonInfo = line; break; }
    }
  }

  // 6. Clean eventLines: remove sun/moon lines and noise
  const cleanEventLines = eventLines.filter(line => {
    if (isSunLine(line) || isMoonLine(line)) return false;
    if (line.includes('\u09ac\u0999\u09cd\u0997\u09be\u09ac\u09cd\u09a6') || line.includes('\u0987\u0982\u09b0\u09c7\u099c\u09c0')) return false;
    if (line.includes('\u09ae\u09be\u09b8\u09c7\u09b0') || line.includes('\u09a8\u09bf\u09b0\u09cd\u0998\u09a8\u09cd\u099f')) return false;
    return line.length > 5;
  });

  // Prefer text-parsed grahosphut, fall back to table-parsed
  const finalGrahosphut = grahosphutFromText.length > 0 ? grahosphutFromText : grahosphutLines;

  return {
    siteTitle,
    siteSubtitle,
    topMenuItems,
    sideMenuItems,
    pageTitle,
    pageSubtitle,
    dateInfo,
    events: cleanEventLines.join('\n'),
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
    inauspiciousTimes,
    lagna,
    grahosphut: finalGrahosphut.join('\n'),
    footerText,
  };
}

async function scrapeSandhya(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  let title = '';
  let contentSpan = $('#ctl00_ContentPlaceHolder1_mLBLm');
  if (contentSpan.length === 0) contentSpan = $('#ctl00_ContentPlaceHolder1_mLBL');

  if (contentSpan.length > 0) {
    let bTags = [];
    contentSpan.find('b').slice(0, 3).each((i, el) => {
      let t = $(el).text().trim();
      if (t) bTags.push(t);
    });
    title = bTags.join(' | ');
  }

  let tableData = [];
  let table = contentSpan.find('table').first();
  if (table.length > 0) {
    table.find('tr').each((i, row) => {
      let rowData = [];
      $(row).find('td, th').each((j, cell) => {
        let t = $(cell).text().trim();
        if (t) rowData.push(t);
      });
      if (rowData.length > 0) tableData.push(rowData);
    });
  }

  if (tableData.length === 0) {
    $('table').each((i, t) => {
      let rows = $(t).find('tr');
      if (rows.length > 3) {
        rows.each((j, row) => {
          let rowData = [];
          $(row).find('td, th').each((k, cell) => {
            let t = $(cell).text().trim();
            if (t) rowData.push(t);
          });
          if (rowData.length > 0) tableData.push(rowData);
        });
        return false;
      }
    });
  }

  return { title, tableData };
}

async function scrapeMasik(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  let title = '\u09ae\u09be\u09b8\u09bf\u0995 \u09aa\u099e\u09cd\u099c\u09bf\u0995\u09be';
  let contentSpan = $('#ctl00_ContentPlaceHolder1_mLBLm');
  if (contentSpan.length === 0) contentSpan = $('#ctl00_ContentPlaceHolder1_mLBL');

  if (contentSpan.length > 0) {
    let bTags = [];
    contentSpan.find('b').slice(0, 3).each((i, el) => {
      let t = $(el).text().trim();
      if (t) bTags.push(t);
    });
    if (bTags.length > 0) title = bTags.join(' | ');
  }

  let specialDates = [];
  if (contentSpan.length > 0) {
    let innerHtml = contentSpan.html();
    innerHtml = innerHtml.replace(/<br\s*\/?>|<\/br>|<p>|<\/p>/gi, '\n');
    let temp$ = cheerio.load(innerHtml);
    let lines = temp$.text().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let captureDates = false;
    for (let line of lines) {
      if (line.includes('\u09ac\u09bf\u09b6\u09c7\u09b7 \u09a6\u09bf\u09a8\u09b8\u09ae\u09c2\u09b9')) captureDates = true;
      else if (line.includes('\u09b6\u09c1\u09ad \u09a6\u09bf\u09a8\u09c7\u09b0 \u09a8\u09bf\u09b0\u09cd\u0998\u09a8\u09cd\u099f')) captureDates = false;
      else if (captureDates && line.startsWith('*')) specialDates.push(line);
    }
  }

  let shubhaDinerNirghanta = [];
  $('table').each((i, table) => {
    let htmlContent = $(table).parent().html() || '';
    if (htmlContent.includes('\u09b6\u09c1\u09ad \u09a6\u09bf\u09a8\u09c7\u09b0 \u09a8\u09bf\u09b0\u09cd\u0998\u09a8\u09cd\u099f') || htmlContent.includes('\u09b6\u09c1\u09ad \u09ac\u09bf\u09ac\u09be\u09b9') || htmlContent.includes('\u0985\u09a4\u09bf\u09b0\u09bf\u0995\u09cd\u09a4 \u09ac\u09bf\u09ac\u09be\u09b9')) {
      $(table).find('tr').each((j, row) => {
        let rowData = [];
        $(row).find('td, th').each((k, cell) => {
          let t = $(cell).text().trim();
          if (t) rowData.push(t);
        });
        if (rowData.length > 0) shubhaDinerNirghanta.push(rowData);
      });
      return false;
    }
  });

  return { title, specialDates, shubhaDinerNirghanta };
}

async function scrapeBatsorik(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  let title = '\u09ac\u09be\u09ce\u09b8\u09b0\u09bf\u0995 \u09aa\u099e\u09cd\u099c\u09bf\u0995\u09be';
  let contentSpan = $('#ctl00_ContentPlaceHolder1_mLBLm');
  if (contentSpan.length === 0) contentSpan = $('#ctl00_ContentPlaceHolder1_mLBL');

  let specialDates = [];
  if (contentSpan.length > 0) {
    let innerHtml = contentSpan.html();
    innerHtml = innerHtml.replace(/<br\s*\/?>|<\/br>|<p>|<\/p>/gi, '\n');
    let temp$ = cheerio.load(innerHtml);
    let lines = temp$.text().split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (let line of lines) {
      if (line.startsWith('*')) specialDates.push(line);
    }
  }

  let shubhaDinerNirghanta = [];
  $('table').each((i, table) => {
    let htmlContent = $(table).parent().html() || '';
    if (htmlContent.includes('\u09b6\u09c1\u09ad \u09a6\u09bf\u09a8\u09c7\u09b0 \u09a8\u09bf\u09b0\u09cd\u0998\u09a8\u09cd\u099f') || htmlContent.includes('\u09b6\u09c1\u09ad \u09ac\u09bf\u09ac\u09be\u09b9') || htmlContent.includes('\u0995\u09cd\u09b0\u09af\u09bc \u09ac\u09be\u09a8\u09bf\u099c\u09cd\u09af')) {
      $(table).find('tr').each((j, row) => {
        let rowData = [];
        $(row).find('td, th').each((k, cell) => {
          let t = $(cell).text().trim();
          if (t) rowData.push(t);
        });
        if (rowData.length > 0) shubhaDinerNirghanta.push(rowData);
      });
      return false;
    }
  });

  return { title, specialDates, shubhaDinerNirghanta };
}

async function scrapeAll() {
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }

  const tasks = [
    { file: 'kolkata_home.json',     fn: () => scrapeHome('https://www.ponjika.com/') },
    { file: 'kolkata_sandhya.json',  fn: () => scrapeSandhya('https://www.ponjika.com/Sandhya.aspx') },
    { file: 'kolkata_masik.json',    fn: () => scrapeMasik('https://www.ponjika.com/eMaha.aspx') },
    { file: 'kolkata_batsorik.json', fn: () => scrapeBatsorik('https://www.ponjika.com/eBosor.aspx') },
    { file: 'bd_home.json',          fn: () => scrapeHome('http://bd.ponjika.com/') },
    { file: 'bd_sandhya.json',       fn: () => scrapeSandhya('http://bd.ponjika.com/Sandhya.aspx') },
    { file: 'bd_masik.json',         fn: () => scrapeMasik('http://bd.ponjika.com/eMaha.aspx') },
    { file: 'bd_batsorik.json',      fn: () => scrapeBatsorik('http://bd.ponjika.com/eBosor.aspx') },
  ];

  let successCount = 0;
  for (const task of tasks) {
    try {
      console.log(`Fetching: ${task.file} ...`);
      const result = await task.fn();
      if (result) {
        fs.writeFileSync(path.join(dataDir, task.file), JSON.stringify(result, null, 2), 'utf8');
        console.log(`  Saved: ${task.file}`);
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

module.exports = { scrapeHome, scrapeSandhya, scrapeMasik, scrapeBatsorik };
