// ============================================================
// Route Wind Analyzer
// ============================================================

// Data: Open-Meteo (ECMWF IFS 0.25°) — same model Windy.com defaults to.
const MAPTILER_KEY   = 'TQ5LlWGUvgHtC6UNQ8CD';
const NUM_SAMPLES    = 30;

let map, routeLayer, windRouteLayer, markersLayer;
let routePoints    = [];
let routeDistances = [];
let rawGpx         = '';
let rawGpxName     = '';
let lastResults    = [];   // sampled points with wind+weather, cached
let lastClimbs     = [];   // detected climbs on current route
let velocityLayer  = null; // live wind particles overlay

// In-app route drawer state
let drawMap         = null;
let drawRouteLayer  = null;
let drawWaypoints   = [];   // [{lat, lon, marker}]
let drawRouteCoords = [];   // [[lat, lon], ...] full snapped path
let drawTotalKm     = 0;

// Draw routing preferences
let drawProfile      = 'road';  // 'road' | 'gravel' | 'mtb'
let drawManualMode   = false;   // straight-line vs road-snapped routing
let drawShowMarkers  = false;   // show km distance markers on route
let drawMarkersLayer = null;    // L.layerGroup for km labels
let drawSearchTimer  = null;    // debounce timer for Nominatim search

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initUI();

  const now = new Date();
  now.setMinutes(0, 0, 0);
  const local = new Date(now - now.getTimezoneOffset() * 60000);
  document.getElementById('ride-time').value = local.toISOString().slice(0, 16);

  // Draw tab is active by default — initialize its map immediately
  // (otherwise it stays empty until you switch tabs away and back)
  ensureDrawMap();
  requestAnimationFrame(() => drawMap && drawMap.invalidateSize());
});

// ── Tabs ─────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + name));
  if (name === 'wind') map.invalidateSize();
  if (name === 'draw') {
    ensureDrawMap();
    requestAnimationFrame(() => drawMap && drawMap.invalidateSize());
  }
}

