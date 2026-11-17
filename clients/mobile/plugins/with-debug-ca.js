const fs = require('node:fs/promises')
const path = require('node:path')
const { withDangerousMod } = require('expo/config-plugins')

module.exports = config => withDangerousMod(config, ['android', async mod => {
  const source = path.join(mod.modRequest.platformProjectRoot, 'app', 'src', 'debug')
  const manifestPath = path.join(source, 'AndroidManifest.xml')
  const certificate = await fs.readFile(process.env.ATTENDANCE_ANDROID_DEBUG_CA, 'utf8')
  if (!/^-----BEGIN CERTIFICATE-----\r?\n/.test(certificate)) {
    throw new Error('ATTENDANCE_ANDROID_DEBUG_CA must point to a PEM certificate')
  }
  const manifest = await fs.readFile(manifestPath, 'utf8')
  const entry = 'android:networkSecurityConfig="@xml/attendance_debug_tls"'
  if (!manifest.includes(entry) && manifest.includes('android:networkSecurityConfig=')) {
    throw new Error('Android debug manifest already configures TLS')
  }
  if (!manifest.includes('<application')) throw new Error('Android debug manifest is missing its application element')
  for (const directory of ['raw', 'xml']) await fs.mkdir(path.join(source, 'res', directory), { recursive: true })
  await fs.writeFile(path.join(source, 'res', 'raw', 'attendance_debug_ca.pem'), certificate)
  await fs.writeFile(path.join(source, 'res', 'xml', 'attendance_debug_tls.xml'), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <domain-config>
        <domain>localhost</domain>
        <trust-anchors><certificates src="@raw/attendance_debug_ca" /></trust-anchors>
    </domain-config>
    <domain-config cleartextTrafficPermitted="true">
        <domain>10.0.2.2</domain>
        <domain>127.0.0.1</domain>
    </domain-config>
</network-security-config>
`)
  if (!manifest.includes(entry)) {
    await fs.writeFile(manifestPath, manifest.replace('<application', `<application ${entry}`))
  }
  return mod
}])
