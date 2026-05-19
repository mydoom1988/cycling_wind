const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.gpx':  'application/gpx+xml',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  // Proxy: /api/segments?swLat=...&swLng=...&neLat=...&neLng=...
  if (req.url.startsWith('/api/segments')) {
    const qs = req.url.split('?')[1] || '';
    const target = `https://www.doogal.co.uk/StravaSegments/?${qs}`;
    https.get(target, { headers: { 'User-Agent': 'Mozilla/5.0' } }, upstream => {
      let body = '';
      upstream.on('data', chunk => body += chunk);
      upstream.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'public, max-age=300',
        });
        res.end(body);
      });
    }).on('error', e => {
      res.writeHead(502);
      res.end('Proxy error: ' + e.message);
    });
    return;
  }

  const urlPath = req.url.split('?')[0];
  const file    = urlPath === '/' ? '/index.html' : urlPath;
  const full    = path.join(__dirname, file);

  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`Route Wind running on port ${PORT}`);
});