// ── Map setup ─────────────────────────────────────────────────
function initMap() {
  map = L.map('map', { center: [50, 10], zoom: 5 });

  L.tileLayer(`https://api.maptiler.com/maps/outdoor/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
    attribution: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 22,
    tileSize: 512,
    zoomOffset: -1,
  }).addTo(map);

  routeLayer      = L.layerGroup().addTo(map);
  windRouteLayer  = L.layerGroup().addTo(map);
  markersLayer    = L.layerGroup().addTo(map);

  setupRainLayer();
}

async function setupRainLayer() {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) return;
    const data = await res.json();
    const past = data.radar?.past;
    if (!past?.length) return;
    const latest = past[past.length - 1];
    // Color 8 = Dark Sky (transparent where no precip); smooth=1, snow=1
    const url = `${data.host}${latest.path}/256/{z}/{x}/{y}/8/1_1.png`;
    const rainLayer = L.tileLayer(url, {
      opacity: 0.6,
      maxNativeZoom: 7,    // RainViewer's free radar tiles only cover up to z7
      maxZoom: 22,         // Leaflet upscales the z7 tile for higher zooms
      attribution: '© <a href="https://rainviewer.com/">RainViewer</a>',
    });
    L.control.layers(null, { '🌧 Rain (radar)': rainLayer }, {
      collapsed: false,
      position: 'topleft',
    }).addTo(map);
  } catch (e) {
    console.warn('Rain layer setup failed:', e.message);
  }
}

// ── UI wiring ─────────────────────────────────────────────────
function initUI() {
  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Analyze button
  document.getElementById('analyze-btn').addEventListener('click', () => {
    if (routePoints.length) analyzeWind(routePoints);
  });

  // File upload
  const zone  = document.getElementById('upload-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('click',     () => input.click());
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) handleFile(input.files[0]); });

  document.getElementById('ride-speed').addEventListener('input', updateFinishTime);
  document.getElementById('ride-time').addEventListener('input', updateFinishTime);
  document.getElementById('download-btn').addEventListener('click', downloadGpx);
  document.getElementById('reverse-btn').addEventListener('click', reverseRoute);

  // Draw-tab actions
  document.getElementById('draw-clear').addEventListener('click', clearDraw);
  document.getElementById('draw-undo').addEventListener('click', undoDraw);
  document.getElementById('draw-save').addEventListener('click', saveDraw);

  // Wind-table collapse
  const toggleTable = () => {
    document.getElementById('wind-table').classList.toggle('collapsed');
    document.getElementById('wind-table-toggle').classList.toggle('collapsed');
  };
  document.getElementById('wind-table-header').addEventListener('click', toggleTable);

  // Mobile legend "i" expander
  document.getElementById('legend-mobile-btn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('legend').classList.add('expanded');
  });
  document.addEventListener('click', e => {
    const legend = document.getElementById('legend');
    if (!legend.contains(e.target)) legend.classList.remove('expanded');
  });

  // Persist rider profile
  ['rider-weight', 'bike-weight', 'rider-ftp'].forEach(id => {
    const el = document.getElementById(id);
    const saved = localStorage.getItem('rw_' + id);
    if (saved) el.value = saved;
    el.addEventListener('change', () => localStorage.setItem('rw_' + id, el.value));
  });
}

function reverseRoute() {
  if (!routePoints.length) { showToast('Load a route first', 'error'); return; }
  routePoints = [...routePoints].reverse();
  rawGpx = rawGpx; // GPX content itself isn't reversed (just display)
  displayRoute(routePoints);
  if (lastResults.length) {
    setTimeout(() => analyzeWind(routePoints), 80);
  } else {
    showToast('Route reversed', 'success');
  }
}

function downloadGpx() {
  if (!rawGpx) { showToast('Load a GPX route first', 'error'); return; }
  const blob = new Blob([rawGpx], { type: 'application/gpx+xml' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (rawGpxName || 'route') + '.gpx';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('GPX downloaded', 'success');
}

// ── GPX handling ─────────────────────────────────────────────
function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.gpx')) {
    showToast('Please upload a .gpx file', 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = e => {
    try {
      rawGpx     = e.target.result;
      rawGpxName = file.name.replace(/\.gpx$/i, '');
      const pts = parseGPX(rawGpx);
      if (pts.length < 2) { showToast('GPX has no track points', 'error'); return; }
      routePoints = pts;
      document.getElementById('file-name').textContent = '📍 ' + file.name;
      document.getElementById('file-name').classList.remove('hidden');
      displayRoute(pts);
      switchTab('wind');
      // Re-fit after the map element is visible and has correct dimensions
      requestAnimationFrame(() => {
        map.invalidateSize();
        map.fitBounds(L.polyline(pts.map(p => [p.lat, p.lon])).getBounds(), { padding: [50, 50] });
        // On mobile, scroll the map into view so user sees the result
        if (window.matchMedia('(max-width: 768px)').matches) {
          document.getElementById('main').scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    } catch (err) {
      showToast('Failed to parse GPX: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

function parseGPX(xml) {
  const doc   = new DOMParser().parseFromString(xml, 'text/xml');
  const trkp  = [...doc.querySelectorAll('trkpt')];
  const rtep  = [...doc.querySelectorAll('rtept')];
  const nodes = trkp.length ? trkp : rtep;
  if (!nodes.length) throw new Error('No trkpt or rtept elements found');

  return nodes.map(n => ({
    lat:  parseFloat(n.getAttribute('lat')),
    lon:  parseFloat(n.getAttribute('lon')),
    ele:  n.querySelector('ele')  ? parseFloat(n.querySelector('ele').textContent)  : null,
    time: n.querySelector('time') ? new Date(n.querySelector('time').textContent) : null,
  })).filter(p => !isNaN(p.lat) && !isNaN(p.lon));
}

// ── Route display ─────────────────────────────────────────────
function displayRoute(pts) {
  routeLayer.clearLayers();
  markersLayer.clearLayers();
  if (velocityLayer) { map.removeLayer(velocityLayer); velocityLayer = null; }

  windRouteLayer.clearLayers();

  const ll = pts.map(p => [p.lat, p.lon]);

  // Pre-compute cumulative distances (reused elsewhere)
  routeDistances = [0];
  for (let i = 1; i < pts.length; i++)
    routeDistances.push(routeDistances[i-1] + haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon));

  // Base route line (shown before wind analysis)
  L.polyline(ll, { color: '#1d4ed8', weight: 4, opacity: 0.9 }).addTo(routeLayer);
  addEndpoint(ll[0],           '#4CAF50', 'Start');
  addEndpoint(ll[ll.length-1], '#F44336', 'Finish');

  map.fitBounds(L.polyline(ll).getBounds(), { padding: [40, 40] });

  const dist = routeDistances[routeDistances.length - 1];
  document.getElementById('stat-distance').textContent  = (dist / 1000).toFixed(1);
  document.getElementById('stat-elevation').textContent = Math.round(elevGain(pts));
  updateFinishTime(dist);
  document.getElementById('route-info').classList.remove('hidden');
  renderElevationProfile(pts);

  // Detect climbs (independent of wind analysis)
  lastClimbs = detectClimbs(pts, routeDistances);
  renderClimbs(lastClimbs);

  document.getElementById('wind-section').classList.add('hidden');
  document.getElementById('wind-table').innerHTML = '';
  lastResults = [];
}

function addEndpoint(latlng, color, label) {
  L.circleMarker(latlng, { radius: 7, fillColor: color, color: '#fff', weight: 2, fillOpacity: 1 })
    .bindTooltip(label).addTo(routeLayer);
}

function updateFinishTime(distOrEvent) {
  const dist  = typeof distOrEvent === 'number' ? distOrEvent
              : (routeDistances.length ? routeDistances[routeDistances.length - 1] : 0);
  if (!dist) return;
  const speed  = parseFloat(document.getElementById('ride-speed').value) || 26;
  const hrs    = dist / 1000 / speed;
  const h      = Math.floor(hrs);
  const m      = Math.round((hrs - h) * 60);
  document.getElementById('stat-duration').textContent = `${h}h ${m.toString().padStart(2,'0')}m`;

  const durText  = `${h}h ${m.toString().padStart(2,'0')}m`;
  const startVal = document.getElementById('ride-time').value;
  const el       = document.getElementById('finish-time');
  if (startVal) {
    const finish = new Date(new Date(startVal).getTime() + hrs * 3600000);
    const timeStr = finish.toLocaleString([], { weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    el.innerHTML = `<span class="finish-duration">${durText}</span><span class="finish-clock">${timeStr}</span>`;
  } else {
    el.textContent = durText;
  }
}

// ── Wind analysis ─────────────────────────────────────────────
async function analyzeWind(pts) {
  const rideTime = new Date(document.getElementById('ride-time').value);
  if (isNaN(rideTime)) { showToast('Set a ride start time first', 'error'); return; }

  const speed      = parseFloat(document.getElementById('ride-speed').value) || 26;
  const totalDist  = totalDistance(pts);
  const rideDurMs  = (totalDist / 1000 / speed) * 3600 * 1000;

  setLoading(true, 10, 'Sampling route…');
  const samples = sampleRoute(pts, NUM_SAMPLES);

  for (let i = 0; i < samples.length; i++) {
    const next = samples[i + 1] ?? samples[i - 1];
    const prev = i > 0 ? samples[i - 1] : samples[i + 1];
    samples[i].bearing = bearing(prev, next);
    samples[i].estTime = new Date(rideTime.getTime() + (samples[i].distFromStart / totalDist) * rideDurMs);
  }

  setLoading(true, 40, 'Fetching ECMWF wind & weather…');
  let pointsData;
  try {
    pointsData = await fetchOpenMeteoBulk(samples);
  } catch (e) {
    setLoading(false);
    showToast('Weather fetch failed: ' + e.message, 'error');
    return;
  }
  setLoading(true, 85, 'Computing analysis…');

  const results = samples.map((s, i) => {
    const raw  = pointsData[i] || null;
    const wind = raw ? windAtTime(raw, s.estTime.getTime()) : null;
    return { ...s, rawWind: raw, wind };
  });
  setLoading(false);

  const valid = results.filter(r => r.wind);
  if (!valid.length) { showToast('No wind data', 'error'); return; }

  // Compute gradient + power for each sample
  for (let i = 0; i < results.length; i++) {
    const next = results[i + 1] ?? results[i];
    const dDist = Math.max(1, next.distFromStart - results[i].distFromStart);
    const dEle  = (next.ele ?? results[i].ele ?? 0) - (results[i].ele ?? 0);
    results[i].gradient = (dEle / dDist) * 100;
  }
  const riderMass = riderTotalMass();
  for (const r of results) {
    if (!r.wind) { r.power = null; continue; }
    const hw = headwind(r.wind.speed, r.wind.dir, r.bearing);
    r.headwindMs = hw;
    r.power = estimatePower(speed, r.gradient, -hw, riderMass);
  }

  lastResults = results;
  renderColoredRoute(results, pts);
  renderTable(results);
  renderCoachCard(results, totalDist, speed);
  renderWeatherSummary(results);
  renderPacingStrategy(results, lastClimbs);
  renderWindOverlay(pts, rideTime);
  showToast(`ECMWF wind & weather loaded (${valid.length} pts)`, 'success');
}

// ── Live wind overlay (animated particles via leaflet-velocity) ─
async function renderWindOverlay(pts, atTime) {
  if (!window.L || !L.velocityLayer) {
    console.warn('leaflet-velocity not loaded');
    showToast('Live wind layer unavailable (plugin not loaded)', 'error');
    return;
  }
  try {
    const bounds = L.latLngBounds(pts.map(p => [p.lat, p.lon]));
    const data = await loadWindGrid(bounds, atTime);
    if (velocityLayer) { map.removeLayer(velocityLayer); velocityLayer = null; }
    velocityLayer = L.velocityLayer({
      displayValues: true,
      displayOptions: {
        velocityType: 'ECMWF wind',
        position: 'bottomleft',
        emptyString: 'No wind data',
        speedUnit: 'm/s',
      },
      data,
      maxVelocity: 18,
      velocityScale: 0.012,
      particleAge: 70,
      lineWidth: 1.2,
      particleMultiplier: 0.0018,
      frameRate: 16,
      colorScale: [
        'rgba(255,255,255,0.85)',
        'rgba(186,230,253,0.9)',
        'rgba(96,165,250,0.9)',
        'rgba(251,191,36,0.95)',
        'rgba(239,68,68,1)',
      ],
    });
    velocityLayer.addTo(map);
    console.log('Live wind layer added with', data[0].data.length, 'grid points');
  } catch (e) {
    console.warn('Live wind overlay failed:', e.message);
    showToast('Live wind layer failed: ' + e.message, 'error');
  }
}

async function loadWindGrid(bounds, atTime) {
  const COLS = 22;
  const ROWS = 16;
  const sw = bounds.getSouthWest();
  const ne = bounds.getNorthEast();

  // Cover a generous region around the route so particles fill the visible map
  // even after the user pans/zooms. At minimum ~250 km square; otherwise route + 100%.
  const centerLat = (sw.lat + ne.lat) / 2;
  const centerLon = (sw.lng + ne.lng) / 2;
  const halfLat = Math.max(1.1, (ne.lat - sw.lat));            // ~120 km min
  const halfLon = Math.max(1.6, (ne.lng - sw.lng));            // ~110 km min @ 45°N
  const minLat = centerLat - halfLat, maxLat = centerLat + halfLat;
  const minLon = centerLon - halfLon, maxLon = centerLon + halfLon;
  const dx = (maxLon - minLon) / (COLS - 1);
  const dy = (maxLat - minLat) / (ROWS - 1);

  const lats = [], lons = [];
  // Row-major, top → bottom, left → right
  for (let i = 0; i < ROWS; i++) {
    for (let j = 0; j < COLS; j++) {
      lats.push((maxLat - i * dy).toFixed(4));
      lons.push((minLon + j * dx).toFixed(4));
    }
  }

  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
              `&hourly=wind_speed_10m,wind_direction_10m&models=ecmwf_ifs025&forecast_days=6&timezone=UTC&wind_speed_unit=ms`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
  const json = await res.json();
  const points = Array.isArray(json) ? json : [json];

  // Find target hour index in first point's time series
  const times    = points[0].hourly.time;
  const targetH  = new Date(atTime); targetH.setMinutes(0,0,0);
  const targetIso = targetH.toISOString().slice(0, 13);
  let idx = times.findIndex(t => t.startsWith(targetIso));
  if (idx < 0) idx = 0;

  const us = [], vs = [];
  for (const p of points) {
    const s = p.hourly.wind_speed_10m[idx];
    const d = p.hourly.wind_direction_10m[idx];
    if (s == null || d == null) { us.push(0); vs.push(0); continue; }
    const r = d * Math.PI / 180;          // d = direction FROM (meteorological)
    us.push(-s * Math.sin(r));
    vs.push(-s * Math.cos(r));
  }

  const refTime = new Date(targetIso + ':00:00Z').toISOString();
  const headerBase = {
    parameterCategory: 2,
    parameterUnit:     'm/s',
    nx: COLS, ny: ROWS,
    lo1: minLon, la1: maxLat,
    lo2: maxLon, la2: minLat,
    dx, dy,
    refTime,
  };
  return [
    { header: { ...headerBase, parameterNumber: 2, parameterNumberName: 'eastward_wind'  }, data: us },
    { header: { ...headerBase, parameterNumber: 3, parameterNumberName: 'northward_wind' }, data: vs },
  ];
}

// Bulk-fetch wind+weather for all sample points in ONE Open-Meteo call (ECMWF model).
async function fetchOpenMeteoBulk(samples) {
  const lats = samples.map(s => s.lat.toFixed(4)).join(',');
  const lons = samples.map(s => s.lon.toFixed(4)).join(',');
  const params = new URLSearchParams({
    latitude:       lats,
    longitude:      lons,
    hourly:         'wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m,precipitation',
    models:         'ecmwf_ifs025',
    forecast_days:  '6',
    timezone:       'UTC',
    wind_speed_unit:'ms',
  });
  const res = await fetch('https://api.open-meteo.com/v1/forecast?' + params);
  if (!res.ok) {
    const txt = await res.text().catch(() => res.status);
    throw new Error(`Open-Meteo ${res.status}: ${txt}`);
  }
  const json = await res.json();
  return Array.isArray(json) ? json : [json];
}

// Look up wind/weather at a specific time from one point's Open-Meteo forecast.
function windAtTime(data, targetMs) {
  if (!data?.hourly) return null;
  const times = data.hourly.time;
  if (!times?.length) return null;

  // Times come back like "2026-05-13T07:00" (UTC). Find the closest hour.
  const targetHourIso = new Date(targetMs).toISOString().slice(0, 13);
  let idx = times.findIndex(t => t.startsWith(targetHourIso));
  if (idx < 0) {
    let minDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const tMs  = new Date(times[i] + 'Z').getTime();
      const diff = Math.abs(tMs - targetMs);
      if (diff < minDiff) { minDiff = diff; idx = i; }
    }
  }

  const speed   = data.hourly.wind_speed_10m?.[idx];
  const dirFrom = data.hourly.wind_direction_10m?.[idx];
  if (speed == null || dirFrom == null) return null;

  // Convert meteorological "from" direction to "to" direction (where wind is going)
  const dirTo = (dirFrom + 180) % 360;
  const fromRad = dirFrom * Math.PI / 180;
  const u = -speed * Math.sin(fromRad);   // east component (positive = eastward motion)
  const v = -speed * Math.cos(fromRad);   // north component

  const gust  = data.hourly.wind_gusts_10m?.[idx];
  const tempC = data.hourly.temperature_2m?.[idx];
  const rh    = data.hourly.relative_humidity_2m?.[idx];
  const pr    = data.hourly.precipitation?.[idx];

  return {
    speed,
    dir:        dirTo,
    u, v,
    gust:       gust ?? speed,
    tempC:      tempC ?? null,
    feelsLikeC: tempC != null ? feelsLike(tempC, speed, rh) : null,
    rh:         rh ?? null,
    precipMm:   pr ?? 0,
    timestamp:  new Date(times[idx] + 'Z'),
  };
}

function feelsLike(tempC, windMs, rh) {
  // Wind chill (Environment Canada): valid for T <= 10°C and wind > 1.3 m/s
  if (tempC <= 10 && windMs > 1.3) {
    const v = windMs * 3.6; // km/h
    return 13.12 + 0.6215 * tempC - 11.37 * Math.pow(v, 0.16) + 0.3965 * tempC * Math.pow(v, 0.16);
  }
  // Heat index (simplified) for T >= 27°C
  if (tempC >= 27 && rh != null) {
    return tempC + 0.348 * (rh / 100) * 6.105 * Math.exp(17.27 * tempC / (237.7 + tempC)) - 4.25;
  }
  return tempC;
}

// ── Colored route ────────────────────────────────────────────
function headwindColor(hw) {
  if (hw >=  3) return '#16a34a';
  if (hw >=  1) return '#86efac';
  if (hw >= -1) return '#fbbf24';
  if (hw >= -3) return '#f97316';
  return '#dc2626';
}

function renderColoredRoute(results, pts) {
  windRouteLayer.clearLayers();
  const valid = results.filter(r => r.wind);
  if (!valid.length) return;

  // Thin white outline underneath for contrast
  L.polyline(pts.map(p => [p.lat, p.lon]), {
    color: '#fff', weight: 7, opacity: 0.5, lineJoin: 'round',
  }).addTo(windRouteLayer);

  // Draw a colored segment between each consecutive pair of samples
  for (let i = 0; i < results.length - 1; i++) {
    const r = results[i];
    if (!r.wind) continue;

    const hw    = headwind(r.wind.speed, r.wind.dir, r.bearing);
    const color = headwindColor(hw);
    const start = r.distFromStart;
    const end   = results[i + 1].distFromStart;

    // Collect original pts that fall in this segment
    const segLL = [[r.lat, r.lon]];
    for (let j = 0; j < pts.length; j++) {
      if (routeDistances[j] > start && routeDistances[j] < end)
        segLL.push([pts[j].lat, pts[j].lon]);
    }
    segLL.push([results[i + 1].lat, results[i + 1].lon]);

    L.polyline(segLL, { color, weight: 5, opacity: 0.9, lineJoin: 'round' }).addTo(windRouteLayer);
  }

  // Re-add endpoints on top
  addEndpoint(pts[0],           '#4CAF50', 'Start');
  addEndpoint(pts[pts.length-1], '#F44336', 'Finish');
}

// ── Table ─────────────────────────────────────────────────────
function renderTable(results) {
  const valid    = results.filter(r => r.wind);
  const avgSpeed = valid.reduce((s, r) => s + r.wind.speed, 0) / valid.length;
  const maxGust  = Math.max(...valid.map(r => r.wind.gust ?? r.wind.speed));
  const maxHead  = Math.max(...valid.map(r => -headwind(r.wind.speed, r.wind.dir, r.bearing)));

  document.getElementById('wind-avg').textContent  = avgSpeed.toFixed(1) + ' m/s';
  document.getElementById('wind-max').textContent  = maxGust.toFixed(1) + ' m/s';
  document.getElementById('wind-head').textContent = maxHead > 0 ? maxHead.toFixed(1) + ' m/s' : 'none';

  const table = document.getElementById('wind-table');
  table.innerHTML = '';

  for (const r of results) {
    if (!r.wind) continue;
    const { speed, dir } = r.wind;
    const color  = speedColor(speed);
    const hw     = headwind(speed, dir, r.bearing);
    const hwText = hw > 0.5  ? `↗ ${hw.toFixed(1)} m/s tailwind` :
                   hw < -0.5 ? `↙ ${Math.abs(hw).toFixed(1)} m/s headwind` : '↔ crosswind';
    const hwCls  = hw > 0.5 ? 'tailwind' : hw < -0.5 ? 'headwind' : 'crosswind';
    const tempStr = r.wind.tempC != null ? ` · ${Math.round(r.wind.tempC)}°C` : '';
    const powStr  = r.power != null ? ` · ~${Math.round(r.power)}W` : '';

    const row = document.createElement('div');
    row.className = 'wind-row';
    row.innerHTML = `
      <div class="wind-arrow">${arrowSvg(dir, color, 30)}</div>
      <div class="wind-info">
        <div class="km">${(r.distFromStart / 1000).toFixed(1)} km · ${compass(dir)}${tempStr}${powStr}</div>
        <div class="condition ${hwCls}">${hwText}</div>
      </div>
      <div class="wind-speed">
        <span class="ms" style="color:${color}">${speed.toFixed(1)}</span>
        <span class="unit">m/s</span>
      </div>`;
    row.addEventListener('click', () => map.setView([r.lat, r.lon], 14));
    table.appendChild(row);
  }

  document.getElementById('wind-section').classList.remove('hidden');
}

// ── Elevation profile ─────────────────────────────────────────
function renderElevationProfile(pts) {
  const panel = document.getElementById('elevation-panel');
  const svg   = document.getElementById('elevation-svg');

  const legend = document.getElementById('legend');
  const withEle = pts.filter(p => p.ele != null);
  if (withEle.length < 2) {
    panel.classList.add('hidden');
    legend.classList.add('elev-hidden');
    legend.classList.remove('elev-collapsed');
    return;
  }
  legend.classList.remove('elev-hidden');

  // Accumulate distances for every point
  const dists = [0];
  for (let i = 1; i < pts.length; i++)
    dists.push(dists[i-1] + haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon));
  const totalM = dists[dists.length - 1];

  const eles   = pts.map(p => p.ele ?? null);
  const valid  = eles.filter(e => e != null);
  const minE   = Math.min(...valid);
  const maxE   = Math.max(...valid);
  const rangeE = Math.max(maxE - minE, 1);
  const gain   = elevGain(pts);

  document.getElementById('elevation-stats').textContent =
    `↑ ${Math.round(gain)} m  ·  min ${Math.round(minE)} m  ·  max ${Math.round(maxE)} m`;

  const W = 1000, H = 110;
  const padL = 42, padR = 12, padT = 10, padB = 24;
  const cW = W - padL - padR, cH = H - padT - padB;

  const xOf = d  => padL + (d / totalM) * cW;
  const yOf = e  => padT + cH - ((e - minE) / rangeE) * cH;

  // Build polyline points and filled path
  const ptPairs = pts
    .map((p, i) => p.ele != null ? `${xOf(dists[i]).toFixed(1)},${yOf(p.ele).toFixed(1)}` : null)
    .filter(Boolean);

  const firstX = xOf(dists[pts.findIndex(p => p.ele != null)]).toFixed(1);
  const lastX  = xOf(dists[pts.length - 1 - [...pts].reverse().findIndex(p => p.ele != null)]).toFixed(1);
  const baseY  = (padT + cH).toFixed(1);
  const areaD  = `M ${firstX},${baseY} L ${ptPairs.join(' L ')} L ${lastX},${baseY} Z`;

  // X-axis km labels (every ~10 km, max 10 ticks)
  const kmStep = Math.ceil((totalM / 1000) / 10) * 1 || 1;
  const xTicks = [];
  for (let km = 0; km <= totalM / 1000; km += kmStep)
    xTicks.push(`<line x1="${xOf(km*1000).toFixed(1)}" y1="${padT}" x2="${xOf(km*1000).toFixed(1)}" y2="${(padT+cH).toFixed(1)}" stroke="#334155" stroke-width="0.5"/>
      <text x="${xOf(km*1000).toFixed(1)}" y="${H-6}" fill="#64748b" font-size="9" text-anchor="middle">${km} km</text>`);

  // Y-axis ele labels (3 levels)
  const yTicks = [0, 0.5, 1].map(f => {
    const e = minE + f * rangeE;
    const y = yOf(e).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${padL+cW}" y2="${y}" stroke="#334155" stroke-width="0.5"/>
      <text x="${(padL-4)}" y="${y}" fill="#64748b" font-size="9" text-anchor="end" dominant-baseline="middle">${Math.round(e)}</text>`;
  });

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="elevGrad" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%"   stop-color="#3b82f6" stop-opacity="0.7"/>
        <stop offset="100%" stop-color="#3b82f6" stop-opacity="0.15"/>
      </linearGradient>
    </defs>
    ${xTicks.join('')}
    ${yTicks.join('')}
    <path d="${areaD}" fill="url(#elevGrad)"/>
    <polyline points="${ptPairs.join(' ')}" fill="none" stroke="#60a5fa" stroke-width="1.5" stroke-linejoin="round"/>
    <line id="elev-cursor" x1="0" y1="${padT}" x2="0" y2="${padT+cH}" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,2" opacity="0"/>
  `;

  panel.classList.remove('hidden');

  // Bike marker on map
  const bikeIcon = L.divIcon({
    html: '<div class="bike-marker">🚴</div>',
    className: '',
    iconSize:   [30, 26],
    iconAnchor: [15, 13],
  });
  let bikeMarker = null;

  // Hover tooltip
  let tooltip = document.querySelector('.elev-tooltip');
  if (!tooltip) { tooltip = document.createElement('div'); tooltip.className = 'elev-tooltip'; document.body.appendChild(tooltip); }

  svg.onmousemove = e => {
    const rect  = svg.getBoundingClientRect();
    const svgX  = (e.clientX - rect.left) / rect.width * W;
    const frac  = Math.max(0, Math.min(1, (svgX - padL) / cW));
    const dist  = frac * totalM;

    // Find nearest point with elevation
    let nearest = 0, minDiff = Infinity;
    dists.forEach((d, i) => {
      const diff = Math.abs(d - dist);
      if (diff < minDiff && eles[i] != null) { minDiff = diff; nearest = i; }
    });
    const ele = eles[nearest];
    if (ele == null) return;

    // Move cursor line
    const cx = xOf(dists[nearest]).toFixed(1);
    document.getElementById('elev-cursor').setAttribute('x1', cx);
    document.getElementById('elev-cursor').setAttribute('x2', cx);
    document.getElementById('elev-cursor').setAttribute('opacity', '1');

    // Tooltip
    tooltip.textContent  = `${(dists[nearest]/1000).toFixed(1)} km · ${Math.round(ele)} m`;
    tooltip.style.left   = (e.clientX + 14) + 'px';
    tooltip.style.top    = (e.clientY - 28) + 'px';
    tooltip.style.display = 'block';

    // Bike marker
    const latlng = [pts[nearest].lat, pts[nearest].lon];
    if (!bikeMarker) {
      bikeMarker = L.marker(latlng, { icon: bikeIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    } else {
      bikeMarker.setLatLng(latlng);
    }
  };

  svg.onmouseleave = () => {
    document.getElementById('elev-cursor').setAttribute('opacity', '0');
    tooltip.style.display = 'none';
    if (bikeMarker) { map.removeLayer(bikeMarker); bikeMarker = null; }
  };

  // Toggle collapse
  const btn = document.getElementById('elevation-toggle');
  btn.onclick = () => {
    panel.classList.toggle('collapsed');
    btn.classList.toggle('collapsed');
    legend.classList.toggle('elev-collapsed', panel.classList.contains('collapsed'));
    map.invalidateSize();
  };
}

// ── SVG arrow ─────────────────────────────────────────────────
function arrowSvg(dir, color, size) {
  const c  = size / 2;
  const tl = size * 0.42;
  const hl = size * 0.36;
  const hw = size * 0.20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <g transform="translate(${c},${c}) rotate(${dir})">
      <line x1="0" y1="${tl}" x2="0" y2="${-hl}" stroke="${color}" stroke-width="2.2" stroke-linecap="round" opacity="0.9"/>
      <polygon points="0,${-c*0.88} ${hw},${-hl+hw*0.6} ${-hw},${-hl+hw*0.6}" fill="${color}" opacity="0.95"/>
      <circle r="${size*0.1}" fill="${color}" opacity="0.7"/>
    </g>
  </svg>`;
}

