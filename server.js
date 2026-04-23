const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { scrapeHome, scrapeSandhya, scrapeMasik, scrapeBatsorik } = require('./scrape');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const dataDir = path.join(__dirname, 'data');

// Serve static JSON files if they exist (fastest)
app.use('/api/static', express.static(dataDir));

// Dynamic API endpoints that scrape live data
app.get('/api/ponjika', async (req, res) => {
  const region = req.query.region || 'kolkata';
  const type = req.query.type || 'home';
  
  const baseUrl = region === 'bangladesh' ? 'http://bd.ponjika.com' : 'https://www.ponjika.com';
  
  try {
    let data;
    if (type === 'home') {
      data = await scrapeHome(region === 'bangladesh' ? baseUrl + '/' : baseUrl + '/');
    } else if (type === 'sandhya') {
      data = await scrapeSandhya(baseUrl + '/Sandhya.aspx');
    } else if (type === 'masik') {
      data = await scrapeMasik(baseUrl + '/eMaha.aspx');
    } else if (type === 'batsorik') {
      data = await scrapeBatsorik(baseUrl + '/eBosor.aspx');
    } else {
      return res.status(400).json({ error: 'Invalid type parameter. Use home, sandhya, masik, or batsorik.' });
    }
    
    if (!data) {
      return res.status(500).json({ error: 'Failed to scrape data.' });
    }
    
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Run scraper manually
app.get('/api/scrape', (req, res) => {
  // We run this in the background
  const { exec } = require('child_process');
  exec('node scrape.js', (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: 'Scraping successful', output: stdout });
  });
});

app.listen(PORT, () => {
  console.log(`Ponjika API running on http://localhost:\${PORT}`);
  console.log(`Try: http://localhost:\${PORT}/api/ponjika?region=bangladesh&type=home`);
});
