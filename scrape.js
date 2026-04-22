const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'bn,en-US;q=0.9,en;q=0.8',
  'Connection': 'keep-alive',
};

async function fetchHtml(url) {
  try {
    const response = await axios.get(url, { headers, responseType: 'arraybuffer' });
    // Decode as utf-8 manually
    return Buffer.from(response.data).toString('utf-8');
  } catch (error) {
    console.error(`Error fetching \${url}:`, error.message);
    return null;
  }
}

async function scrapeHome(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);
  
  let contentSpan = $('#ctl00_ContentPlaceHolder1_mLBL');
  if (contentSpan.length === 0) return null;

  // Remove tables
  contentSpan.find('table').remove();
  
  // Replace br and p tags with newline
  let innerHtml = contentSpan.html();
  innerHtml = innerHtml.replace(/<br\s*\/?>|<\/br>|<p>|<\/p>/gi, '\n');
  const temp$ = cheerio.load(innerHtml);
  
  let lines = temp$.text().split('\n').map(line => line.trim()).filter(line => line.length > 0 && line !== '|');
  
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
  
  for (let line of lines) {
    if (line.includes('আজ:')) {
      dateInfo = line;
      continue;
    }
    if (dateInfo === '' && (line.includes('বঙ্গাব্দ') || line.includes('ইংরেজী'))) {
      dateInfo = line;
      continue;
    }
    if (line.includes('সূর্য উদয়:')) {
      sunInfo = line;
      continue;
    }
    if (line.includes('চন্দ্র উদয়:')) {
      moonInfo = line;
      continue;
    }
    if (line.includes('তিথি:')) tithi = line;
    else if (line.includes('নক্ষত্র:')) nakshatra = line;
    else if (line.includes('করণ:')) karana = line;
    else if (line.includes('যোগ:')) yoga = line;
    else if (line.includes('অমৃতযোগ:') || line.includes('মহেন্দ্রযোগ:')) auspiciousTimes += (auspiciousTimes ? ' ' : '') + line;
    else if (line.includes('কুলিকবেলা:') || line.includes('কালবেলা') || line.includes('বারবেলা') || line.includes('কালরাত্রি')) inauspiciousTimes += (inauspiciousTimes ? ' ' : '') + line;
    else if (line.startsWith('লগ্ন:')) lagna = line;
    else if (line.length > 5 && !line.includes('©') && !line.includes('গ্রহস্ফুট')) {
      eventLines.push(line);
    }
  }

  if (auspiciousTimes.length > 150) {
    auspiciousTimes = auspiciousTimes.split('|').join('\n').trim();
  }
  if (inauspiciousTimes.length > 150) {
    inauspiciousTimes = inauspiciousTimes.split('।').join('\n').trim();
  }

  return {
    dateInfo,
    events: eventLines.slice(0, 5).join('\n'),
    sunInfo,
    moonInfo,
    tithi,
    nakshatra,
    karana,
    yoga,
    auspiciousTimes,
    inauspiciousTimes,
    lagna
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
        return false; // break
      }
    });
  }

  return { title, tableData };
}

async function scrapeMasik(url) {
  const html = await fetchHtml(url);
  if (!html) return null;
  const $ = cheerio.load(html);

  let title = 'মাসিক পঞ্জিকা';
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
      if (line.includes('বিশেষ দিনসমূহ')) captureDates = true;
      else if (line.includes('শুভ দিনের নির্ঘন্ট')) captureDates = false;
      else if (captureDates) {
        if (line.startsWith('*')) specialDates.push(line);
      }
    }
  }

  let shubhaDinerNirghanta = [];
  $('table').each((i, table) => {
    let htmlContent = $(table).parent().html() || '';
    if (htmlContent.includes('শুভ দিনের নির্ঘন্ট') || htmlContent.includes('শুভ বিবাহ') || htmlContent.includes('অতিরিক্ত বিবাহ')) {
      $(table).find('tr').each((j, row) => {
        let rowData = [];
        $(row).find('td, th').each((k, cell) => {
          let t = $(cell).text().trim();
          if (t) rowData.push(t);
        });
        if (rowData.length > 0) shubhaDinerNirghanta.push(rowData);
      });
      return false; // break
    }
  });

  return { title, specialDates, shubhaDinerNirghanta };
}

async function scrapeAll() {
  console.log('Scraping Kolkata data...');
  const kolkataHome = await scrapeHome('https://www.ponjika.com/');
  const kolkataSandhya = await scrapeSandhya('https://www.ponjika.com/Sandhya.aspx');
  const kolkataMasik = await scrapeMasik('https://www.ponjika.com/eMaha.aspx');

  console.log('Scraping Bangladesh data...');
  const bdHome = await scrapeHome('http://bd.ponjika.com/');
  const bdSandhya = await scrapeSandhya('http://bd.ponjika.com/Sandhya.aspx');
  const bdMasik = await scrapeMasik('http://bd.ponjika.com/eMaha.aspx');

  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir);
  }

  fs.writeFileSync(path.join(dataDir, 'kolkata_home.json'), JSON.stringify(kolkataHome, null, 2));
  fs.writeFileSync(path.join(dataDir, 'kolkata_sandhya.json'), JSON.stringify(kolkataSandhya, null, 2));
  fs.writeFileSync(path.join(dataDir, 'kolkata_masik.json'), JSON.stringify(kolkataMasik, null, 2));
  
  fs.writeFileSync(path.join(dataDir, 'bd_home.json'), JSON.stringify(bdHome, null, 2));
  fs.writeFileSync(path.join(dataDir, 'bd_sandhya.json'), JSON.stringify(bdSandhya, null, 2));
  fs.writeFileSync(path.join(dataDir, 'bd_masik.json'), JSON.stringify(bdMasik, null, 2));

  console.log('Scraping complete. Data saved to data/ folder.');
}

if (require.main === module) {
  scrapeAll();
}

module.exports = { scrapeHome, scrapeSandhya, scrapeMasik };