// ── Geo utilities ─────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
  const R  = 6371000;
  const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
  const Δφ = (lat2 - lat1) * Math.PI / 180;
  const Δλ = (lon2 - lon1) * Math.PI / 180;
  const a  = Math.sin(Δφ/2)**2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function totalDistance(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++)
    d += haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
  return d;
}

function elevGain(pts) {
  let g = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].ele != null && pts[i-1].ele != null) {
      const d = pts[i].ele - pts[i-1].ele;
      if (d > 0) g += d;
    }
  }
  return g;
}

function sampleRoute(pts, n) {
  const total    = totalDistance(pts);
  const interval = total / Math.max(n - 1, 1);
  const out      = [];
  let accumulated = 0, nextTarget = 0;

  const interp = (a, b, t, key) =>
    (a[key] != null && b[key] != null) ? a[key] + t * (b[key] - a[key]) : (a[key] ?? b[key] ?? null);

  for (let i = 1; i < pts.length && out.length < n; i++) {
    const seg = haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
    while (nextTarget <= accumulated + seg && out.length < n) {
      const t = seg > 0 ? (nextTarget - accumulated) / seg : 0;
      out.push({
        lat:           pts[i-1].lat + t * (pts[i].lat - pts[i-1].lat),
        lon:           pts[i-1].lon + t * (pts[i].lon - pts[i-1].lon),
        ele:           interp(pts[i-1], pts[i], t, 'ele'),
        distFromStart: nextTarget,
      });
      nextTarget += interval;
    }
    accumulated += seg;
  }

  if (out.length < n) {
    const last = pts[pts.length - 1];
    out.push({ lat: last.lat, lon: last.lon, ele: last.ele, distFromStart: total });
  }
  return out.slice(0, n);
}

