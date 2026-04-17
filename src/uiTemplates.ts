export const measureToolbarHtml = () => `
  <div
    id="measureToolbar"
    class="flex fixed bottom-center divider-horizontal bg-inverted z-index-ontop-high no-print"
    style="margin-bottom: 20px; gap: 6px; height: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;"
  >
    <button id="measure-distance" class="padding-small icon-smaller round light box-shadow relative o-tooltip active" aria-label="Avstånd" tabindex="0" title="Mät avstånd (Vänsterklick: sätt punkter)">
      <span class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_straighten_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Avstånd" data-placement="south"></span>
    </button>

    <button id="measure-height" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Höjd" tabindex="0" title="Mät höjdskillnad (Vänsterklick: sätt punkter)">
      <span class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_height_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Höjd" data-placement="south"></span>
    </button>

    <button id="measure-footprint" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Fotavtryck" tabindex="0" title="Mät fotavtryck - horisontell projektion (Vänsterklick: lägg till punkter, Högerklick: avsluta)">
      <span class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_footprint_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Fotavtryck" data-placement="south"></span>
    </button>

    <button id="measure-surface" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Yta" tabindex="0" title="Mät 3D-yta - tak, väggar, sluttningar (Vänsterklick: lägg till punkter, Högerklick: avsluta)">
      <span class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(180, 100%, 35%)">
          <use xlink:href="#o_polygon_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Yta" data-placement="south"></span>
    </button>

    <div style="width: 1px; background: #ccc; margin: 4px 2px;"></div>

    <button id="measure-clear" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Rensa" tabindex="0" title="Rensa alla mätningar">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 100%, 40%)">
          <use xlink:href="#ic_delete_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Rensa" data-placement="south"></span>
    </button>

    <button id="measure-close" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Stäng" tabindex="0" title="Stäng mätverktyg">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_close_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Stäng" data-placement="south"></span>
    </button>
  </div>
`;

export interface PolygonToolbarOptions {
  showGeojson?: boolean;
  showDxf?: boolean;
  dxfCrs?: string[];
  showShare?: boolean;
}

export const polygonToolbarHtml = (options: PolygonToolbarOptions = {}) => {
  const {
    showGeojson = true,
    showDxf = true,
    dxfCrs = ['EPSG:3006'],
    showShare = true,
  } = options;

  // Generate download buttons
  const downloadButtons: string[] = [];
  if (showGeojson) {
    downloadButtons.push(`<button id="polygon-download-geojson" style="padding: 4px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px; background: white;">GeoJSON 2D (EPSG:4326)</button>`);
  }
  if (showDxf && dxfCrs.length > 0) {
    dxfCrs.forEach(crs => {
      const safeId = crs.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
      downloadButtons.push(`<button id="polygon-download-dxf-${safeId}" data-crs="${crs}" class="polygon-download-dxf-btn" style="padding: 4px 8px; cursor: pointer; border: 1px solid #ccc; border-radius: 3px; background: white;">DXF 3D (${crs})</button>`);
    });
  }

  const shareButtonHtml = showShare ? `
    <button id="polygon-share" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Dela" tabindex="0" title="Dela ritade polygoner">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(210, 100%, 40%)">
          <use xlink:href="#ic_screen_share_outline_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Dela" data-placement="south"></span>
    </button>
  ` : '';

  const downloadSectionHtml = downloadButtons.length > 0 ? `
    <div class="o-popover-container">
      <button id="polygon-download-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Ladda ner" tabindex="0" title="Ladda ner ritade polygoner">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
            <use xlink:href="#ic_download_24px"></use>
          </svg>
        </span>
        <span data-tooltip="Ladda ner" data-placement="south"></span>
      </button>
      <div id="polygon-download-popover" class="o-popover" style="width: min-content; left: 90px;">
        <div style="padding: 0.25rem 0.5rem; display: flex; flex-direction: column; gap: 4px;">
          ${downloadButtons.join('\n          ')}
        </div>
      </div>
    </div>
  ` : '';

  return `
  <div
    id="polygonDrawToolbar"
    class="flex fixed bottom-center divider-horizontal bg-inverted z-index-ontop-high no-print"
    style="margin-bottom: 20px; gap: 6px; height: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;"
  >
    <button id="polygon-draw" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Polygon" tabindex="0" title="Rita polygon (Vänsterklick: lägg till punkter, Högerklick: avsluta)">
      <span class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_timeline_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Polygon" data-placement="south"></span>
    </button>

    <button id="rectangle-draw" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Rektangel" tabindex="0" title="Rita rektangel (Klicka i ett hörn, sedan i motsatt hörn)">
      <span class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#o_polygon_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Rektangel" data-placement="south"></span>
    </button>

    <div class="o-popover-container">
      <button id="polygon-height-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Höjd" tabindex="0" title="Extruderingshöjd (meter)">
        <span class="icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
            <use xlink:href="#ic_height_24px"></use>
          </svg>
        </span>
        <span data-tooltip="Höjd" data-placement="south"></span>
      </button>
      <div id="polygon-height-popover" class="o-popover" style="width: min-content; left: 80px;">
        <div style="padding: 0.25rem 0.75rem;">
          <input
            id="polygon-height-compact"
            type="number"
            value="10"
            min="0"
            step="1"
            style="width: 6rem;"
          />
        </div>
      </div>
    </div>

    <div class="o-popover-container">
      <button id="polygon-color-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Färg" tabindex="0" title="Fyllnadsfärg">
        <span class="icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
            <use xlink:href="#ic_palette_24px"></use>
          </svg>
        </span>
        <span data-tooltip="Färg" data-placement="south"></span>
      </button>
      <div id="polygon-color-popover" class="o-popover" style="width: min-content; left: 74px;">
        <div style="padding: 0.25rem 0.75rem;">
          <select id="polygon-color-select" style="width: 7rem;">
            <option value="white" selected>Vit</option>
            <option value="red">Röd</option>
            <option value="green">Grön</option>
            <option value="blue">Blå</option>
            <option value="yellow">Gul</option>
            <option value="cyan">Cyan</option>
          </select>
        </div>
      </div>
    </div>

    <button id="polygon-opacity-toggle" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Opacitet" tabindex="0" title="Växla ogenomskinlig/genomskinlig">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_box-shadow_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Opacitet" data-placement="south"></span>
    </button>

    <button id="polygon-clear-compact" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Ta bort" tabindex="0" title="Rensa alla polygoner">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 100%, 40%)">
          <use xlink:href="#ic_delete_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Ta bort" data-placement="south"></span>
    </button>

    <button id="polygon-toggle-labels" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Etiketter" tabindex="0" title="Växla polygonetiketter">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_title_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Etiketter" data-placement="south"></span>
    </button>

    ${shareButtonHtml}
    ${downloadSectionHtml}
  </div>
`;
};

