/**
 * DayZ Static Map — Leaflet + CRS.Simple
 * Renders game world on a configurable image overlay with place name labels
 * and SVG marker layers loaded from JSON files.
 */

const PLACE_STYLES = {
  capital: { size: 18, weight: 'bold',   color: '#fff' },
  city:    { size: 16, weight: 'bold',   color: '#ddd' },
  village: { size: 15, weight: 'normal', color: '#bbb' },
  local:   { size: 14, weight: 'normal', color: '#999' },
  hill:    { size: 14, weight: 'normal', color: '#8a8' },
  marine:  { size: 14, weight: 'italic', color: '#89b' },
};

// Minimum Leaflet zoom level at which each place zoom tier becomes visible
const PLACE_ZOOM_MAP = { 1: -4, 2: -3.5, 3: -3, 4: -2, 5: 0 };

/**
 * Compute Leaflet image overlay bounds from map config.
 *
 * game_region_px defines the pixel rectangle within the image that corresponds
 * to the game coordinate space. Decorative borders extend the image beyond game
 * bounds — the image is positioned so the region aligns exactly with game coords.
 */
function computeImageBounds(cfg) {
  const xMax = cfg.game_bounds.x_max;
  const yMax = cfg.game_bounds.y_max;
  const imgW = cfg.image.width;
  const imgH = cfg.image.height;
  const reg = cfg.image.game_region_px;

  // Scale: game units per pixel within the defined region
  const scaleX = xMax / (reg.x1 - reg.x0);
  const scaleY = yMax / (reg.y1 - reg.y0);

  // Image corners in game coordinate space (Leaflet lat=gameY, lng=gameX).
  // Image pixel-y increases downward; game-y increases upward.
  const swLat = -(imgH - reg.y1) * scaleY;  // bottom of image below game origin
  const swLng = -reg.x0 * scaleX;           // left of image before game origin
  const neLat = yMax + reg.y0 * scaleY;     // top of image above game y_max
  const neLng = xMax + (imgW - reg.x1) * scaleX; // right of image past game x_max

  return L.latLngBounds([swLat, swLng], [neLat, neLng]);
}

/**
 * Add a toggle row to the layer sidebar.
 * Checking/unchecking the checkbox adds or removes the layer from the map.
 */
function addSidebarEntry(map, title, iconUrl, layer) {
  const list = document.getElementById('layer-list');
  if (!list) return;

  const label = document.createElement('label');
  label.className = 'layer-entry';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = true;
  cb.addEventListener('change', function () {
    if (cb.checked) { layer.addTo(map); } else { map.removeLayer(layer); }
  });
  label.appendChild(cb);

  if (iconUrl) {
    const img = document.createElement('img');
    img.src = iconUrl;
    img.alt = '';
    label.appendChild(img);
  }

  const span = document.createElement('span');
  span.textContent = title;
  label.appendChild(span);

  list.appendChild(label);
}

/**
 * Initialise the map and return an addMarkerLayer function.
 *
 * Marker icons are sized in game coordinate units (icon_game_size per section)
 * so they scale naturally with the map zoom level.
 */