function offsetPoint(lat, lon, bearingDeg, distMeters) {
  const R  = 6371000;
  const d  = distMeters / R;
  const b  = bearingDeg * Math.PI / 180;
  const φ1 = lat * Math.PI / 180;
  const λ1 = lon * Math.PI / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b));
  const λ2 = λ1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: φ2 * 180 / Math.PI, lon: λ2 * 180 / Math.PI };
}

function bearing(p1, p2) {
  const φ1 = p1.lat * Math.PI / 180, φ2 = p2.lat * Math.PI / 180;
  const Δλ = (p2.lon - p1.lon) * Math.PI / 180;
  const y  = Math.sin(Δλ) * Math.cos(φ2);
  const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function headwind(windSpeed, windDir, travelBearing) {
  const angle = (windDir - travelBearing + 360) % 360;
  return windSpeed * Math.cos(angle * Math.PI / 180);
}

function speedColor(ms) {
  if (ms < 3)  return '#4CAF50';
  if (ms < 7)  return '#FFC107';
  if (ms < 12) return '#FF9800';
  if (ms < 18) return '#F44336';
  return '#9C27B0';
}

function compass(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── Coach: power, TSS, calories, hydration ───────────────────
function riderTotalMass() {
  const rider = parseFloat(document.getElementById('rider-weight').value) || 75;
  const bike  = parseFloat(document.getElementById('bike-weight').value) || 9;
  return rider + bike;
}

function riderFTP() {
  return parseFloat(document.getElementById('rider-ftp').value) || 220;
}

// Estimate watts to hold speedKmh given gradient (%) and headwind (m/s, +ve = into rider).
function estimatePower(speedKmh, gradientPct, windHeadMs, mass) {
  const v   = speedKmh / 3.6;
  const g   = 9.81;
  const rho = 1.225;
  const crr = 0.005;
  const cda = 0.4;
  const eff = 0.97;            // drivetrain efficiency

  const rolling = crr * mass * g * v;
  const gravity = mass * g * (gradientPct / 100) * v;
  const apparent = v + Math.max(-v, windHeadMs);
  const air = 0.5 * rho * cda * apparent * apparent * Math.sign(apparent || 1) * v;
  const total = (rolling + gravity + air) / eff;
  return Math.max(0, total);
}

function renderCoachCard(results, totalDistM, speedKmh) {
  const valid    = results.filter(r => r.power != null);
  if (!valid.length) return;
  const durHours = (totalDistM / 1000) / speedKmh;

  // Distance-weighted average power
  let powSum = 0, distSum = 0;
  for (let i = 0; i < valid.length; i++) {
    const next = valid[i + 1] ?? valid[i];
    const segD = Math.max(1, next.distFromStart - valid[i].distFromStart);
    powSum  += valid[i].power * segD;
    distSum += segD;
  }
  const avgPower = powSum / distSum;

  // Normalized Power (simplified): 4th-root of 4th-power mean
  const np = Math.pow(
    valid.reduce((s, r) => s + Math.pow(r.power, 4), 0) / valid.length, 0.25
  );

  const ftp = riderFTP();
  const intensity = np / ftp;
  const tss = durHours * intensity * intensity * 100;

  // kJ → kcal (cycling efficiency ~24% → kJ ≈ kcal for the rider's metabolic output)
  const kj   = avgPower * durHours * 3.6;
  const kcal = Math.round(kj);

  // Hydration: 600 ml/h baseline, +120 ml/h per 5°C above 20°C, +100 ml/h if intensity > 0.85
  const avgTemp = valid.reduce((s, r) => s + (r.wind?.tempC ?? 18), 0) / valid.length;
  const tempBoost = Math.max(0, (avgTemp - 20) / 5) * 120;
  const intensityBoost = intensity > 0.85 ? 100 : 0;
  const waterMlPerHr = 600 + tempBoost + intensityBoost;
  const totalWaterL  = (waterMlPerHr * durHours) / 1000;

  document.getElementById('coach-tss').textContent   = Math.round(tss);
  document.getElementById('coach-power').textContent = Math.round(avgPower) + ' W';
  document.getElementById('coach-kcal').textContent  = kcal + ' kcal';
  document.getElementById('coach-water').textContent = totalWaterL.toFixed(1) + ' L';

  // Fueling guidance
  const intensityLabel =
    intensity < 0.55 ? 'recovery'      :
    intensity < 0.75 ? 'endurance (Z2)' :
    intensity < 0.90 ? 'tempo (Z3)'    :
    intensity < 1.05 ? 'threshold (Z4)' : 'VO₂max (Z5)';
  const carbsPerHr = intensity < 0.6 ? 30 : intensity < 0.85 ? 60 : 90;
  const fuelEveryKm = Math.max(10, Math.round((speedKmh * 0.5))); // every ~30 min
  document.getElementById('coach-fuel').innerHTML =
    `<strong>${intensityLabel}</strong> · IF ${intensity.toFixed(2)} · ` +
    `target <strong>${carbsPerHr} g</strong> carbs/h, sip every <strong>${fuelEveryKm} km</strong>.`;
}

function renderWeatherSummary(results) {
  const valid = results.filter(r => r.wind && r.wind.tempC != null);
  if (!valid.length) return;
  const avgT  = valid.reduce((s, r) => s + r.wind.tempC, 0) / valid.length;
  const avgFL = valid.reduce((s, r) => s + (r.wind.feelsLikeC ?? r.wind.tempC), 0) / valid.length;
  const maxPr = Math.max(0, ...valid.map(r => r.wind.precipMm || 0));
  document.getElementById('weather-temp').textContent  = avgT.toFixed(0) + '°C';
  document.getElementById('weather-feels').textContent = avgFL.toFixed(0) + '°C';
  document.getElementById('weather-rain').textContent  = maxPr > 0.1 ? maxPr.toFixed(1) + ' mm' : 'dry';
}

// ── Pacing strategy ──────────────────────────────────────────
function renderPacingStrategy(results, climbs) {
  const list = document.getElementById('pacing-list');
  list.innerHTML = '';
  const tips = [];

  // Worst headwind run
  const headwindRun = findRun(results, r => r.headwindMs != null && r.headwindMs < -2);
  if (headwindRun && headwindRun.length >= 2) {
    const startKm = (headwindRun[0].distFromStart / 1000).toFixed(0);
    const endKm   = (headwindRun[headwindRun.length-1].distFromStart / 1000).toFixed(0);
    const avgHw   = -headwindRun.reduce((s, r) => s + r.headwindMs, 0) / headwindRun.length;
    tips.push({
      cls: 'headwind',
      html: `<strong>Save in headwind:</strong> km ${startKm}–${endKm}, avg ${avgHw.toFixed(1)} m/s into you. Drop to ~70–80% effort, tuck low.`,
    });
  }

  // Best tailwind run
  const tailRun = findRun(results, r => r.headwindMs != null && r.headwindMs > 2);
  if (tailRun && tailRun.length >= 2) {
    const startKm = (tailRun[0].distFromStart / 1000).toFixed(0);
    const endKm   = (tailRun[tailRun.length-1].distFromStart / 1000).toFixed(0);
    const avgTw   = tailRun.reduce((s, r) => s + r.headwindMs, 0) / tailRun.length;
    tips.push({
      cls: 'tailwind',
      html: `<strong>Push tailwind:</strong> km ${startKm}–${endKm}, +${avgTw.toFixed(1)} m/s at your back. Add 5–10% power, free km/h.`,
    });
  }

  // Climbs
  if (climbs.length) {
    const big = climbs.filter(c => c.category !== '4').slice(0, 2);
    const list2 = (big.length ? big : climbs.slice(0, 2));
    for (const c of list2) {
      tips.push({
        cls: 'climb',
        html: `<strong>Climb @ km ${c.startKm.toFixed(0)}:</strong> ${c.lengthKm.toFixed(1)} km @ ${c.avgGrad.toFixed(1)}% (Cat ${c.category}). Pace ~Z3 for ${humanDuration((c.lengthKm / 12) * 3600)}.`,
      });
    }
  }

  // Weather warnings
  const valid = results.filter(r => r.wind);
  const maxGust = Math.max(...valid.map(r => r.wind.gust ?? r.wind.speed));
  if (maxGust > 13) {
    tips.push({
      cls: '',
      html: `<strong>Gusts up to ${maxGust.toFixed(0)} m/s</strong> — beware crosswind on exposed sections, watch echelons in groups.`,
    });
  }
  const coldMin = Math.min(...valid.filter(r => r.wind.feelsLikeC != null).map(r => r.wind.feelsLikeC));
  if (coldMin < 5) {
    tips.push({
      cls: '',
      html: `<strong>Feels-like as low as ${coldMin.toFixed(0)}°C</strong> — pack a vest/gloves, especially for descents.`,
    });
  }
  const totalRain = valid.reduce((s, r) => s + (r.wind.precipMm || 0), 0);
  if (totalRain > 1) {
    tips.push({
      cls: '',
      html: `<strong>Rain risk (${totalRain.toFixed(1)} mm)</strong> — fenders, tubeless, ride defensively in bends.`,
    });
  }

  if (!tips.length) {
    list.innerHTML = '<li>Conditions look benign — ride to plan.</li>';
    return;
  }

  for (const t of tips) {
    const li = document.createElement('li');
    li.className = t.cls;
    li.innerHTML = t.html;
    list.appendChild(li);
  }
}

function findRun(arr, predicate) {
  let bestRun = null, bestSum = -Infinity;
  let cur = [], curSum = 0;
  for (const r of arr) {
    if (predicate(r)) {
      cur.push(r);
      curSum += Math.abs(r.headwindMs);
    } else {
      if (curSum > bestSum) { bestRun = cur; bestSum = curSum; }
      cur = []; curSum = 0;
    }
  }
  if (curSum > bestSum) bestRun = cur;
  return bestRun;
}

function humanDuration(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), mm = m % 60;
  return `${h}h ${mm.toString().padStart(2,'0')}m`;
}

// ── Climb detection ──────────────────────────────────────────
function detectClimbs(pts, dists) {
  const MIN_GRAD = 3;     // %
  const MIN_LEN  = 500;   // m
  const MIN_GAIN = 30;    // m
  const SMOOTH   = 300;   // m smoothing window

  const grads = [];
  for (let i = 0; i < pts.length; i++) {
    let lo = i, hi = i;
    while (lo > 0 && dists[i] - dists[lo - 1] < SMOOTH / 2) lo--;
    while (hi < pts.length - 1 && dists[hi + 1] - dists[i] < SMOOTH / 2) hi++;
    if (pts[lo].ele == null || pts[hi].ele == null || dists[hi] - dists[lo] < 50) {
      grads.push(0); continue;
    }
    grads.push((pts[hi].ele - pts[lo].ele) / (dists[hi] - dists[lo]) * 100);
  }

  const climbs = [];
  let startIdx = -1;
  for (let i = 0; i < pts.length; i++) {
    if (grads[i] >= MIN_GRAD) {
      if (startIdx === -1) startIdx = i;
    } else if (startIdx !== -1) {
      const endIdx = i - 1;
      const len    = dists[endIdx] - dists[startIdx];
      const dEle   = (pts[endIdx].ele ?? 0) - (pts[startIdx].ele ?? 0);
      if (len >= MIN_LEN && dEle >= MIN_GAIN) {
        const avgGrad = (dEle / len) * 100;
        const points  = (len / 1000) * avgGrad;
        climbs.push({
          startIdx, endIdx,
          startKm:  dists[startIdx] / 1000,
          endKm:    dists[endIdx]   / 1000,
          lengthKm: len / 1000,
          ascent:   dEle,
          avgGrad,
          category: climbCategory(points),
          lat: pts[startIdx].lat,
          lon: pts[startIdx].lon,
        });
      }
      startIdx = -1;
    }
  }
  return climbs;
}

function climbCategory(points) {
  if (points >= 50) return 'HC';
  if (points >= 25) return '1';
  if (points >= 12) return '2';
  if (points >=  6) return '3';
  return '4';
}

function renderClimbs(climbs) {
  const section = document.getElementById('climbs-section');
  const list    = document.getElementById('climbs-list');
  list.innerHTML = '';
  if (!climbs.length) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  for (const c of climbs) {
    const catClass = c.category === 'HC' ? 'hc' : 'cat' + c.category;
    const row = document.createElement('div');
    row.className = 'climb-row';
    row.innerHTML = `
      <div class="climb-cat ${catClass}">${c.category}</div>
      <div class="climb-info">
        <div class="climb-info-km">km ${c.startKm.toFixed(0)}</div>
        <div class="climb-info-stats">${c.lengthKm.toFixed(1)} km · ↑${Math.round(c.ascent)} m</div>
      </div>
      <div class="climb-gradient">${c.avgGrad.toFixed(1)}%</div>`;
    row.addEventListener('click', () => {
      switchTab('wind');
      map.setView([c.lat, c.lon], 14);
    });
    list.appendChild(row);
  }
}

// ── Polyline-6 decoder (Valhalla shape format) ───────────────
// Valhalla returns route geometry as Google encoded polyline with precision 6.
function decodePolyline6(encoded) {
  const coords = [];
  let index = 0, lat = 0, lng = 0;
  while (index < encoded.length) {
    let shift = 0, result = 0, b;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    shift = result = 0;
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    lng += (result & 1) ? ~(result >> 1) : (result >> 1);
    coords.push([lat / 1e6, lng / 1e6]); // [lat, lon]
  }
  return coords;
}

// ── Nominatim geocoder for the search box ───────────────────
async function searchNominatim(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5&addressdetails=1`;
  try {
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) return;
    const results = await res.json();
    showSearchSuggestions(results);
  } catch (e) {
    console.warn('Geocode failed:', e.message);
  }
}

function showSearchSuggestions(results) {
  const container = document.getElementById('draw-suggestions');
  container.innerHTML = '';
  if (!results.length) {
    container.innerHTML = '<div class="draw-suggestion-empty">No results found</div>';
    return;
  }
  results.forEach(r => {
    const item = document.createElement('div');
    item.className = 'draw-suggestion';
    // Trim display_name to first 3 parts
    const name = r.display_name.split(',').slice(0, 3).join(', ');
    item.textContent = name;
    item.title = r.display_name;
    item.addEventListener('mousedown', e => {
      e.preventDefault(); // prevent input blur before click fires
      const lat = parseFloat(r.lat), lon = parseFloat(r.lon);
      drawMap.setView([lat, lon], 13);
      document.getElementById('draw-search').value = name;
      document.getElementById('draw-search-clear').style.display = 'block';
      container.innerHTML = '';
    });
    container.appendChild(item);
  });
}

// ── km distance markers on the drawn route ───────────────────
function renderDrawMarkers() {
  if (!drawMarkersLayer) return;
  drawMarkersLayer.clearLayers();
  if (!drawShowMarkers || drawRouteCoords.length < 2) return;

  const dists = [0];
  for (let i = 1; i < drawRouteCoords.length; i++) {
    const [la, lo] = drawRouteCoords[i];
    const [la0, lo0] = drawRouteCoords[i - 1];
    dists.push(dists[i - 1] + haversine(la0, lo0, la, lo));
  }
  const totalM = dists[dists.length - 1];

  let nextMark = 1000; // first label at 1 km
  for (let i = 1; i < drawRouteCoords.length && nextMark < totalM; i++) {
    while (nextMark <= dists[i] && nextMark < totalM) {
      const segLen = dists[i] - dists[i - 1];
      const t = segLen > 0 ? (nextMark - dists[i - 1]) / segLen : 0;
      const lat = drawRouteCoords[i - 1][0] + t * (drawRouteCoords[i][0] - drawRouteCoords[i - 1][0]);
      const lon = drawRouteCoords[i - 1][1] + t * (drawRouteCoords[i][1] - drawRouteCoords[i - 1][1]);
      const km  = Math.round(nextMark / 1000);
      L.marker([lat, lon], {
        icon: L.divIcon({
          html: `<div class="dist-marker">${km}</div>`,
          className: '',
          iconSize: [20, 16],
          iconAnchor: [10, 8],
        }),
        interactive: false,
        zIndexOffset: -100,
      }).addTo(drawMarkersLayer);
      nextMark += 1000;
    }
  }
}

// ── In-app route drawer ───────────────────────────────────────
function ensureDrawMap() {
  if (drawMap) return;
  drawMap = L.map('draw-map', { center: [55.0, 24.0], zoom: 8 });
  L.tileLayer(`https://api.maptiler.com/maps/outdoor/{z}/{x}/{y}.png?key=${MAPTILER_KEY}`, {
    attribution: '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> © <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    maxZoom: 22, tileSize: 512, zoomOffset: -1,
  }).addTo(drawMap);
  drawRouteLayer   = L.layerGroup().addTo(drawMap);
  drawMarkersLayer = L.layerGroup().addTo(drawMap);
  drawMap.on('click', e => addWaypoint(e.latlng.lat, e.latlng.lng));

  // ── Activity-type pills ──────────────────────────────────────
  document.querySelectorAll('#draw-activity-pills .draw-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#draw-activity-pills .draw-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      drawProfile = btn.dataset.value;
      if (drawWaypoints.length >= 2 && !drawManualMode) recalculateRoute();
    });
  });

  // ── Manual mode toggle ───────────────────────────────────────
  document.getElementById('draw-manual-toggle').addEventListener('change', e => {
    drawManualMode = e.target.checked;
    if (drawWaypoints.length >= 2) recalculateRoute();
    else updateDrawStats();
  });

  // ── km markers toggle ────────────────────────────────────────
  document.getElementById('draw-markers-toggle').addEventListener('change', e => {
    drawShowMarkers = e.target.checked;
    renderDrawMarkers();
  });

  // ── Location search ──────────────────────────────────────────
  const searchInput = document.getElementById('draw-search');
  const searchClear = document.getElementById('draw-search-clear');
  const suggestions = document.getElementById('draw-suggestions');

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim();
    searchClear.style.display = q ? 'block' : 'none';
    clearTimeout(drawSearchTimer);
    if (!q) { suggestions.innerHTML = ''; return; }
    drawSearchTimer = setTimeout(() => searchNominatim(q), 320);
  });

  searchInput.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      searchInput.value = '';
      searchClear.style.display = 'none';
      suggestions.innerHTML = '';
    }
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    searchClear.style.display = 'none';
    suggestions.innerHTML = '';
    searchInput.focus();
  });

  // Close suggestions when clicking outside the search wrap
  document.addEventListener('click', e => {
    const wrap = document.getElementById('draw-search-wrap');
    if (wrap && !wrap.contains(e.target)) suggestions.innerHTML = '';
  });

  // Try to centre on user's location
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => drawMap.setView([pos.coords.latitude, pos.coords.longitude], 12),
      () => {},
      { timeout: 4000 }
    );
  }
}