export const polygonEditPanelHtml = () => `
  <div
    id="polygonEditPanel"
    class="flex fixed bottom-center divider-horizontal bg-inverted z-index-ontop-high no-print"
    style="margin-bottom: 60px; gap: 8px; padding: 8px 12px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; display: none; align-items: center; border-radius: 4px;"
  >  
    <input 
      id="polygon-edit-name" 
      type="text" 
      placeholder="Namn" 
      style="width: 120px; padding: 4px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 13px;"
    />

    <div class="o-popover-container">
      <button id="polygon-edit-height-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Höjd" tabindex="0" title="Ändra höjd">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
            <use xlink:href="#ic_height_24px"></use>
          </svg>
        </span>
      </button>
      <div id="polygon-edit-height-popover" class="o-popover" style="width: min-content; left: 80px; bottom: 40px;">
        <div style="padding: 0.25rem 0.75rem;">
          <input
            id="polygon-edit-height-input"
            type="number"
            value="10"
            min="0"
            step="1"
            style="width: 6rem;"
          />
        </div>
      </div>
    </div>

    <div class="o-popover-container">
      <button id="polygon-edit-color-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Färg" tabindex="0" title="Ändra färg">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
            <use xlink:href="#ic_palette_24px"></use>
          </svg>
        </span>
      </button>
      <div id="polygon-edit-color-popover" class="o-popover" style="width: min-content; left: 74px; bottom: 40px;">
        <div style="padding: 0.25rem 0.75rem;">
          <select id="polygon-edit-color-select" style="width: 7rem;">
            <option value="white" selected>Vit</option>
            <option value="red">Röd</option>
            <option value="green">Grön</option>
            <option value="blue">Blå</option>
            <option value="yellow">Gul</option>
            <option value="cyan">Cyan</option>
          </select>
        </div>
      </div>
    </div>

    <button id="polygon-edit-opacity-toggle" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Opacitet" tabindex="0" title="Växla ogenomskinlig/genomskinlig">
      <span class="icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_box-shadow_24px"></use>
        </svg>
      </span>
    </button>

    <div class="o-popover-container">
      <button id="polygon-edit-rotate-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Rotera" tabindex="0" title="Rotera polygon">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
            <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
          </svg>
        </span>
      </button>
      <div id="polygon-edit-rotate-popover" class="o-popover" style="width: min-content; left: 60px; bottom: 40px;">
        <div style="padding: 0.25rem 0.75rem; display: flex; gap: 4px; align-items: center;">
          <button id="polygon-rotate-ccw" style="padding: 4px 8px; cursor: pointer;" title="Rotera 15° moturs">↻</button>
          <input
            id="polygon-edit-rotate-input"
            type="number"
            value="15"
            min="-360"
            max="360"
            step="15"
            style="width: 4rem;"
          />
          <span style="font-size: 12px;">°</span>
          <button id="polygon-rotate-cw" style="padding: 4px 8px; cursor: pointer;" title="Rotera 15° medurs">↺</button>
        </div>
      </div>
    </div>

    <button id="polygon-edit-delete" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Ta bort" tabindex="0" title="Ta bort denna polygon">
      <span class="icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="hsl(0, 100%, 40%)">
          <use xlink:href="#ic_delete_24px"></use>
        </svg>
      </span>
    </button>

    <button id="polygon-edit-deselect" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Avmarkera" tabindex="0" title="Avmarkera polygon">
      <span class="icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_close_24px"></use>
        </svg>
      </span>
    </button>
  </div>
`;

