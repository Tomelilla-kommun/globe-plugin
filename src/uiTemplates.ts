export const polygonToolbarHtml = () => `
  <div
    id="polygonDrawToolbar"
    class="flex fixed bottom-center divider-horizontal bg-inverted z-index-ontop-high no-print"
    style="margin-bottom: 20px; gap: 6px; height: 2rem; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;"
  >
    <button id="polygon-draw" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Polygon" tabindex="0" title="Draw Polygon (Left click: add points, Right click: finish)">
      <span class="icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#o_polygon_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Polygon" data-placement="south"></span>
    </button>

    <div class="o-popover-container">
      <button id="polygon-height-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Höjd" tabindex="0" title="Extrude height (meters)">
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
      <button id="polygon-color-button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Färg" tabindex="0" title="Fill color">
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
            <option value="white" selected>White</option>
            <option value="red">Red</option>
            <option value="green">Green</option>
            <option value="blue">Blue</option>
            <option value="yellow">Yellow</option>
            <option value="cyan">Cyan</option>
          </select>
        </div>
      </div>
    </div>

    <button id="polygon-opacity-toggle" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Opacitet" tabindex="0" title="Toggle opaque/transparent">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_box-shadow_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Opacitet" data-placement="south"></span>
    </button>

    <button id="polygon-clear-compact" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Ta bort" tabindex="0" title="Clear all polygons">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 100%, 40%)">
          <use xlink:href="#ic_delete_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Ta bort" data-placement="south"></span>
    </button>

    <button id="polygon-toggle-labels" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Etiketter" tabindex="0" title="Toggle polygon labels">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_title_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Etiketter" data-placement="south"></span>
    </button>

    <button id="polygon-share" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Dela" tabindex="0" title="Share drawn polygons">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(210, 100%, 40%)">
          <use xlink:href="#ic_screen_share_outline_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Dela" data-placement="south"></span>
    </button>

    <button id="polygon-download-geojson" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Ladda ner" tabindex="0" title="Download drawn polygons as GeoJSON">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="hsl(0, 0%, 29%)">
          <use xlink:href="#ic_download_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Ladda ner" data-placement="south"></span>
    </button>
  </div>
`;

export const streetViewHtml = (heightText: string) => `
  <div id="streetView" style="
    position: absolute;
    bottom: 35px;
    left: 8px;
    z-index: 100;
    cursor: pointer;
    background: rgba(255, 255, 255, 0.7);
    border-radius: 4px;
    padding: 3px;
    display: flex;
    align-items: center;
    gap: 8px;
  ">

    <div id="" style="
      border: 1px solid #424242;
      border-radius: 4px;
      display: flex;
    ">
      <div id="street-mode-toggle" style=" padding-top: 2px;">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="gray" xmlns="http://www.w3.org/2000/svg">
          <path d="M15 4.5C15 5.88071 13.8807 7 12.5 7C11.1193 7 10 5.88071 10 4.5C10 3.11929 11.1193 2 12.5 2C13.8807 2 15 3.11929 15 4.5Z" fill="hsl(0, 0%, 29%)"/>
          <path fill-rule="evenodd" clip-rule="evenodd" d="M10.9292 9.2672C11.129 9.25637 11.3217 9.25 11.5 9.25C12.0541 9.25 12.6539 9.31158 13.1938 9.38913C14.7154 9.60766 15.8674 10.7305 16.3278 12.1117C16.4321 12.4245 16.7484 12.6149 17.0737 12.5607L18.8767 12.2602C19.2853 12.1921 19.6717 12.4681 19.7398 12.8767C19.8079 13.2853 19.5319 13.6717 19.1233 13.7398L17.3203 14.0403C16.2669 14.2159 15.2425 13.599 14.9048 12.586C14.5975 11.6642 13.862 11.0005 12.9806 10.8739C12.7129 10.8354 12.4404 10.8029 12.1757 10.7809L11.9045 13.4923C11.8206 14.332 11.8108 14.5537 11.8675 14.7518C11.9241 14.9498 12.0497 15.1328 12.5652 15.8009L16.9942 21.5419C17.2473 21.8698 17.1865 22.3408 16.8585 22.5938C16.5306 22.8468 16.0596 22.7861 15.8066 22.4581L11.3775 16.7172C11.3536 16.6862 11.33 16.6556 11.3066 16.6254C10.896 16.0941 10.5711 15.6738 10.4253 15.1645C10.2796 14.6551 10.3329 14.1265 10.4004 13.4585C10.4042 13.4205 10.4081 13.382 10.412 13.3431L10.6661 10.8023C8.99274 11.076 7.75003 12.6491 7.75003 14.5C7.75003 14.9142 7.41424 15.25 7.00003 15.25C6.58581 15.25 6.25003 14.9142 6.25003 14.5C6.25003 11.8593 8.16383 9.41707 10.9292 9.2672ZM10.1471 16.7646C10.5533 16.8458 10.8167 17.2409 10.7355 17.6471C10.3779 19.4349 9.4014 21.0394 7.97772 22.1783L7.46855 22.5857C7.1451 22.8444 6.67313 22.792 6.41438 22.4685C6.15562 22.1451 6.20806 21.6731 6.53151 21.4143L7.04067 21.007C8.18877 20.0885 8.97625 18.7946 9.26459 17.3529C9.34583 16.9467 9.74094 16.6833 10.1471 16.7646Z" fill="hsl(0, 0%, 29%)"/>
        </svg>
      </div>
      <div id="height-controls" style="
        display: none;
        flex-direction: row;
        align-items: center;
        justify-content: center;
        border-left: 1px solid;
        padding: 2px;
        font-family: sans-serif;
        font-size: 14px;
        color: hsl(0, 0%, 29%);
      ">
        <div style="padding-left: 3px; padding-right: 3px;">
          <div id="height-up" style="margin-bottom: -3px; color: hsl(0, 0%, 29%);">▲</div>
          <div id="height-down" style="margin-top: -3px; color: hsl(0, 0%, 29%);">▼</div>
        </div>
        <div id="height-display">${heightText}</div>
      </div>
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
    <button id="cam-up" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Tilt up" tabindex="0" title="Tilt up" style="margin-bottom: -8px; border: none; cursor: pointer;">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(-90deg);">
          <use xlink:href="#ic_chevron_right_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Upp" data-placement="east"></span>
    </button>
    <div style="display: flex; gap: 18px; margin-bottom: -8px;">
      <button id="cam-left" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Orbit left" tabindex="0" title="Orbit left" style="border: none; cursor: pointer;">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(180deg);">
            <use xlink:href="#ic_chevron_right_24px"></use>
          </svg>
        </span>
        <span data-tooltip="Vänster" data-placement="north"></span>
      </button>
      <button id="cam-right" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Orbit right" tabindex="0" title="Orbit right" style="border: none; cursor: pointer;">
        <span class="icon">
          <svg width="18" height="18" viewBox="0 0 24 24">
            <use xlink:href="#ic_chevron_right_24px"></use>
          </svg>
        </span>
        <span data-tooltip="Höger" data-placement="north"></span>
      </button>
    </div>
    <button id="cam-down" type="button" class="padding-small icon-smaller round light box-shadow relative o-tooltip" aria-label="Tilt down" tabindex="0" title="Tilt down" style="border: none; cursor: pointer;">
      <span class="icon">
        <svg width="18" height="18" viewBox="0 0 24 24" style="transform: rotate(90deg);">
          <use xlink:href="#ic_chevron_right_24px"></use>
        </svg>
      </span>
      <span data-tooltip="Ner" data-placement="east"></span>
    </button>
  </div>
`;