function waypointIcon(num, total) {
  const cls = num === 1 ? 'wp-start' : (num === total ? 'wp-finish' : '');
  return L.divIcon({
    html: `<div class="wp-marker ${cls}">${num}</div>`,
    iconSize:  [26, 26],
    iconAnchor:[13, 13],
    className: '',
  });
}

function rebuildWaypointIcons() {
  const total = drawWaypoints.length;
  drawWaypoints.forEach((w, i) => {
    w.marker.setIcon(waypointIcon(i + 1, total));
  });
}

async function addWaypoint(lat, lon) {
  const wp = { lat, lon, marker: null };
  wp.marker = L.marker([lat, lon], { icon: waypointIcon(drawWaypoints.length + 1, drawWaypoints.length + 1) }).addTo(drawMap);
  wp.marker.on('click', () => removeWaypoint(wp));
  drawWaypoints.push(wp);
  rebuildWaypointIcons();
  if (drawWaypoints.length >= 2) await recalculateRoute();
  updateDrawStats();
}

function removeWaypoint(wp) {
  const idx = drawWaypoints.indexOf(wp);
  if (idx < 0) return;
  drawMap.removeLayer(wp.marker);
  drawWaypoints.splice(idx, 1);
  rebuildWaypointIcons();
  if (drawWaypoints.length >= 2) recalculateRoute();
  else {
    drawRouteLayer.clearLayers();
    drawMarkersLayer && drawMarkersLayer.clearLayers();
    drawRouteCoords = [];
    drawTotalKm = 0;
  }
  updateDrawStats();
}

