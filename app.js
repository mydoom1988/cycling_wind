// ============================================================
// Route Wind Analyzer
// ============================================================

const WINDY_KEY      = 'EnsmRmSN5tXbcHrBgA3AtRtDWiSis50I';
const MAPTILER_KEY   = 'TQ5LlWGUvgHtC6UNQ8CD';
const NUM_SAMPLES    = 30;
const BATCH_SIZE     = 5;
const ARROW_OFFSET_M = 180;

let map, routeLayer, windRouteLayer, markersLayer;
let routePoints    = [];
let routeDistances = [];
let rawGpx         = '';
let rawGpxName     = '';

// ── Bootstrap ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  initUI();

  const now = new Date();
  now.setMinutes(0, 0, 0);
  const local = new Date(now - now.getTimezoneOffset() * 60000);
  document.getElementById('ride-time').value = local.toISOString().slice(0, 16);
});

// ── Tabs ─────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + name));
  if (name === 'wind') map.invalidateSize();
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

  document.getElementById('wind-section').classList.add('hidden');
  document.getElementById('wind-table').innerHTML = '';
}

function addEndpoint(latlng, color, label) {
  L.circleMarker(latlng, { radius: 7, fillColor: color, color: '#fff', weight: 2, fillOpacity: 1 })
    .bindTooltip(label).addTo(routeLayer);
}

function updateFinishTime(distOrEvent) {
  const dist  = typeof distOrEvent === 'number' ? distOrEvent
              : (routeDistances.length ? routeDistances[routeDistances.length - 1] : 0);
  if (!dist) return;
  const speed  = parseFloat(document.getElementById('ride-speed').value) || 20;
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

  const speed      = parseFloat(document.getElementById('ride-speed').value) || 20;
  const totalDist  = totalDistance(pts);
  const rideDurMs  = (totalDist / 1000 / speed) * 3600 * 1000;

  setLoading(true, 0, 'Sampling route…');
  const samples = sampleRoute(pts, NUM_SAMPLES);

  for (let i = 0; i < samples.length; i++) {
    const next = samples[i + 1] ?? samples[i - 1];
    const prev = i > 0 ? samples[i - 1] : samples[i + 1];
    samples[i].bearing = bearing(prev, next);
    samples[i].estTime = new Date(rideTime.getTime() + (samples[i].distFromStart / totalDist) * rideDurMs);
  }

  const results = [];
  try {
    for (let i = 0; i < samples.length; i += BATCH_SIZE) {
      const batch = samples.slice(i, i + BATCH_SIZE);
      const fetched = await Promise.all(batch.map(async s => {
        try {
          const raw  = await fetchWind(s.lat, s.lon);
          const wind = windAtTime(raw, s.estTime.getTime());
          return { ...s, wind };
        } catch (e) {
          console.warn('Wind fetch failed:', e.message);
          return { ...s, wind: null };
        }
      }));
      results.push(...fetched);
      setLoading(true,
        Math.round((results.length / samples.length) * 100),
        `Fetching wind (${results.length}/${samples.length})…`);
    }
  } finally {
    setLoading(false);
  }

  const valid = results.filter(r => r.wind);
  if (!valid.length) { showToast('No wind data — check API key', 'error'); return; }

  renderColoredRoute(results, pts);
  renderMarkers(results);
  renderTable(results);
  showToast(`Wind loaded for ${valid.length} points`, 'success');
}

async function fetchWind(lat, lon) {
  const res = await fetch('https://api.windy.com/api/point-forecast/v2', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lat, lon, model: 'gfs', parameters: ['wind'], levels: ['surface'], key: WINDY_KEY }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.status);
    throw new Error(`Windy API ${res.status}: ${txt}`);
  }
  return res.json();
}

