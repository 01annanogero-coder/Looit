// Builds a locally installable, dev-signed MSIX (out/make/msix/x64/*.msix).
//
// Store submissions don't need this certificate: the Microsoft Store re-signs
// packages. It exists only so the package can be installed for local testing.
// The certificate is created once with Windows PowerShell (no pwsh needed) and
// kept in certs/ (git-ignored).
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const certDir = path.resolve('certs');
const pfx = path.join(certDir, 'dev-cert.pfx');
const cer = path.join(certDir, 'dev-cert.cer');
const passFile = path.join(certDir, 'dev-cert.password');
// Must match the publisher in forge.config.mts.
const subject = 'CN=Looit Dev';

if (!existsSync(pfx)) {
  mkdirSync(certDir, { recursive: true });
  const password = randomBytes(18).toString('base64url');
  writeFileSync(passFile, password);
  const script = `
$ErrorActionPreference = 'Stop'
$cert = New-SelfSignedCertificate -Type CodeSigning -Subject '${subject}' -FriendlyName 'Looit Dev MSIX signing' \`
  -KeyUsage DigitalSignature -KeySpec Signature -KeyLength 2048 -KeyExportPolicy Exportable \`
  -NotAfter (Get-Date).AddYears(5) -CertStoreLocation 'cert:\\CurrentUser\\My'
$pw = ConvertTo-SecureString -String '${password}' -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath '${pfx}' -Password $pw | Out-Null
Export-Certificate -Cert $cert -FilePath '${cer}' | Out-Null
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' });
  console.log(`Created dev certificate: ${cer}`);
}

const result = spawnSync('npx', ['electron-forge', 'make'], {
  stdio: 'inherit',
  shell: true,
  env: {
    ...process.env,
    WINDOWS_CERTIFICATE_FILE: pfx,
    WINDOWS_CERTIFICATE_PASSWORD: readFileSync(passFile, 'utf8').trim(),
  },
});
process.exit(result.status ?? 1);
