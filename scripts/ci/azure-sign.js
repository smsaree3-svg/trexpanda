// electron-builder custom Windows signing hook (win.sign).
// Signs every .exe (the app and the NSIS installer) with Microsoft Artifact
// Signing (formerly Trusted Signing) through signtool + the Azure dlib.
// It is a no-op unless the CI step "Configure Windows signing" has set
// TREX_AZURE_SIGN=1, so local and unsigned builds keep working.
const { execFileSync } = require('child_process');

module.exports = async function sign(configuration) {
  if (process.env.TREX_AZURE_SIGN !== '1') return;
  const file = configuration.path;
  if (!/\.(exe|dll)$/i.test(file)) return;
  const args = [
    'sign', '/v', '/debug',
    '/fd', 'SHA256',
    '/tr', 'http://timestamp.acs.microsoft.com',
    '/td', 'SHA256',
    '/dlib', process.env.TREX_SIGN_DLIB,
    '/dmdf', process.env.TREX_SIGN_METADATA,
    file,
  ];
  for (let attempt = 1; ; attempt++) {
    try {
      execFileSync(process.env.TREX_SIGNTOOL, args, { stdio: 'inherit' });
      console.log(`Signed with Artifact Signing: ${file}`);
      return;
    } catch (err) {
      if (attempt >= 3) throw new Error(`Artifact Signing failed for ${file}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
};
