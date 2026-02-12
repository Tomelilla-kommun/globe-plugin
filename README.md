# Origo globe plugin
A plugin for [Origo map](https://github.com/origo-map/origo) to enable a [CesiumJS](https://cesium.com/platform/cesiumjs/) globe using [Ol-Cesium](https://openlayers.org/ol-cesium/).

<img src="data/soderstadion.png" alt="Söderstadion" title="Söderstadion" height="400px" />

## Setup

See [index_example.html](https://github.com/haninge-geodata/origo-globe-plugin/blob/main/index_example.html) and [index_example.json](https://github.com/haninge-geodata/origo-globe-plugin/blob/main/index_example.json) to get started with configuration.

Copy the files in the `build` folder and place them in Origo's `plugins/globe` folder.

ℹ️ Due to loading issues, ol-cesium needs to be loaded from Origo-map.

Install ol-cesium:
```
npm install olcs
```
In [origo.js](https://github.com/origo-map/origo/blob/master/origo.js), add:

```
import OLCesium from 'olcs/OLCesium';

window.OLCesium = OLCesium;
```

## Functions

All functions described in this section can be enabled or disabled in the `Globe` configuration (see below) within `index.html`:

```js
const globe = Globe({
    viewShed: true,
    streetView: true,
    cameraControls: true,
    measure: true,
    shadowDates: true,
    // ...
});
```

### ViewShed

The ViewShed feature analyzes the visible area from a selected point, taking into account terrain and 3D objects (such as buildings and trees) that may obstruct the view.

To use this function:
1. Activate the ViewShed tool.
2. Select the origin point for the analysis.
3. Select the endpoint to define the direction and extent of the viewshed.

<img src="data/viewShed.png" alt="ViewShed" title="ViewShed" height="300px" />

### StreetView

The StreetView feature allows users to navigate through the 3D environment at ground level, providing an immersive experience similar to real-world street-level exploration. This feature lets you move around, look in different directions, and explore the environment as if you were walking through it.

To use this function:
1. Activate StreetView by pressing the person icon at the bottom left corner.
2. Select the point on the map where you want to enter StreetView.
3. To exit StreetView mode, press the person icon again.

While in this mode, you can change the simulated height by pressing the up and down arrows beside the person icon, tilt the camera, and click on the ground in the viewer to pan to new areas.

<img src="data/streetView.png" alt="StreetView" title="StreetView" height="400px" />

### CameraControls

If enabled, extra controls are added to the map in the bottom left corner.
With these controls, the user can tilt and rotate the camera using buttons.

<img src="data/cameraControls.png" alt="CameraControls" title="CameraControls" height="80px" />

### measure


### shadowDates