function initMap(mapConfig, placeNames) {
  const xMax = mapConfig.game_bounds.x_max;
  const yMax = mapConfig.game_bounds.y_max;
  const gameBounds = L.latLngBounds([0, 0], [yMax, xMax]);
  const imgBounds = computeImageBounds(mapConfig);

  const map = L.map('map', {
    crs: L.CRS.Simple,
    minZoom: -4,
    maxZoom: 4,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    maxBounds: gameBounds.pad(0.15),
    maxBoundsViscosity: 1.0,
    attributionControl: false,
  });

  L.imageOverlay(mapConfig.image_file, imgBounds).addTo(map);
  map.fitBounds(gameBounds);

  // ── Marker zoom-scaling ──────────────────────────────────────────────────────
  // Each entry: { marker, iconUrl, gameSize }
  // gameSize is the icon diameter in game coordinate units — markers scale with zoom.
  const scaledMarkers = [];

  function pxPerGameUnit() {
    const z = map.getZoom();
    const p0 = map.project(L.latLng(0, 0), z);
    const p1 = map.project(L.latLng(0, 1), z);
    return Math.abs(p1.x - p0.x);
  }

  function refreshMarkerSizes() {
    const px = pxPerGameUnit();
    for (const entry of scaledMarkers) {
      const raw = Math.round(entry.gameSize * px);
      const size = Math.min(entry.maxSize, Math.max(entry.minSize, raw));
      const half = Math.round(size / 2);
      entry.marker.setIcon(L.icon({
        iconUrl: entry.iconUrl,
        iconSize: [size, size],
        iconAnchor: [half, half],
      }));
    }
  }

  map.on('zoomend', refreshMarkerSizes);

  // ── Place name labels ───────────────────────────────────────────────────────
  const placeNameLayer = L.layerGroup().addTo(map);

  for (const place of placeNames) {
    const style = PLACE_STYLES[place.type] || PLACE_STYLES.local;
    const marker = L.marker(L.latLng(place.y, place.x), {
      icon: L.divIcon({
        className: 'place-label',
        html: `<span style="font-size:${style.size}px;font-weight:${style.weight};color:${style.color}">${place.name}</span>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
      interactive: false,
    });
    marker._showAtZoom = PLACE_ZOOM_MAP[place.zoom] !== undefined ? PLACE_ZOOM_MAP[place.zoom] : -2;
    placeNameLayer.addLayer(marker);
  }

  function updatePlaceVisibility() {
    const z = map.getZoom();
    placeNameLayer.eachLayer(function (layer) {
      const el = layer.getElement();
      if (!el) return;
      el.style.display = z >= layer._showAtZoom ? '' : 'none';
    });
  }

  map.on('zoomend', updatePlaceVisibility);
  map.whenReady(function () {
    setTimeout(updatePlaceVisibility, 200);
  });

  addSidebarEntry(map, 'Place Names', null, placeNameLayer);

  const markerDefaults = mapConfig.marker_defaults || {};

  // ── Public: load a marker data file and add it to the map ───────────────────
  // display_type "point"  — SVG icon, size driven by icon_game_size (section-level diameter)
  // display_type "radial" — SVG icon, size driven by each item's r (2*r = diameter in game units)
  function addMarkerLayer(data) {
    const layer = L.layerGroup().addTo(map);

    for (const section of data.sections) {
      const isCircle = section.display_type === 'radial';
      // radial: size is purely 2*r in game units — ignore map-config defaults entirely
      const minSize = section.icon_size_min || (isCircle ? 1   : markerDefaults.icon_size_min || 8);
      const maxSize = section.icon_size_max || (isCircle ? 1e9 : markerDefaults.icon_size_max || 128);

      for (const item of section.items) {
        const gameSize = isCircle
          ? 2 * item.r
          : (section.icon_game_size || markerDefaults.icon_game_size || 300);

        // Placeholder icon — refreshMarkerSizes() sets the correct size immediately below
        const marker = L.marker(L.latLng(item.y, item.x), {
          icon: L.icon({ iconUrl: section.icon, iconSize: [1, 1], iconAnchor: [0, 0] }),
        }).addTo(layer);
        scaledMarkers.push({ marker, iconUrl: section.icon, gameSize, minSize, maxSize });
      }
    }

    refreshMarkerSizes();
    addSidebarEntry(map, data.meta.title, data.meta.title_icon, layer);
  }

  return addMarkerLayer;
}

// ── Sidebar toggle ────────────────────────────────────────────────────────────
const toggleBtn = document.getElementById('layer-toggle');
const layerPanel = document.getElementById('layer-panel');
if (toggleBtn && layerPanel) {
  toggleBtn.addEventListener('click', function () {
    layerPanel.classList.toggle('hidden');
  });
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
(async function () {
  try {
    const mapConfig = await fetch('data/map-config.json').then(function (r) { return r.json(); });
    const placeNames = await fetch('data/places.json').then(function (r) { return r.json(); });
    const addMarkerLayer = initMap(mapConfig, placeNames);

    for (const file of (mapConfig.marker_files || [])) {
      fetch(file)
        .then(function (r) { return r.json(); })
        .then(addMarkerLayer);
    }
  } catch (err) {
    console.error('Failed to load map data:', err); // eslint-disable-line no-console
  }
}());
