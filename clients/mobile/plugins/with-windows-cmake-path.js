const { withAppBuildGradle } = require('expo/config-plugins')

module.exports = config => {
  if (process.platform !== 'win32') return config
  return withAppBuildGradle(config, mod => {
    const argument = '-DCMAKE_OBJECT_PATH_MAX=248'
    const contents = mod.modResults.contents
    if (contents.includes(argument)) return mod
    if (mod.modResults.language !== 'groovy' || !contents.includes('    defaultConfig {')) {
      throw new Error('Android Gradle template no longer exposes the defaultConfig block')
    }
    mod.modResults.contents = contents.replace('    defaultConfig {', `    defaultConfig {
        externalNativeBuild {
            cmake {
                arguments "${argument}"
            }
        }`)
    return mod
  })
}