export const polygonTranslateArrowsHtml = () => `
  <div id="polygon-translate-arrows" style="
    position: absolute;
    display: none;
    pointer-events: none;
    z-index: 200;
  ">
    <div id="polygon-translate-handle" style="
      position: absolute;
      transform: translate(-50%, -50%);
      width: 50px;
      height: 50px;
      cursor: move;
      background: rgba(255,255,255,0.95);
      border: 2px solid #666;
      border-radius: 50%;
      pointer-events: auto;
      box-shadow: 0 2px 8px rgba(0,0,0,0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      user-select: none;
      touch-action: none;
    " title="Dra för att flytta polygon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="#444">
        <path d="M12 2l-4 4h3v4H7V7l-4 4 4 4v-3h4v4H8l4 4 4-4h-3v-4h4v3l4-4-4-4v3h-4V6h3z"/>
      </svg>
    </div>
  </div>
`;

export const streetViewHtml = (heightText: string) => `
  <div id="streetView" class="o-ui" style="
    position: absolute;
    bottom: 40px;
    left: 10px;
    z-index: 100;
    display: flex;
    flex-direction: row;
    align-items: center;
    width: min-content;
    gap: 6px;
  ">
    <button id="street-mode-toggle" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Gatuvy" tabindex="0" title="Gatuvy">
      <span class="icon">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_walk_24px"></use>
        </svg>
      </span>
    </button>

    <div id="height-controls" class="padding-small round light box-shadow" style="
      display: none;
      flex-direction: row;
      align-items: center;
      justify-content: center;
      font-family: sans-serif;
      font-size: 13px;
      color: hsl(0, 0%, 29%);
      gap: 6px;
      background: white;
      border-radius: 8px;
      padding: 6px 10px;
      user-select: none;
      -webkit-user-select: none;
    ">
      <div id="height-down" style="cursor: pointer; line-height: 1;">▼</div>
      <div id="height-display" style="min-width: 40px; text-align: center;">${heightText}</div>
      <div id="height-up" style="cursor: pointer; line-height: 1;">▲</div>
    </div>
  </div>
`;

export const cameraControlsHtml = () => `
  <div id="controlUI" class="o-ui" style="
    position: absolute;
    top: 8px;
    left: 60px;
    z-index: 99;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: min-content;
    gap: 4px;
  ">
    <button id="cam-up" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Luta uppåt" tabindex="0" title="Luta uppåt" style="margin-bottom: -8px; border: none; cursor: pointer;">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(-90deg);">
          <use xlink:href="#ic_chevron_right_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Upp" data-placement="east"></span>
    </button>
    <div style="display: flex; gap: 18px; margin-bottom: -8px;">
      <button id="cam-left" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Rotera vänster" tabindex="0" title="Rotera vänster" style="border: none; cursor: pointer;">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(180deg);">
            <use xlink:href="#ic_chevron_right_24px"></use>
          </svg>
        </span>
        <span data-tooltip="Vänster" data-placement="north"></span>
      </button>
      <button id="cam-right" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Rotera höger" tabindex="0" title="Rotera höger" style="border: none; cursor: pointer;">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24">
            <use xlink:href="#ic_chevron_right_24px"></use>
          </svg>
        </span>
        <span data-tooltip="Höger" data-placement="north"></span>
      </button>
    </div>
    <button id="cam-down" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Luta nedåt" tabindex="0" title="Luta nedåt" style="border: none; cursor: pointer;">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(90deg);">
          <use xlink:href="#ic_chevron_right_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Ner" data-placement="east"></span>
    </button>
  </div>
`;