function windAtTime(data, targetMs) {
  const ts = data.ts;
  let idx = 0, minDiff = Infinity;
  for (let i = 0; i < ts.length; i++) {
    const d = Math.abs(ts[i] - targetMs);
    if (d < minDiff) { minDiff = d; idx = i; }
  }
  const u = data['wind_u-surface'][idx];
  const v = data['wind_v-surface'][idx];
  return {
    speed:     Math.sqrt(u * u + v * v),
    dir:       (Math.atan2(u, v) * 180 / Math.PI + 360) % 360,
    u, v,
    timestamp: new Date(ts[idx]),
  };
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

    // Direction-of-travel chevron at the sample point
    const chevron = L.divIcon({
      html: `<svg width="16" height="16" viewBox="-8 -8 16 16">
               <g transform="rotate(${r.bearing})">
                 <path d="M0,-5 L4,4 L0,1.5 L-4,4 Z" fill="#fff" stroke="#0f172a" stroke-width="1.4" stroke-linejoin="round"/>
               </g>
             </svg>`,
      className: '',
      iconSize:   [16, 16],
      iconAnchor: [8, 8],
    });
    L.marker([r.lat, r.lon], { icon: chevron, interactive: false, zIndexOffset: 400 }).addTo(windRouteLayer);
  }

  // Re-add endpoints on top
  addEndpoint(pts[0],           '#4CAF50', 'Start');
  addEndpoint(pts[pts.length-1], '#F44336', 'Finish');
}

// ── Markers ───────────────────────────────────────────────────
function renderMarkers(results) {
  markersLayer.clearLayers();
  for (const r of results) {
    if (!r.wind) continue;
    const { speed, dir, timestamp } = r.wind;
    const color = speedColor(speed);
    const hw    = headwind(speed, dir, r.bearing);

    // Offset to upwind side
    const pos = offsetPoint(r.lat, r.lon, (dir + 180) % 360, ARROW_OFFSET_M);

    const icon = L.divIcon({
      html: arrowSvg(dir, color, 48),
      className: '',
      iconSize:   [48, 48],
      iconAnchor: [24, 24],
    });

    const hwLabel = hw > 0.5  ? `↗ ${hw.toFixed(1)} m/s tailwind` :
                    hw < -0.5 ? `↙ ${Math.abs(hw).toFixed(1)} m/s headwind` : '↔ crosswind';
    const hwCls   = hw > 0.5 ? 'popup-hw-tail' : hw < -0.5 ? 'popup-hw-head' : '';

    L.marker([pos.lat, pos.lon], { icon })
      .bindPopup(`
        <div class="popup-km">${(r.distFromStart / 1000).toFixed(1)} km</div>
        <div class="popup-row"><span class="popup-label">Speed</span><span>${speed.toFixed(1)} m/s (${(speed * 3.6).toFixed(1)} km/h)</span></div>
        <div class="popup-row"><span class="popup-label">Direction</span><span>${Math.round(dir)}° ${compass(dir)}</span></div>
        <div class="popup-row"><span class="popup-label">Component</span><span class="${hwCls}">${hwLabel}</span></div>
        <div class="popup-time">Forecast: ${timestamp.toLocaleString()}</div>
      `)
      .addTo(markersLayer);
  }
}

// ── Table ─────────────────────────────────────────────────────
function renderTable(results) {
  const valid    = results.filter(r => r.wind);
  const avgSpeed = valid.reduce((s, r) => s + r.wind.speed, 0) / valid.length;
  const maxSpeed = Math.max(...valid.map(r => r.wind.speed));
  const maxHead  = Math.max(...valid.map(r => -headwind(r.wind.speed, r.wind.dir, r.bearing)));

  document.getElementById('wind-avg').textContent  = avgSpeed.toFixed(1) + ' m/s';
  document.getElementById('wind-max').textContent  = maxSpeed.toFixed(1) + ' m/s';
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

    const row = document.createElement('div');
    row.className = 'wind-row';
    row.innerHTML = `
      <div class="wind-arrow">${arrowSvg(dir, color, 30)}</div>
      <div class="wind-info">
        <div class="km">${(r.distFromStart / 1000).toFixed(1)} km · ${compass(dir)}</div>
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

  for (let i = 1; i < pts.length && out.length < n; i++) {
    const seg = haversine(pts[i-1].lat, pts[i-1].lon, pts[i].lat, pts[i].lon);
    while (nextTarget <= accumulated + seg && out.length < n) {
      const t = seg > 0 ? (nextTarget - accumulated) / seg : 0;
      out.push({
        lat:          pts[i-1].lat + t * (pts[i].lat - pts[i-1].lat),
        lon:          pts[i-1].lon + t * (pts[i].lon - pts[i-1].lon),
        distFromStart: nextTarget,
      });
      nextTarget += interval;
    }
    accumulated += seg;
  }

  if (out.length < n) {
    const last = pts[pts.length - 1];
    out.push({ lat: last.lat, lon: last.lon, distFromStart: total });
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
