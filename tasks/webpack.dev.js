const path = require('path');
const fs = require('fs');
const express = require('express');
const compression = require('compression');
const CopyWebpackPlugin = require('copy-webpack-plugin');
const { merge } = require('webpack-merge');
const common = require('./webpack.common');

const cesiumSource = 'node_modules/cesium/Source';
const cesiumWorkers = '../Build/Cesium/Workers';

module.exports = merge(common, {
  output: {
    path: `${__dirname}/../../Tomelilla-kommun/origo/plugins/globe`,
    publicPath: '/build',
    filename: 'globe.js',
    libraryTarget: 'var',
    libraryExport: 'default',
    library: 'Globe',
  },
  mode: 'development',
  module: {
    rules: [
      {
        test: /\.(s(a|c)ss)$/,
        use: ['style-loader', 'css-loader', 'sass-loader'],
      },
    ],
  },
  devServer: {
    static: './',
    port: 9009,
    hot: false,
    devMiddleware: {
      writeToDisk: false,
    },

    setupMiddlewares: (middlewares, devServer) => {
      const cesiumStaticPath = `${__dirname}/../../Tomelilla-kommun/origo/plugins/globe/cesiumassets`;
      const fileCache = new Map();

      function getCachedFileData(filePath) {
        let cached = fileCache.get(filePath);
        if (!cached) {
          const stats = fs.statSync(filePath);
          cached = {
            mtime: stats.mtime,
            etag: `${path.basename(filePath)}-${stats.mtime.getTime()}`,
            hasBr: fs.existsSync(filePath + '.br'),
            hasGz: fs.existsSync(filePath + '.gz'),
          };
          fileCache.set(filePath, cached);
        }
        return cached;
      }

      function preloadCache(dir) {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) preloadCache(fullPath);
          else if (entry.isFile() && !entry.name.startsWith('.')) getCachedFileData(fullPath);
        }
      }

      preloadCache(cesiumStaticPath);
      console.log(`🔹 Preloaded ${fileCache.size} static files from ${cesiumStaticPath}`);

      devServer.app.use(
        compression({
          filter: (req, res) => {
            if (/\.(terrain|glb|gz|br)$/.test(req.url)) return false;
            return compression.filter(req, res);
          },
        })
      );

      devServer.app.use(
        '/cesiumassets',
        express.static(cesiumStaticPath, {
          etag: false,
          maxAge: '365d',
          immutable: true,
          setHeaders: (res, filePath) => {
            const { mtime, etag, hasBr, hasGz } = getCachedFileData(filePath);
            res.setHeader('Last-Modified', mtime.toUTCString());
            res.setHeader('ETag', etag);

            if (filePath.endsWith('.terrain'))
              res.setHeader('Content-Type', 'application/octet-stream');
            else if (filePath.endsWith('.glb'))
              res.setHeader('Content-Type', 'model/gltf-binary');
            else if (filePath.endsWith('.js'))
              res.setHeader('Content-Type', 'application/javascript');

            if (hasBr) res.setHeader('Content-Encoding', 'br');
            else if (hasGz) res.setHeader('Content-Encoding', 'gzip');
          },
        })
      );

      console.log('✅ Cesium static assets served from:', cesiumStaticPath);
      return middlewares;
    },
  },

  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: path.join(cesiumSource, cesiumWorkers), to: `${__dirname}/../../origo/plugins/globe/cesiumassets/Workers` },
        { from: path.join(cesiumSource, 'Widgets'), to: `${__dirname}/../../origo/plugins/globe/cesiumassets/Widgets` },
        { from: path.join(cesiumSource, 'Assets'), to: `${__dirname}/../../origo/plugins/globe/cesiumassets/Assets` },
        { from: path.join(cesiumSource, 'ThirdParty'), to: `${__dirname}/../../origo/plugins/globe/cesiumassets/ThirdParty` }
      ],
    }),
  ],
});
