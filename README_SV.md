# Origo globe plugin
Ett plugin för [Origo map](https://github.com/origo-map/origo) som möjliggör en [CesiumJS](https://cesium.com/platform/cesiumjs/)-glob med hjälp av [Ol-Cesium](https://openlayers.org/ol-cesium/).

<img src="data/soderstadion.png" alt="Söderstadion" title="Söderstadion" height="400px" />

## Installation

Se [index_example.html](https://github.com/haninge-geodata/origo-globe-plugin/blob/main/index_example.html) och [index_example.json](https://github.com/haninge-geodata/origo-globe-plugin/blob/main/index_example.json) för att komma igång med konfigurationen.

Kopiera filerna i mappen `build` och placera dem i Origos mapp `plugins/globe`.

ℹ️ På grund av laddningsproblem måste ol-cesium laddas från Origo-map.

Installera ol-cesium:
```
npm install olcs
```
I [origo.js](https://github.com/origo-map/origo/blob/master/origo.js), lägg till:

```
import OLCesium from 'olcs/OLCesium';

window.OLCesium = OLCesium;
```

## Konfiguration

Alla globinställningar kan konfigureras i `index.json` under sektionen `"3D"`. Detta samlar all 3D-relaterad konfiguration på ett ställe.

### Fullständigt konfigurationsexempel

```json
{
  "3D": {
    "showGlobe": true,
    "globeOnStart": true,
    "viewShed": true,
    "streetView": true,
    "streetViewMap": "webservices:topowebbkartan",
    "fx": false,
    "drawTool": {
      "active": true,
      "options": {
        "export": {
          "geojson": true,
          "dxf": true,
          "dxfCrs": ["EPSG:3008", "EPSG:4326"]
        },
        "share": true,
        "defaultColor": "white",
        "defaultHeight": 10
      }
    },
    "cameraControls": true,
    "measure": true,
    "quickTimeShadowPicker": true,
    "flyTo": false,
    "deactivateControls": [],
    "settings": {
      "depthTestAgainstTerrain": true,
      "enableAtmosphere": true,
      "enableGroundAtmosphere": true,
      "enableFog": false,
      "enableLighting": true,
      "shadows": {
        "darkness": 0.3,
        "fadingEnabled": true,
        "maximumDistance": 1000,
        "normalOffset": true,
        "size": 4096,
        "softShadows": false
      },
      "skyBox": {
        "url": "plugins/globe/cesiumassets/Assets/Textures/SkyBox/",
        "images": {
          "pX": "tycho2t3_80_px.jpg",
          "nX": "tycho2t3_80_mx.jpg",
          "pY": "tycho2t3_80_py.jpg",
          "nY": "tycho2t3_80_my.jpg",
          "pZ": "tycho2t3_80_pz.jpg",
          "nZ": "tycho2t3_80_mz.jpg"
        }
      }
    },
    "cesiumIontoken": "din-cesium-ion-token",
    "cesiumTerrainProvider": "data/TerrainOptimized17/"
  }
}
```

### Konfigurationsalternativ

| Alternativ | Typ | Standard | Beskrivning |
|------------|-----|----------|-------------|
| `showGlobe` | boolean | `true` | Visa/dölj globen |
| `globeOnStart` | boolean | `false` | Aktivera 3D-läge automatiskt vid laddning |
| `viewShed` | boolean | `false` | Aktivera siktfältsanalys |
| `streetView` | boolean | `false` | Aktivera gatuvyläge |
| `streetViewMap` | string | `""` | Lagernamn att använda som marktextur i gatuvy |
| `cameraControls` | boolean | `false` | Visa knappar för kameralutning/rotation |
| `measure` | boolean | `false` | Aktivera 3D-mätverktyg |
| `quickTimeShadowPicker` | boolean | `false` | Aktivera snabbväljare för tid/datum för skuggor |
| `flyTo` | boolean | `false` | Animera kameran vid val av objekt |
| `fx` | boolean | `false` | Aktivera extra visuella effekter |
| `drawTool` | object/boolean | `false` | Ritverktygets konfiguration (se nedan) |
| `deactivateControls` | string[] | `[]` | Lista över Origo-kontroller att dölja när 3D är aktivt |
| `cesiumIontoken` | string | - | Din Cesium Ion-åtkomsttoken |
| `cesiumTerrainProvider` | string | - | Sökväg till anpassade terrängplattor |

### Ritverktygets alternativ

```json
"drawTool": {
  "active": true,
  "options": {
    "export": {
      "geojson": true,
      "dxf": true,
      "dxfCrs": ["EPSG:3008", "EPSG:4326"]
    },
    "share": true,
    "defaultColor": "white",
    "defaultHeight": 10
  }
}
```

| Alternativ | Typ | Standard | Beskrivning |
|------------|-----|----------|-------------|
| `export.geojson` | boolean | `true` | Aktivera GeoJSON-export |
| `export.dxf` | boolean | `true` | Aktivera DXF-export |
| `export.dxfCrs` | string[] | `["EPSG:3006"]` | Koordinatsystem för DXF-export (se tabell nedan) |
| `share` | boolean | `true` | Aktivera delnings-URL-funktion |

#### Tillgängliga DXF-koordinatsystem (SWEREF99)

| EPSG-kod | Namn | Beskrivning |
|----------|------|-------------|
| `EPSG:3006` | SWEREF99 TM | Nationellt system (standard) |
| `EPSG:3007` | SWEREF99 12 00 | Lokal zon 12°00' |
| `EPSG:3008` | SWEREF99 13 30 | Lokal zon 13°30' |
| `EPSG:3009` | SWEREF99 15 00 | Lokal zon 15°00' |
| `EPSG:3010` | SWEREF99 16 30 | Lokal zon 16°30' |
| `EPSG:3011` | SWEREF99 18 00 | Lokal zon 18°00' |
| `EPSG:3012` | SWEREF99 14 15 | Lokal zon 14°15' |
| `EPSG:3013` | SWEREF99 15 45 | Lokal zon 15°45' |
| `EPSG:3014` | SWEREF99 17 15 | Lokal zon 17°15' |
| `EPSG:3015` | SWEREF99 18 45 | Lokal zon 18°45' |
| `EPSG:3016` | SWEREF99 20 15 | Lokal zon 20°15' |
| `EPSG:3017` | SWEREF99 21 45 | Lokal zon 21°45' |
| `EPSG:3018` | SWEREF99 23 15 | Lokal zon 23°15' |

| `defaultColor` | string | `"white"` | Standardfärg för polygoner (white, red, green, blue, yellow, cyan) |
| `defaultHeight` | number | `10` | Standard extruderingshöjd i meter |

### Minimal konfiguration i index.html

Med det nya konfigurationssystemet behöver `index.html` endast:

```js
origo.on('load', async (viewer) => {
  const indexJson = await fetch('index.json').then(r => r.json());
  const globe = Globe({
    indexJson: indexJson,
  });
  viewer.addComponent(globe);
});
```

Inställningar kan fortfarande skickas direkt till `Globe({...})` för att åsidosätta värden från `index.json`.


## Lagerkonfiguration

För att lägga till 3D-lager i visaren, se `index_example.json`.

### Anpassade terrängplattor

För att lägga till en anpassad terrängleverantör, ange den i din `index.json` under sektionen `"3D"`:

```json
"3D": {
  "cesiumTerrainProvider": "sökväg/till/din/terräng"
}
```

### Anpassat 3D-tile-lager

I `index.json`, lägg till ditt anpassade 3D-tile-lager enligt nedan:

```json
{
    "name": "Byggnader",
    "title": "Byggnader",
    "type": "THREEDTILE",
    "url": "sökväg/till/dina/3Dtiles/tileset.json",
    "visible": true,
    "style": {
        "color": "color('#FFFFFF', 1)"
    }
}
```

Ändring av `style` påverkar utseendet på 3D-lagret.

### glb/gltf-modeller

För att lägga till glb/gltf-modeller, använd exemplet nedan. Flera modeller kan läggas till i arrayen "models".

```json
{
    "name": "GLB",
    "title": "GLB",
    "type": "THREEDTILE",
    "dataType": "model",
    "url": "sökväg/till/dina/GLB-GLTF-filer",
    "visible": true,
    "models": [
        {
            "fileName": "hus1.glb",
            "lat": 55.54734220671179,
            "lng": 13.949731975672035,
            "height": 66.0,
            "heightReference": "NONE",
            "rotHeading": 0,
            "animation": false
        }
    ]
}
```

### Extruderat 2D-lager

För att lägga till 2D-data som 3D-extruderade objekt, lägg till lagret enligt nedan.

**Krav:**
- Datan måste ha två höjdattribut: höjden vid toppen av objektet och höjden vid botten av objektet, båda relativa till geoiden.

I attributet `extrusion`, tilldela attributvärdena till `groundAttr` (höjd vid botten av objektet) och `roofAttr` (höjd vid toppen av objektet).

(Endast testat med GeoServer)

```json
{
    "name": "geostore:Byggnader",
    "title": "Byggnader2D",
    "dataSource": "https://mapserver.com/WFS",
    "type": "THREEDTILE",
    "dataType": "extrusion",
    "extrusion": {
        "groundAttr": "mark_hojd",
        "roofAttr": "tak_hojd",
        "color": "LIGHTGRAY",
        "opacity": 0.9,
        "outline": true,
        "outlineColor": "RED"
    },
    "visible": true
}
```
Ändring av `color`, `opacity`, `outline` och `outlineColor` påverkar utseendet på lagret.


## Funktioner

Alla funktioner som beskrivs i denna sektion kan aktiveras eller inaktiveras i `index.json` under sektionen `"3D"`.

### ViewShed (Siktfält)

ViewShed-funktionen analyserar det synliga området från en vald punkt, med hänsyn till terräng och 3D-objekt (som byggnader och träd) som kan blockera sikten.

För att använda denna funktion:
1. Aktivera ViewShed-verktyget.
2. Välj utgångspunkt för analysen.
3. Välj slutpunkt för att definiera riktning och omfattning för siktfältet.
4. Dra den blå startpunkten för att justera siktfältets position.

<img src="data/viewShed.png" alt="ViewShed" title="ViewShed" height="300px" />

### StreetView (Gatuvy)

StreetView-funktionen gör det möjligt för användare att navigera genom 3D-miljön på marknivå. Denna funktion låter dig röra dig omkring, titta i olika riktningar och utforska miljön som om du gick genom den.

För att använda denna funktion:
1. Aktivera StreetView genom att trycka på personikonen i nedre vänstra hörnet.
2. Välj punkten på kartan där du vill gå in i StreetView.
3. För att lämna StreetView-läget, tryck på personikonen igen.

När du är i detta läge kan du ändra den simulerade höjden genom att trycka på upp- och nedpilarna bredvid personikonen, luta kameran och klicka på marken i visaren för att panorera till nya områden.

<img src="data/streetView.png" alt="StreetView" title="StreetView" height="400px" />

### CameraControls (Kamerakontroller)

Om aktiverat läggs extra kontroller till på kartan i nedre vänstra hörnet.
Med dessa kontroller kan användaren luta och rotera kameran med knappar.

<img src="data/cameraControls.png" alt="CameraControls" title="CameraControls" height="80px" />

### Measure (Mät)

3D-mätverktyget erbjuder fyra mätlägen:

| Läge | Beskrivning |
|------|-------------|
| **Avstånd** | Mät 3D-avstånd mellan två punkter på terräng eller 3D-objekt |
| **Höjd** | Mät vertikal höjdskillnad mellan två punkter |
| **Fotavtryck** | Mät horisontell projicerad yta (som att titta rakt ner) - användbart för tomter och byggnadsytor |
| **3D-yta** | Mät verklig 3D-ytarea - användbart för tak, väggar, sluttningar och terräng |

Så här använder du:
1. Välj mätläge från verktygsfältet.
2. För avstånd/höjd: klicka på två punkter på kartan.
3. För fotavtryck/ytarea: klicka på flera punkter för att definiera polygonen, högerklicka sedan för att slutföra.
4. Använd rensa-knappen för att ta bort alla mätningar.

<img src="data/measure.png" alt="Mät" title="Mät" height="340px" />

### QuickTimeShadowPicker (Snabbval för skuggor)

Möjliggör snabb åtkomst till datum och tider för dagjämningar och solstånd för skugganalys.

<img src="data/quickTimeShadowPicker.png" alt="QuickTimeShadowPicker" title="QuickTimeShadowPicker" height="340px" />

### FlyTo (Flyg till)

Om aktiverat animerar FlyTo kameran att panorera och zooma för att fokusera på det valda objektet.

### Draw (Rita)

Ritverktyget låter dig skapa 3D-extruderade polygoner och rektanglar på kartan. Genom att aktivera Rita får du ett verktygsfält längst ner på skärmen.

#### Ritverktyg

| Verktyg | Beskrivning |
|---------|-------------|
| **Polygon** | Rita fria polygoner genom att klicka på hörnen. Högerklicka för att avsluta. |
| **Rektangel** | Rita rektanglar genom att klicka på två motsatta hörn. |

#### Verktygsfältsknappar

| Knapp | Beskrivning |
|-------|-------------|
| Höjd | Ställ in extruderingshöjden (i meter) för nya polygoner |
| Färg | Välj fyllnadsfärg (vit, röd, grön, blå, gul, cyan) |
| Opacitet | Växla mellan transparent (70%) och ogenomskinlig (100%) |
| Rensa | Ta bort alla ritade polygoner |
| Etiketter | Slå på/av polygoninformationsetiketter |
| Dela | Kopiera en delbar URL till urklipp med alla ritade polygoner |
| Ladda ner | Exportera polygoner som GeoJSON eller DXF (med konfigurerbara koordinatsystem) |

#### Redigera enskilda polygoner

Klicka på valfri ritad polygon för att välja den. Ett sekundärt verktygsfält visas med redigeringsalternativ:

| Alternativ | Beskrivning |
|------------|-------------|
| Namn | Redigera polygonens namn |
| Höjd | Ändra extruderingshöjden |
| Färg | Ändra fyllnadsfärgen |
| Opacitet | Växla transparens |
| Ta bort | Ta bort denna polygon |
| Avmarkera | Stäng redigeringspanelen |

Polygonens kontur blir gul när den är vald.

#### Polygonetiketter

Varje polygon visar information inklusive:
- Namn
- Bashöjd (terrängnivå)
- Extruderingshöjd
- Topphöjd (bas + extrudering)
- Area i m²

#### Exportformat

- **GeoJSON 2D (EPSG:4326)**: Standard GeoJSON med 2D-koordinater. Egenskaper inkluderar extrudeHeight, baseHeight, area, color och fillAlpha för 3D-rekonstruktion.
- **DXF 3D**: AutoCAD-kompatibelt format med full 3D-geometri, stödjer flera koordinatsystem (SWEREF99-zoner)

#### Delning

Dela-knappen skapar en URL som innehåller alla ritade polygoner. När någon öppnar länken:
- 3D-läge aktiveras automatiskt
- Alla delade polygoner laddas och visas
- Vyn zoomar för att passa alla polygoner
