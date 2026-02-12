const path = require('path');
const fs = require('fs');
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
      writeToDisk: true,
    },
  },

  plugins: [
    new CopyWebpackPlugin({
      patterns: [
        { from: path.resolve(cesiumSource, cesiumWorkers), to: `C:\\Users\\SEIAMM\\Documents\\GitHub\\Tomelilla-kommun\\origo\\plugins\\globe\\cesiumassets\\Workers` },
        { from: path.resolve(cesiumSource, 'Widgets'), to: `C:\\Users\\SEIAMM\\Documents\\GitHub\\Tomelilla-kommun\\origo\\plugins\\globe\\cesiumassets\\Widgets` },
        { from: path.resolve(cesiumSource, 'Assets'), to: `C:\\Users\\SEIAMM\\Documents\\GitHub\\Tomelilla-kommun\\origo\\plugins\\globe\\cesiumassets\\Assets` },
        { from: path.resolve(cesiumSource, 'ThirdParty'), to: `C:\\Users\\SEIAMM\\Documents\\GitHub\\Tomelilla-kommun\\origo\\plugins\\globe\\cesiumassets\\ThirdParty` }
      ],
    })
  ],
});