function undoDraw() {
  if (!drawWaypoints.length) return;
  removeWaypoint(drawWaypoints[drawWaypoints.length - 1]);
}

function clearDraw() {
  drawWaypoints.forEach(w => drawMap && drawMap.removeLayer(w.marker));
  drawWaypoints = [];
  drawRouteLayer   && drawRouteLayer.clearLayers();
  drawMarkersLayer && drawMarkersLayer.clearLayers();
  drawRouteCoords = [];
  drawTotalKm = 0;
  updateDrawStats();
}

// Dispatcher: route according to current mode & profile
async function recalculateRoute() {
  if (drawWaypoints.length < 2) return;

  if (drawManualMode) {
    // Manual mode: straight lines between waypoints, no snapping
    drawRouteCoords = drawWaypoints.map(w => [w.lat, w.lon]);
    drawTotalKm = 0;
    for (let i = 1; i < drawRouteCoords.length; i++) {
      drawTotalKm += haversine(
        drawRouteCoords[i - 1][0], drawRouteCoords[i - 1][1],
        drawRouteCoords[i][0],     drawRouteCoords[i][1]
      ) / 1000;
    }
    drawRouteLayer.clearLayers();
    L.polyline(drawRouteCoords, {
      color: '#1d4ed8', weight: 5, opacity: 0.9, lineJoin: 'round', dashArray: '10,6',
    }).addTo(drawRouteLayer);
    renderDrawMarkers();
    updateDrawStats();
    return;
  }

  if (drawProfile === 'gravel' || drawProfile === 'mtb') {
    setLoading(true, 50, 'Routing (Valhalla)…');
    try { await recalculateValhalla(); }
    catch (e) { showToast('Routing failed: ' + e.message, 'error'); }
    finally   { setLoading(false); }
  } else {
    await recalculateOSRM();
  }
  renderDrawMarkers();
  updateDrawStats();
}

