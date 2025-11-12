const webpack = require('webpack');
const path = require('path');

module.exports = {
  entry: [
    './globe.js'
  ],
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: 'ts-loader',
        exclude: /node_modules/
      },
      {
        test: /\.js$/,
        exclude: /node_modules/
      },
      {
        test: /\.(sc|c)ss$/,
        use: ['style-loader', 'css-loader', 'sass-loader']
      }
    ]
  }, 
  externals: ['Origo'],
  resolve: {
    extensions: ['.*', '.js', '.scss', '.ts', '.json'],
    fallback: { https: false, zlib: false, http: false, url: false },
    alias: {
      cesium: path.resolve('node_modules/cesium/Source/Cesium')
    }
  },
  plugins: [
    new webpack.ProvidePlugin({
      proj4: 'proj4'
    }),
    new webpack.DefinePlugin({
      CESIUM_BASE_URL: JSON.stringify('plugins/globe/cesiumassets')
    })
  ]
};
