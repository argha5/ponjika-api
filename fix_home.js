// Post-process: extract sunInfo/moonInfo from events if missing
// Run after scrape to fix the JSON files
const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const files = ['kolkata_home.json', 'bd_home.json'];

for (const file of files) {
  const filePath = path.join(dataDir, file);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  
  if (!data.sunInfo || !data.moonInfo) {
    const evLines = (data.events || '').split('\n');
    const cleanEvents = [];
    
    for (const line of evLines) {
      // Check char code 0x9b8 = স, 0x9c2 = ূ, 0x9b0 = র, 0x9cd = ্, 0x9af = য
      // That spells সূর্য
      const firstChar = line.charCodeAt(0);
      const secondChar = line.charCodeAt(1);
      
      // Sun line: starts with সূ (0x9b8, 0x9c2)
      if (!data.sunInfo && firstChar === 0x9b8 && secondChar === 0x9c2) {
        data.sunInfo = line;
        continue;
      }
      // Moon line: starts with চন (0x99a, 0x9a8)
      if (!data.moonInfo && firstChar === 0x99a && secondChar === 0x9a8) {
        data.moonInfo = line;
        continue;
      }
      cleanEvents.push(line);
    }
    
    data.events = cleanEvents.join('\n');
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`Fixed: ${file} -> sunInfo: ${data.sunInfo.slice(0,30)}...`);
  } else {
    console.log(`OK: ${file}`);
  }
}