// OSRM road-bike routing (reliable, Road profile)
async function recalculateOSRM() {
  const coords = drawWaypoints.map(w => `${w.lon.toFixed(6)},${w.lat.toFixed(6)}`).join(';');
  const url = `https://routing.openstreetmap.de/routed-bike/route/v1/driving/${coords}?overview=full&geometries=geojson`;
  try {
    setLoading(true, 50, 'Routing…');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Routing ${res.status}`);
    const data = await res.json();
    if (data.code !== 'Ok') throw new Error('Route: ' + data.code);
    const route = data.routes[0];
    drawRouteCoords = route.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    drawTotalKm    = route.distance / 1000;

    drawRouteLayer.clearLayers();
    L.polyline(drawRouteCoords, {
      color: '#1d4ed8', weight: 5, opacity: 0.9, lineJoin: 'round',
    }).addTo(drawRouteLayer);
  } catch (e) {
    showToast('Routing failed: ' + e.message, 'error');
  } finally {
    setLoading(false);
  }
}

// Valhalla routing for Gravel / MTB profiles
async function recalculateValhalla() {
  const bikePref = drawProfile === 'mtb'
    ? { bicycle_type: 'Mountain', use_roads: 0.1, use_trails: 0.9, use_hills: 0.9 }
    : { bicycle_type: 'Cross',    use_roads: 0.4, use_trails: 0.7, use_hills: 0.6 };

  const body = {
    locations: drawWaypoints.map(w => ({ lon: w.lon, lat: w.lat })),
    costing: 'bicycle',
    costing_options: { bicycle: bikePref },
    directions_type: 'none',
  };

  const res = await fetch('https://valhalla1.openstreetmap.de/route', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Fall back to OSRM on Valhalla error
    showToast(`Valhalla unavailable (${res.status}), using road routing`, 'error');
    await recalculateOSRM();
    return;
  }
  const data = await res.json();
  if (!data.trip?.legs?.length) throw new Error('No route from Valhalla');

  // Decode and concatenate all leg shapes (polyline6)
  const allCoords = [];
  for (const leg of data.trip.legs) {
    const coords = decodePolyline6(leg.shape);
    if (allCoords.length) coords.shift(); // remove duplicate junction point
    allCoords.push(...coords);
  }
  drawRouteCoords = allCoords;
  drawTotalKm = 0;
  for (let i = 1; i < drawRouteCoords.length; i++) {
    drawTotalKm += haversine(
      drawRouteCoords[i - 1][0], drawRouteCoords[i - 1][1],
      drawRouteCoords[i][0],     drawRouteCoords[i][1]
    ) / 1000;
  }

  drawRouteLayer.clearLayers();
  L.polyline(drawRouteCoords, {
    color: '#1d4ed8', weight: 5, opacity: 0.9, lineJoin: 'round',
  }).addTo(drawRouteLayer);
}

function updateDrawStats() {
  const el  = document.getElementById('draw-stats');
  const btn = document.getElementById('draw-save');
  if (!el || !btn) return;
  if (drawWaypoints.length === 0) {
    el.textContent = drawManualMode
      ? 'Manual mode: click to place waypoints, joined with straight lines.'
      : 'Tap the map to add waypoints — cycling routes snap to roads.';
  } else if (drawWaypoints.length === 1) {
    el.textContent = '1 waypoint set — add at least 1 more.';
  } else {
    const modeTag = drawManualMode ? ' · manual' : '';
    el.textContent = `${drawWaypoints.length} waypoints · ${drawTotalKm.toFixed(1)} km${modeTag} · click a marker to remove`;
  }
  btn.disabled = drawRouteCoords.length < 2;
}

async function fetchElevations(coords) {
  // Open-Meteo's elevation endpoint caps at 100 coords per call AND rate-limits
  // bursts. So: subsample to <=100 evenly-spaced points (1 API call total),
  // then linearly interpolate elevation back to every route coordinate.
  if (!coords.length) return [];

  const MAX_SAMPLES = 100;
  const N = Math.min(MAX_SAMPLES, coords.length);
  const samples = [];                       // [{idx, ele}]
  const seen    = new Set();
  for (let k = 0; k < N; k++) {
    const idx = Math.round((k / Math.max(N - 1, 1)) * (coords.length - 1));
    if (!seen.has(idx)) { seen.add(idx); samples.push({ idx }); }
  }

  const lats = samples.map(s => coords[s.idx][0].toFixed(5)).join(',');
  const lons = samples.map(s => coords[s.idx][1].toFixed(5)).join(',');
  const url  = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Elevation ${res.status}`);
    const data = await res.json();
    const eles = data.elevation || [];
    samples.forEach((s, k) => { s.ele = eles[k]; });
  } catch (e) {
    console.warn('Elevation fetch failed:', e.message);
    return new Array(coords.length).fill(null);
  }

  // Linear interpolation from sampled values to every index
  const result = new Array(coords.length).fill(null);
  let s = 0;
  for (let i = 0; i < coords.length; i++) {
    while (s < samples.length - 1 && samples[s + 1].idx <= i) s++;
    const a = samples[s];
    const b = samples[Math.min(s + 1, samples.length - 1)];
    if (a.ele == null && b.ele == null) continue;
    if (a.ele == null)        { result[i] = b.ele; continue; }
    if (b.ele == null || a.idx === b.idx) { result[i] = a.ele; continue; }
    const t = (i - a.idx) / (b.idx - a.idx);
    result[i] = a.ele + t * (b.ele - a.ele);
  }
  return result;
}

