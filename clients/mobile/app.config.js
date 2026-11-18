module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...config.plugins,
    './plugins/with-windows-cmake-path',
    ...(process.env.ATTENDANCE_ANDROID_DEBUG_CA ? ['./plugins/with-debug-ca'] : []),
  ],
})
