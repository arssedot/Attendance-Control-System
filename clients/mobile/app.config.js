module.exports = ({ config }) => ({
  ...config,
  plugins: [
    ...config.plugins,
    ...(process.env.ATTENDANCE_ANDROID_DEBUG_CA ? ['./plugins/with-debug-ca'] : []),
  ],
})