async function saveDraw() {
  if (drawRouteCoords.length < 2) { showToast('Add at least 2 waypoints', 'error'); return; }

  setLoading(true, 30, 'Fetching elevation…');
  let eles = [];
  try {
    eles = await fetchElevations(drawRouteCoords);
  } catch (e) {
    console.warn('Elevation fetch failed:', e.message);
  }
  setLoading(false);

  routePoints = drawRouteCoords.map(([lat, lon], i) => ({
    lat, lon,
    ele:  eles[i] ?? null,
    time: null,
  }));

  const trkpts = routePoints
    .map(p => {
      const eleTag = p.ele != null ? `<ele>${p.ele.toFixed(1)}</ele>` : '';
      return `    <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">${eleTag}</trkpt>`;
    })
    .join('\n');
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  rawGpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1" creator="Route Wind">
  <trk><name>Route Wind ${stamp}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
  rawGpxName  = 'route-' + Date.now();

  document.getElementById('file-name').textContent = `📍 Drawn route (${drawTotalKm.toFixed(1)} km)`;
  document.getElementById('file-name').classList.remove('hidden');

  displayRoute(routePoints);
  switchTab('wind');
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(L.polyline(routePoints.map(p => [p.lat, p.lon])).getBounds(), { padding: [50, 50] });
  });
  showToast('Route saved — hit Analyze ↑', 'success');
}

// ── UI helpers ────────────────────────────────────────────────
function setLoading(show, pct = 0, text = '') {
  document.getElementById('loading').classList.toggle('hidden', !show);
  if (text) document.getElementById('loading-text').textContent = text;
  document.getElementById('loading-bar').style.width = pct + '%';
}

let toastTimer;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = type;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}
