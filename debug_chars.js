const {scrapeHome} = require('./scrape.js');

scrapeHome('https://www.ponjika.com/').then(d => {
  // Check what's in events - split by newline
  const evLines = d.events.split('\n');
  console.log('Event lines count:', evLines.length);
  
  for (const line of evLines) {
    if (line.length > 5) {
      console.log('\nLine:', line.slice(0, 30));
      // Print first 10 char codes
      const codes = [];
      for (let i = 0; i < Math.min(10, line.length); i++) {
        codes.push(line.charCodeAt(i).toString(16));
      }
      console.log('CharCodes:', codes.join(' '));
    }
  }
  
  // Expected sun keyword charCodes: 09b8 09c2 09b0 09cd 09af = সূর্য
  const sunKeyword = '\u09b8\u09c2\u09b0\u09cd\u09af';
  console.log('\nExpected সূর্য codes:');
  for (let i = 0; i < sunKeyword.length; i++) {
    console.log(sunKeyword.charCodeAt(i).toString(16));
  }
});
